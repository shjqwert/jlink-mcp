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
import { SessionOperations, type GdbAttachBoundaryEvidence, type SessionGdbClient } from "./session-operations";
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

test("raw GDB command preserves firmware identity and independently invalidates mutation trust", async (context) => {
  const fixtureValue = await fixture(context, "gdb-command", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  const command = "set $r0 = 0x1234";
  const result = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, command);
  assert.equal(result.ok, true);
  assert.deepEqual(fixtureValue.gdb.commands, [command]);
  assert.equal(result.artifact?.match, "verified");
  assert.equal(result.artifact?.firmwareIdentity, "verified");
  assert.equal(result.artifact?.mutationTrust, "unverified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.status, "verified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveMemoryMutationTrust.source, "gdb_command");
  assert.equal((result.data as { sideEffects: string }).sideEffects, "unknown");
});

test("managed breakpoint insertion invalidates firmware identity until Verify-only", async (context) => {
  const fixtureValue = await fixture(context, "gdb-flash-breakpoint-artifact", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.gdb.commandResult = {
    success: true,
    output: "Breakpoint 1",
    dispatchedCommand: "-break-insert -- OsUserConfig.c:60",
    commandDispatched: true,
    observedTargetExecutionState: "halted",
  };

  const result = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "break OsUserConfig.c:60");

  assert.equal(result.ok, true);
  assert.equal(result.artifact?.firmwareIdentity, "unverified");
  assert.equal(result.artifact?.mutationTrust, "unverified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.source, "gdb_breakpoint_insert");
});

test("raw GDB command without current state evidence invalidates cached state and blocks server stop", async (context) => {
  const fixtureValue = await fixture(context, "gdb-command-state-unknown");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.commandResult = { success: true, output: "done", rawOutput: "^done" };
  const command = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "monitor reset halt");
  assert.equal(command.ok, true);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(stopped.ok, false);
  assert.equal(stopped.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(fixtureValue.probe.serverRunning, true);
});

test("typed breakpoint listing preserves halted evidence and permits GDB close", async (context) => {
  const fixtureValue = await fixture(context, "gdb-breakpoint-list-close");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.gdb.commandResult = {
    success: true,
    output: "Num Type Disp Enb Address What\n1 breakpoint keep y 0x0001c0f2 JlinkTestFixtureTask1ms",
    rawOutput: "~\"Num Type Disp Enb Address What\\n\"\n^done\n(gdb)",
  };

  const listed = await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot);
  assert.equal(listed.ok, true, JSON.stringify(listed.error));
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
  assert.equal((listed.data as { targetExecutionState: string }).targetExecutionState, "halted");
  assert.match((listed.data as { output: string }).output, /breakpoint/);

  fixtureValue.probe.targetState = "halted";
  const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(closed.ok, true, JSON.stringify(closed.error));
  assert.equal(fixtureValue.probe.naturalExitWaitCalls, 1);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
});

test("GDB-014 typed breakpoint list-delete-list preserves halted close evidence", async (context) => {
  const fixtureValue = await fixture(context, "gdb-breakpoint-list-delete-close", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  await fixtureValue.targets.setMemoryMutationTrust(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.gdb.commandResult = {
    success: true,
    output: "Num Type Disp Enb Address What\n1 breakpoint keep y 0x0001c0f2 JlinkTestFixtureTask1ms",
  };
  const beforeDelete = await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot);
  assert.equal(beforeDelete.ok, true, JSON.stringify(beforeDelete.error));

  fixtureValue.gdb.commandResult = { success: true, output: "" };
  const deleted = await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1);
  assert.equal(deleted.ok, true, JSON.stringify(deleted.error));
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
  assert.equal(deleted.artifact?.firmwareIdentity, "verified");
  assert.equal(deleted.artifact?.mutationTrust, "unverified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveMemoryMutationTrust.source, "gdb_breakpoint_delete");

  fixtureValue.gdb.commandResult = { success: true, output: "No breakpoints or watchpoints." };
  const afterDelete = await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot);
  assert.equal(afterDelete.ok, true, JSON.stringify(afterDelete.error));
  assert.match((afterDelete.data as { output: string }).output, /No breakpoints/);
  assert.deepEqual(fixtureValue.gdb.commands, ["info breakpoints", "-break-delete 1", "info breakpoints"]);

  fixtureValue.probe.targetState = "halted";
  const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(closed.ok, true, JSON.stringify(closed.error));
  assert.equal((closed.data as { serverExitMode: string }).serverExitMode, "single_run_after_gdb_disconnect");
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
});

