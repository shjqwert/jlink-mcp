import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ProbeBackend,
  ProbeErrorCode,
  type CommandResult,
  type GDBServerInfo,
  type ProbeMemoryTransactionInput,
  type ProbeMemoryTransactionResult,
  type TargetStateObservation,
} from "../../probe/backend";
import { repoTempRoot } from "../preflight/temp-preflight";
import { DirectMcuService, removeFlashSnapshotDirectory, type FlashSnapshotCleanup, type MemoryWriteInput } from "./direct-operations";
import { MemorySessionError, MemorySessionManager, type MemorySessionLauncher, type MemorySessionRuntimeFacts, type PersistentMemorySession } from "./memory-session";
import { ProbeQueue } from "./probe-queue";
import { TargetStore } from "./target-store";

test("direct CPU controls are idempotent and report verified final state", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "control");
  probe.targetState = "halted";
  const noOp = await service.control("halt", projectRoot);
  assert.equal(noOp.ok, true);
  assert.deepEqual(noOp.data, { noOp: true, command: null, finalState: "halted" });
  assert.deepEqual(probe.actions, []);

  const resume = await service.control("resume", projectRoot);
  assert.equal(resume.ok, true);
  assert.equal(probe.targetState, "running");
  assert.deepEqual(probe.actions, ["resume"]);
  assert.equal(resume.after.targetState, "running");
  assert.equal(typeof resume.queueSequence, "number");
});

test("CPU controls use one persistent native session instead of the reconnecting J-Link backend", async (context) => {
  const { targets, queue, projectRoot } = await fixture(context, "control-persistent-session");
  const launcher = new PreDispatchMemorySessionLauncher();
  const sessions = new MemorySessionManager(queue, launcher, 10_000);
  let reconnectingBackendCalls = 0;
  const service = new DirectMcuService(targets, queue, async () => {
    reconnectingBackendCalls += 1;
    return { probe: new FakeProbe() };
  }, undefined, sessions);
  launcher.probe.targetState = "running";

  const halt = await service.control("halt", projectRoot);
  assert.equal(halt.ok, true);
  assert.equal(launcher.probe.targetState, "halted");
  assert.deepEqual(launcher.probe.actions, ["halt"]);

  const resume = await service.control("resume", projectRoot);
  assert.equal(resume.ok, true);
  assert.equal(launcher.probe.targetState, "running");
  assert.deepEqual(launcher.probe.actions, ["halt", "resume"]);

  const resetHalt = await service.control("reset_halt", projectRoot);
  assert.equal(resetHalt.ok, true);
  assert.equal(launcher.probe.targetState, "halted");

  const reset = await service.control("reset", projectRoot);
  assert.equal(reset.ok, true);
  assert.equal(launcher.probe.targetState, "running");
  assert.deepEqual(launcher.probe.actions, ["halt", "resume", "reset_halt", "reset"]);
  assert.equal(reconnectingBackendCalls, 0);
  await sessions.dispose();
});

test("halt fails closed when a persistent native control session is unavailable", async (context) => {
  const { probe, targets, queue, projectRoot } = await fixture(context, "control-session-unavailable");
  const sessions = new MemorySessionManager(queue, new UnavailableMemorySessionLauncher(), 10_000);
  const service = new DirectMcuService(targets, queue, async () => ({ probe }), undefined, sessions);
  probe.targetState = "running";

  const result = await service.control("halt", projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "SAME_SESSION_UNAVAILABLE");
  assert.deepEqual(probe.actions, []);
});

test("control failure preserves explicit native dispatch and target-state evidence", async (context) => {
  const first = await fixture(context, "control-failure-unissued-known");
  first.probe.targetState = "running";
  first.probe.haltResult = {
    success: false,
    rawOutput: "pre-dispatch rejection",
    output: "",
    error: "pre-dispatch rejection",
    errorCode: ProbeErrorCode.PROBE_BUSY,
    writeIssued: false,
    stateUnknown: false,
  };

  const unissued = await first.service.control("halt", first.projectRoot);
  assert.equal(unissued.ok, false);
  assert.equal(unissued.error?.writeIssued, false);
  assert.equal(unissued.error?.stateUnknown, false);

  const second = await fixture(context, "control-failure-issued-known");
  second.probe.targetState = "running";
  second.probe.haltResult = {
    success: false,
    rawOutput: "known final state mismatch",
    output: "",
    error: "known final state mismatch",
    errorCode: ProbeErrorCode.TARGET_UNREACHABLE,
    writeIssued: true,
    stateUnknown: false,
  };

  const issued = await second.service.control("halt", second.projectRoot);
  assert.equal(issued.ok, false);
  assert.equal(issued.error?.writeIssued, true);
  assert.equal(issued.error?.stateUnknown, false);
});

test("read_memory preserves running state and returns decoded bytes", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "read-memory");
  probe.targetState = "running";
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(result.ok, true);
  assert.equal((result.data as { dataHex: string }).dataHex, "11223344");
  assert.equal(result.before.targetState, "running");
  assert.equal(result.after.targetState, "running");
  assert.deepEqual(probe.actions, ["read:20000000:4"]);
  assert.deepEqual(probe.readAccessSizes, [4]);
});

test("read_memory refuses to issue a read when the initial target state is unknown", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "read-memory-before-unknown");
  probe.observations.push({ state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } });
  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(result.error?.stateUnknown, true);
  assert.deepEqual(probe.actions, []);
});

test("read_memory retains bytes but fails when the final target state is unknown", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "read-memory-after-unknown");
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
  );
  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_OPERATION_STATE_UNKNOWN");
  assert.equal(result.error?.stateUnknown, true);
  assert.equal((result.data as { dataHex: string }).dataHex, "11223344");
  assert.deepEqual(probe.actions, ["read:20000000:4"]);
});

test("read_memory retires its session after known target-state drift without marking the final state unknown", async (context) => {
  const { service, probe, targets, queue, projectRoot } = await fixture(context, "read-memory-known-drift");
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.stateUnknown, false);
  assert.equal((result.data as { dataHex: string }).dataHex, "11223344");
  assert.deepEqual((result.data as { memorySessionRetirement: unknown }).memorySessionRetirement, {
    status: "verified",
    operationTargetState: "halted",
    targetStateBeforeClose: "halted",
    targetStateAfterReconnect: "halted",
  });
  assert.equal(queue.getOwner(targets.require(projectRoot).probeSerial), undefined);

  probe.targetState = "halted";
  const resumed = await service.control("resume", projectRoot);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.error, undefined);
});

test("read_memory preserves hidden-state causality when session retirement changes the final state", async (context) => {
  const { service, probe, targets, queue, projectRoot } = await fixture(context, "read-memory-retirement-state-drift");
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
  );

  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.stateUnknown, true);
  assert.match(result.error?.message ?? "", /memory read changed target run state/);
  assert.match(result.error?.message ?? "", /target state observations disagree/);
  assert.deepEqual((result.data as { memorySessionRetirement: unknown }).memorySessionRetirement, {
    status: "state_mismatch",
    operationTargetState: "halted",
    targetStateBeforeClose: "halted",
    targetStateAfterReconnect: "running",
  });
  assert.equal(queue.getOwner(targets.require(projectRoot).probeSerial), undefined);
});

test("read_memory preserves hidden-state causality when the independent closing observation fails", async (context) => {
  const { service, probe, targets, queue, projectRoot } = await fixture(context, "read-memory-retirement-observation-failed");
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  probe.observationRejectOnCall = 4;
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );

  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.stateUnknown, true);
  assert.match(result.error?.message ?? "", /memory read changed target run state/);
  assert.match(result.error?.message ?? "", /independent final observation failed/);
  assert.equal((result.data as { memorySessionRetirement: { status: string } }).memorySessionRetirement.status, "final_observation_failed");
  assert.equal(queue.getOwner(targets.require(projectRoot).probeSerial), undefined);
});

test("read_memory fails closed and preserves an initial observation error without an operation final state", async (context) => {
  const { service, probe, targets, queue, projectRoot } = await fixture(context, "read-memory-retirement-initial-observation-failed");
  probe.observationRejectOnCall = 1;

  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "MEMORY_SESSION_RETIREMENT_UNCONFIRMED");
  assert.equal(result.error?.stateUnknown, true);
  assert.match(result.error?.message ?? "", /observation transport rejected/);
  assert.match(result.error?.message ?? "", /target state remained unknown/);
  assert.deepEqual((result.data as { memorySessionRetirement: unknown }).memorySessionRetirement, {
    status: "state_unknown",
    operationTargetState: undefined,
    targetStateBeforeClose: "running",
    targetStateAfterReconnect: "running",
  });
  assert.equal(queue.getOwner(targets.require(projectRoot).probeSerial), undefined);
});

test("read_memory preserves an explicit unknown operation final state during session retirement", async (context) => {
  const { service, probe, targets, queue, projectRoot } = await fixture(context, "read-memory-retirement-explicit-unknown");
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
  );

  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_OPERATION_STATE_UNKNOWN");
  assert.equal(result.error?.stateUnknown, true);
  assert.match(result.error?.message ?? "", /target state remained unknown/);
  assert.equal((result.data as { memorySessionRetirement: { status: string; operationTargetState?: string } }).memorySessionRetirement.status, "state_unknown");
  assert.equal((result.data as { memorySessionRetirement: { operationTargetState?: string } }).memorySessionRetirement.operationTargetState, "unknown");
  assert.equal(queue.getOwner(targets.require(projectRoot).probeSerial), undefined);
});

