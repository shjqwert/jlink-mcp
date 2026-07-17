import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { readJcapV0Raw, rebuildJcapV0Index, writeJcapV0Raw } from "../jcap/jcap-v0";
import { runApprovalBrokerCli } from "../approval-broker";
import { executeR4Operation, unverifiedVariableWritePlan } from "../risk-operations";

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
  let cpuControlExecutions = 0;
  memory.set(0x20000000, encodeHssValues("int32", [0], "little"));
  memory.set(0x20000010 + 4, encodeHssValues("int16", [0], "little"));
  memory.set(0x20000020 + 8, encodeHssValues("int16", [0, 0, 0, 0], "little"));
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    ...testRoots(root),
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
    memoryIo: memory,
    cpuControlExecutor: async () => { cpuControlExecutions += 1; return { status: "ok" }; },
  });
  try {
    await writeProject(root);
    await writePolicy(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const start = await service.captureStart({
      device: "Z20K146M",
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    const captureId = (start.data as { captureId: string }).captureId;
    const conflict = await service.cpuControl("halt");
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error?.code, HSS_ERROR.CAPTURE_CONFLICT);
    assert.equal(conflict.error?.details.hardwareActionIssued, false);
    assert.equal(cpuControlExecutions, 0);
    const firstR4Binding = await service.r4Binding("erase", {});
    assert.equal(firstR4Binding.target.targetId, "Z20K146M");
    assert.equal(firstR4Binding.connectionGeneration, probe.getConnectionGeneration() + 1);
    assert.match(firstR4Binding.artifact.generation, /^[0-9a-f]{64}$/);
    assert.match(firstR4Binding.artifact.sha256, /^[0-9a-f]{64}$/);
    const policyFile = join(root, ".jlink-mcp", "policy.json");
    const changedPolicy = JSON.parse(await readFile(policyFile, "utf8")) as Record<string, unknown>;
    changedPolicy.requireReadback = false;
    await writeFile(policyFile, JSON.stringify(changedPolicy), "utf8");
    assert.notEqual((await service.r4Binding("erase", {})).policy.sha256, firstR4Binding.policy.sha256);
    await writePolicy(root);
    const scalarPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 120 });
    let releaseFirstWrite!: () => void;
    let firstWriteStarted!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => { firstWriteStarted = resolve; });
    const releaseFirstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    memory.beforeWrite = async (address) => {
      if (address === 0x20000000) {
        firstWriteStarted();
        await releaseFirstWriteGate;
      }
      if (address === 0x20000010 + 4) {
        const records = (await readAudit(root)).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { auditId?: string; phase?: string; queueStages?: Array<{ stage: string }> });
        const firstOutcome = records.find((record) => record.auditId === scalarPlan.data!.operationPlan.auditId && record.phase === "outcome");
        assert.ok(firstOutcome, "the first outcome audit must be fsynced before the second write enters memory I/O");
        assert.deepEqual(firstOutcome.queueStages?.map((stage) => stage.stage).filter((stage) => ["EVENT_APPEND", "AUDIT_APPEND"].includes(stage)), ["EVENT_APPEND", "AUDIT_APPEND"]);
      }
    };
    const scalarExecute = service.variableWriteExecute({ writePlanId: scalarPlan.data!.writePlanId });
    await firstWriteGate;
    const elementPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 2 }, value: 120 });
    const elementExecute = service.variableWriteExecute({ writePlanId: elementPlan.data!.writePlanId });
    releaseFirstWrite();
    const [scalarExec, elementExec] = await Promise.all([scalarExecute, elementExecute]);
    memory.beforeWrite = undefined;
    assert.equal(scalarExec.ok, true, JSON.stringify(scalarExec));
    assert.equal(scalarExec.data!.readback, 120);
    assert.deepEqual(scalarExec.data!.queueStages?.map((record) => record.stage).filter((stage) => ["PRE_READ_OLD", "WRITING", "READBACK", "EVENT_APPEND", "AUDIT_APPEND"].includes(stage)), ["PRE_READ_OLD", "WRITING", "READBACK", "EVENT_APPEND", "AUDIT_APPEND"]);
    assert.equal(elementExec.data!.readback, 120);
    const r3Plan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: "Debug_R3" }, value: 1 });
    assert.equal(r3Plan.ok, false);
    assert.equal(r3Plan.error?.code, HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE);
    assert.deepEqual([...memory.get(0x20000008, 4)], [...Buffer.alloc(4)]);
    const slicePlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, values: [100, 120, 140, 160] });
    const sliceExec = await service.variableWriteExecute({ writePlanId: slicePlan.data!.writePlanId });
    assert.deepEqual(sliceExec.data!.readbackValues, [100, 120, 140, 160]);
    assert.deepEqual([...memory.get(0x20000020 + 8, 8)], [...encodeHssValues("int16", [100, 120, 140, 160], "little")]);
    await service.captureStop({ captureId });
    const packageDir = (start.data as { packageDir: string }).packageDir;
    const raw = readJcapV0Raw(packageDir);
    assert.equal(existsSync(join(packageDir, "capture.events.jsonl")), false);
    assert.equal(existsSync(join(packageDir, "capture.flags.jsonl")), false);
    assert.equal(raw.events.filter((event) => event.type === "variable_write").length, 3);
    const query = await service.captureQuery({ captureId, mode: "event_window", eventId: scalarExec.data!.eventId, variables: ["g_hssDbgCounterFocIsr"], windowBeforeMs: 50, windowAfterMs: 50, buckets: 10 });
    assert.equal(query.ok, true);
    const exported = await service.captureExport({ captureId });
    assert.equal(exported.ok, true);
    assert.match(await readFile((exported.data as { exportFile: string }).exportFile, "utf8"), /sampleIndex,tick,statusFlags,variable,value/);
    const audit = await readAudit(root);
    assert.match(audit, /variable_write_plan/);
    assert.match(audit, /variable_write_execute/);
    assert.match(audit, /verified variable writes require an executable R2 policy entry/);
    assert.match(audit, /PRE_READ_OLD/);
    const auditRecords = audit.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { operation?: string; auditId?: string; phase?: string });
    const scalarAudit = auditRecords.filter((record) => record.operation === "variable_write_execute" && record.auditId === scalarExec.data!.auditId);
    assert.deepEqual([...new Set(scalarAudit.map((record) => record.phase))].sort(), ["intent", "outcome"]);
    assert.equal(scalarAudit.filter((record) => record.phase === "outcome").length, 1);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("MVP-B helper IPC completes scalar and fixed-array writes", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    ...testRoots(root),
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
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    const captureId = (start.data as { captureId: string }).captureId;
    const resume = await service.cpuControl("resume");
    assert.equal(resume.ok, true, JSON.stringify(resume));
    assert.equal(resume.data?.operation, "resume");
    assert.equal((resume.data?.result as Record<string, unknown>).afterState, "running");
    const plan = await service.variableWritePlan({ captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 120 });

    const execute = await service.variableWriteExecute({ writePlanId: plan.data!.writePlanId });

    assert.equal(execute.ok, true, JSON.stringify(execute));
    assert.equal(execute.data!.readback, 120);

    const elementPlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 2 }, value: 120 });
    const elementExecute = await service.variableWriteExecute({ writePlanId: elementPlan.data!.writePlanId });
    assert.equal(elementExecute.ok, true, JSON.stringify(elementExecute));
    assert.equal(elementExecute.data?.readback, 120);
    const slicePlan = await service.variableWritePlan({ captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, values: [10, 20, 30, 40] });
    const sliceExecute = await service.variableWriteExecute({ writePlanId: slicePlan.data!.writePlanId });
    assert.equal(sliceExecute.ok, true, JSON.stringify(sliceExecute));
    assert.deepEqual(sliceExecute.data?.readbackValues, [10, 20, 30, 40]);
    await service.captureStop({ captureId });
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("active write ordering has no sample-nearest or host-time fallback", () => {
  assert.equal("attachSampleIndex" in HssCaptureService.prototype, false);
});

