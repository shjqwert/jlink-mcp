import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ProcessManager } from "../../utils/process-manager";
import { JLinkBackend } from "../../probe/jlink";
import { resolveHssRuntimeIdentity } from "../hss-dll/hss-dll-adapter";
import { cacheHssScript, hssTrustProjectIdentity, saveHssTrustProfile } from "../trust/trust-profile";
import { HssCaptureService } from "./hss-capture-service";
import { HSS_ERROR } from "./hss-errors";
import { encodeHssRecord, writeInitialMetadata } from "./hss-artifact";
import type { HssVariableMemoryIo } from "./hss-memory-io";
import { encodeHssValues } from "./hss-typed-value";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";
import type { HssVariableWriteExecuteResult } from "./hss-write-execute";

const FAKE_HSS_DLL_SHA256 = createHash("sha256").update(fakeHssDllBuffer()).digest("hex");
const FAKE_JLINK_SCRIPT_FILE = join(process.cwd(), ".tmp", "approved-hss-mvp-b.JLinkScript");
const FAKE_JLINK_SCRIPT_CONTENT = "// deterministic trusted MVP-B ScriptFile fixture\n";
const FAKE_JLINK_SCRIPT_SHA256 = createHash("sha256").update(FAKE_JLINK_SCRIPT_CONTENT).digest("hex");
const FAKE_JLINK_SCRIPT_APPROVAL_SHA256 = createHash("sha256").update(JSON.stringify({
  mode: "file",
  sha256: FAKE_JLINK_SCRIPT_SHA256,
})).digest("hex");
const FAKE_HSS_RUNTIME_IDENTITY = resolveHssRuntimeIdentity({
  selectedDllPath: "JLink_x64.dll",
  sha256: FAKE_HSS_DLL_SHA256,
}, {}, { helperPath: process.execPath, scriptIdentity: {
  mode: "file",
  path: FAKE_JLINK_SCRIPT_FILE,
  sha256: FAKE_JLINK_SCRIPT_SHA256,
  approvalSha256: FAKE_JLINK_SCRIPT_APPROVAL_SHA256,
  approvalSource: "trusted-allowlist",
  validated: true,
} }, {
  helperVersion: "1",
  helperProtocolVersion: 1,
  dllVersion: "88400",
});
const FAKE_HSS_RUNTIME_IDENTITY_SHA256 = FAKE_HSS_RUNTIME_IDENTITY.sha256!;