test("read_memory fails closed when closeForTarget cannot confirm a session", async (context) => {
  const { probe, targets, queue, projectRoot } = await fixture(context, "read-memory-retirement-close-undefined");
  probe.readResult = {
    success: false,
    rawOutput: "transport failed",
    output: "",
    error: "transport failed",
    errorCode: ProbeErrorCode.TARGET_UNREACHABLE,
  };
  const sessions = {
    localOwnerForTarget: () => undefined,
    probeFor: async () => probe,
    closeForTarget: async () => undefined,
  } as unknown as MemorySessionManager;
  const service = new DirectMcuService(targets, queue, async () => ({ probe }), undefined, sessions, false);

  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(result.error?.stateUnknown, true);
  assert.match(result.error?.message ?? "", /transport failed/);
  assert.match(result.error?.message ?? "", /close did not confirm/);
  assert.equal((result.data as { memorySessionRetirement: { status: string } }).memorySessionRetirement.status, "close_unconfirmed");
});

test("read_memory retains its owner fail-closed when session retirement cannot confirm helper exit", async (context) => {
  const root = testDirectory(context, "read-memory-unconfirmed-retirement");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const targets = new TargetStore(join(root, "state"));
  const target = await targets.configure({ projectRoot, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000 });
  const queue = new ProbeQueue(join(root, "queue"));
  const probe = new FakeProbe();
  const session = new PreDispatchMemorySession(probe);
  session.closeError = new MemorySessionError(
    "MEMORY_SESSION_CLOSE_UNCONFIRMED",
    "native memory helper did not exit after close",
    true,
    true,
    true,
    session.pid,
  );
  const launcher: MemorySessionLauncher = {
    async open(_target, onStarted) {
      onStarted?.(session.pid, session.runtime);
      return session;
    },
  };
  const sessions = new MemorySessionManager(queue, launcher, 10_000);
  context.after(async () => {
    session.closeError = undefined;
    await sessions.dispose();
  });
  const service = new DirectMcuService(targets, queue, async () => ({ probe }), undefined, sessions);
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  probe.readResult = {
    success: false,
    rawOutput: "transport failed",
    output: "",
    error: "transport failed",
    errorCode: ProbeErrorCode.TARGET_UNREACHABLE,
  };
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
  );

  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(result.error?.stateUnknown, true);
  assert.match(result.error?.message ?? "", /transport failed/);
  assert.match(result.error?.message ?? "", /native memory helper did not exit after close/);
  assert.equal((result.data as { memorySessionRetirement: { status: string } }).memorySessionRetirement.status, "close_failed");
  assert.equal(queue.getOwner(target.probeSerial)?.kind, "memory");
});