test("outside-capture scalar writes require verified evidence or an explicit R4 exception", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const memory = new FakeMemory();
  memory.set(0x20000000, encodeHssValues("int32", [0], "little"));
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    ...testRoots(root),
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
    assert.equal(plan.ok, false, JSON.stringify(plan));
    assert.equal(plan.error?.code, HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED);

    const implicit = await service.variableWriteExecute({ target: "Debug_IqRef", type: "int32", value: 140 });
    assert.equal(implicit.ok, false);
    assert.equal(implicit.error?.code, HSS_ERROR.WRITE_PLAN_NOT_FOUND);
    assert.deepEqual([...memory.get(0x20000000, 4)], [...Buffer.alloc(4)]);

    const start = await service.captureStart({
      device: "Z20K146M",
      dllPath: dll,
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
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
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("outside-capture production path does not synthesize verified Artifact evidence", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const serial = "123456789";
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000, serialNumber: serial }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    ...testRoots(root),
    env: {},
    helperPath: process.execPath,
    helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256],
    validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeProject(root, serial);
    await writePolicy(root);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const plan = await service.variableWritePlan({ targetRef: { kind: "scalar", path: "Debug_IqRef" }, type: "int32", value: 120 });
    assert.equal(plan.ok, false, JSON.stringify(plan));
    assert.equal(plan.error?.code, HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("unverified R4 exception persists the canonical envelope and invokes only the unsupported Native command", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const captured = join(root, "r4-helper-invocation.json");
  const serial = "123456789";
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000, serialNumber: serial }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root, ...testRoots(root), env: { R4_ENVELOPE_CAPTURE: captured }, helperPath: process.execPath, helperArgsPrefix: [helper],
    validatedDllSha256: [FAKE_HSS_DLL_SHA256], validatedRuntimeIdentitySha256: [FAKE_HSS_RUNTIME_IDENTITY_SHA256],
  });
  try {
    await writeProject(root, serial);
    await writePolicy(root, true);
    await writeFakeHssDll(dll);
    await writeFile(helper, fakeHelperSource(), "utf8");
    const planned = await service.variableWritePlan({ targetRef: { kind: "scalar", path: "Debug_R3" }, type: "int32", value: 42 });
    assert.equal(planned.ok, true, JSON.stringify(planned));
    assert.equal(planned.data?.risk, "R4");
    const writePlanId = planned.data!.writePlanId;
    const binding = await service.variableWriteApprovalBinding(writePlanId);
    const challenge = unverifiedVariableWritePlan(binding);
    let token = "";
    assert.equal(await runApprovalBrokerCli([challenge.challengeId, "--user-authorized", "true"], root, (value) => { token = value; }), 0);
    const outcome = await executeR4Operation({ challengeId: challenge.challengeId, approvalToken: token, cwd: root }, {
      revalidate: () => service.variableWriteApprovalBinding(writePlanId),
      execute: (approval) => service.executeR4VariableWrite(writePlanId, approval),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? "" : outcome.error.code, "native_r4_unavailable");
    const invocation = JSON.parse(await readFile(captured, "utf8")) as { command: string; args: string[]; plan: Record<string, any> };
    assert.equal(invocation.command, "variable-write-r4");
    assert.equal(invocation.plan.schema, "jlink-mcp-r4-native-exception");
    assert.equal(invocation.plan.binding.target.artifactMatch, "unverified");
    assert.equal(invocation.plan.binding.policy.unverifiedWriteException, true);
    assert.equal(invocation.plan.approval.state, "consumed");
    assert.equal(invocation.plan.operation.writePlanId, writePlanId);
    assert.equal(invocation.plan.write.bytesHex, "2a000000");
    assert.equal(invocation.args[invocation.args.indexOf("--r4-exception-summary-sha256") + 1], invocation.plan.summarySha256);
    const persisted = JSON.stringify(invocation.plan);
    for (const forbidden of ["approvalToken", "secret", "signature", '"nonce"']) assert.equal(persisted.includes(forbidden), false);
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("variable_write_plan rejects active capture after helper exit", async () => {
  const root = await tempProject();
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, { cwd: root, ...testRoots(root) });
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
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("hss_capture_stop timeout kills helper and finalizes failed metadata", async () => {
  const root = await tempProject();
  const helper = join(root, "helper.js");
  const dll = join(root, "JLink_x64.dll");
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, {
    cwd: root,
    ...testRoots(root),
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
      symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }],
      requestedRateHz: 100,
      durationSec: 1,
    });
    assert.equal(start.ok, true, JSON.stringify(start));
    const captureId = (start.data as { captureId: string }).captureId;

    const stopped = await service.captureStop({ captureId });

    assert.equal(stopped.ok, true);
    assert.equal((stopped.data as { captureState: string }).captureState, "failed");
    assert.equal((stopped.data as { indexStatus: string }).indexStatus, "ready");
    assert.equal(probe.getExclusiveOwner(), null);
    assert.equal(readJcapV0Raw((start.data as { packageDir: string }).packageDir).events.at(-1)?.state, "failed");
  } finally {
    await service.dispose();
    probe.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  }
});

