import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { analyzeExperiment } from "../analysis/profiles";
import policyJson from "../fixtures/hm-c095-write-policy.json";
import { FakeMemoryBackend } from "./fake-memory-backend";
import { SafeWriteRequest, validateSafeWriteRequest, WritePolicy } from "./write-contract";
import { executeSafeWrite } from "./write-verify";

const policy = policyJson as WritePolicy;

test("safe write contract accepts allowlisted scratch writes and rejects unsafe input", () => {
  const valid = scratchWrite(123);
  assert.equal(validateSafeWriteRequest(valid, policy).ok, true);

  for (const input of [
    { ...valid, type: "uint64" },
    { ...valid, value: Number.NaN },
    { ...valid, value: Infinity },
    { ...valid, value: -1 },
    { ...valid, value: 0.5 },
    { ...valid, selector: "" },
    { ...valid, selector: "test.c::ptr->field" },
    { ...valid, selector: "test.c::array[0]" },
    { ...valid, selector: "test.c::notAllowlisted" },
  ]) {
    assert.equal(validateSafeWriteRequest(input, policy).ok, false);
  }

  for (const selector of [
    "OsUserConfig.c::bMotorStarted",
    "AppMotorDbg.c::gstMotorDbg.fModPu",
    "AppMotorCtrl.c::gstMotorCtrl.bRunEnable",
    "TraceSignals.c::g_traceModPu",
    "TraceSignals.c::g_traceIuPu",
    "TraceSignals.c::g_traceMotorFault",
  ]) {
    assert.deepEqual(validateSafeWriteRequest({ ...valid, selector }, policy), {
      ok: false,
      error: { code: "validation_error", message: "selector is classified as dangerous" },
    });
  }
});

test("fake target memory writes, reads back, and generates analyzable response", () => {
  const backend = new FakeMemoryBackend();
  assert.deepEqual(executeSafeWrite(scratchWrite(42), policy, backend), { ok: true, readback: 42 });
  assert.deepEqual(executeSafeWrite({
    selector: "test.c::g_JlinkMcpFloatRef",
    type: "float32",
    value: 0.5,
    verify: { selector: "test.c::g_JlinkMcpFloatRef", type: "float32", operator: "eq", value: 0.5 },
    allowlistId: "fake-memory",
  }, policy, backend), { ok: true, readback: 0.5 });

  const trigger = executeSafeWrite({
    selector: "test.c::g_JlinkMcpTrigger",
    type: "uint32",
    value: 7,
    verify: { selector: "test.c::g_JlinkMcpObserved", type: "uint32", operator: "eq", value: 8 },
    allowlistId: "fake-memory",
  }, policy, backend);
  assert.deepEqual(trigger, { ok: true, readback: 8 });

  const analysis = analyzeExperiment(backend.toExperimentRecord(), "generic_state_machine");
  assert.ok(analysis.patterns.some((pattern) => pattern.type === "state_transition"));
});

test("fake write verification reports mismatch, timeout, and unknown symbol", () => {
  const backend = new FakeMemoryBackend();
  const mismatch = executeSafeWrite({ ...scratchWrite(3), verify: { selector: "test.c::g_JlinkMcpScratch", type: "uint32", operator: "eq", value: 4 } }, policy, backend);
  assert.equal(mismatch.ok, false);
  assert.equal(!mismatch.ok && mismatch.error.code, "verify_timeout");

  const unknownPolicy: WritePolicy = {
    ...policy,
    allowlists: {
      ...policy.allowlists,
      "fake-memory": [
        ...policy.allowlists["fake-memory"],
        { selector: "test.c::g_JlinkMcpMissing", type: "uint32", min: 0, max: 1 },
      ],
    },
  };
  const unknown = executeSafeWrite({
    selector: "test.c::g_JlinkMcpMissing",
    type: "uint32",
    value: 1,
    verify: { selector: "test.c::g_JlinkMcpMissing", type: "uint32", operator: "eq", value: 1 },
    allowlistId: "fake-memory",
  }, unknownPolicy, backend);
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error.code, "unknown_symbol");
});

test("HM_C095 write policy allows only guwWdgFlg offline and rejects motor observation/control writes", () => {
  assert.equal(validateSafeWriteRequest({
    selector: "guwWdgFlg",
    type: "uint16",
    value: 1,
    verify: { selector: "guwWdgFlg", type: "uint16", operator: "eq", value: 1 },
    allowlistId: "hm-c095-trace-stop-maint",
  }, policy).ok, true);
  assert.equal(validateSafeWriteRequest({
    selector: "TraceSignals.c::g_traceWdgFlg",
    type: "uint16",
    value: 2,
    max: 999,
    verify: { selector: "TraceSignals.c::g_traceWdgFlg", type: "uint16", operator: "eq", value: 2 },
    allowlistId: "hm-c095-trace-stop-maint",
  }, policy).ok, false);

  let hmValue = 0;
  const hmBackend = {
    writeSymbol(selector: string, value: number): void {
      assert.equal(selector, "TraceSignals.c::g_traceWdgFlg");
      hmValue = value;
    },
    readSymbol(selector: string): number {
      assert.equal(selector, "TraceSignals.c::g_traceWdgFlg");
      return hmValue;
    },
  };
  assert.deepEqual(executeSafeWrite({
    selector: "guwWdgFlg",
    type: "uint16",
    value: 1,
    verify: { selector: "guwWdgFlg", type: "uint16", operator: "eq", value: 1 },
    allowlistId: "hm-c095-trace-stop-maint",
  }, policy, hmBackend), { ok: true, readback: 1 });

  for (const selector of policy.dangerousSelectors) {
    const concrete = selector.endsWith(".*") ? `${selector.slice(0, -1)}fModPu` : selector;
    assert.equal(validateSafeWriteRequest({
      selector: concrete,
      type: "uint32",
      value: 0,
      verify: { selector: concrete, type: "uint32", operator: "eq", value: 0 },
      allowlistId: "hm-c095-trace-stop-maint",
    }, policy).ok, false);
  }
});

test("write validation modules stay fake-backend only", async () => {
  for (const file of [
    "src/mcp/write/write-contract.ts",
    "src/mcp/write/fake-memory-backend.ts",
    "src/mcp/write/write-verify.ts",
  ]) {
    const source = await readFile(join(process.cwd(), file), "utf8");
    const imports = source.split(/\r?\n/).filter((line) => line.startsWith("import "));
    assert.equal(imports.some((line) => /jlink|gdb|rtt|probe/i.test(line)), false);
    assert.equal(/capture_control|write_memory|halt\(|resume\(|reset\(|flash\(/i.test(source), false);
  }
});

function scratchWrite(value: number): SafeWriteRequest {
  return {
    selector: "test.c::g_JlinkMcpScratch",
    type: "uint32",
    value,
    verify: { selector: "test.c::g_JlinkMcpScratch", type: "uint32", operator: "eq", value },
    allowlistId: "fake-memory",
  };
}