test("failed read_memory preserves failure and final-state evidence", async (context) => {
  const drift = await fixture(context, "read-memory-failed-drift");
  drift.probe.readResult = { success: false, rawOutput: "transport failed", output: "", error: "transport failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE };
  drift.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const driftResult = await drift.service.readMemory({ projectRoot: drift.projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(driftResult.ok, false);
  assert.equal(driftResult.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(driftResult.error?.stateUnknown, false);
  assert.equal((driftResult.data as { command: { errorCode: string } }).command.errorCode, ProbeErrorCode.TARGET_UNREACHABLE);

  const unknown = await fixture(context, "read-memory-failed-unknown");
  unknown.probe.readResult = { success: false, rawOutput: "transport failed", output: "", error: "transport failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE };
  unknown.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
  );
  const unknownResult = await unknown.service.readMemory({ projectRoot: unknown.projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.error?.code, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(unknownResult.error?.stateUnknown, true);
  assert.equal(unknownResult.after.targetState, "unknown");

  const rejected = await fixture(context, "read-memory-backend-reject");
  rejected.probe.readMemoryReject = new Error("backend rejected");
  const rejectedResult = await rejected.service.readMemory({ projectRoot: rejected.projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(rejectedResult.ok, false);
  assert.equal(rejectedResult.error?.code, "PROBE_COMMAND_REJECTED");
  assert.equal(rejectedResult.error?.stateUnknown, false);
  assert.equal(rejectedResult.after.targetState, "running");
});

test("read_memory decodes realistic J-Link mem16 and mem32 words as little-endian bytes", async (context) => {
  const sixteen = await fixture(context, "read-mem16");
  sixteen.probe.readResult = { success: true, rawOutput: "20000000 = 2211 4433", output: "" };
  const result16 = await sixteen.service.readMemory({ projectRoot: sixteen.projectRoot, address: 0x20000000, width: 16, byteCount: 4 });
  assert.equal(result16.ok, true);
  assert.equal((result16.data as { dataHex: string }).dataHex, "11223344");

  const thirtyTwo = await fixture(context, "read-mem32");
  thirtyTwo.probe.readResult = { success: true, rawOutput: "20000000 = 44332211", output: "" };
  const result32 = await thirtyTwo.service.readMemory({ projectRoot: thirtyTwo.projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(result32.ok, true);
  assert.equal((result32.data as { dataHex: string }).dataHex, "11223344");
});

test("core-register access reports HALT_REQUIRED before issuing any register command", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "halt-required");
  probe.targetState = "running";
  const result = await service.readCoreRegister(projectRoot, "PC");
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HALT_REQUIRED");
  assert.deepEqual(probe.actions, []);
  assert.equal(probe.targetState, "running");

  const all = await service.readCoreRegisters(projectRoot);
  assert.equal(all.ok, false);
  assert.equal(all.error?.code, "HALT_REQUIRED");
  assert.deepEqual(probe.actions, []);

  const write = await service.writeCoreRegister({ projectRoot, name: "PC", value: 0x2000 });
  assert.equal(write.ok, false);
  assert.equal(write.error?.code, "HALT_REQUIRED");
  assert.equal(write.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
});

test("diagnose_crash collects Cortex-M fault and validated exception-frame evidence without changing state", async (context) => {
  const { service, probe, projectRoot, targets } = await fixture(context, "diagnose-crash");
  await targets.configure({
    projectRoot,
    device: "TEST",
    probeSerial: "123456",
    interface: "SWD",
    speed: 1000,
    memoryRegions: [{ start: 0x20000000, length: 0x1000, kind: "ram", writable: true }],
  });
  probe.targetState = "halted";
  probe.registersReadResult = { success: true, rawOutput: "PC = 08000100, LR = FFFFFFFD, MSP = 20000020, PSP = 20000020", output: "" };
  const fault = Buffer.alloc(60);
  fault.writeUInt32LE(0x00008200, 36); // CFSR: precise bus fault + valid BFAR.
  fault.writeUInt32LE(0x08000100, 52);
  probe.memory.set(0xe000ed04, fault);
  const frame = Buffer.alloc(32);
  frame.writeUInt32LE(0x08000104, 24);
  frame.writeUInt32LE(0x01000000, 28);
  probe.memory.set(0x20000020, frame);

  const result = await service.diagnoseCrash(projectRoot);

  assert.equal(result.ok, true);
  assert.equal(result.before.targetState, "halted");
  assert.equal(result.after.targetState, "halted");
  const data = result.data as {
    coreRegisters: { registers: Record<string, string> };
    faultRegisters: { raw: Record<string, string>; decoded: { cfsrHfsr: string } };
    frame: { status: string; stacked?: Record<string, string> };
  };
  assert.equal(data.coreRegisters.registers.PC, "0x08000100");
  assert.equal(data.faultRegisters.raw.CFSR, "0x00008200");
  assert.equal(data.faultRegisters.raw.BFAR, "0x08000100");
  assert.match(data.faultRegisters.decoded.cfsrHfsr, /PRECISERR/);
  assert.equal(data.frame.status, "verified");
  assert.equal(data.frame.stacked?.pc, "0x08000104");
  assert.deepEqual(probe.actions, ["read-registers", "read:e000ed04:60", "read:20000020:32"]);
});

test("diagnose_crash refuses a running target without issuing reads", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "diagnose-crash-running");
  probe.targetState = "running";

  const result = await service.diagnoseCrash(projectRoot);

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HALT_REQUIRED");
  assert.deepEqual(probe.actions, []);
  assert.equal(probe.targetState, "running");
});

test("failed core-register reads preserve command failure and final-state evidence", async (context) => {
  const drift = await fixture(context, "core-read-failed-drift");
  drift.probe.registerReadResult = { success: false, rawOutput: "transport failed", output: "", error: "transport failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE };
  drift.probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
  );
  const driftResult = await drift.service.readCoreRegister(drift.projectRoot, "PC");
  assert.equal(driftResult.ok, false);
  assert.equal(driftResult.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(driftResult.error?.stateUnknown, false);
  assert.equal((driftResult.data as { command: { errorCode: string } }).command.errorCode, ProbeErrorCode.TARGET_UNREACHABLE);

  const unknown = await fixture(context, "core-reads-failed-unknown");
  unknown.probe.registersReadResult = { success: false, rawOutput: "transport failed", output: "", error: "transport failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE };
  unknown.probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
  );
  const unknownResult = await unknown.service.readCoreRegisters(unknown.projectRoot);
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.error?.code, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(unknownResult.error?.stateUnknown, true);
  assert.equal(unknownResult.after.targetState, "unknown");

  const rejected = await fixture(context, "core-read-backend-reject");
  rejected.probe.registerReadReject = new Error("backend rejected");
  rejected.probe.targetState = "halted";
  const rejectedResult = await rejected.service.readCoreRegister(rejected.projectRoot, "PC");
  assert.equal(rejectedResult.ok, false);
  assert.equal(rejectedResult.error?.code, "PROBE_COMMAND_REJECTED");
  assert.equal(rejectedResult.error?.stateUnknown, false);
  assert.equal(rejectedResult.after.targetState, "halted");

  const observationRejected = await fixture(context, "core-reads-observation-reject");
  observationRejected.probe.registersReadResult = { success: false, rawOutput: "transport failed", output: "", error: "transport failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE };
  observationRejected.probe.targetState = "halted";
  observationRejected.probe.observationRejectOnCall = 2;
  const observationRejectedResult = await observationRejected.service.readCoreRegisters(observationRejected.projectRoot);
  assert.equal(observationRejectedResult.ok, false);
  assert.equal(observationRejectedResult.error?.code, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(observationRejectedResult.error?.stateUnknown, true);
});

test("write_core_register fails when the target no longer remains halted", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "core-write-hidden-state-change");
  probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
  );
  const result = await service.writeCoreRegister({ projectRoot, name: "PC", value: 0x2000 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, false);
  assert.ok(probe.actions.includes("write-register:PC:8192"));
});

test("write_memory refuses an unconfigured region before issuing a write", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "write-defaults");
  const result = await service.writeMemory({ projectRoot, address: 0x10000000, width: 32, byteCount: 4, dataHex: "78563412", knownRegion: "ram" } as MemoryWriteInput & { knownRegion: "ram" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "MEMORY_REGION_NOT_VERIFIED");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
});

test("write_memory refuses an unknown initial state and fails on target-state drift", async (context) => {
  const unknown = await fixture(context, "write-before-unknown");
  unknown.probe.observations.push({ state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } });
  const refused = await unknown.service.writeMemory({ projectRoot: unknown.projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(refused.error?.writeIssued, false);
  assert.deepEqual(unknown.probe.actions, []);

  const changed = await fixture(context, "write-hidden-state-change");
  changed.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const result = await changed.service.writeMemory({ projectRoot: changed.projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, false);
  assert.equal((result.data as { requestedHex: string }).requestedHex, "01020304");
});

test("write_memory performs explicit exact readback only when requested", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "write-verify");
  probe.memory.set(0x20000000, Buffer.from([0, 0, 0, 0]));
  const result = await service.writeMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304", captureOld: true, verify: true });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(probe.actions, ["read:20000000:4", "write:20000000:4:4", "read:20000000:4"]);
  assert.equal((result.data as { oldHex: string }).oldHex, "00000000");
  assert.equal((result.data as { readbackHex: string }).readbackHex, "01020304");
});

test("write_memory consumes one-connection Probe transaction evidence", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "write-probe-transaction");
  const old = Buffer.from("00000000", "hex");
  const requested = Buffer.from("01020304", "hex");
  probe.memory.set(0x20000000, requested);
  probe.transactionResult = {
    command: { ...ok(), writeIssued: true, stateUnknown: false },
    oldBytes: old,
    readbacks: [requested],
    readbackObservedAt: ["2026-07-19T00:00:00.005Z"],
    verificationStartedAt: "2026-07-19T00:00:00.000Z",
    verificationEndedAt: "2026-07-19T00:00:00.010Z",
    restoreIssued: false,
    restoreVerified: false,
    targetStateBefore: "running",
    targetStateAfter: "running",
  };
  const result = await service.writeMemory({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: requested.toString("hex"),
    captureOld: true,
    verify: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(probe.actions, ["transaction:20000000:4:1:0:0:false", "read:20000000:4"]);
  assert.equal(probe.transactionInput?.captureOld, true);
  assert.equal(probe.transactionInput?.verifyDurationMs, 0);
  const data = result.data as { oldHex: string; requestedHex: string; readbackHex: string };
  assert.equal(data.oldHex, old.toString("hex"));
  assert.equal(data.requestedHex, requested.toString("hex"));
  assert.equal(data.readbackHex, requested.toString("hex"));
});

test("write_memory rejects a same-connection readback that does not persist", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "write-probe-post-connection-mismatch");
  const old = Buffer.from("00000000", "hex");
  const requested = Buffer.from("01020304", "hex");
  probe.memory.set(0x20000000, old);
  probe.transactionResult = {
    command: { ...ok(), writeIssued: true, stateUnknown: false },
    oldBytes: old,
    readbacks: [requested],
    restoreIssued: false,
    restoreVerified: false,
    targetStateBefore: "running",
    targetStateAfter: "running",
  };
  const result = await service.writeMemory({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: requested.toString("hex"),
    captureOld: true,
    verify: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "READBACK_MISMATCH");
  const data = result.data as { readbackHex: string; transactionReadbackHex: string };
  assert.equal(data.transactionReadbackHex, requested.toString("hex"));
  assert.equal(data.readbackHex, old.toString("hex"));
  assert.deepEqual(probe.actions, ["transaction:20000000:4:1:0:0:false", "read:20000000:4"]);
});

test("readback mismatch retains the actual memory and core-register values", async (context) => {
  const memory = await fixture(context, "memory-readback-mismatch");
  memory.probe.readResult = { success: true, rawOutput: "20000000 = 04030200", output: "" };
  const memoryResult = await memory.service.writeMemory({ projectRoot: memory.projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304", verify: true });
  assert.equal(memoryResult.ok, false);
  assert.equal(memoryResult.error?.code, "READBACK_MISMATCH");
  assert.equal((memoryResult.data as { readbackHex: string }).readbackHex, "00020304");
  assert.equal(memoryResult.after.targetState, "running");

  const register = await fixture(context, "register-readback-mismatch");
  register.probe.targetState = "halted";
  const registerResult = await register.service.writeCoreRegister({ projectRoot: register.projectRoot, name: "PC", value: 0x2000, verify: true });
  assert.equal(registerResult.ok, false);
  assert.equal(registerResult.error?.code, "READBACK_MISMATCH");
  assert.equal((registerResult.data as { readback: number }).readback, 0x1000);
  assert.equal(registerResult.after.targetState, "halted");
});

test("post-write readback decode failures retain issued and unknown-state facts", async (context) => {
  const memory = await fixture(context, "memory-readback-decode");
  const artifactPath = join(memory.projectRoot, "firmware.elf");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const prior = memory.targets.require(memory.projectRoot);
  const configured = await memory.targets.configure({
    projectRoot: memory.projectRoot,
    device: prior.device,
    probeSerial: prior.probeSerial,
    interface: prior.interface,
    speed: prior.speed,
    artifactPath,
    memoryRegions: [{ start: 0x20000000, length: 0x1000, kind: "ram", writable: true }],
  });
  await memory.targets.setArtifactMatch(memory.projectRoot, "verified", "test_verified", {
    targetGeneration: configured.generation,
    probeSerial: configured.probeSerial,
    artifactGeneration: configured.artifact?.generation,
  });
  memory.probe.readResult = { success: true, rawOutput: "not a memory dump", output: "" };
  const memoryResult = await memory.service.writeMemory({ projectRoot: memory.projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304", verify: true });
  assert.equal(memoryResult.ok, false);
  assert.equal(memoryResult.error?.code, "READ_LENGTH_MISMATCH");
  assert.equal(memoryResult.error?.writeIssued, true);
  assert.equal(memoryResult.error?.stateUnknown, true);
  assert.equal(memoryResult.after.targetState, "running");
  assert.equal(memory.targets.require(memory.projectRoot).liveArtifactMatch.source, "test_verified");

  const register = await fixture(context, "register-readback-decode");
  register.probe.targetState = "halted";
  register.probe.registerReadResult = { success: true, rawOutput: "no register value", output: "" };
  const registerResult = await register.service.writeCoreRegister({ projectRoot: register.projectRoot, name: "PC", value: 0x2000, verify: true });
  assert.equal(registerResult.ok, false);
  assert.equal(registerResult.error?.code, "REGISTER_DECODE_FAILED");
  assert.equal(registerResult.error?.writeIssued, true);
  assert.equal(registerResult.error?.stateUnknown, true);
  assert.equal(registerResult.after.targetState, "halted");
});

test("mutating backend rejection is reported as an issued uncertain outcome", async (context) => {
  const memory = await fixture(context, "memory-backend-reject");
  memory.probe.writeMemoryReject = new Error("transport rejected");
  const memoryResult = await memory.service.writeMemory({ projectRoot: memory.projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304" });
  assert.equal(memoryResult.ok, false);
  assert.equal(memoryResult.error?.code, "PROBE_COMMAND_REJECTED");
  assert.equal(memoryResult.error?.writeIssued, true);
  assert.equal(memoryResult.error?.stateUnknown, true);

  const register = await fixture(context, "register-backend-reject");
  register.probe.targetState = "halted";
  register.probe.writeRegisterReject = new Error("transport rejected");
  const registerResult = await register.service.writeCoreRegister({ projectRoot: register.projectRoot, name: "PC", value: 0x2000 });
  assert.equal(registerResult.ok, false);
  assert.equal(registerResult.error?.code, "PROBE_COMMAND_REJECTED");
  assert.equal(registerResult.error?.writeIssued, true);
  assert.equal(registerResult.error?.stateUnknown, true);
});

test("write_memory honors explicit Native write dispatch evidence", async (context) => {
  const early = await fixture(context, "memory-write-not-issued");
  early.probe.writeMemoryResult = { success: false, rawOutput: "", output: "", error: "identity rejected", errorCode: ProbeErrorCode.PROBE_IDENTITY_MISMATCH, writeIssued: false };
  const earlyResult = await early.service.writeMemory({ projectRoot: early.projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304" });
  assert.equal(earlyResult.ok, false);
  assert.equal(earlyResult.error?.writeIssued, false);
  assert.equal(earlyResult.error?.stateUnknown, false);

  const dispatched = await fixture(context, "memory-write-issued-failure");
  dispatched.probe.writeMemoryResult = { success: false, rawOutput: "", output: "", error: "write API failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE, writeIssued: true };
  const dispatchedResult = await dispatched.service.writeMemory({ projectRoot: dispatched.projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304" });
  assert.equal(dispatchedResult.ok, false);
  assert.equal(dispatchedResult.error?.writeIssued, true);
  assert.equal(dispatchedResult.error?.stateUnknown, true);
});

test("post-mutation observation rejection remains an issued uncertain failure", async (context) => {
  const control = await fixture(context, "control-observe-reject");
  const artifactPath = join(control.projectRoot, "firmware.elf");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const previous = control.targets.require(control.projectRoot);
  const configured = await control.targets.configure({
    projectRoot: control.projectRoot,
    device: previous.device,
    probeSerial: previous.probeSerial,
    interface: previous.interface,
    speed: previous.speed,
    artifactPath,
  });
  await control.targets.setArtifactMatch(control.projectRoot, "verified", "test_verified", {
    targetGeneration: configured.generation,
    probeSerial: configured.probeSerial,
    artifactGeneration: configured.artifact?.generation,
  });
  control.probe.observationRejectOnCall = 2;
  const controlResult = await control.service.control("halt", control.projectRoot);
  assert.equal(controlResult.error?.code, "PROBE_COMMAND_REJECTED");
  assert.equal(controlResult.error?.writeIssued, true);
  assert.equal(controlResult.error?.stateUnknown, true);
  assert.equal((controlResult.data as { command: { success: boolean } }).command.success, true);
  assert.equal(control.targets.require(control.projectRoot).liveArtifactMatch.status, "unverified");
  assert.equal(control.targets.require(control.projectRoot).liveArtifactMatch.source, "post_operation_observation_failed");

  const flash = await fixture(context, "flash-observe-reject");
  writeFileSync(join(flash.projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  flash.probe.observationRejectOnCall = 2;
  const flashResult = await flash.service.flash({ projectRoot: flash.projectRoot, path: "image.bin", baseAddress: 0x08000000 });
  assert.equal(flashResult.error?.code, "POST_FLASH_STATE_OBSERVATION_FAILED");
  assert.equal(flashResult.error?.writeIssued, true);
  assert.equal(flashResult.error?.stateUnknown, false);
  assert.equal((flashResult.data as { command: { success: boolean } }).command.success, true);

  const erase = await fixture(context, "erase-observe-reject");
  erase.probe.observationRejectOnCall = 2;
  const eraseResult = await erase.service.erase({ projectRoot: erase.projectRoot });
  assert.equal(eraseResult.error?.writeIssued, true);
  assert.equal(eraseResult.error?.stateUnknown, true);
  assert.equal((eraseResult.data as { command: { success: boolean } }).command.success, true);

  const raw = await fixture(context, "raw-observe-reject");
  raw.probe.observationRejectOnCall = 2;
  const rawResult = await raw.service.probeCommand({ projectRoot: raw.projectRoot, commands: ["w4 0x20000000, 1"] });
  assert.equal(rawResult.error?.writeIssued, true);
  assert.equal(rawResult.error?.stateUnknown, true);
  assert.equal((rawResult.data as { command: { success: boolean } }).command.success, true);
});

test("flash rejects raw BIN without baseAddress before hardware issue", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "flash-bin");
  writeFileSync(join(projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  const result = await service.flash({ projectRoot, path: "image.bin" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "BASE_ADDRESS_REQUIRED");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
});

test("flash snapshots its immutable execution input under the repo-local temp root", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "flash-repo-temp");
  const imagePath = join(projectRoot, "image.bin");
  writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));

  const result = await service.flash({ projectRoot, path: imagePath, baseAddress: 0x08000000 });

  assert.equal(result.ok, true);
  assert.equal(probe.flashPaths.length, 1);
  assert.ok(probe.flashPaths[0].startsWith(join(repoTempRoot(), "flash-")));
  assert.notEqual(probe.flashPaths[0], imagePath);
});

test("flash snapshot cleanup retries transient sharing violations and returns persistent failures", async () => {
  let attempts = 0;
  const transient = await removeFlashSnapshotDirectory("ignored", {
    retryDelaysMs: [0, 0],
    remove: () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
    },
  });
  assert.equal(transient, undefined);
  assert.equal(attempts, 3);

  attempts = 0;
  const persistent = await removeFlashSnapshotDirectory("ignored", {
    retryDelaysMs: [0, 0],
    remove: () => {
      attempts += 1;
      throw Object.assign(new Error("still shared"), { code: "EPERM" });
    },
  });
  assert.equal((persistent as NodeJS.ErrnoException).code, "EPERM");
  assert.equal(attempts, 3);
});

test("flash cleanup failure cannot replace a verified hardware result", async (context) => {
  const cleanup: FlashSnapshotCleanup = async (snapshotRoot) => {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw Object.assign(new Error("simulated cleanup sharing violation"), { code: "EPERM" });
  };
  const { service, probe, projectRoot } = await fixture(context, "flash-cleanup-warning", cleanup);
  const imagePath = join(projectRoot, "image.bin");
  writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));

  const result = await service.flash({ projectRoot, path: imagePath, baseAddress: 0x08000000 });

  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(result.observedEffects, ["reset", "halt", "flash_program_issued", "vendor_verification_succeeded", "vendor_target_state_change:running->halted"]);
  assert.deepEqual(result.requestedEffects, ["reset", "halt", "program_flash", "vendor_verify"]);
  assert.match(result.warnings.join("\n"), /cleanup failed.*hardware result remains authoritative/i);
  assert.equal(probe.flashPaths.length, 1);
});

test("flash reports vendor target-state changes without resuming a previously running target", async (context) => {
  const unknown = await fixture(context, "flash-before-unknown");
  writeFileSync(join(unknown.projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  unknown.probe.observations.push({ state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } });
  const observedUnknown = await unknown.service.flash({ projectRoot: unknown.projectRoot, path: "image.bin", baseAddress: 0x08000000 });
  assert.equal(observedUnknown.ok, true);
  assert.ok(observedUnknown.observedEffects.includes("vendor_target_state_change:unknown->halted"));
  assert.equal(unknown.probe.actions.length, 1);

  const changed = await fixture(context, "flash-hidden-state-change");
  writeFileSync(join(changed.projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  changed.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const result = await changed.service.flash({ projectRoot: changed.projectRoot, path: "image.bin", baseAddress: 0x08000000 });
  assert.equal(result.ok, true);
  assert.ok(result.observedEffects.includes("vendor_target_state_change:running->halted"));
  assert.equal(result.verification.status, "verified");
  assert.equal((result.data as { command: { success: boolean } }).command.success, true);
});

test("flash restores a previously halted target after the vendor tool resumes it", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "flash-restore-halted");
  writeFileSync(join(projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );

  const result = await service.flash({ projectRoot, path: "image.bin", baseAddress: 0x08000000 });

  assert.equal(result.ok, true);
  assert.deepEqual(probe.actions.filter((action) => action === "halt"), ["halt"]);
  assert.equal((result.after as { targetState: string }).targetState, "halted");
  assert.ok(result.observedEffects.includes("vendor_target_state_change:halted->running"));
  assert.ok(result.observedEffects.includes("post_flash_halt_restored"));
});

test("flash attempts halt after a post-Flash observation failure and reports the recovered final state", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "flash-observation-failure-restore");
  writeFileSync(join(projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  probe.targetState = "halted";
  probe.observationRejectOnCall = 2;

  const result = await service.flash({ projectRoot, path: "image.bin", baseAddress: 0x08000000 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_FLASH_STATE_OBSERVATION_FAILED");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, false);
  assert.deepEqual(probe.actions.filter((action) => action === "halt"), ["halt"]);
  assert.equal((result.after as { targetState: string }).targetState, "halted");
});

test("flash restores a previously halted target when the first post-Flash state is unknown", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "flash-unknown-state-restore");
  writeFileSync(join(projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
    { state: "halted", source: "dhcsr", result: ok() },
  );

  const result = await service.flash({ projectRoot, path: "image.bin", baseAddress: 0x08000000 });

  assert.equal(result.ok, true);
  assert.equal((result.after as { targetState: string }).targetState, "halted");
  assert.ok(result.observedEffects.includes("vendor_target_state_change:halted->unknown"));
  assert.ok(result.observedEffects.includes("post_flash_halt_restored"));
});

test("flash reports a failed halt restoration without discarding vendor verification", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "flash-halt-restore-failed");
  const artifactPath = join(projectRoot, "firmware.elf");
  const imagePath = join(projectRoot, "image.bin");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
  const previous = targets.require(projectRoot);
  await targets.configure({
    projectRoot,
    device: previous.device,
    probeSerial: previous.probeSerial,
    interface: previous.interface,
    speed: previous.speed,
    artifactPath,
    artifactFlashImages: [{ path: imagePath, baseAddress: 0x08000000 }],
  });
  probe.haltResult = { success: false, rawOutput: "halt failed", output: "halt failed", error: "halt failed" };
  probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
  );

  const result = await service.flash({ projectRoot, path: imagePath, baseAddress: 0x08000000 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_FLASH_HALT_FAILED");
  assert.equal(result.error?.stateUnknown, false);
  assert.equal((result.after as { targetState: string }).targetState, "running");
  assert.equal(targets.require(projectRoot).liveArtifactMatch.status, "verified");
});

test("flash observes the final state after a post-Flash halt throws", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "flash-halt-throws");
  writeFileSync(join(projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  probe.haltReject = new Error("halt transport rejected");
  probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
  );

  const result = await service.flash({ projectRoot, path: "image.bin", baseAddress: 0x08000000 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_FLASH_HALT_FAILED");
  assert.equal(result.error?.stateUnknown, true);
  assert.equal(probe.observationCalls, 3);
  assert.equal((result.after as { targetState: string }).targetState, "unknown");
});

test("flash marks state unknown when final observation throws after a successful halt", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "flash-final-observation-throws");
  const artifactPath = join(projectRoot, "firmware.elf");
  const imagePath = join(projectRoot, "image.bin");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
  const previous = targets.require(projectRoot);
  await targets.configure({
    projectRoot,
    device: previous.device,
    probeSerial: previous.probeSerial,
    interface: previous.interface,
    speed: previous.speed,
    artifactPath,
    artifactFlashImages: [{ path: imagePath, baseAddress: 0x08000000 }],
  });
  probe.targetState = "halted";
  probe.observationRejectOnCall = 3;
  probe.observations.push(
    { state: "halted", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
  );

  const result = await service.flash({ projectRoot, path: imagePath, baseAddress: 0x08000000 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_FLASH_FINAL_STATE_UNCONFIRMED");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, true);
  assert.equal((result.after as { targetState: string }).targetState, "unknown");
  assert.equal(targets.require(projectRoot).liveArtifactMatch.status, "verified");
});

test("flash revalidates its input inside the Probe lease", async (context) => {
  const { service, probe, targets, queue, projectRoot } = await fixture(context, "flash-toctou");
  const imagePath = join(projectRoot, "image.bin");
  writeFileSync(imagePath, Buffer.from([1, 2, 3, 4]));
  const target = targets.require(projectRoot);
  let releaseBlocker!: () => void;
  let blockerStarted!: () => void;
  const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const blocker = queue.runExclusive(target.probeSerial, async () => { blockerStarted(); await blocked; });
  await started;
  const pending = service.flash({ projectRoot, path: imagePath, baseAddress: 0x08000000 });
  writeFileSync(imagePath, Buffer.from([4, 3, 2, 1]));
  releaseBlocker();
  await blocker;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "FLASH_INPUT_CHANGED");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
});

test("erase with unsupported blank verification is rejected before erase", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "erase-verify");
  const rejected = await service.erase({ projectRoot, verifyBlank: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "BLANK_VERIFICATION_UNSUPPORTED");
  assert.deepEqual(probe.actions, []);

  const erased = await service.erase({ projectRoot, verifyBlank: false });
  assert.equal(erased.ok, true);
  assert.equal(erased.artifact, null);
  assert.deepEqual(probe.actions, ["erase"]);
});

test("erase reports a fatal J-Link programming diagnostic as issued with unknown state", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "erase-fatal-programming-diagnostic");
  probe.eraseResult = {
    success: false,
    rawOutput: "Verification of RAMCode failed",
    output: "Verification of RAMCode failed",
    error: "J-Link reported a fatal programming diagnostic: Verification of RAMCode failed",
    errorCode: ProbeErrorCode.JLINK_COMMAND_FAILED,
    stateUnknown: true,
  };

  const result = await service.erase({ projectRoot });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.error?.stage, "erase");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, true);
  assert.deepEqual(probe.actions, ["erase"]);
});

test("erase reports unknown and known vendor target-state changes without auto-recovery", async (context) => {
  const unknown = await fixture(context, "erase-before-unknown");
  unknown.probe.observations.push({ state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } });
  const observedUnknown = await unknown.service.erase({ projectRoot: unknown.projectRoot });
  assert.equal(observedUnknown.ok, true);
  assert.ok(observedUnknown.observedEffects.includes("vendor_target_state_change:unknown->halted"));
  assert.deepEqual(observedUnknown.requestedEffects, ["reset", "halt", "erase_flash"]);
  assert.deepEqual(unknown.probe.actions, ["erase"]);

  const changed = await fixture(context, "erase-hidden-state-change");
  changed.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const result = await changed.service.erase({ projectRoot: changed.projectRoot });
  assert.equal(result.ok, true);
  assert.ok(result.observedEffects.includes("vendor_target_state_change:running->halted"));
  assert.equal(result.verification.status, "executed_unverified");
  assert.equal((result.data as { command: { success: boolean } }).command.success, true);
});

test("erase fails closed when the backend does not leave the target halted", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "erase-final-running");
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "running", source: "dhcsr", result: ok() },
  );

  const result = await service.erase({ projectRoot });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_ERASE_FINAL_STATE_UNCONFIRMED");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, false);
});

test("raw Probe commands preserve exact payload and report unknown effects", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "raw-command");
  const commands = ["mem 0x20000000, 4", "rreg PC"];
  const result = await service.probeCommand({ projectRoot, commands });
  assert.equal(result.ok, true);
  assert.deepEqual((result.data as { commands: string[] }).commands, commands);
  assert.equal((result.data as { sideEffects: string }).sideEffects, "unknown");
  assert.deepEqual(probe.rawCommands, commands);
});

test("failed raw Probe command still invalidates Artifact state when issue was possible", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "raw-command-failure");
  probe.rawResult = { success: false, rawOutput: "partial", output: "partial", error: "connection lost" };
  const result = await service.probeCommand({ projectRoot, commands: ["unknown-command"] });
  assert.equal(result.ok, false);
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, false);
  assert.equal(result.after.targetState, "running");
  assert.equal((result.data as { command: { rawOutput: string } }).command.rawOutput, "partial");
  assert.equal(targets.require(projectRoot).liveArtifactMatch.source, "probe_command_failed_after_issue");

  const unknown = await fixture(context, "raw-command-failure-unknown");
  unknown.probe.rawResult = { success: false, rawOutput: "partial", output: "partial", error: "connection lost" };
  unknown.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
  );
  const unknownResult = await unknown.service.probeCommand({ projectRoot: unknown.projectRoot, commands: ["unknown-command"] });
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.error?.writeIssued, true);
  assert.equal(unknownResult.error?.stateUnknown, true);
});