test("hss_session_recover rebuilds a missing JCAP index without changing raw", async () => {
  const root = await tempProject();
  const captureId = "11111111-1111-4111-8111-111111111111";
  const captureDir = join(testRoots(root).storageRoot, "captures", `${captureId}.jcap`);
  const probe = new JLinkBackend({ installDir: root, device: "Z20K146M", interface: "SWD", speed: 4000 }, new ProcessManager());
  const service = new HssCaptureService(probe, { cwd: root, ...testRoots(root) });
  try {
    writeJcapV0Raw({
      packageDir: captureDir,
      provenance: { captureId, backend: "jlink-hss", runtime: {}, target: {}, script: { mode: "none" } },
      samples: [{ sampleIndex: 0, tick: "0", statusFlags: HSS_STATUS_FLAGS.valid, values: { g_hssDbgCounterFocIsr: 0 } }],
      events: [
        { eventId: "11111111-1111-4111-8111-111111111110", eventSequence: 0, type: "lifecycle", tick: "0", state: "planned" },
        { eventId: "11111111-1111-4111-8111-111111111112", eventSequence: 1, type: "lifecycle", tick: "0", state: "active" },
        { eventId: "11111111-1111-4111-8111-111111111113", eventSequence: 2, type: "lifecycle", tick: "1", state: "finalizing" },
        { eventId: "11111111-1111-4111-8111-111111111114", eventSequence: 3, type: "lifecycle", tick: "1", state: "completed" },
      ],
    });
    await rebuildJcapV0Index(captureDir);
    const before = createHash("sha256").update(await readFile(join(captureDir, "raw", "samples.bin"))).digest("hex");
    await rm(join(captureDir, "capture.db"));

    const recovered = await service.sessionRecover();

    assert.equal(recovered.ok, true);
    assert.equal((recovered.data as { recovered: number }).recovered, 1);
    assert.equal((recovered.data as { sessions: Array<{ captureState: string; indexStatus: string }> }).sessions[0].indexStatus, "ready");
    assert.equal(createHash("sha256").update(await readFile(join(captureDir, "raw", "samples.bin"))).digest("hex"), before);
  } finally {
    probe.dispose();
    await rm(dirname(root), { recursive: true, force: true });
  }
});

