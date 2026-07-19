import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  ProbeBackend,
  ProbeErrorCode,
  type CommandResult,
  type GDBServerInfo,
  type TargetStateObservation,
} from "../../probe/backend";
import { DirectMcuService } from "./direct-operations";
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

test("read_memory reports known target-state drift without marking the final state unknown", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "read-memory-known-drift");
  probe.memory.set(0x20000000, Buffer.from([0x11, 0x22, 0x33, 0x44]));
  probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const result = await service.readMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.stateUnknown, false);
  assert.equal((result.data as { dataHex: string }).dataHex, "11223344");
});

test("failed read_memory preserves failure and final-state evidence", async (context) => {
  const drift = await fixture(context, "read-memory-failed-drift");
  drift.probe.readResult = { success: false, rawOutput: "transport failed", output: "", error: "transport failed", errorCode: ProbeErrorCode.TARGET_UNREACHABLE };
  drift.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
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

test("write_memory defaults to no old-value read and no readback", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "write-defaults");
  const result = await service.writeMemory({ projectRoot, address: 0x20000000, width: 32, byteCount: 4, dataHex: "78563412" });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, "executed_unverified");
  assert.deepEqual(probe.actions, ["write:20000000:4:4"]);
  assert.equal((result.data as { oldHex?: string }).oldHex, undefined);
  assert.equal((result.data as { readbackHex?: string }).readbackHex, undefined);
  assert.equal((result.data as { regionStatus: string }).regionStatus, "unknown");
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
  assert.equal(memory.targets.require(memory.projectRoot).liveArtifactMatch.source, "unknown_memory_write");

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
  assert.equal(flashResult.error?.writeIssued, true);
  assert.equal(flashResult.error?.stateUnknown, true);
  assert.equal((flashResult.data as { command: { success: boolean } }).command.success, true);

  const erase = await fixture(context, "erase-observe-reject");
  erase.probe.observationRejectOnCall = 2;
  const eraseResult = await erase.service.erase(erase.projectRoot);
  assert.equal(eraseResult.error?.writeIssued, true);
  assert.equal(eraseResult.error?.stateUnknown, true);
  assert.equal((eraseResult.data as { command: { success: boolean } }).command.success, true);

  const raw = await fixture(context, "raw-observe-reject");
  raw.probe.observationRejectOnCall = 2;
  const rawResult = await raw.service.probeCommand(raw.projectRoot, ["w4 0x20000000, 1"]);
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

test("flash reports unknown and known vendor target-state changes without auto-recovery", async (context) => {
  const unknown = await fixture(context, "flash-before-unknown");
  writeFileSync(join(unknown.projectRoot, "image.bin"), Buffer.from([1, 2, 3, 4]));
  unknown.probe.observations.push({ state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } });
  const observedUnknown = await unknown.service.flash({ projectRoot: unknown.projectRoot, path: "image.bin", baseAddress: 0x08000000 });
  assert.equal(observedUnknown.ok, true);
  assert.ok(observedUnknown.observedEffects.includes("vendor_target_state_change:unknown->running"));
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
  const rejected = await service.erase(projectRoot, true);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "BLANK_VERIFICATION_UNSUPPORTED");
  assert.deepEqual(probe.actions, []);

  const erased = await service.erase(projectRoot, false);
  assert.equal(erased.ok, true);
  assert.equal(erased.artifact, null);
  assert.deepEqual(probe.actions, ["erase"]);
});

test("erase reports unknown and known vendor target-state changes without auto-recovery", async (context) => {
  const unknown = await fixture(context, "erase-before-unknown");
  unknown.probe.observations.push({ state: "unknown", source: "unavailable", result: { success: false, rawOutput: "", output: "", stateUnknown: true } });
  const observedUnknown = await unknown.service.erase(unknown.projectRoot);
  assert.equal(observedUnknown.ok, true);
  assert.ok(observedUnknown.observedEffects.includes("vendor_target_state_change:unknown->running"));
  assert.deepEqual(unknown.probe.actions, ["erase"]);

  const changed = await fixture(context, "erase-hidden-state-change");
  changed.probe.observations.push(
    { state: "running", source: "dhcsr", result: ok() },
    { state: "halted", source: "dhcsr", result: ok() },
  );
  const result = await changed.service.erase(changed.projectRoot);
  assert.equal(result.ok, true);
  assert.ok(result.observedEffects.includes("vendor_target_state_change:running->halted"));
  assert.equal(result.verification.status, "executed_unverified");
  assert.equal((result.data as { command: { success: boolean } }).command.success, true);
});

test("raw Probe commands preserve exact payload and report unknown effects", async (context) => {
  const { service, probe, projectRoot } = await fixture(context, "raw-command");
  const commands = ["mem 0x20000000, 4", "rreg PC"];
  const result = await service.probeCommand(projectRoot, commands);
  assert.equal(result.ok, true);
  assert.deepEqual((result.data as { commands: string[] }).commands, commands);
  assert.equal((result.data as { sideEffects: string }).sideEffects, "unknown");
  assert.deepEqual(probe.rawCommands, commands);
});

test("failed raw Probe command still invalidates Artifact state when issue was possible", async (context) => {
  const { service, probe, targets, projectRoot } = await fixture(context, "raw-command-failure");
  probe.rawResult = { success: false, rawOutput: "partial", output: "partial", error: "connection lost" };
  const result = await service.probeCommand(projectRoot, ["unknown-command"]);
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
  const unknownResult = await unknown.service.probeCommand(unknown.projectRoot, ["unknown-command"]);
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
  assert.deepEqual(probe.actions, []);
});

test("configured unknown-region writes invalidate Artifact evidence", async (context) => {
  const { service, targets, projectRoot } = await fixture(context, "write-configured-unknown");
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
  assert.equal(result.ok, true);
  assert.equal(targets.require(projectRoot).liveArtifactMatch.source, "unknown_memory_write");
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

async function fixture(context: TestContext, name: string): Promise<{ service: DirectMcuService; probe: FakeProbe; targets: TargetStore; queue: ProbeQueue; projectRoot: string }> {
  const root = testDirectory(context, name);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const targets = new TargetStore(join(root, "state"));
  await targets.configure({ projectRoot, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000 });
  const probe = new FakeProbe();
  const queue = new ProbeQueue(join(root, "queue"));
  const service = new DirectMcuService(targets, queue, async () => ({ probe }));
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
  readResult?: CommandResult;
  readMemoryReject?: Error;
  readAccessSizes: Array<1 | 2 | 4 | undefined> = [];
  observations: TargetStateObservation[] = [];
  observationCalls = 0;
  observationRejectOnCall?: number;

  override async observeTargetState(): Promise<TargetStateObservation> {
    this.observationCalls += 1;
    if (this.observationRejectOnCall === this.observationCalls) throw new Error("observation transport rejected");
    const queued = this.observations.shift();
    if (queued) return queued;
    return { state: this.targetState, source: "dhcsr", result: ok() };
  }
  async getDeviceInfo(): Promise<CommandResult> { return ok(); }
  async halt(): Promise<CommandResult> { this.actions.push("halt"); this.targetState = "halted"; return ok(); }
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
  async flash(filePath: string, baseAddress?: number): Promise<CommandResult> { this.actions.push(`flash:${filePath}:${baseAddress ?? "embedded"}`); return ok(); }
  async erase(): Promise<CommandResult> { this.actions.push("erase"); return ok(); }
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

function ok(): CommandResult {
  return { success: true, rawOutput: "", output: "ok" };
}

function testDirectory(_context: TestContext, name: string): string {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-mcp-direct-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
