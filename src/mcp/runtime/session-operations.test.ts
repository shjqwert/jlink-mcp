import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { GDBResponse, GDBTargetExecutionState, GDBUnexpectedExit } from "../../gdb/gdb-client";
import { ProbeBackend, ProbeErrorCode, type CommandResult, type GDBServerInfo, type TargetStateObservation } from "../../probe/backend";
import { RTTClient } from "../../rtt/rtt-client";
import { DirectMcuService } from "./direct-operations";
import { MemorySessionManager } from "./memory-session";
import { ProbeQueue } from "./probe-queue";
import { SessionOperations, type SessionGdbClient } from "./session-operations";
import { TargetStore } from "./target-store";

test("GDB Server claims a long-lived owner that excludes direct MCU operations", async (context) => {
  const fixtureValue = await fixture(context, "gdb-owner");
  const started = await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  assert.equal(started.ok, true);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)?.kind, "gdb");

  const blocked = await fixtureValue.direct.control("halt", fixtureValue.projectRoot);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, "GDB_SESSION_ACTIVE");
  assert.equal(fixtureValue.probe.haltCalls, 0);

  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(stopped.ok, true);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
});

test("raw GDB command is exact and invalidates live Artifact verification", async (context) => {
  const fixtureValue = await fixture(context, "gdb-command", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  const command = "set $r0 = 0x1234";
  const result = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, command);
  assert.equal(result.ok, true);
  assert.deepEqual(fixtureValue.gdb.commands, [command]);
  assert.equal(result.artifact?.match, "unverified");
  assert.equal((result.data as { sideEffects: string }).sideEffects, "unknown");
});

test("raw GDB command without current state evidence invalidates cached state and blocks server stop", async (context) => {
  const fixtureValue = await fixture(context, "gdb-command-state-unknown");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.commandResult = { success: true, output: "done", rawOutput: "^done" };
  const command = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "monitor reset halt");
  assert.equal(command.ok, true);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
  const waited = await fixtureValue.sessions.gdbWait(fixtureValue.projectRoot, 1);
  assert.equal(waited.ok, false);
  assert.equal(waited.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(fixtureValue.gdb.waitCalls, 0);
  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(fixtureValue.probe.serverRunning, true);
});

test("gdb_wait is a no-op for halted state and polls only an explicitly running target", async (context) => {
  const fixtureValue = await fixture(context, "gdb-wait-state-boundary");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  const halted = await fixtureValue.sessions.gdbWait(fixtureValue.projectRoot, 1);
  assert.equal(halted.ok, true);
  assert.equal((halted.data as { noOp: boolean }).noOp, true);
  assert.equal(fixtureValue.gdb.waitCalls, 0);

  fixtureValue.gdb.executionState = "running";
  fixtureValue.gdb.waitResult = { success: true, output: "Target still running (timeout)", stopReason: "running", observedTargetExecutionState: "running" };
  const running = await fixtureValue.sessions.gdbWait(fixtureValue.projectRoot, 1);
  assert.equal(running.ok, true);
  assert.equal(fixtureValue.gdb.waitCalls, 1);
  assert.equal(fixtureValue.gdb.executionState, "running");
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
  assert.equal(running.verification.method, "gdb_running_timeout");

  fixtureValue.gdb.executionState = "running";
  fixtureValue.gdb.waitResult = { success: false, output: "disconnected", error: "GDB disconnected", code: "GDB_NOT_CONNECTED", observedTargetExecutionState: "unknown" };
  const disconnected = await fixtureValue.sessions.gdbWait(fixtureValue.projectRoot, 1);
  assert.equal(disconnected.ok, false);
  assert.equal(disconnected.error?.code, "GDB_NOT_CONNECTED");
  assert.equal(disconnected.error?.writeIssued, false);
  assert.equal(disconnected.error?.stateUnknown, true);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
});

test("raw GDB command with an explicit running record permits server stop", async (context) => {
  const fixtureValue = await fixture(context, "gdb-command-state-running");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.commandResult = { success: true, output: "running", rawOutput: "^running", observedTargetExecutionState: "running" };
  const command = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "continue");
  assert.equal(command.ok, true);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(stopped.ok, true);
  assert.equal(fixtureValue.probe.serverRunning, false);
});