class FakeMemory implements HssVariableMemoryIo {
  private readonly memory = new Map<number, Buffer>();
  beforeWrite?: (address: number, bytes: Buffer) => Promise<void>;
  set(address: number, bytes: Buffer): void { this.memory.set(address, Buffer.from(bytes)); }
  get(address: number, length: number): Buffer { return Buffer.from(this.memory.get(address) ?? Buffer.alloc(length)); }
  async read(address: number, length: number): Promise<Buffer> { return this.get(address, length); }
  async write(address: number, bytes: Buffer): Promise<void> { await this.beforeWrite?.(address, bytes); this.set(address, bytes); }
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

async function writeProject(root: string, serial?: string): Promise<void> {
  const exe = join(root, "Appl", "Debug", "Exe");
  const list = join(root, "Appl", "Debug", "List");
  const bsw = join(root, "Appl", "Source", "BSW", "Src");
  await mkdir(exe, { recursive: true });
  await mkdir(list, { recursive: true });
  await mkdir(join(root, "EB_Project", "config"), { recursive: true });
  await mkdir(bsw, { recursive: true });
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
    probe: { interface: "SWD", speedKhz: 4000, ...(serial ? { serial } : {}) },
    validation: { getCaps: true, lifecycle: true, decoderSemantics: true },
  }, root);
  await writeFile(join(exe, "FOC_SCM.out"), artifactElfFixture());
  await writeFile(join(list, "FOC_SCM.map"), [
    "g_hssDbgCounterFocIsr   0x2000'0100     0x4  Data  Gb  app.o [1]",
    "Debug_IqRef              0x2000'0000     0x4  Data  Gb  app.o [1]",
    "Debug_R3                 0x2000'0008     0x4  Data  Gb  app.o [1]",
    "Debug_TargetTable        0x2000'0010     0x8  Data  Gb  app.o [1]",
    "Debug_ProfileTable       0x2000'0020     0x20 Data  Gb  app.o [1]",
  ].join("\n"), "utf8");
  await Promise.all([
    writeFile(join(root, "EB_Project", "config", "Mcu.xdm"), '<d McuFOSCClockFrequency value="40000000"/>', "utf8"),
    writeFile(join(bsw, "Parcc_Drv_PBcfg.c"), "Start of PARCC_MCPWM1 clock divider (Parcc_Drv_ClockDividerType)1U\nStart of PARCC_TDG1 clock divider (Parcc_Drv_ClockDividerType)1U", "utf8"),
    writeFile(join(bsw, "Mcpwm_Pwm_Drv_PBcfg.c"), "Pwm_Drv_I1_Counter0_Cfg = { .PwmPeriod = 625U };\nPwm_Drv_Inst1_Cfg = { .ClkDiv = MCPWM_PWM_DRV_CLK_DIVIDE_1 };\nMCPWM_PWM_DRV_MODE_COMBINE_SYM_CENTER_ALIGNED", "utf8"),
    writeFile(join(bsw, "Tdg_Adc_Drv_PBcfg.c"), "DelayOutputConfig_Group1_Channel0 = { TDG_ADC_DRV_DELAY_OUTPUT_0, 1238U };\nTdg_Adc_Drv_Config_1 = { (Tdg_Adc_Drv_ClockDivideType)1U, 1241U, /* ModulateValue */ };\nTdg_Adc_Drv_GroupConfig_1 = { (boolean)FALSE };", "utf8"),
    writeFile(join(bsw, "Tmu_Drv_Cfg.c"), "TMU_DRV_INPUT_CHANNEL_MCPWM1_INIT_TRIG0, TMU_DRV_OUTPUT_CHANNEL_TDG1_TRIG_IN", "utf8"),
  ]);
}