test("write_memory rejects ranges that cross configured region boundaries", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "write-cross-region");
  const before = targets.require(projectRoot);
  await targets.configure({
    projectRoot,
    device: before.device,
    probeSerial: before.probeSerial,
    interface: before.interface,
    speed: before.speed,
    memoryRegions: [
      { start: 0x20000000, length: 4, kind: "ram", writable: true },
      { start: 0x20000004, length: 4, kind: "rom", writable: false },
    ],
  });
  const result = await service.writeMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 8, dataHex: "0000000000000000" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "MEMORY_RANGE_CROSSES_REGION");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
});

test("write_memory refuses a configured unknown region before issuing a write", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "write-configured-unknown");
  const beforeMatch = targets.require(projectRoot).liveArtifactMatch;
  const before = targets.require(projectRoot);
  await targets.configure({
    projectRoot,
    device: before.device,
    probeSerial: before.probeSerial,
    interface: before.interface,
    speed: before.speed,
    memoryRegions: [{ start: 0x20000000, length: 16, kind: "unknown", writable: true }],
  });
  const result = await service.writeMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "MEMORY_REGION_NOT_VERIFIED");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
  assert.equal(targets.require(projectRoot).liveArtifactMatch.status, beforeMatch.status);
  assert.equal(targets.require(projectRoot).liveArtifactMatch.source, beforeMatch.source);
});