test("failed raw GDB command retains command and partial output facts", async (context) => {
  const fixtureValue = await fixture(context, "gdb-command-failure", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.gdb.commandResult = { success: false, output: "partial output", rawOutput: "^running", error: "timed out", code: "GDB_COMMAND_TIMEOUT", exitCode: 9, exitSignal: null };
  const result = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "monitor long-command", 25);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "GDB_COMMAND_TIMEOUT");
  assert.equal((result.data as { command: string }).command, "monitor long-command");
  assert.equal((result.data as { output: string }).output, "partial output");
  assert.equal((result.data as { rawOutput: string }).rawOutput, "^running");
  assert.equal((result.data as { exitCode: number }).exitCode, 9);
  assert.equal(result.artifact?.match, "unverified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.status, "unverified");
  assert.equal(result.error?.stateUnknown, true);

  fixtureValue.gdb.executionState = "running";
  fixtureValue.gdb.commandResult = { success: false, output: "failed while running", error: "command failed", code: "GDB_COMMAND_FAILED", observedTargetExecutionState: "running" };
  const known = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "monitor known-failure", 25);
  assert.equal(known.ok, false);
  assert.equal(known.error?.writeIssued, true);
  assert.equal(known.error?.stateUnknown, false);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
});

test("queued GDB request rejects an owner replaced while waiting", async (context) => {
  const fixtureValue = await fixture(context, "gdb-owner-race");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  const original = fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)!;
  let allowReplacement!: () => void;
  let blockerStarted!: () => void;
  const started = new Promise<void>((resolve) => { blockerStarted = resolve; });
  const allowed = new Promise<void>((resolve) => { allowReplacement = resolve; });
  let replacement!: ReturnType<ProbeQueue["claimOwner"]>;
  const blocker = fixtureValue.queue.runExclusive(fixtureValue.target.probeSerial, async (metadata) => {
    blockerStarted();
    await allowed;
    fixtureValue.queue.releaseOwner(fixtureValue.target.probeSerial, original.token);
    replacement = fixtureValue.queue.claimOwner(fixtureValue.target.probeSerial, {
      kind: "gdb",
      projectRoot: `${fixtureValue.target.projectRoot}-replacement`,
      targetGeneration: "replacement-generation",
    }, metadata.leaseToken);
  }, {
    allowedOwnerKinds: ["gdb"],
    ownerTarget: { projectRoot: original.projectRoot, targetGeneration: original.targetGeneration },
    requiredOwner: original,
  });
  await started;
  const pending = fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "info registers");
  allowReplacement();
  await blocker;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "OWNER_CHANGED");
  assert.deepEqual(fixtureValue.gdb.commands, []);
  fixtureValue.queue.releaseOwner(fixtureValue.target.probeSerial, replacement.token);
});

test("unexpected GDB Server exit releases its long-lived owner", async (context) => {
  const fixtureValue = await fixture(context, "gdb-unexpected-exit", true);
  const started = await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  assert.equal(started.ok, true);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.triggerGdbServerExit();
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)?.kind, "gdb", "owner must gate requests until Artifact invalidation is persisted");
  await waitUntil(() => fixtureValue.queue.getOwner(fixtureValue.target.probeSerial) === undefined);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
  assert.equal(fixtureValue.runtime.gdbOwnerToken, undefined);
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.source, "gdb_server_unexpected_exit");
});

test("intentional GDB Server stop preserves verified Artifact evidence", async (context) => {
  const fixtureValue = await fixture(context, "gdb-intentional-stop", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.probe.stopHook = fixtureValue.triggerGdbServerExit;
  const result = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(result.ok, true);
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.status, "verified");
});