test("gdb_close accepts a clean single-run detach resume only after a fully managed breakpoint lifecycle", async (context) => {
  const fixtureValue = await fixture(context, "gdb-managed-breakpoint-detach-resume", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  const connected = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
  assert.equal(connected.ok, true, JSON.stringify(connected.error));

  fixtureValue.gdb.commandResult = {
    success: true,
    output: "Breakpoint 1",
    dispatchedCommand: "-break-insert -- OsUserConfig.c:60",
    commandDispatched: true,
    observedTargetExecutionState: "running",
  };
  const inserted = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "break OsUserConfig.c:60");
  assert.equal(inserted.ok, true, JSON.stringify(inserted.error));

  fixtureValue.gdb.waitResult = {
    success: true,
    output: "Target stopped: breakpoint-hit breakpoint #1",
    stopReason: "breakpoint-hit breakpoint #1 at OsUserConfig.c:60",
    observedTargetExecutionState: "halted",
  };
  const waited = await fixtureValue.sessions.gdbWait(fixtureValue.projectRoot);
  assert.equal(waited.ok, true, JSON.stringify(waited.error));

  fixtureValue.gdb.commandResult = {
    success: true,
    output: "Num Type Disp Enb Address What\n1 breakpoint keep y 0x0001c0f2 OsUserConfig.c:60",
  };
  assert.equal((await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot)).ok, true);

  fixtureValue.gdb.commandResult = { success: true, output: "" };
  assert.equal((await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1)).ok, true);

  fixtureValue.gdb.commandResult = { success: true, output: "No breakpoints or watchpoints." };
  assert.equal((await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot)).ok, true);

  fixtureValue.probe.targetState = "running";
  const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);

  assert.equal(closed.ok, true, JSON.stringify(closed.error));
  assert.equal((closed.data as { targetExecutionStateExpectedAfterClose: string }).targetExecutionStateExpectedAfterClose, "running");
  assert.equal((closed.data as { closeStateExpectationSource: string }).closeStateExpectationSource, "managed_breakpoint_detach_resume");
  assert.equal((closed.after as { targetExecutionState: string }).targetExecutionState, "running");
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
});

test("gdb_close rejects a single-run detach resume after a signal stop", async (context) => {
  const fixtureValue = await fixture(context, "gdb-signal-stop-detach-resume");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  assert.equal((await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true)).ok, true);

  fixtureValue.gdb.commandResult = {
    success: true,
    output: "Breakpoint 1",
    dispatchedCommand: "-break-insert -- OsUserConfig.c:60",
    commandDispatched: true,
    observedTargetExecutionState: "running",
  };
  assert.equal((await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "break OsUserConfig.c:60")).ok, true);

  fixtureValue.gdb.waitResult = {
    success: true,
    output: "Target stopped: signal-received signal SIGSEGV",
    stopReason: "signal-received signal SIGSEGV at HardFault_Handler()",
    observedTargetExecutionState: "halted",
  };
  assert.equal((await fixtureValue.sessions.gdbWait(fixtureValue.projectRoot)).ok, true);

  fixtureValue.probe.targetState = "running";
  const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);

  assert.equal(closed.ok, false);
  assert.equal(closed.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal((closed.data as { closeStateExpectationSource: string }).closeStateExpectationSource, "current_gdb_state");
  assert.equal((closed.data as { targetExecutionStateExpectedAfterClose: string }).targetExecutionStateExpectedAfterClose, "halted");
});

test("gdb_close rejects a breakpoint detach resume without typed cleanup evidence", async (context) => {
  const fixtureValue = await fixture(context, "gdb-breakpoint-detach-without-cleanup");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  assert.equal((await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true)).ok, true);

  fixtureValue.gdb.commandResult = {
    success: true,
    output: "Breakpoint 1",
    dispatchedCommand: "-break-insert -- OsUserConfig.c:60",
    commandDispatched: true,
    observedTargetExecutionState: "running",
  };
  assert.equal((await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "break OsUserConfig.c:60")).ok, true);
  fixtureValue.gdb.waitResult = {
    success: true,
    output: "Target stopped: breakpoint-hit breakpoint #1",
    stopReason: "breakpoint-hit breakpoint #1 at OsUserConfig.c:60",
    observedTargetExecutionState: "halted",
  };
  assert.equal((await fixtureValue.sessions.gdbWait(fixtureValue.projectRoot)).ok, true);

  fixtureValue.probe.targetState = "running";
  const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);

  assert.equal(closed.ok, false);
  assert.equal(closed.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal((closed.data as { targetExecutionStateExpectedAfterClose: string }).targetExecutionStateExpectedAfterClose, "halted");
});