test("write_memory refuses a non-writable Flash region before issuing a write", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "write-flash-region");
  const before = targets.require(projectRoot);
  await targets.configure({
    projectRoot,
    device: before.device,
    probeSerial: before.probeSerial,
    interface: before.interface,
    speed: before.speed,
    memoryRegions: [{ start: 0, length: 16, kind: "flash", writable: false }],
  });

  const result = await service.writeMemory({ projectRoot, address: 0, width: 32, byteCount: 4, dataHex: "01020304" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "MEMORY_REGION_NOT_WRITABLE");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
});

test("write_memory refuses an unaligned address before issuing a write", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "write-unaligned");

  const result = await service.writeMemory({ projectRoot, address: 0x20000002, width: 32, byteCount: 4, dataHex: "01020304" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "UNALIGNED_ACCESS");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(probe.actions, []);
});

test("post-write unknown target state is a structured uncertain failure", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "write-unknown-state");
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } },
  );
  const result = await service.writeMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01020304" });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "POST_OPERATION_STATE_UNKNOWN");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, true);
});

test("connection identity failure invalidates verified Artifact evidence", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "connection-invalidation");
  const artifactPath = join(projectRoot, "firmware.elf");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const previous = targets.require(projectRoot);
  const configured = await targets.configure({
    projectRoot,
    device: previous.device,
    probeSerial: previous.probeSerial,
    interface: previous.interface,
    speed: previous.speed,
    artifactPath,
  });
  await targets.setArtifactMatch(projectRoot, "verified", "test_verified", {
    targetGeneration: configured.generation,
    probeSerial: configured.probeSerial,
    artifactGeneration: configured.artifact?.generation,
  });
  probe.readResult = { success: false, rawOutput: "No J-Link", output: "", error: "probe missing", errorCode: ProbeErrorCode.PROBE_NOT_FOUND };
  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PROBE_NOT_FOUND");
  assert.equal(targets.require(projectRoot).liveArtifactMatch.source, "probe_connection_identity_lost");
});