test("GDB backtrace returns HALT_REQUIRED and never halts implicitly", async (context) => {
  const fixtureValue = await fixture(context, "gdb-backtrace");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.backtraceResult = { success: false, output: "Cannot execute this command while the target is running", error: "target is running" };
  const result = await fixtureValue.sessions.gdbBacktrace(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HALT_REQUIRED");
  assert.equal(fixtureValue.probe.haltCalls, 0);
  assert.equal(fixtureValue.gdb.backtraceCalls, 0);

  fixtureValue.gdb.executionState = "unknown";
  const unknown = await fixtureValue.sessions.gdbBacktrace(fixtureValue.projectRoot);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(fixtureValue.gdb.backtraceCalls, 0);
});

test("managedGdbBacktrace only reuses an already-owned managed GDB session", async (context) => {
  const fixtureValue = await fixture(context, "managed-gdb-backtrace");
  assert.equal(await fixtureValue.sessions.managedGdbBacktrace(fixtureValue.projectRoot), undefined);

  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.backtraceResult = { success: true, output: "#0 fault_handler" };
  const backtrace = await fixtureValue.sessions.managedGdbBacktrace(fixtureValue.projectRoot);
  assert.equal(backtrace?.ok, true, JSON.stringify(backtrace?.error));
  assert.equal(backtrace?.tool, "gdb_backtrace");
  assert.equal((backtrace?.data as { output: string }).output, "#0 fault_handler");
  assert.equal(fixtureValue.gdb.backtraceCalls, 1);
  assert.equal(fixtureValue.probe.haltCalls, 0);
});

test("GDB backtrace reports a hidden transition from halted to running", async (context) => {
  const fixtureValue = await fixture(context, "gdb-backtrace-hidden-running");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.backtraceResult = { success: true, output: "partial", observedTargetExecutionState: "running" };
  const result = await fixtureValue.sessions.gdbBacktrace(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.stateUnknown, false);
  assert.equal((result.data as { output: string }).output, "partial");
});

test("GDB backtrace reports a hidden transition from halted to unknown", async (context) => {
  const fixtureValue = await fixture(context, "gdb-backtrace-hidden-unknown");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.backtraceResult = { success: true, output: "partial", observedTargetExecutionState: "unknown" };
  const result = await fixtureValue.sessions.gdbBacktrace(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.stateUnknown, true);
  assert.equal((result.data as { output: string }).output, "partial");
});

test("GDB Server stop leaves an already halted target halted and reports its final state", async (context) => {
  const fixtureValue = await fixture(context, "gdb-stop-halted");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.probe.targetState = "halted";
  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
  assert.equal((stopped.after as { targetExecutionState: string }).targetExecutionState, "halted");
  assert.equal(fixtureValue.probe.serverRunning, false);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
  assert.equal(fixtureValue.probe.haltCalls, 0);
});

test("GDB Server start refuses a halted target before any process side effect", async (context) => {
  const fixtureValue = await fixture(context, "gdb-start-halted");
  fixtureValue.probe.targetState = "halted";
  const refused = await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "RESUME_REQUIRED");
  assert.equal(fixtureValue.probe.serverRunning, false);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
});

test("GDB Server start invalidates verified Artifact evidence on Probe identity loss", async (context) => {
  const fixtureValue = await fixture(context, "gdb-start-identity-loss", true);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.probe.targetState = "unknown";
  fixtureValue.probe.targetStateResult = {
    success: false,
    rawOutput: "No J-Link found",
    output: "",
    error: "No J-Link found",
    errorCode: ProbeErrorCode.PROBE_NOT_FOUND,
    stateUnknown: true,
  };
  const result = await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(result.artifact?.match, "unverified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.source, "probe_connection_identity_lost");
  assert.equal(fixtureValue.probe.serverRunning, false);
});

test("stale Artifact during GDB load retains a halted client to avoid hidden resume", async (context) => {
  const fixtureValue = await fixture(context, "gdb-stale-halted", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  const artifactPath = join(fixtureValue.projectRoot, "firmware.elf");
  fixtureValue.gdb.connectHook = () => {
    fixtureValue.gdb.executionState = "halted";
    writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]));
  };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, artifactPath);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "ARTIFACT_STALE");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(fixtureValue.gdb.connected, true);
  assert.equal((result.data as { cleanup: string }).cleanup, "client_retained_to_avoid_hidden_resume");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.status, "unverified");
});

test("GDB connect reports and retains an unexpected running-to-halted transition", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-hidden-halt");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, false);
  assert.deepEqual(result.observedEffects, ["gdb_client_connected", "unexpected_target_state_change:running->halted"]);
  assert.equal(fixtureValue.gdb.isConnected(), true);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
  assert.equal((result.data as { cleanup: string }).cleanup, "client_retained_to_avoid_hidden_resume");
});

test("an idle GDB client exit invalidates cached state before the next connect", async (context) => {
  const fixtureValue = await fixture(context, "gdb-idle-client-exit");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.triggerUnexpectedExit();
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(fixtureValue.gdb.connectCalls, 0);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
});

test("a failed first GDB connect invalidates cached running state", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-failure-state");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.connectResult = { success: false, output: "remote timeout", error: "timeout", code: "GDB_COMMAND_TIMEOUT" };
  const first = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot);
  assert.equal(first.ok, false);
  assert.equal(first.error?.stateUnknown, true);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
  const second = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot);
  assert.equal(second.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(fixtureValue.gdb.connectCalls, 1);
});