test("gdb_close retains ownership when single-run Server cleanup is not observed", async (context) => {
  const fixtureValue = await fixture(context, "gdb-close-single-run-timeout", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.probe.naturalExitResult = false;

  const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);

  assert.equal(closed.ok, false);
  assert.equal(closed.error?.code, "GDB_SERVER_GRACEFUL_EXIT_TIMEOUT");
  assert.equal(closed.error?.writeIssued, true);
  assert.equal(closed.error?.stateUnknown, true);
  assert.equal(fixtureValue.probe.naturalExitWaitCalls, 1);
  assert.equal(fixtureValue.probe.stopCalls, 0);
  assert.equal(fixtureValue.probe.serverRunning, true);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)?.kind, "gdb");

  const retried = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(retried.ok, false);
  assert.equal(retried.error?.code, "GDB_SERVER_GRACEFUL_EXIT_TIMEOUT");
  assert.equal(fixtureValue.probe.naturalExitWaitCalls, 2);
  assert.equal(fixtureValue.probe.stopCalls, 0);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)?.kind, "gdb");
});

test("gdb_close rejects nonzero and signaled single-run Server exits", async (context) => {
  for (const item of [
    { name: "nonzero", exitCode: 3, signal: null },
    { name: "signal", exitCode: null, signal: "SIGTERM" as NodeJS.Signals },
  ]) {
    const fixtureValue = await fixture(context, `gdb-close-${item.name}`, true);
    await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
    fixtureValue.gdb.executionState = "halted";
    fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
    fixtureValue.probe.naturalExitClean = false;
    fixtureValue.probe.naturalExitCode = item.exitCode;
    fixtureValue.probe.naturalExitSignal = item.signal;

    const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);

    assert.equal(closed.ok, false, item.name);
    assert.equal(closed.error?.code, "GDB_SERVER_GRACEFUL_EXIT_UNCONFIRMED", item.name);
    assert.equal(closed.error?.stateUnknown, true, item.name);
    assert.equal(fixtureValue.probe.stopCalls, 0, item.name);
    assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)?.kind, "gdb", item.name);
  }
});

test("GDB-003 stopped next and finish evidence survives typed breakpoint listing and close", async (context) => {
  const fixtureValue = await fixture(context, "gdb-step-list-close");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  for (const command of ["next", "finish"]) {
    fixtureValue.gdb.commandResult = {
      success: true,
      output: `Stopped after ${command}`,
      rawOutput: '*stopped,reason="end-stepping-range",stopped-threads="all"\n^done\n(gdb)',
      observedTargetExecutionState: "halted",
    };
    const stepped = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, command);
    assert.equal(stepped.ok, true, JSON.stringify(stepped.error));
    assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");

    fixtureValue.gdb.commandResult = { success: true, output: "No breakpoints or watchpoints." };
    const listed = await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot);
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
  }

  fixtureValue.probe.targetState = "halted";
  const closed = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(closed.ok, true, JSON.stringify(closed.error));
});

test("typed breakpoint operations fail closed on unknown or changing execution state", async (context) => {
  const fixtureValue = await fixture(context, "gdb-breakpoint-state-gates");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "unknown";
  fixtureValue.runtime.gdbServerTargetExecutionState = "unknown";
  const unknownList = await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot);
  assert.equal(unknownList.error?.code, "TARGET_STATE_UNKNOWN");
  assert.deepEqual(fixtureValue.gdb.commands, []);

  fixtureValue.gdb.executionState = "running";
  fixtureValue.runtime.gdbServerTargetExecutionState = "running";
  const runningDelete = await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1);
  assert.equal(runningDelete.error?.code, "HALT_REQUIRED");
  assert.deepEqual(fixtureValue.gdb.commands, []);

  fixtureValue.runtime.gdbServerTargetExecutionState = "unknown";
  const runningUnknownDelete = await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1);
  assert.equal(runningUnknownDelete.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(runningUnknownDelete.error?.stateUnknown, true);
  assert.deepEqual(fixtureValue.gdb.commands, []);

  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  const mismatchedDelete = await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1);
  assert.equal(mismatchedDelete.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(mismatchedDelete.error?.stateUnknown, true);
  assert.deepEqual(fixtureValue.gdb.commands, []);

  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.gdb.commandResult = {
    success: true,
    output: "No breakpoints or watchpoints.",
    observedTargetExecutionState: "running",
  };
  const driftedList = await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot);
  assert.equal(driftedList.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(driftedList.error?.stateUnknown, false);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
});