test("final observation identity failure invalidates Artifact evidence without hiding issued control facts", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "final-observation-invalidation");
  const artifactPath = join(projectRoot, "firmware.elf");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const previous = targets.require(projectRoot);
  const configured = await targets.configure({ projectRoot, device: previous.device, probeSerial: previous.probeSerial, interface: previous.interface, speed: previous.speed, artifactPath });
  await targets.setArtifactMatch(projectRoot, "verified", "test_verified", {
    targetGeneration: configured.generation,
    probeSerial: configured.probeSerial,
    artifactGeneration: configured.artifact?.generation,
  });
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "connect lost", output: "", errorCode: ProbeErrorCode.TARGET_UNREACHABLE } },
  );
  const result = await service.control("halt", projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "FINAL_STATE_UNCONFIRMED");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, true);
  assert.equal((result.data as { command: { success: boolean } }).command.success, true);
  assert.equal(targets.require(projectRoot).liveArtifactMatch.source, "probe_connection_identity_lost");
});

test("queued direct request rejects a Target generation changed while waiting", async (context) => {
  const { service, probe, targets, queue, projectRoot } = await fixture(context, "generation-race");
  const before = targets.require(projectRoot);
  let releaseBlocker!: () => void;
  let blockerStarted!: () => void;
  const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const blocker = queue.runExclusive(before.probeSerial, async () => { blockerStarted(); await blocked; });
  await started;
  const pending = service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  await targets.configure({ projectRoot, device: before.device, probeSerial: before.probeSerial, interface: before.interface, speed: before.speed });
  releaseBlocker();
  await blocker;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TARGET_GENERATION_CHANGED");
  assert.deepEqual(probe.actions, []);
});

test("target_configure is rejected while a long-lived Probe owner is active", async (context) => {
  const { service, targets, queue, projectRoot } = await fixture(context, "configure-owner");
  const before = targets.require(projectRoot);
  let owner!: ReturnType<ProbeQueue["claimOwner"]>;
  await queue.runExclusive(before.probeSerial, async (metadata) => {
    owner = queue.claimOwner(before.probeSerial, { kind: "hss", projectRoot: before.projectRoot, targetGeneration: before.generation }, metadata.leaseToken);
  });
  const result = await service.configure({ projectRoot, device: before.device, probeSerial: before.probeSerial, interface: before.interface, speed: before.speed });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "CAPTURE_ACTIVE");
  assert.equal(targets.require(projectRoot).generation, before.generation);
  queue.releaseOwner(before.probeSerial, owner.token);
});

test("a foreign memory owner blocks direct control and reconfiguration with owner facts", async (context) => {
  const { probe, targets, queue, projectRoot } = await fixture(context, "foreign-memory-owner");
  const sessions = new MemorySessionManager(queue, new UnavailableMemorySessionLauncher(), 10_000);
  const service = new DirectMcuService(targets, queue, async () => ({ probe }), undefined, sessions);
  const target = targets.require(projectRoot);
  let owner!: ReturnType<ProbeQueue["claimOwner"]>;
  await queue.runExclusive(target.probeSerial, async (metadata) => {
    owner = queue.claimOwner(target.probeSerial, {
      kind: "memory",
      projectRoot: target.projectRoot,
      targetGeneration: target.generation,
    }, metadata.leaseToken);
  });

  const control = await service.control("halt", projectRoot);
  assert.equal(control.ok, false);
  assert.equal(control.error?.code, "MEMORY_SESSION_ACTIVE");
  assert.equal((control.probe?.owner as { token: string }).token, owner.token);
  assert.equal(probe.actions.length, 0);

  const configured = await service.configure({ projectRoot, device: target.device, probeSerial: target.probeSerial, interface: target.interface, speed: target.speed });
  assert.equal(configured.ok, false);
  assert.equal(configured.error?.code, "MEMORY_SESSION_ACTIVE");
  assert.equal(((configured.before as { owner: { token: string } }).owner).token, owner.token);
  assert.equal(targets.require(projectRoot).generation, target.generation);
  queue.releaseOwner(target.probeSerial, owner.token);
});

test("structured writes default to no old read and no readback", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-default");
  const result = await service.structuredWrite({
    projectRoot,
    operationTool: "write_variable",
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "78563412",
    knownRegion: "ram",
  });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "executed_unverified");
  assert.deepEqual(probe.actions, ["write:20000000:4:4"]);
});

test("write_variable independent verification uses a second runtime and labels its evidence", async (context) => {
  const { probe: writingProbe, targets, queue, projectRoot } = await fixture(context, "structured-independent-verification");
  const verifyingProbe = new FakeProbe();
  verifyingProbe.memory.set(0x20000000, Buffer.from("78563412", "hex"));
  let runtimeCalls = 0;
  const service = new DirectMcuService(targets, queue, async () => ({ probe: ++runtimeCalls === 1 ? writingProbe : verifyingProbe }));

  const result = await service.structuredWrite({
    projectRoot,
    operationTool: "write_variable",
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "78563412",
    knownRegion: "ram",
    verify: true,
    verificationConnection: "independent_session",
  });

  assert.equal(result.ok, true);
  assert.equal(runtimeCalls, 2);
  assert.deepEqual(writingProbe.actions, ["write:20000000:4:4"]);
  assert.deepEqual(verifyingProbe.actions, ["read:20000000:4"]);
  const data = result.data as { verificationConnection: string; verificationSource: string; targetConsumption: string };
  assert.equal(data.verificationConnection, "independent_session");
  assert.equal(data.verificationSource, "independent_session_readback");
  assert.equal(data.targetConsumption, "not_observed");
});

test("write_variable fails closed when a same-session backend is unavailable", async (context) => {
  const { probe, targets, queue, projectRoot } = await fixture(context, "structured-same-session-unavailable");
  const sessions = new MemorySessionManager(queue, new UnavailableMemorySessionLauncher(), 10_000);
  const service = new DirectMcuService(targets, queue, async () => ({ probe }), undefined, sessions);

  const result = await service.structuredWrite({
    projectRoot,
    operationTool: "write_variable",
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "78563412",
    knownRegion: "ram",
    verify: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "SAME_SESSION_UNAVAILABLE");
  assert.deepEqual(probe.actions, []);
});

test("structured writes consume one-connection Probe transaction evidence", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-probe-transaction");
  const old = Buffer.from("01000000", "hex");
  const requested = Buffer.from("02000000", "hex");
  probe.memory.set(0x20000000, old);
  probe.transactionResult = {
    command: { ...ok(), writeIssued: true, stateUnknown: false },
    oldBytes: old,
    readbacks: [requested],
    restoreReadback: old,
    restoreIssued: true,
    restoreVerified: true,
    targetStateBefore: "running",
    targetStateAfter: "running",
  };
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: requested.toString("hex"),
    knownRegion: "ram",
    captureOld: true,
    verify: true,
    restore: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "verified");
  assert.deepEqual(probe.actions, ["transaction:20000000:4:1:0:0:true", "read:20000000:4"]);
  assert.equal(probe.transactionInput?.expectedTargetState, "running");
  assert.equal(probe.transactionInput?.verifyDurationMs, 0);
  const data = result.data as { oldHex: string; requestedHex: string; readbackHex: string; restore: { status: string; readbackHex: string } };
  assert.equal(data.oldHex, old.toString("hex"));
  assert.equal(data.requestedHex, requested.toString("hex"));
  assert.equal(data.readbackHex, requested.toString("hex"));
  assert.equal(data.restore.status, "verified");
  assert.equal(data.restore.readbackHex, old.toString("hex"));
});

test("structured exact verification rejects a transaction-local value that does not persist", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-probe-post-connection-mismatch");
  const old = Buffer.from("01000000", "hex");
  const requested = Buffer.from("02000000", "hex");
  probe.memory.set(0x20000000, old);
  probe.transactionResult = {
    command: { ...ok(), writeIssued: true, stateUnknown: false },
    oldBytes: old,
    readbacks: [requested],
    restoreIssued: false,
    restoreVerified: false,
    targetStateBefore: "running",
    targetStateAfter: "running",
  };
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: requested.toString("hex"),
    knownRegion: "ram",
    captureOld: true,
    verify: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "READBACK_MISMATCH");
  const data = result.data as { readbackHex: string; transactionReadbackHex: string };
  assert.equal(data.transactionReadbackHex, requested.toString("hex"));
  assert.equal(data.readbackHex, old.toString("hex"));
  assert.deepEqual(probe.actions, ["transaction:20000000:4:1:0:0:false", "read:20000000:4"]);
});