function artifactElfFixture(): Buffer {
  const data = Buffer.alloc(0x104);
  data.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0);
  data[4] = 1;
  data[5] = 1;
  data.writeUInt32LE(52, 28);
  data.writeUInt16LE(52, 40);
  data.writeUInt16LE(32, 42);
  data.writeUInt16LE(2, 44);
  data.writeUInt32LE(1, 52);
  data.writeUInt32LE(0x100, 56);
  data.writeUInt32LE(0x08000000, 60);
  data.writeUInt32LE(0x08000000, 64);
  data.writeUInt32LE(4, 68);
  data.writeUInt32LE(4, 72);
  data.writeUInt32LE(5, 76);
  data.writeUInt32LE(4, 80);
  data.writeUInt32LE(1, 84);
  data.writeUInt32LE(0x104, 88);
  data.writeUInt32LE(0x20000000, 92);
  data.writeUInt32LE(0x20000000, 96);
  data.writeUInt32LE(0, 100);
  data.writeUInt32LE(0x1000, 104);
  data.writeUInt32LE(6, 108);
  data.writeUInt32LE(4, 112);
  data.set(Buffer.from([0x11, 0x22, 0x33, 0x44]), 0x100);
  return data;
}

async function writePolicy(root: string, r4Exception = false): Promise<void> {
  await mkdir(join(root, ".jlink-mcp"), { recursive: true });
  await writeFile(join(root, ".jlink-mcp", "policy.json"), JSON.stringify({
    version: 2,
    requireReadback: true,
    variableWriteAllowlist: [
      { path: "Debug_IqRef", kind: "scalar", type: "int32", min: -1000, max: 1000, maxWriteOps: 3 },
      { path: "Debug_R3", kind: "scalar", type: "int32", risk: r4Exception ? "R4" : "R3", ...(r4Exception ? { unverifiedTargetWriteException: true } : {}), min: -1000, max: 1000, maxWriteOps: 1 },
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
if (command === "qpc-timebase") { console.log(JSON.stringify({ status: "ok", qpcCounter: "100000", qpcFrequency: "1000000" })); process.exit(0); }
if (command === "variable-write-r4") {
  const plan = JSON.parse(fs.readFileSync(option("--plan"), "utf8"));
  if (process.env.R4_ENVELOPE_CAPTURE) fs.writeFileSync(process.env.R4_ENVELOPE_CAPTURE, JSON.stringify({ command, args: process.argv.slice(3), plan }));
  console.log(JSON.stringify({ status: "error", errorCode: "HSS_R4_NATIVE_EXCEPTION_UNSUPPORTED", reason: "fixture Native does not implement R4 exception writes", writeIssued: false, targetWritten: false }));
  process.exit(0);
}
if (command === "variable-write") {
  const bytesHex = option("--bytes-hex");
  console.log(JSON.stringify({ status: "ok", targetArtifactMatch: "verified", oldBytesHex: "00".repeat(bytesHex.length / 2), readbackBytesHex: bytesHex, operationBeforeQpcCounter: "100002", operationAfterQpcCounter: "100003", writeIssued: true, helperVersion: "1", helperProtocolVersion: 1, dllVersion: 88400, jlinkScriptMode: option("--jlink-script-mode"), jlinkScriptFile: option("--jlink-script-file"), jlinkScriptSha256: option("--approved-jlink-script-sha256"), jlinkScriptReturnCode: 0 }));
  process.exit(0);
}
const plan = JSON.parse(fs.readFileSync(option("--plan"), "utf8"));
const crypto = require("crypto");
const records = [];
function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.from(JSON.stringify({ formatVersion: 0, status: "experimental", kind: "sample", payloadEncoding: "json", payloadBytes: payload.length, payloadSha256: crypto.createHash("sha256").update(payload).digest("hex") }) + "\\n");
  return Buffer.concat([header, payload, Buffer.from("\\n")]);
}
for (let i = 0; i < Math.min(plan.requestedRateHz * plan.durationSec, 20); i++) {
  records.push(frame({ sampleIndex: i, tick: String(Math.round(i * 1000000000 / plan.requestedRateHz)), statusFlags: ${HSS_STATUS_FLAGS.valid}, values: { g_hssDbgCounterFocIsr: i * Math.max(1, Math.round(plan.postConnectExpectedRateHz / plan.requestedRateHz)) } }));
}
fs.writeFileSync(plan.outputFile, Buffer.concat(records));
console.log(JSON.stringify({ record: "lifecycle", phase: "qpc_epoch", captureId: plan.captureId, qpcCounter: "100000", qpcEpochCounter: plan.qpcEpochCounter, qpcFrequency: plan.qpcFrequency }));
console.log(JSON.stringify({ record: "artifact_match", captureId: plan.captureId, targetArtifactMatch: "verified", artifactMatch: { captureAllowed: true, fixture: "hss-mvp-b" } }));
console.log(JSON.stringify({ record: "lifecycle", phase: "hss_start", captureId: plan.captureId, qpcCounter: "100001", returnCode: 0, crashed: false }));
const memory = new Map([["536870912", "00000000"]]);
let targetWritten = false;
function handleWriteRequest() {
  if (!plan.writeRequestFile || !plan.writeResponseFile || !fs.existsSync(plan.writeRequestFile)) return;
  const request = JSON.parse(fs.readFileSync(plan.writeRequestFile, "utf8"));
  fs.rmSync(plan.writeRequestFile, { force: true });
  const address = String(Number.parseInt(String(request.address), 16));
  if (request.op === "read") {
    fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", bytesHex: memory.get(address) ?? "00".repeat(request.length) }));
    return;
  }
  if (request.op === "write") {
    memory.set(address, request.bytesHex);
    targetWritten = true;
    fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", writeIssued: true, operationBeforeQpcCounter: "100002", operationAfterQpcCounter: "100003" }));
    return;
  }
  if (request.op === "resume") {
    fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "ok", beforeState: "running", afterState: "running", resumeIssued: false, operationBeforeQpcCounter: "100002", operationAfterQpcCounter: "100003" }));
    return;
  }
  fs.writeFileSync(plan.writeResponseFile, JSON.stringify({ requestId: request.requestId, status: "error", reason: "bad op" }));
}
const timer = setInterval(handleWriteRequest, 5);
setTimeout(() => {
  clearInterval(timer);
  console.log(JSON.stringify({ record: "lifecycle", phase: "hss_stop", captureId: plan.captureId, qpcCounter: "100004", returnCode: 0, crashed: false }));
  console.log(JSON.stringify({ record: "result", status: "ok", helperVersion: "1", helperProtocolVersion: 1, dllVersion: 88400, lifecycleValidated: true, decoderSemanticsValidated: true, jlinkScriptMode: plan.jlinkScriptMode, jlinkScriptFile: plan.jlinkScriptFile, jlinkScriptSha256: plan.approvedJlinkScriptSha256, jlinkScriptReturnCode: 0, resetBeforeCapture: plan.resetBeforeCapture === true, captureId: plan.captureId, qpcEpochCounter: plan.qpcEpochCounter, qpcFrequency: plan.qpcFrequency, rawClosed: true, samplesSha256: crypto.createHash("sha256").update(fs.readFileSync(plan.outputFile)).digest("hex"), requestedRateHz: plan.requestedRateHz, actualRateHz: plan.requestedRateHz, durationSec: plan.durationSec, sampleCount: records.length, validSamples: records.length, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, readMode: plan.readMode, resumeBeforeStart: false, resumeIssued: false, targetWasHaltedBeforeResume: false, targetWasHaltedAfterResume: false, targetReset: false, targetWritten, flashIssued: false, resetIssued: false, haltIssued: false }));
}, 1000);
`;
}

async function readAudit(root: string): Promise<string> {
  const auditRoot = join(testRoots(root).evidenceRoot, "audit");
  const sessions = await import("node:fs/promises").then((fs) => fs.readdir(auditRoot));
  const chunks = await Promise.all(sessions.map((session) => readFile(join(auditRoot, session, "audit.jsonl"), "utf8").catch(() => "")));
  return chunks.join("\n");
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-mvp-b-${Date.now()}-${Math.random().toString(16).slice(2)}`, "project");
  await mkdir(root, { recursive: true });
  return root;
}

function testRoots(root: string): { storageRoot: string; evidenceRoot: string } {
  const sandbox = dirname(root);
  return { storageRoot: join(sandbox, "storage"), evidenceRoot: join(sandbox, "evidence") };
}