test("typed breakpoint command failures prioritize observed execution-state drift", async (context) => {
  const fixtureValue = await fixture(context, "gdb-breakpoint-failure-drift", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.gdb.commandResult = {
    success: false,
    output: "partial",
    error: "command failed",
    code: "GDB_COMMAND_FAILED",
    observedTargetExecutionState: "running",
  };
  const listDrift = await fixtureValue.sessions.gdbBreakpointList(fixtureValue.projectRoot);
  assert.equal(listDrift.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(listDrift.error?.writeIssued, false);
  assert.equal((listDrift.data as { code: string }).code, "GDB_COMMAND_FAILED");

  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.gdb.commandResult = {
    success: false,
    output: "client exited",
    error: "GDB exited",
    code: "GDB_PROCESS_EXITED",
  };
  const deleteUnknown = await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1);
  assert.equal(deleteUnknown.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(deleteUnknown.error?.writeIssued, true);
  assert.equal(deleteUnknown.error?.stateUnknown, true);
  assert.equal((deleteUnknown.data as { code: string }).code, "GDB_PROCESS_EXITED");
  assert.equal(deleteUnknown.artifact?.firmwareIdentity, "verified");
  assert.equal(deleteUnknown.artifact?.mutationTrust, "unverified");
});

test("typed breakpoint delete preserves unissued facts when client state drifts before dispatch", async (context) => {
  const fixtureValue = await fixture(context, "gdb-breakpoint-predispatch-drift", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  await fixtureValue.targets.setMemoryMutationTrust(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.gdb.typedCommandHook = () => { fixtureValue.gdb.executionState = "running"; };

  const runningDrift = await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1);
  assert.equal(runningDrift.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(runningDrift.error?.writeIssued, false);
  assert.equal(runningDrift.error?.stateUnknown, false);
  assert.equal((runningDrift.data as { commandDispatched: boolean }).commandDispatched, false);
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveMemoryMutationTrust.status, "verified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveMemoryMutationTrust.source, "fixture");
  assert.deepEqual(fixtureValue.gdb.commands, []);

  fixtureValue.gdb.executionState = "halted";
  fixtureValue.runtime.gdbServerTargetExecutionState = "halted";
  fixtureValue.gdb.typedCommandHook = () => { fixtureValue.gdb.executionState = "unknown"; };
  const exitDrift = await fixtureValue.sessions.gdbBreakpointDelete(fixtureValue.projectRoot, 1);
  assert.equal(exitDrift.error?.code, "HIDDEN_STATE_CHANGE");
  assert.equal(exitDrift.error?.writeIssued, false);
  assert.equal(exitDrift.error?.stateUnknown, true);
  assert.equal((exitDrift.data as { commandDispatched: boolean }).commandDispatched, false);
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveMemoryMutationTrust.status, "verified");
  assert.deepEqual(fixtureValue.gdb.commands, []);
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
  fixtureValue.gdb.commandResult = { success: false, output: "partial output", rawOutput: "^running", dispatchedCommand: "-break-insert -- task", error: "timed out", code: "GDB_COMMAND_TIMEOUT", exitCode: 9, exitSignal: null };
  const result = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "monitor long-command", 25);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "GDB_COMMAND_TIMEOUT");
  assert.equal((result.data as { command: string }).command, "monitor long-command");
  assert.equal((result.data as { output: string }).output, "partial output");
  assert.equal((result.data as { rawOutput: string }).rawOutput, "^running");
  assert.equal((result.data as { dispatchedCommand: string }).dispatchedCommand, "-break-insert -- task");
  assert.equal((result.data as { exitCode: number }).exitCode, 9);
  assert.equal(result.artifact?.match, "verified");
  assert.equal(result.artifact?.firmwareIdentity, "verified");
  assert.equal(result.artifact?.mutationTrust, "unverified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.status, "verified");
  assert.equal(result.error?.stateUnknown, true);

  fixtureValue.gdb.executionState = "running";
  fixtureValue.gdb.commandResult = { success: false, output: "failed while running", error: "command failed", code: "GDB_COMMAND_FAILED", observedTargetExecutionState: "running" };
  const known = await fixtureValue.sessions.gdbCommand(fixtureValue.projectRoot, "monitor known-failure", 25);
  assert.equal(known.ok, false);
  assert.equal(known.error?.writeIssued, true);
  assert.equal(known.error?.stateUnknown, false);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
});

test("empty GDB interrupt window preserves firmware identity and explicit cleanup releases a running owner", async (context) => {
  const fixtureValue = await fixture(context, "gdb-empty-interrupt-window", true);
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  await fixtureValue.targets.setArtifactMatch(fixtureValue.projectRoot, "verified", "fixture");
  fixtureValue.gdb.executionState = "running";
  fixtureValue.gdb.commandResult = {
    success: false,
    output: "",
    rawOutput: "",
    dispatchedCommand: "-break-insert -- JlinkTestFixtureTask1ms",
    error: "empty interrupt MI window",
    code: "GDB_INTERRUPT_EMPTY_WINDOW",
    observedTargetExecutionState: "running",
  };

  const command = await fixtureValue.sessions.gdbCommand(
    fixtureValue.projectRoot,
    "break JlinkTestFixtureTask1ms",
    25,
  );

  assert.equal(command.ok, false);
  assert.equal(command.error?.code, "GDB_INTERRUPT_EMPTY_WINDOW");
  assert.equal(command.error?.stateUnknown, false);
  assert.equal(command.artifact?.firmwareIdentity, "verified");
  assert.equal(command.artifact?.mutationTrust, "unverified");
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial)?.kind, "gdb");

  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(stopped.ok, true, JSON.stringify(stopped.error));
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
  assert.equal((stopped.after as { targetExecutionState: string }).targetExecutionState, "running");
});