test("MVP-B fake/injected memoryIo covers scalar write and draft array write paths", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const memory = new FakeMemory();
  memory.set(0x20000000, encodeHssValues("int32", [0], "little"));
  memory.set(0x20000010 + 4, encodeHssValues("int16", [0], "little"));
  memory.set(0x20000020 + 8, encodeHssValues("int16", [0, 0, 0, 0], "little"));
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
    memoryIo: memory,
  });
  try {
    await writeProject(root);
    await writePolicy(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const start = await service.captureStart({
      device: "Z20K146M",
      dllPath: dll,
      symbols: [{ name: "Debug_IqRef", type: "int32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    const captureId = (start.data as { captureId: string }).captureId;
    const scalarPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 120 });
    const scalarExec = await service.variableWriteExecute({ writePlanId: scalarPlan.data!.writePlanId });
    assert.equal(scalarExec.ok, true);
    assert.equal(scalarExec.data!.readback, 120);
    assert.deepEqual(scalarExec.data!.queueStages?.map((record) => record.stage).filter((stage) => ["PRE_READ_OLD", "WRITING", "READBACK"].includes(stage)), ["PRE_READ_OLD", "WRITING", "READBACK"]);
    const r3Plan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: "Debug_R3" }, value: 1 });
    assert.equal(r3Plan.ok, true);
    assert.equal(r3Plan.data!.risk, "R3");
    assert.equal(r3Plan.data!.executable, false);
    const r3Execute = await service.variableWriteExecute({ writePlanId: r3Plan.data!.writePlanId });
    assert.equal(r3Execute.ok, false);
    assert.equal(r3Execute.error?.code, HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE);
    assert.equal(r3Execute.error?.details.operationPlanRequired, true);
    assert.deepEqual([...memory.get(0x20000008, 4)], [...Buffer.alloc(4)]);
    const elementPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 2 }, value: 120 });
    const elementExec = await service.variableWriteExecute({ writePlanId: elementPlan.data!.writePlanId });
    assert.equal(elementExec.data!.readback, 120);
    const slicePlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, values: [100, 120, 140, 160] });
    const sliceExec = await service.variableWriteExecute({ writePlanId: slicePlan.data!.writePlanId });
    assert.deepEqual(sliceExec.data!.readbackValues, [100, 120, 140, 160]);
    assert.deepEqual([...memory.get(0x20000020 + 8, 8)], [...encodeHssValues("int16", [100, 120, 140, 160], "little")]);
    await service.captureStop({ captureId });
    const metadataFile = join(root, ".jlink-mcp", "captures", captureId, "capture.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(existsSync(join(root, ".jlink-mcp", "captures", captureId, "capture.events.jsonl")), true);
    assert.equal(existsSync(join(root, ".jlink-mcp", "captures", captureId, "capture.flags.jsonl")), true);
    assert.equal(metadata.events.filter((event: { type?: string }) => event.type === "variable_write").length, 3);
    assert.ok(metadata.flagIntervals.length >= 6);
    const query = await service.captureQuery({ captureId, mode: "event_window", eventId: scalarExec.data!.eventId, windowBeforeMs: 50, windowAfterMs: 50, includeRawSamples: true, hmC095Profile: false });
    assert.equal(query.ok, true);
    assert.ok(((query.data as { eventWindow: { sampleCount: number } }).eventWindow.sampleCount) > 0);
    const exported = await service.captureExport({ captureId, eventAware: true, eventId: scalarExec.data!.eventId, windowBeforeMs: 50, windowAfterMs: 50 });
    assert.equal(exported.ok, true);
    assert.match(await readFile((exported.data as { csvFile: string }).csvFile, "utf8"), /eventMarker,eventId/);
    const audit = await readAudit(root);
    assert.match(audit, /variable_write_plan/);
    assert.match(audit, /variable_write_execute/);
    assert.match(audit, /operationPlanRequired/);
    assert.match(audit, /PRE_READ_OLD/);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("MVP-B helper IPC completes scalar writes and rejects non-scalar writes", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeProject(root);
    await writePolicy(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const start = await service.captureStart({
      device: "Z20K146M",
      dllPath: dll,
      symbols: [{ name: "Debug_IqRef", type: "int32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    const captureId = (start.data as { captureId: string }).captureId;
    const plan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 120 });

    const execute = await service.variableWriteExecute({ writePlanId: plan.data!.writePlanId });

    assert.equal(execute.ok, true);
    assert.equal(execute.data!.readback, 120);

    const elementPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 2 }, value: 120 });
    const elementExecute = await service.variableWriteExecute({ writePlanId: elementPlan.data!.writePlanId });
    assert.equal(elementExecute.ok, false);
    assert.equal(elementExecute.error?.code, HSS_ERROR.SYMBOL_KIND_UNSUPPORTED);
    await service.captureStop({ captureId });
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("active write event time is anchored to HSS sample time when host time is skewed", async () => {
  const root = await tempProject();
  try {
    const segmentFile = join(root, "capture_0001.bin");
    const records = Array.from({ length: 500 }, (_, index) => encodeHssRecord({
      sampleIndex: BigInt(index),
      timestampTicks: BigInt(index * 1_000_000),
      statusFlags: HSS_STATUS_FLAGS.valid,
      rawValues: [index],
    }, 1));
    await writeFile(segmentFile, Buffer.concat(records));
    const result = writeExecuteResult({
      hostWriteStartUs: 10_002_954_000,
      hostWriteEndUs: 10_002_955_000,
      writeStartUs: 10_002_954_000,
      writeEndUs: 10_002_955_000,
    });
    const attachSampleIndex = (HssCaptureService.prototype as unknown as {
      attachSampleIndex(active: unknown, result: HssVariableWriteExecuteResult): Promise<void>;
    }).attachSampleIndex;

    await attachSampleIndex.call({}, {
      segmentFile,
      startTimeUs: 10_000_000_000,
      plan: {
        sampling: { requestedRateHz: 1000 },
        symbols: [{ name: "Debug_IqRef", type: "int32" }],
      },
    }, result);

    assert.equal(result.sampleIndexNear, 499);
    assert.equal(result.captureWriteStartUs, 499_000);
    assert.equal(result.captureWriteEndUs, 500_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("variable_write_execute supports outside-capture scalar writes and rejects active bypass", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const memory = new FakeMemory();
  memory.set(0x20000000, encodeHssValues("int32", [0], "little"));
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
    memoryIo: memory,
  });
  try {
    await writeProject(root);
    await writePolicy(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");

    const plan = await service.variableWritePlan({ targetRef: { kind: "scalar", path: "Debug_IqRef" }, type: "int32", value: 120 });
    assert.equal(plan.ok, true);
    assert.equal(plan.data!.willEnterCaptureQueue, false);
    const executed = await service.variableWriteExecute({ writePlanId: plan.data!.writePlanId });
    assert.equal(executed.ok, true);
    assert.equal(executed.data!.readback, 120);

    const implicit = await service.variableWriteExecute({ target: "Debug_IqRef", type: "int32", value: 140 });
    assert.equal(implicit.ok, true);
    assert.equal(implicit.data!.readback, 140);
    assert.deepEqual([...memory.get(0x20000000, 4)], [...encodeHssValues("int32", [140], "little")]);

    const start = await service.captureStart({
      device: "Z20K146M",
      dllPath: dll,
      symbols: [{ name: "Debug_IqRef", type: "int32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    const bypass = await service.variableWriteExecute({ target: "Debug_IqRef", type: "int32", value: 160 });
    assert.equal(bypass.ok, false);
    assert.equal(bypass.error?.code, HSS_ERROR.ACTIVE_CAPTURE_WRITE_REQUIRES_CAPTURE_QUEUE);
    await service.captureStop({ captureId: (start.data as { captureId: string }).captureId });
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("variable_write_plan rejects active capture after helper exit", async () => {
  const root = await tempProject();
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, { cwd: root });
  try {
    const internals = service as unknown as { active: unknown };
    internals.active = {
      captureId: "exited-capture",
      helperExited: true,
    };

    const plan = await service.variableWritePlan({ captureId: "exited-capture", targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 120 });

    assert.equal(plan.ok, false);
    assert.equal(plan.error?.code, HSS_ERROR.CAPTURE_NOT_ACTIVE);
    internals.active = null;
  } finally {
    (service as unknown as { active: unknown }).active = null;
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("hss_capture_stop timeout kills helper and finalizes failed metadata", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
    stopTimeoutMs: 50,
  });
  try {
    await writeProject(root);
    await writePolicy(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const start = await service.captureStart({
      device: "Z20K146M",
      dllPath: dll,
      symbols: [{ name: "Debug_IqRef", type: "int32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    const captureId = (start.data as { captureId: string }).captureId;

    const stopped = await service.captureStop({ captureId });

    assert.equal(stopped.ok, true);
    assert.equal((stopped.data as { state: string }).state, "failed");
    assert.equal(probe.getExclusiveOwner(), null);
    const metadataFile = join(root, ".jlink-mcp", "captures", captureId, "capture.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.state, "failed");
    assert.match((metadata.failures as string[]).join("\n"), /capture stop timed out/);
    const helperEvent = (metadata.events as Array<{ type?: string; helperResult?: Record<string, unknown> }>).find((event) => event.type === "helperResult");
    assert.equal(helperEvent?.helperResult?.errorCode, HSS_ERROR.HSS_CAPTURE_STOP_TIMEOUT);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("hss_session_recover marks abandoned local capture metadata", async () => {
  const root = await tempProject();
  const captureId = "11111111-1111-4111-8111-111111111111";
  const captureDir = join(root, ".jlink-mcp", "captures", captureId);
  const metadataFile = join(captureDir, "capture.json");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, { cwd: root });
  try {
    await mkdir(captureDir, { recursive: true });
    await writeInitialMetadata({
      metadataFile,
      captureId,
      sessionName: "abandoned",
      projectRoot: root,
      artifact: { file: join(root, "FOC_SCM.out"), sha256: "0", resolver: "iar-map" },
      target: { device: "Z20K146M", interface: "SWD", speedKhz: 4000 },
      symbols: [{ name: "Debug_IqRef", type: "int32", address: "0x20000000", size: 4, source: "iar-map" }],
      requestedRateHz: 100,
    });

    const recovered = await service.sessionRecover();

    assert.equal(recovered.ok, true);
    assert.equal((recovered.data as { recovered: number }).recovered, 1);
    const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as Record<string, unknown>;
    assert.match((metadata.failures as string[]).join("\n"), /abandoned by previous process/);
    const helperEvent = (metadata.events as Array<{ helperResult?: Record<string, unknown> }>).find((event) => event.helperResult);
    assert.equal(helperEvent?.helperResult?.errorCode, HSS_ERROR.HSS_SESSION_ABANDONED);
  } finally {
    probe.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

class FakeMemory implements HssVariableMemoryIo {
  private readonly memory = new Map<number, Buffer>();
  set(address: number, bytes: Buffer): void { this.memory.set(address, Buffer.from(bytes)); }
  get(address: number, length: number): Buffer { return Buffer.from(this.memory.get(address) ?? Buffer.alloc(length)); }
  async read(address: number, length: number): Promise<Buffer> { return this.get(address, length); }
  async write(address: number, bytes: Buffer): Promise<void> { this.set(address, bytes); }
}

function writeExecuteResult(overrides: Partial<HssVariableWriteExecuteResult>): HssVariableWriteExecuteResult {
  return {
    writeId: "wr_test",
    eventId: "evt_test",
    captureId: "capture_test",
    targetRef: { kind: "scalar", path: "Debug_IqRef" },
    canonicalTarget: "Debug_IqRef",
    oldValue: 0,
    newValue: 1,
    readback: 1,
    readbackOk: true,
    mismatches: [],
    writeStartUs: 0,
    writeEndUs: 1,
    sampleIndexNear: null,
    risk: "R2",
    consumedWriteOps: 1,
    consumedElements: 1,
    ...overrides,
  };
}

async function writeFakeHssDll(file: string): Promise<void> {
  await writeFile(file, fakeHssDllBuffer());
}

function fakeHssDllBuffer(): Buffer {
  const data = Buffer.alloc(1024);
  data.write("MZ", 0, "ascii");
  data.writeUInt32LE(0x80, 0x3c);
  data.write("PE\0\0", 0x80, "ascii");
  data.writeUInt16LE(0x8664, 0x84);
  data.write("JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop", 0x100, "ascii");
  return data;
}

async function writeProject(root: string): Promise<void> {
  const exe = join(root, "Appl", "Debug", "Exe");
  const list = join(root, "Appl", "Debug", "List");
  await mkdir(exe, { recursive: true });
  await mkdir(list, { recursive: true });
  await mkdir(join(root, ".jlink-mcp"), { recursive: true });
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  await writeFile(FAKE_JLINK_SCRIPT_FILE, FAKE_JLINK_SCRIPT_CONTENT, "utf8");
  const script = cacheHssScript({ mode: "file", path: FAKE_JLINK_SCRIPT_FILE }, root);
  saveHssTrustProfile({
    version: 1,
    suiteVersion: "hss-runtime-v1",
    validatedAt: new Date(0).toISOString(),
    runtime: {
      dllPath: FAKE_HSS_RUNTIME_IDENTITY.dllPath!, dllSha256: FAKE_HSS_RUNTIME_IDENTITY.dllSha256!, dllVersion: FAKE_HSS_RUNTIME_IDENTITY.dllVersion!,
      helperPath: FAKE_HSS_RUNTIME_IDENTITY.helperPath, helperSha256: FAKE_HSS_RUNTIME_IDENTITY.helperSha256!, helperVersion: FAKE_HSS_RUNTIME_IDENTITY.helperVersion!, helperProtocolVersion: FAKE_HSS_RUNTIME_IDENTITY.helperProtocolVersion!,
      adapterPath: FAKE_HSS_RUNTIME_IDENTITY.adapterPath, adapterSha256: FAKE_HSS_RUNTIME_IDENTITY.adapterSha256!, adapterVersion: FAKE_HSS_RUNTIME_IDENTITY.adapterVersion, sha256: FAKE_HSS_RUNTIME_IDENTITY_SHA256,
    },
    script,
    project: hssTrustProjectIdentity(root),
    target: { targetId: "Z20K146M" },
    probe: { interface: "SWD", speedKhz: 4000 },
    validation: { getCaps: true, lifecycle: true, decoderSemantics: true },
  }, root);
  await writeFile(join(exe, "FOC_SCM.out"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]));
  await writeFile(join(list, "FOC_SCM.map"), [
    "Debug_IqRef              0x2000'0000     0x4  Data  Gb  app.o [1]",
    "Debug_R3                 0x2000'0008     0x4  Data  Gb  app.o [1]",
    "Debug_TargetTable        0x2000'0010     0x8  Data  Gb  app.o [1]",
    "Debug_ProfileTable       0x2000'0020     0x20 Data  Gb  app.o [1]",
  ].join("\n"), "utf8");
}

async function writePolicy(root: string): Promise<void> {
  await mkdir(join(root, ".jlink-mcp"), { recursive: true });
  await writeFile(join(root, ".jlink-mcp", "policy.json"), JSON.stringify({
    version: 2,
    requireReadback: true,
    variableWriteAllowlist: [
      { path: "Debug_IqRef", kind: "scalar", type: "int32", min: -1000, max: 1000, maxWriteOps: 3 },
      { path: "Debug_R3", kind: "scalar", type: "int32", risk: "R3", min: -1000, max: 1000, maxWriteOps: 1 },
      { path: "Debug_TargetTable", kind: "fixed_array", elementType: "int16", arrayLength: 4, allowedIndices: [2], min: -1000, max: 1000, maxWriteOps: 3 },
      { path: "Debug_ProfileTable", kind: "fixed_array", elementType: "int16", arrayLength: 16, allowedIndexRange: { start: 4, end: 7 }, min: -1000, max: 1000, allowArraySliceWrite: true, maxElementsPerWrite: 4, maxElementsTotal: 4, maxWriteOps: 3 },
    ],
  }), "utf8");
}

function fakeHelperSource(): string {
  return `
const fs = require("fs");
const command = process.argv[2];
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
if (command === "version") { console.log(JSON.stringify({ status: "ok", helperVersion: "1", helperProtocolVersion: 1 })); process.exit(0); }
if (command === "preflight") { console.log(JSON.stringify({ status: "ok", exportsFound: true, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 })); process.exit(0); }
if (command === "connect-preflight") { console.log(JSON.stringify({ status: "ok", targetWasHalted: false, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false })); process.exit(0); }
if (command === "getcaps") { console.log(JSON.stringify({ status: "ok", returnCode: 0, caps: { maxBlocks: 16, maxFreq: 1000 }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1, jlinkScriptMode: option("--jlink-script-mode"), jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0 })); process.exit(0); }
if (command === "target-state") { console.log(JSON.stringify({ status: "ok", operation: "target-state", dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1, targetWasHalted: false, targetWasHaltedRaw: 0, beforeState: "running", afterState: "running", jlinkScriptMode: option("--jlink-script-mode"), jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0, targetReset: false, targetWritten: false, flashIssued: false, resetIssued: false, haltIssued: false, resumeIssued: false })); process.exit(0); }
const plan = JSON.parse(fs.readFileSync(option("--plan"), "utf8"));
const records = [];
for (let i = 0; i < plan.requestedRateHz * plan.durationSec; i++) {
  const record = Buffer.alloc(28);
  record.writeBigUInt64LE(BigInt(i), 0);
  record.writeBigInt64LE(BigInt(Math.round(i * 1000000000 / plan.requestedRateHz)), 8);
  record.writeUInt32LE(${HSS_STATUS_FLAGS.valid}, 16);
  record.writeUInt32LE(0, 20);
  record.writeUInt32LE(i, 24);
  records.push(record);
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
const memory = new Map([["536870912", "00000000"]]);
let targetWritten = false;
function handleWriteRequest() {
  if (!plan.writeRequestFile || !plan.writeResponseFile || !fs.existsSync(plan.writeRequestFile)) return;
  const request = JSON.parse(fs.readFileSync(plan.writeRequestFile, "utf8"));
  fs.rmSync(plan.writeRequestFile, { force: true });
  const address = String(Number.parseInt(String(request.address), 16));
  if (request.op === "read") {
    fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", bytesHex: memory.get(address) ?? "00000000" }));
    return;
  }
  if (request.op === "write") {
    memory.set(address, request.bytesHex);
    targetWritten = true;
    fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", writeIssued: true }));
    return;
  }
  fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "error", reason: "bad op" }));
}
const timer = setInterval(handleWriteRequest, 5);
setTimeout(() => { clearInterval(timer); console.log(JSON.stringify({ status: "ok", helperVersion: "1", helperProtocolVersion: 1, dllVersion: 88400, lifecycleValidated: true, decoderSemanticsValidated: true, jlinkScriptMode: plan.jlinkScriptMode, jlinkScriptFile: plan.jlinkScriptFile, jlinkScriptSha256: plan.approvedJlinkScriptSha256, jlinkScriptReturnCode: 0, resetBeforeCapture: plan.resetBeforeCapture === true, captureId: plan.captureId, requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples: records.length, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, readMode: plan.readMode, resumeBeforeStart: false, resumeIssued: false, targetWasHaltedBeforeResume: false, targetWasHaltedAfterResume: false, targetReset: false, targetWritten, flashIssued: false, resetIssued: false, haltIssued: false, hssSampleHeaderBytes: 4, hssSampleStrideBytes: 8, bytesPerSample: 4, hssBlockCount: 1, readBufferBytes: 4096, firstChangedOffset: 0, firstChangedBytes: "00000000", headerChangedRatio: 1, payloadChangedRatio: 1, payloadFirstChangedOffset: 4, payloadFirstChangedBytes: "01000000" })); }, 1000);
`;
}

async function readAudit(root: string): Promise<string> {
  const auditRoot = join(root, ".jlink-mcp", "audit");
  const sessions = await import("node:fs/promises").then((fs) => fs.readdir(auditRoot));
  const chunks = await Promise.all(sessions.map((session) => readFile(join(auditRoot, session, "audit.jsonl"), "utf8").catch(() => "")));
  return chunks.join("\n");
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-mvp-b-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}