test("one-connection observe verification retains bounded timeline and numeric evidence", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-probe-observe");
  const requested = Buffer.from("02000000", "hex");
  probe.transactionResult = {
    command: { ...ok(), writeIssued: true, stateUnknown: false },
    readbacks: [Buffer.from("00000000", "hex"), requested, Buffer.from("03000000", "hex")],
    readbackObservedAt: ["2026-07-19T00:00:00.000Z", "2026-07-19T00:00:00.010Z", "2026-07-19T00:00:00.020Z"],
    verificationStartedAt: "2026-07-19T00:00:00.000Z",
    verificationEndedAt: "2026-07-19T00:00:00.020Z",
    restoreIssued: false,
    restoreVerified: false,
    targetStateBefore: "running",
    targetStateAfter: "running",
  };
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: requested.toString("hex"),
    knownRegion: "ram",
    verify: true,
    comparator: {
      mode: "observe",
      durationMs: 100,
      maxPolls: 3,
      intervalMs: 10,
      comparator: { mode: "exact", type: "uint32", endian: "little" },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(probe.actions, ["transaction:20000000:4:3:10:100:false"]);
  const details = result.verification.details as {
    observationCount: number;
    matchedAt: string;
    matchedAtPoll: number;
    min: number;
    max: number;
    first: { numeric: number };
    last: { numeric: number };
  };
  assert.equal(details.observationCount, 3);
  assert.equal(details.matchedAt, "2026-07-19T00:00:00.010Z");
  assert.equal(details.matchedAtPoll, 2);
  assert.equal(details.min, 0);
  assert.equal(details.max, 3);
  assert.equal(details.first.numeric, 0);
  assert.equal(details.last.numeric, 3);
});

test("structured restore is forced, verified, and retains a failed main comparison", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-restore");
  const old = Buffer.from("01000000", "hex");
  probe.memory.set(0x20000000, old);
  probe.memoryReads.push(old, Buffer.from("03000000", "hex"), old);
  const result = await service.structuredWrite({
    projectRoot,
    operationTool: "write_variable",
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "02000000",
    knownRegion: "ram",
    verify: true,
    restore: true,
    comparator: { mode: "exact", type: "uint32", endian: "little" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "READBACK_MISMATCH");
  assert.equal(result.error?.stateUnknown, false);
  assert.equal((result.data as { restore: { status: string } }).restore.status, "verified");
  assert.equal(probe.memory.get(0x20000000)?.toString("hex"), old.toString("hex"));
});

test("partial transaction failure retains the main error after verified compensation", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-partial-write-restored");
  const old = Buffer.from("0100000002000000", "hex");
  probe.memory.set(0x20000000, old);
  probe.transactionResult = {
    command: { success: false, rawOutput: "partial write failed", output: "", error: "partial write failed", writeIssued: true, stateUnknown: true },
    oldBytes: old,
    readbacks: [],
    restoreReadback: old,
    restoreIssued: true,
    restoreVerified: true,
    targetStateBefore: "running",
    targetStateAfter: "running",
  };
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 8,
    dataHex: "0300000004000000",
    knownRegion: "ram",
    captureOld: true,
    verify: true,
    restore: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PROBE_COMMAND_FAILED");
  assert.match(result.error?.message ?? "", /partial write failed/);
  assert.equal((result.data as { restore: { status: string } }).restore.status, "verified");
  assert.deepEqual(probe.actions, ["transaction:20000000:8:1:0:0:true", "read:20000000:8"]);
});

test("structured restore uncertainty is explicit after an issued write", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-restore-failed");
  probe.memory.set(0x20000000, Buffer.from("01000000", "hex"));
  probe.writeMemoryResults.push(ok(), { success: false, rawOutput: "restore failed", output: "", error: "restore failed", writeIssued: true });
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "02000000",
    knownRegion: "ram",
    restore: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PROBE_COMMAND_FAILED");
  assert.equal(result.error?.stateUnknown, true);
  assert.equal((result.data as { restore: { status: string } }).restore.status, "uncertain");
});

test("structured comparator validation rejects unsafe requests before write", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-comparator-invalid");
  const base = { projectRoot, address: 0x20000000, width: 32 as const, byteCount: 4, dataHex: "02000000", knownRegion: "ram" as const, verify: true };
  const mismatch = await service.structuredWrite({ ...base, comparator: { mode: "tolerance", expected: 3, absTolerance: 0, relTolerance: 0, type: "uint32", endian: "little" } });
  const zeroMask = await service.structuredWrite({ ...base, comparator: { mode: "masked", maskHex: "00000000" } });
  const wrongType = await service.structuredWrite({ ...base, comparator: { mode: "exact", type: "uint16", endian: "little" } });
  assert.deepEqual([mismatch.error?.code, zeroMask.error?.code, wrongType.error?.code], ["COMPARATOR_EXPECTED_MISMATCH", "COMPARATOR_INVALID", "COMPARATOR_INVALID"]);
  assert.deepEqual(probe.actions, []);
});

test("bounded observe uses typed values, monotonic bounds, and match evidence", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-observe");
  probe.memoryReads.push(Buffer.from("01000000", "hex"), Buffer.from("02000000", "hex"), Buffer.from("03000000", "hex"));
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "03000000",
    knownRegion: "ram",
    verify: true,
    comparator: { mode: "observe", durationMs: 50, maxPolls: 3, intervalMs: 1, comparator: { mode: "exact", type: "uint32", endian: "little" } },
  });
  assert.equal(result.ok, true);
  const details = (result.data as { verificationDetails: Record<string, unknown> }).verificationDetails;
  assert.equal(details.observationCount, 3);
  assert.equal(details.min, 1);
  assert.equal(details.max, 3);
  assert.ok(details.matchedEvidence);
});

test("structured old-value read failure retains command and final-state evidence without writing", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-old-read-failed");
  probe.readResult = { success: false, rawOutput: "read failed", output: "", error: "read failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE };
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "02000000",
    knownRegion: "ram",
    captureOld: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(result.error?.writeIssued, false);
  assert.equal(result.after?.targetState, "running");
  assert.equal((result.data as { oldReadCommand: { success: boolean } }).oldReadCommand.success, false);
  assert.deepEqual(probe.actions, ["read:20000000:4"]);
});

test("structured restore is not attempted when the main write is explicitly unissued", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-write-unissued");
  probe.memory.set(0x20000000, Buffer.from("01000000", "hex"));
  probe.writeMemoryResults.push({
    success: false,
    rawOutput: "probe missing",
    output: "",
    error: "probe missing",
    errorCode: ProbeErrorCode.PROBE_NOT_FOUND,
    writeIssued: false,
  });
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "02000000",
    knownRegion: "ram",
    restore: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.writeIssued, false);
  assert.equal(result.error?.stateUnknown, false);
  assert.equal((result.data as { restore: { status: string } }).restore.status, "not_needed");
  assert.deepEqual(probe.actions, ["read:20000000:4", "write:20000000:4:4"]);
});

test("pre-dispatch memory-session write failures remain unissued and skip restore", async (context) => {
  const { targets, queue, projectRoot } = await fixture(context, "memory-session-pre-dispatch");
  const launcher = new PreDispatchMemorySessionLauncher();
  const sessions = new MemorySessionManager(queue, launcher, 10_000);
  const service = new DirectMcuService(targets, queue, async () => ({ probe: launcher.probe }), undefined, sessions);

  const raw = await service.writeMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "01000000" });
  assert.equal(raw.ok, false);
  assert.equal(raw.error?.writeIssued, false);
  assert.equal(raw.error?.stateUnknown, true);
  assert.deepEqual(launcher.probe.actions, []);

  launcher.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "unknown", source: "unavailable", result: { success: false, rawOutput: "memory session unavailable", output: "", errorCode: ProbeErrorCode.PROBE_BUSY } },
  );
  const structured = await service.structuredWrite({
    projectRoot,
    operationTool: "write_variable",
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "02000000",
    knownRegion: "ram",
    verify: true,
    restore: true,
  });
  assert.equal(structured.ok, false);
  assert.equal(structured.error?.writeIssued, false);
  assert.equal(structured.error?.stateUnknown, true);
  assert.equal((structured.data as { restore: { status: string } }).restore.status, "not_needed");
  assert.deepEqual(launcher.probe.actions, ["read:20000000:4"]);
  await sessions.dispose();
});

test("structured hidden target drift preserves restore uncertainty", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "structured-drift-restore-uncertain");
  probe.memory.set(0x20000000, Buffer.from("01000000", "hex"));
  probe.writeMemoryResults.push(ok(), { success: false, rawOutput: "restore failed", output: "", error: "restore failed", writeIssued: true });
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const result = await service.structuredWrite({
    projectRoot,
    address: 0x20000000,
    width: 32,
    byteCount: 4,
    dataHex: "02000000",
    knownRegion: "ram",
    restore: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.stateUnknown, true);
  assert.equal((result.data as { restore: { status: string } }).restore.status, "uncertain");
});