test("gdb_server_stop observes target after a timed-out client exits and safely releases owner", async (context) => {
  const fixtureValue = await fixture(context, "gdb-timeout-close-recovery");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.triggerUnexpectedExit();
  fixtureValue.probe.targetState = "running";
  fixtureValue.probe.rejectObservationWhileServerRunning = true;

  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);

  assert.equal(stopped.ok, true);
  assert.equal(stopped.before.targetExecutionState, "unknown");
  assert.equal(stopped.after.targetExecutionState, "running");
  assert.equal(fixtureValue.probe.serverRunning, false);
  assert.equal(fixtureValue.queue.getOwner(fixtureValue.target.probeSerial), undefined);
  assert.equal(fixtureValue.runtime.gdbOwnerToken, undefined);
  assert.equal(stopped.verification.method, "gdb_single_run_exit_and_post_server_probe_observation");
  assert.equal(fixtureValue.probe.naturalExitWaitCalls, 1);
  assert.match(stopped.warnings.join("\n"), /pre-close target state was unknown/i);
});

test("gdb_server_stop compares pre-Server evidence when no client ever connected", async (context) => {
  for (const item of [
    { name: "preserved", finalState: "running" as const, ok: true, code: undefined },
    { name: "changed", finalState: "halted" as const, ok: false, code: "HIDDEN_STATE_CHANGE" },
  ]) {
    const fixtureValue = await fixture(context, `gdb-stop-before-client-${item.name}`);
    fixtureValue.gdb.connected = false;
    await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
    assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
    fixtureValue.probe.targetState = item.finalState;

    const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);

    assert.equal(stopped.ok, item.ok, item.name);
    assert.equal(stopped.error?.code, item.code, item.name);
    assert.equal((stopped.before as { targetExecutionState: string }).targetExecutionState, "unknown", item.name);
    assert.equal(
      (stopped.before as { targetExecutionStateExpectedBeforeClose: string }).targetExecutionStateExpectedBeforeClose,
      "running",
      item.name,
    );
    assert.equal((stopped.after as { targetExecutionState: string }).targetExecutionState, item.finalState, item.name);
    assert.doesNotMatch(stopped.warnings.join("\n"), /client exited before close/i, item.name);
  }
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
  assert.equal(fixtureValue.runtime.gdbAttachBoundaryEvidence, undefined);
  assert.equal(fixtureValue.runtime.gdbInitialAttachBoundaryAvailable, false);
  const target = fixtureValue.targets.require(fixtureValue.projectRoot);
  assert.equal(target.liveArtifactMatch.status, "verified");
  assert.equal(target.liveArtifactMatch.source, "fixture");
  assert.equal(target.liveMemoryMutationTrust.status, "unverified");
  assert.equal(target.liveMemoryMutationTrust.source, "gdb_server_unexpected_exit");
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

test("GDB Server start preserves firmware identity and invalidates mutation trust on Probe identity loss", async (context) => {
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
  assert.equal(result.artifact?.match, "verified");
  assert.equal(result.artifact?.mutationTrust, "unverified");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveArtifactMatch.source, "fixture");
  assert.equal(fixtureValue.targets.require(fixtureValue.projectRoot).liveMemoryMutationTrust.source, "probe_connection_identity_lost");
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

test("GDB connect restores a normal attach halt to the requested running state", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-hidden-halt");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.connectResult = {
    success: true,
    output: "Stopped: signal-received signal SIGTRAP at main()",
    rawOutput: '*stopped,reason="signal-received",signal-name="SIGTRAP",frame={func="main"}\n^done',
    observedTargetExecutionState: "halted",
  };
  fixtureValue.gdb.commandResult = { success: true, output: "running", rawOutput: "^running", observedTargetExecutionState: "running" };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
  assert.equal(result.ok, true);
  assert.deepEqual(fixtureValue.gdb.commands, ["-exec-continue --all"]);
  assert.deepEqual(result.observedEffects, ["gdb_client_connected", "gdb_attach_halted_target", "target_state_restored:halted->running"]);
  assert.equal(fixtureValue.gdb.isConnected(), true);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
  assert.equal((result.data as { targetExecutionStateAfterConnect: string }).targetExecutionStateAfterConnect, "halted");
  assert.equal((result.data as { targetExecutionStateAfterRestore: string }).targetExecutionStateAfterRestore, "running");
});