test("HSS owner returns CAPTURE_ACTIVE without disturbing the owner", async (context) => {
  const fixtureValue = await fixture(context, "hss-owner");
  let owner!: ReturnType<ProbeQueue["claimOwner"]>;
  await fixtureValue.queue.runExclusive(fixtureValue.target.probeSerial, async (metadata) => {
    owner = fixtureValue.queue.claimOwner(fixtureValue.target.probeSerial, {
      kind: "hss",
      projectRoot: fixtureValue.target.projectRoot,
      targetGeneration: fixtureValue.target.generation,
    }, metadata.leaseToken);
  });
  const result = await fixtureValue.sessions.rttConnect(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "CAPTURE_ACTIVE");
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)?.token, owner.token);
  assert.equal(fixtureValue.rtt.connectCalls, 0);
  fixtureValue.queue.releaseOwner(fixtureValue.target.probeSerial, owner.token);
});

test("memory owner blocks every GDB operation with MEMORY_SESSION_ACTIVE and owner facts", async (context) => {
  const fixtureValue = await fixture(context, "memory-owner");
  const sessions = new SessionOperations(fixtureValue.targets, fixtureValue.queue, async () => fixtureValue.runtime, new MemorySessionManager(fixtureValue.queue), false);
  let owner!: ReturnType<ProbeQueue["claimOwner"]>;
  await fixtureValue.queue.runExclusive(fixtureValue.target.probeSerial, async (metadata) => {
    owner = fixtureValue.queue.claimOwner(fixtureValue.target.probeSerial, {
      kind: "memory",
      projectRoot: fixtureValue.target.projectRoot,
      targetGeneration: fixtureValue.target.generation,
    }, metadata.leaseToken);
  });

  const results = await Promise.all([
    sessions.gdbServerStart(fixtureValue.projectRoot),
    sessions.gdbCommand(fixtureValue.projectRoot, "info threads"),
    sessions.gdbWait(fixtureValue.projectRoot, 1),
    sessions.gdbBacktrace(fixtureValue.projectRoot),
    sessions.gdbServerStop(fixtureValue.projectRoot),
  ]);
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "MEMORY_SESSION_ACTIVE");
    assert.equal((result.probe?.owner as { token: string }).token, owner.token);
  }
  assert.equal(fixtureValue.probe.serverRunning, false);
  assert.deepEqual(fixtureValue.gdb.commands, []);
  assert.equal(fixtureValue.gdb.waitCalls, 0);
  assert.equal(fixtureValue.gdb.backtraceCalls, 0);
  fixtureValue.queue.releaseOwner(fixtureValue.target.probeSerial, owner.token);
});