async function fixture(context: TestContext, name: string, cleanupFlashSnapshot?: FlashSnapshotCleanup): Promise<{ service: DirectMcuService; probe: FakeProbe; targets: TargetStore; queue: ProbeQueue; projectRoot: string }> {
  const root = testDirectory(context, name);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const targets = new TargetStore(join(root, "state"));
  await targets.configure({
    projectRoot,
    device: "TEST",
    probeSerial: "123456",
    interface: "SWD",
    speed: 1000,
    memoryRegions: [{ start: 0x20000000, length: 0x1000, kind: "ram", writable: true }],
  });
  const probe = new FakeProbe();
  const queue = new ProbeQueue(join(root, "queue"));
  const sessions = new MemorySessionManager(queue, new FakeMemorySessionLauncher(probe), 10_000);
  context.after(async () => { await sessions.dispose(); });
  const service = new DirectMcuService(targets, queue, async () => ({ probe }), cleanupFlashSnapshot, sessions, false);
  return { service, probe, targets, queue, projectRoot };
}

class FakeProbe extends ProbeBackend {
  readonly type = "jlink" as const;
  readonly displayName = "fake";
  targetState: "running" | "halted" | "unknown" = "running";
  actions: string[] = [];
  rawCommands: string[] = [];
  memory = new Map<number, Buffer>();
  memoryReads: Buffer[] = [];
  registerReadFailsWhileRunning = false;
  registerReadResult?: CommandResult;
  registerReadReject?: Error;
  registersReadResult?: CommandResult;
  registersReadReject?: Error;
  writeMemoryReject?: Error;
  writeMemoryResult?: CommandResult;
  writeMemoryResults: CommandResult[] = [];
  writeRegisterReject?: Error;
  rawResult: CommandResult = ok();
  eraseResult?: CommandResult;
  flashPaths: string[] = [];
  readResult?: CommandResult;
  readMemoryReject?: Error;
  readAccessSizes: Array<1 | 2 | 4 | undefined> = [];
  observations: TargetStateObservation[] = [];
  observationCalls = 0;
  observationRejectOnCall?: number;
  haltResult?: CommandResult;
  haltReject?: Error;
  transactionInput?: ProbeMemoryTransactionInput;
  transactionResult?: ProbeMemoryTransactionResult;

  override async observeTargetState(): Promise<TargetStateObservation> {
    this.observationCalls += 1;
    if (this.observationRejectOnCall === this.observationCalls) throw new Error("observation transport rejected");
    const queued = this.observations.shift();
    if (queued) return queued;
    return { state: this.targetState, source: "dhcsr", result: ok() };
  }
  async getDeviceInfo(): Promise<CommandResult> { return ok(); }
  async halt(): Promise<CommandResult> {
    this.actions.push("halt");
    if (this.haltReject) throw this.haltReject;
    const result = this.haltResult ?? ok();
    if (result.success) this.targetState = "halted";
    return result;
  }
  async resume(): Promise<CommandResult> { this.actions.push("resume"); this.targetState = "running"; return ok(); }
  async reset(halt = false): Promise<CommandResult> { this.actions.push(halt ? "reset_halt" : "reset"); this.targetState = halt ? "halted" : "running"; return ok(); }
  async step(): Promise<CommandResult> { this.actions.push("step"); return ok(); }
  async readMemory(address: number, length: number, accessSize?: 1 | 2 | 4): Promise<CommandResult> {
    this.actions.push(`read:${address.toString(16)}:${length}`);
    this.readAccessSizes.push(accessSize);
    if (this.readMemoryReject) throw this.readMemoryReject;
    if (this.readResult) return this.readResult;
    const bytes = this.memoryReads.shift()?.subarray(0, length) ?? this.memory.get(address)?.subarray(0, length) ?? Buffer.alloc(length);
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ");
    const rawOutput = `${address.toString(16).padStart(8, "0")} = ${hex}  ....`;
    return { success: true, rawOutput, output: rawOutput };
  }
  async writeMemory(): Promise<CommandResult> { return ok(); }
  override async writeMemoryBytes(address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<CommandResult> {
    this.actions.push(`write:${address.toString(16)}:${bytes.length}:${accessSize}`);
    if (this.writeMemoryReject) throw this.writeMemoryReject;
    const queued = this.writeMemoryResults.shift();
    if (queued) {
      if (queued.success) this.memory.set(address, Buffer.from(bytes));
      return queued;
    }
    if (this.writeMemoryResult) return this.writeMemoryResult;
    this.memory.set(address, Buffer.from(bytes));
    return ok();
  }
  override async writeMemoryTransaction(input: ProbeMemoryTransactionInput): Promise<ProbeMemoryTransactionResult | undefined> {
    if (!this.transactionResult) return undefined;
    this.transactionInput = input;
    this.actions.push(`transaction:${input.address.toString(16)}:${input.bytes.length}:${input.verifyReads}:${input.verifyIntervalMs}:${input.verifyDurationMs}:${input.restore}`);
    return this.transactionResult;
  }
  async readAllRegisters(): Promise<CommandResult> {
    this.actions.push("read-registers");
    if (this.registersReadReject) throw this.registersReadReject;
    return this.registersReadResult ?? { success: true, rawOutput: "PC = 00001000, SP = 20001000", output: "" };
  }
  async readRegister(name: string): Promise<CommandResult> {
    this.actions.push(`read-register:${name}`);
    if (this.registerReadReject) throw this.registerReadReject;
    if (this.registerReadFailsWhileRunning && this.targetState === "running") return { success: false, rawOutput: "CPU is running", output: "CPU is running", error: "CPU is running" };
    if (this.registerReadResult) return this.registerReadResult;
    return { success: true, rawOutput: `${name} = 00001000`, output: `${name} = 00001000` };
  }
  override async writeCoreRegister(name: string, value: number): Promise<CommandResult> {
    this.actions.push(`write-register:${name}:${value}`);
    if (this.writeRegisterReject) throw this.writeRegisterReject;
    return ok();
  }
  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> {
    this.flashPaths.push(filePath);
    this.actions.push(`flash:${filePath}:${baseAddress ?? "embedded"}`);
    this.targetState = "halted";
    return ok();
  }
  async erase(): Promise<CommandResult> {
    this.actions.push("erase");
    const result = this.eraseResult ?? ok();
    if (result.success) this.targetState = "halted";
    return result;
  }
  async setBreakpoint(): Promise<CommandResult> { return ok(); }
  async clearBreakpoints(): Promise<CommandResult> { return ok(); }
  async startGDBServer(): Promise<{ success: boolean; message: string }> { return { success: true, message: "ok" }; }
  async stopGDBServer(): Promise<{ success: boolean; message: string }> { return { success: true, message: "ok" }; }
  isGDBServerRunning(): boolean { return false; }
  getGDBServerStatus(): GDBServerInfo { return { running: false, gdbPort: 0, rttTelnetPort: 0 }; }
  getGDBServerOutput(): string[] { return []; }
  async executeRaw(commands: string[]): Promise<CommandResult> { this.rawCommands = [...commands]; this.actions.push("raw"); return this.rawResult; }
  isDeviceConfigured(): boolean { return true; }
  getDeviceName(): string { return "TEST"; }
  setDevice(): void {}
  async listDevices(): Promise<CommandResult> { return ok(); }
  dispose(): void {}
}

class UnavailableMemorySessionLauncher implements MemorySessionLauncher {
  async open(): Promise<undefined> { return undefined; }
}

class FakeMemorySessionLauncher implements MemorySessionLauncher {
  constructor(private readonly probe: ProbeBackend) {}
  async open(_target: Parameters<MemorySessionLauncher["open"]>[0], onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession> {
    const session = new PreDispatchMemorySession(this.probe);
    onStarted?.(session.pid, session.runtime);
    return session;
  }
}

class PreDispatchMemorySessionLauncher implements MemorySessionLauncher {
  readonly probe = new PreDispatchProbe();
  private readonly session = new PreDispatchMemorySession(this.probe);
  async open(_target: Parameters<MemorySessionLauncher["open"]>[0], onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession> {
    onStarted?.(this.session.pid, this.session.runtime);
    return this.session;
  }
}

class PreDispatchMemorySession implements PersistentMemorySession {
  readonly pid = process.pid;
  readonly runtime: MemorySessionRuntimeFacts = {
    helperPath: "fixture-helper.exe",
    runtimePath: "fixture-jlink.dll",
    helperSha256: "a".repeat(64),
    runtimeSha256: "b".repeat(64),
  };
  private alive = true;
  closeError?: Error;
  constructor(readonly probe: ProbeBackend) {}
  isAlive(): boolean { return this.alive; }
  isReusable(): boolean { return this.alive; }
  async close(): Promise<void> {
    if (this.closeError) throw this.closeError;
    this.alive = false;
  }
  onExit(): () => void { return () => undefined; }
}

class PreDispatchProbe extends FakeProbe {
  override async writeMemoryBytes(): Promise<CommandResult> {
    return {
      success: false,
      rawOutput: "memory session unavailable before dispatch",
      output: "",
      error: "memory session unavailable before dispatch",
      errorCode: ProbeErrorCode.PROBE_BUSY,
      writeIssued: false,
      stateUnknown: true,
    };
  }
}

function ok(): CommandResult {
  return { success: true, rawOutput: "", output: "ok" };
}

function testDirectory(_context: TestContext, name: string): string {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-mcp-direct-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