test("GDB connect restores the audited RT-06 J-Link attach stop only with explicit authorization", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-jlink-no-reason-stop");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.connectResult = {
    success: true,
    output: "Stopped at prvCheckTasksWaitingTermination()",
    rawOutput: '&"target remote localhost:2331\\n"\r\n'
      + '~"Remote debugging using localhost:2331\\n"\r\n'
      + '*stopped,frame={addr="0x0001c0c4",func="prvCheckTasksWaitingTermination",args=[],file="Z:\\\\fixture\\\\RTOS\\\\FreeRTOS\\\\Source\\\\tasks.c",fullname="Z:\\\\fixture\\\\RTOS\\\\FreeRTOS\\\\Source\\\\tasks.c",line="3665",arch="armv7e-m"},thread-id="1",stopped-threads="all"\r\n'
      + "^done\r\n(gdb) \r\n",
    observedTargetExecutionState: "halted",
  };
  fixtureValue.gdb.commandResult = { success: true, output: "running", rawOutput: "^running", observedTargetExecutionState: "running" };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
  assert.equal(result.ok, true);
  assert.deepEqual(fixtureValue.gdb.commands, ["-exec-continue --all"]);
  assert.deepEqual(result.observedEffects, ["gdb_client_connected", "gdb_attach_halted_target", "target_state_restored:halted->running"]);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "running");
  assert.equal((result.data as { attachStopClassification: string }).attachStopClassification, "reasonless_attach_like_stop");
  assert.match(result.warnings.join("\n"), /could not distinguish.*application BKPT.*watchpoint.*fault/i);
});

test("GDB connect keeps the audited RT-06 J-Link attach stop halted without explicit authorization", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-jlink-no-restore-authorization");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.connectResult = {
    success: true,
    output: "Stopped at prvCheckTasksWaitingTermination()",
    rawOutput: '*stopped,frame={addr="0x0001c0c4",func="prvCheckTasksWaitingTermination",args=[],file="tasks.c",fullname="tasks.c",line="3665",arch="armv7e-m"},thread-id="1",stopped-threads="all"\r\n^done\r\n',
    observedTargetExecutionState: "halted",
  };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.deepEqual(fixtureValue.gdb.commands, []);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
});