async function fixture(context: TestContext, name: string, withArtifact = false) {
  const root = testDirectory(context, name);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  if (withArtifact) writeFileSync(join(projectRoot, "firmware.elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const targets = new TargetStore(join(root, "state"));
  const target = await targets.configure({
    projectRoot,
    device: "TEST",
    probeSerial: "123456",
    interface: "SWD",
    speed: 1000,
    artifactPath: withArtifact ? "firmware.elf" : undefined,
  });
  const queue = new ProbeQueue(join(root, "queue"));
  const probe = new SessionProbe();
  const gdb = new FakeGdb();
  const rtt = new FakeRtt();
  let gdbServerExitListener: (() => void) | undefined;
  const runtime = {
    probe,
    gdb,
    rtt,
    gdbOwnerToken: undefined as string | undefined,
    gdbOwnerExitSubscription: undefined as (() => void) | undefined,
    gdbServerTargetExecutionState: undefined as GDBTargetExecutionState | undefined,
    onGdbServerExit: (listener: () => void) => {
      gdbServerExitListener = listener;
      return () => { if (gdbServerExitListener === listener) gdbServerExitListener = undefined; };
    },
  };
  const sessions = new SessionOperations(targets, queue, async () => runtime, undefined, false);
  const direct = new DirectMcuService(targets, queue, async () => runtime);
  return { targets, target, queue, probe, gdb, rtt, runtime, sessions, direct, projectRoot, triggerGdbServerExit: () => gdbServerExitListener?.() };
}

class FakeGdb implements SessionGdbClient {
  connected = true;
  executionState: GDBTargetExecutionState = "running";
  commands: string[] = [];
  backtraceCalls = 0;
  waitCalls = 0;
  backtraceResult: GDBResponse = { success: true, output: "#0 main" };
  commandResult: GDBResponse = { success: true, output: "ok" };
  waitResult: GDBResponse = { success: true, output: "stopped", stopReason: "breakpoint", observedTargetExecutionState: "halted" };
  connectHook?: () => void;
  connectCalls = 0;
  connectResult: GDBResponse = { success: true, output: "connected" };
  unexpectedExitListener?: (event: GDBUnexpectedExit) => void;
  async connect(): Promise<GDBResponse> {
    this.connectCalls += 1;
    this.connected = this.connectResult.success;
    if (!this.connectResult.success) this.executionState = "unknown";
    this.connectHook?.();
    return this.connectResult;
  }
  async command(command: string): Promise<GDBResponse> {
    this.commands.push(command);
    this.executionState = this.commandResult.observedTargetExecutionState ?? "unknown";
    return this.commandResult;
  }
  async wait(): Promise<GDBResponse> {
    this.waitCalls += 1;
    if (this.waitResult.observedTargetExecutionState) this.executionState = this.waitResult.observedTargetExecutionState;
    return this.waitResult;
  }
  async backtrace(): Promise<GDBResponse> {
    this.backtraceCalls += 1;
    if (this.backtraceResult.observedTargetExecutionState) this.executionState = this.backtraceResult.observedTargetExecutionState;
    return this.backtraceResult;
  }
  isConnected(): boolean { return this.connected; }
  getTargetExecutionState(): GDBTargetExecutionState { return this.executionState; }
  onUnexpectedExit(listener: (event: GDBUnexpectedExit) => void): () => void { this.unexpectedExitListener = listener; return () => { if (this.unexpectedExitListener === listener) this.unexpectedExitListener = undefined; }; }
  triggerUnexpectedExit(): void { this.connected = false; this.executionState = "unknown"; this.unexpectedExitListener?.({ exitCode: 9, exitSignal: null }); }
  async disconnect(): Promise<void> { this.connected = false; this.executionState = "unknown"; }
}

class FakeRtt extends RTTClient {
  connectCalls = 0;
  constructor() { super("localhost", 1); }
  override async connect(): Promise<void> { this.connectCalls += 1; }
  override disconnect(): void {}
  override isConnected(): boolean { return this.connectCalls > 0; }
}

class SessionProbe extends ProbeBackend {
  readonly type = "jlink" as const;
  readonly displayName = "session fake";
  haltCalls = 0;
  serverRunning = false;
  targetState: "running" | "halted" | "unknown" = "running";
  targetStateResult?: CommandResult;
  stopHook?: () => void;
  override async observeTargetState(): Promise<TargetStateObservation> {
    return { state: this.targetState, source: this.targetState === "unknown" ? "unavailable" : "dhcsr", result: this.targetStateResult ?? ok() };
  }
  async getDeviceInfo(): Promise<CommandResult> { return ok(); }
  async halt(): Promise<CommandResult> { this.haltCalls += 1; return ok(); }
  async resume(): Promise<CommandResult> { return ok(); }
  async reset(): Promise<CommandResult> { return ok(); }
  async step(): Promise<CommandResult> { return ok(); }
  async readMemory(): Promise<CommandResult> { return ok(); }
  async writeMemory(): Promise<CommandResult> { return ok(); }
  async readAllRegisters(): Promise<CommandResult> { return ok(); }
  async readRegister(): Promise<CommandResult> { return ok(); }
  async flash(): Promise<CommandResult> { return ok(); }
  async erase(): Promise<CommandResult> { return ok(); }
  async setBreakpoint(): Promise<CommandResult> { return ok(); }
  async clearBreakpoints(): Promise<CommandResult> { return ok(); }
  async startGDBServer(): Promise<{ success: boolean; message: string }> { this.serverRunning = true; return { success: true, message: "started" }; }
  async stopGDBServer(): Promise<{ success: boolean; message: string }> { this.stopHook?.(); this.serverRunning = false; return { success: true, message: "stopped" }; }
  isGDBServerRunning(): boolean { return this.serverRunning; }
  getGDBServerStatus(): GDBServerInfo { return { running: this.serverRunning, processId: this.serverRunning ? process.pid : undefined, gdbPort: 2331, rttTelnetPort: 19021 }; }
  getGDBServerOutput(): string[] { return []; }
  async executeRaw(): Promise<CommandResult> { return ok(); }
  isDeviceConfigured(): boolean { return true; }
  getDeviceName(): string { return "TEST"; }
  setDevice(): void {}
  async listDevices(): Promise<CommandResult> { return ok(); }
  dispose(): void {}
}

function ok(): CommandResult { return { success: true, rawOutput: "", output: "ok" }; }

function testDirectory(_context: TestContext, name: string): string {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-mcp-session-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for asynchronous state transition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