test("GDB connect retains and reports a fault-handler stop without resuming it", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-fault-handler", false, "Cortex-M4");
  const started = await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
  fixtureValue.gdb.connectHook = () => {
    fixtureValue.probe.gdbOutput.push(
      "GDB client connected",
      "Target halted (PC = 0x000222EE): HardFault_Handler",
    );
  };
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.connectResult = {
    success: true,
    output: "HardFault_Handler () at startup.s:408",
    rawOutput: '*stopped,frame={func="HardFault_Handler"}\n^done',
    observedTargetExecutionState: "halted",
  };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "TARGET_FAULT_OBSERVED_AT_FIRST_GDB_FRAME");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, false);
  assert.deepEqual(fixtureValue.gdb.commands, []);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
  const startBoundary = (started.data as {
    attachBoundaryEvidence: {
      preServerObservation: { state: string; source: string; observedAt: string };
      serverReadyObservedAt: string;
      server: { processId: number; ownerToken: string; targetGeneration: string };
      profile: { configuredDevice: string; gdbDevice: string; effectiveGdbDevice: string };
      serverOutputAtReady: string[];
      serverReadinessEvidence: string;
      targetExecutionStateAtServerReady: string;
    };
  }).attachBoundaryEvidence;
  assert.equal(startBoundary.preServerObservation.state, "running");
  assert.equal(startBoundary.preServerObservation.source, "dhcsr");
  assert.match(startBoundary.preServerObservation.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(startBoundary.serverReadyObservedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(startBoundary.server.processId, process.pid);
  assert.equal(startBoundary.server.ownerToken, fixtureValue.runtime.gdbOwnerToken);
  assert.equal(startBoundary.server.targetGeneration, fixtureValue.target.generation);
  assert.equal(startBoundary.profile.configuredDevice, "TEST");
  assert.equal(startBoundary.profile.gdbDevice, "Cortex-M4");
  assert.equal(startBoundary.profile.effectiveGdbDevice, "Cortex-M4");
  assert.deepEqual(startBoundary.serverOutputAtReady, [
    "Listening on TCP/IP port 2331",
    "Waiting for GDB connection...",
  ]);
  assert.equal(startBoundary.serverReadinessEvidence, "waiting_for_gdb_client");
  assert.equal(startBoundary.targetExecutionStateAtServerReady, "not_observed");
  const faultEvidence = (result.data as {
    attachBoundaryEvidence: typeof startBoundary;
    serverOutputAtClientResponse: string[];
    firstGdbFrame: {
      observedAt: string;
      classification: string;
      causalAttribution: string;
      observationWindow: string;
    };
  });
  assert.deepEqual(faultEvidence.attachBoundaryEvidence, startBoundary);
  assert.deepEqual(faultEvidence.serverOutputAtClientResponse, [
    ...startBoundary.serverOutputAtReady,
    "GDB client connected",
    "Target halted (PC = 0x000222EE): HardFault_Handler",
  ]);
  assert.equal((result.data as { targetExecutionStateBeforeConnect: string }).targetExecutionStateBeforeConnect, "unknown");
  assert.equal((result.data as { targetExecutionStateExpectedAfterAttach: string }).targetExecutionStateExpectedAfterAttach, "running");
  assert.equal(faultEvidence.firstGdbFrame.classification, "fault_handler");
  assert.equal(faultEvidence.firstGdbFrame.causalAttribution, "indeterminate");
  assert.equal(
    faultEvidence.firstGdbFrame.observationWindow,
    "after_pre_server_observation_through_first_gdb_frame",
  );
  assert.match(faultEvidence.firstGdbFrame.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(result.error?.message ?? "", /cannot determine whether.*before or during.*Server attach/i);

  fixtureValue.probe.targetState = "halted";
  const stopped = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(stopped.ok, true);
  assert.equal(fixtureValue.runtime.gdbAttachBoundaryEvidence, undefined);
  assert.equal(fixtureValue.runtime.gdbInitialAttachBoundaryAvailable, false);
});

test("GDB connect keeps an unclassified attach stop halted", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-unclassified-stop");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.connectResult = {
    success: true,
    output: "Stopped at 0x00001234",
    rawOutput: '*stopped,frame={addr="0x00001234"}\n^done',
    observedTargetExecutionState: "halted",
  };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.deepEqual(fixtureValue.gdb.commands, []);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
});

test("GDB connect keeps an explicit breakpoint stop halted", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-breakpoint-stop");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.connectResult = {
    success: true,
    output: "Stopped at main()",
    rawOutput: '*stopped,reason="breakpoint-hit",frame={func="main"}\n^done',
    observedTargetExecutionState: "halted",
  };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE");
  assert.deepEqual(fixtureValue.gdb.commands, []);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted");
});

test("GDB connect authorization never resumes watchpoint or non-SIGTRAP signal stops", async (context) => {
  const cases = [
    {
      name: "watchpoint",
      rawOutput: '*stopped,reason="watchpoint-trigger",wpt={number="2",exp="counter"},frame={func="main"}\n^done',
    },
    {
      name: "non-sigtrap",
      rawOutput: '*stopped,reason="signal-received",signal-name="SIGSEGV",frame={func="main"}\n^done',
    },
  ];
  for (const item of cases) {
    const fixtureValue = await fixture(context, `gdb-connect-${item.name}-stop`);
    await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
    fixtureValue.gdb.executionState = "halted";
    fixtureValue.gdb.connectResult = {
      success: true,
      output: `Stopped: ${item.name}`,
      rawOutput: item.rawOutput,
      observedTargetExecutionState: "halted",
    };
    const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
    assert.equal(result.ok, false, item.name);
    assert.equal(result.error?.code, "HIDDEN_STATE_CHANGE", item.name);
    assert.deepEqual(fixtureValue.gdb.commands, [], item.name);
    assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "halted", item.name);
  }
});

test("GDB connect fails closed when an attach halt cannot be restored", async (context) => {
  const fixtureValue = await fixture(context, "gdb-connect-restore-failure");
  await fixtureValue.sessions.gdbServerStart(fixtureValue.projectRoot);
  fixtureValue.gdb.executionState = "halted";
  fixtureValue.gdb.connectResult = {
    success: true,
    output: "Stopped: signal-received signal SIGTRAP at main()",
    rawOutput: '*stopped,reason="signal-received",signal-name="SIGTRAP",frame={func="main"}\n^done',
    observedTargetExecutionState: "halted",
  };
  fixtureValue.gdb.commandResult = {
    success: false,
    output: "continue failed",
    rawOutput: '^error,msg="continue failed"',
    error: "continue failed",
    observedTargetExecutionState: "unknown",
  };
  const result = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot, undefined, true);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "GDB_ATTACH_STATE_RESTORE_FAILED");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, true);
  assert.deepEqual(fixtureValue.gdb.commands, ["-exec-continue --all"]);
  assert.equal(fixtureValue.runtime.gdbServerTargetExecutionState, "unknown");
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
  assert.equal(fixtureValue.runtime.gdbInitialAttachBoundaryAvailable, false);
  const second = await fixtureValue.sessions.gdbConnect(fixtureValue.projectRoot);
  assert.equal(second.error?.code, "TARGET_STATE_UNKNOWN");
  assert.equal(fixtureValue.gdb.connectCalls, 1);
  fixtureValue.probe.targetState = "halted";
  const cleanup = await fixtureValue.sessions.gdbServerStop(fixtureValue.projectRoot);
  assert.equal(cleanup.ok, false);
  assert.equal(cleanup.error?.code, "HIDDEN_STATE_CHANGE");
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

async function fixture(context: TestContext, name: string, withArtifact = false, gdbDevice?: string) {
  const root = testDirectory(context, name);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  if (withArtifact) writeFileSync(join(projectRoot, "firmware.elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const targets = new TargetStore(join(root, "state"));
  const target = await targets.configure({
    projectRoot,
    device: "TEST",
    gdbDevice,
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
    gdbAttachBoundaryEvidence: undefined as GdbAttachBoundaryEvidence | undefined,
    gdbInitialAttachBoundaryAvailable: false,
    gdbClientExitedUnexpectedly: false,
    gdbPreServerStateExpectationValid: false,
    gdbManagedBreakpointLifecycle: undefined,
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
  typedCommandHook?: () => void;
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
  async listBreakpoints(): Promise<GDBResponse> {
    return this.typedCommand("info breakpoints");
  }
  async deleteBreakpoint(breakpointId: number): Promise<GDBResponse> {
    return this.typedCommand(`-break-delete ${breakpointId}`, "halted");
  }
  private async typedCommand(command: string, requiredState?: GDBTargetExecutionState): Promise<GDBResponse> {
    this.typedCommandHook?.();
    if (
      this.executionState === "unknown"
      || (requiredState && this.executionState !== requiredState)
    ) {
      return {
        success: false,
        output: "",
        error: requiredState ? `typed GDB command requires target state ${requiredState}` : "typed GDB command requires a known target execution state",
        code: this.executionState === "unknown" ? "TARGET_STATE_UNKNOWN" : "HALT_REQUIRED",
        observedTargetExecutionState: this.executionState,
        commandDispatched: false,
      };
    }
    this.commands.push(command);
    if (this.commandResult.observedTargetExecutionState) {
      this.executionState = this.commandResult.observedTargetExecutionState;
      return { ...this.commandResult, commandDispatched: true };
    }
    if (!this.commandResult.success) {
      this.executionState = "unknown";
      return { ...this.commandResult, commandDispatched: true };
    }
    return { ...this.commandResult, preservedTargetExecutionState: this.executionState, commandDispatched: true };
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
  stopCalls = 0;
  naturalExitWaitCalls = 0;
  naturalExitResult = true;
  naturalExitClean = true;
  naturalExitCode: number | null = 0;
  naturalExitSignal: NodeJS.Signals | null = null;
  rejectObservationWhileServerRunning = false;
  gdbOutput: string[] = [];
  override async observeTargetState(): Promise<TargetStateObservation> {
    if (this.rejectObservationWhileServerRunning && this.serverRunning) throw new Error("Probe is owned by GDB Server");
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
  async startGDBServer(): Promise<{ success: boolean; message: string }> {
    this.serverRunning = true;
    this.gdbOutput = ["Listening on TCP/IP port 2331", "Waiting for GDB connection..."];
    return { success: true, message: "started" };
  }
  async waitForGDBServerExit() {
    this.naturalExitWaitCalls += 1;
    if (this.naturalExitResult) this.serverRunning = false;
    return {
      found: true,
      exited: this.naturalExitResult,
      clean: this.naturalExitResult && this.naturalExitClean,
      exitCode: this.naturalExitResult ? this.naturalExitCode : null,
      signal: this.naturalExitResult ? this.naturalExitSignal : null,
    };
  }
  async stopGDBServer(): Promise<{ success: boolean; message: string }> {
    this.stopCalls += 1;
    this.stopHook?.();
    this.serverRunning = false;
    return { success: true, message: "stopped" };
  }
  isGDBServerRunning(): boolean { return this.serverRunning; }
  getGDBServerStatus(): GDBServerInfo { return { running: this.serverRunning, processId: this.serverRunning ? process.pid : undefined, gdbPort: 2331, rttTelnetPort: 19021 }; }
  getGDBServerOutput(lines = 50): string[] { return this.gdbOutput.slice(-lines); }
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
