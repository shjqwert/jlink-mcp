import assert from "node:assert/strict";
import test from "node:test";
import { TaskOperations, type TaskOperationServices } from "./task-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./operation-envelope";

test("debug run_to composes a complete managed breakpoint lifecycle in one task call", async () => {
  const calls: string[] = [];
  const operations = taskOperations({
    targets: { require: () => configuredTarget() },
    sessions: sessionStub(calls),
  });

  const result = await operations.debug("C:\\project", "run_to", { location: "MainTask", timeoutMs: 5_000 });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.tool, "debug");
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "continue", "wait", "backtrace", "delete:3", "list", "server_stop"]);
  const data = result.data as { action: string; steps: Array<Record<string, unknown>> };
  assert.equal(data.action, "run_to");
  assert.equal(result.verification.method, "managed_task_workflow");
  const insertReceipt = data.steps.find((step) => step.tool === "gdb_command" && (step.data as { managedBreakpointId?: number } | undefined)?.managedBreakpointId === 3);
  assert.ok(insertReceipt);
  assert.equal((insertReceipt.data as { rawOutput?: string }).rawOutput, undefined, "normal workflow receipt must omit internal GDB transport output");
  assert.deepEqual((data.steps.find((step) => step.tool === "gdb_backtrace")?.data as { frames: unknown[] }).frames, []);
  assert.equal((data.steps.find((step) => step.tool === "gdb_breakpoint_list")?.data as { output: string }).output, "No breakpoints or watchpoints.");
  const details = result.details as { kind: string; steps: OperationEnvelope[] };
  assert.equal(details.kind, "task_workflow");
  assert.equal(details.steps.length, data.steps.length);
  assert.match((details.steps.find((step) => step.tool === "gdb_command" && String((step.data as { rawOutput?: string }).rawOutput).includes("number=\"3\""))?.data as { rawOutput: string }).rawOutput, /number="3"/);
});

test("debug run_to closes its managed session after breakpoint failure", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbCommand = async () => {
    calls.push("break");
    return failed("gdb_command", "BREAKPOINT_FAILED");
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "MissingSymbol" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "BREAKPOINT_FAILED");
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "server_stop"]);
});

test("debug run_to aborts a failed running-target breakpoint after dispatch", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbConnect = async () => {
    calls.push("connect:false:true");
    return succeeded("gdb_connect", { targetExecutionStateAfterConnect: "running" });
  };
  sessions.gdbCommand = async () => {
    calls.push("break");
    const result = failed("gdb_command", "BREAKPOINT_FAILED", false, true);
    result.data = { commandDispatched: true, observedTargetExecutionState: "running" };
    return result;
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "MissingSymbol" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "BREAKPOINT_FAILED");
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "abort", "server_stop"]);
});

test("debug run_to attempts cleanup and reports uncertainty after an unexpected exception", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbWait = async () => {
    calls.push("wait");
    throw new Error("transport disappeared after breakpoint dispatch");
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "MainTask" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_WORKFLOW_EXCEPTION");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, true);
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "continue", "wait", "server_stop"]);
});

test("debug run_to preserves a later cleanup uncertainty without replacing the first failure", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbBacktrace = async () => {
    calls.push("backtrace");
    return failed("gdb_backtrace", "BACKTRACE_FAILED");
  };
  sessions.gdbBreakpointDelete = async () => {
    calls.push("delete:3");
    return failed("gdb_breakpoint_delete", "BREAKPOINT_DELETE_UNCERTAIN", true, true);
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "MainTask" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "BACKTRACE_FAILED");
  assert.equal(result.error?.writeIssued, true);
  assert.equal(result.error?.stateUnknown, true);
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "continue", "wait", "backtrace", "delete:3", "server_stop"]);
});

test("debug run_to aborts and releases its managed breakpoint after timeout", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbWait = async () => {
    calls.push("wait");
    return succeeded("gdb_wait", { stopReason: "running", observedTargetExecutionState: "running" });
  };
  sessions.gdbAbortManagedBreakpoint = async () => {
    calls.push("abort");
    const result = succeeded("gdb_managed_breakpoint_abort", { restored: { observedTargetExecutionState: "running" } }, ["gdb_server_breakpoints_cleared"]);
    result.after = { targetExecutionState: "running" };
    return result;
  };
  sessions.gdbServerStop = async () => {
    calls.push("server_stop");
    return succeeded("gdb_server_stop", { status: { running: false }, serverExitObservation: { clean: true } }, ["gdb_owner_released"]);
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "NeverRuns", timeoutMs: 25 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_RUN_TO_TIMEOUT");
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "continue", "wait", "abort", "server_stop"]);
  const steps = (result.data as { steps: Array<Record<string, unknown>> }).steps;
  assert.deepEqual(steps.find((step) => step.tool === "gdb_managed_breakpoint_abort")?.after, { targetExecutionState: "running" });
  assert.deepEqual(steps.find((step) => step.tool === "gdb_server_stop")?.observedEffects, ["gdb_owner_released"]);
});

test("debug run_to rejects and cleans an unrelated stop", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbWait = async () => {
    calls.push("wait");
    return succeeded("gdb_wait", { stopReason: "signal-received signal SIGSEGV at HardFault_Handler()", observedTargetExecutionState: "halted" });
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "MainTask" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_RUN_TO_UNEXPECTED_STOP");
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "continue", "wait", "abort", "server_stop"]);
});

test("debug run_to matches the exact managed breakpoint number", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbWait = async () => {
    calls.push("wait");
    return succeeded("gdb_wait", { stopReason: "breakpoint-hit breakpoint #30", observedTargetExecutionState: "halted" });
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "MainTask" });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_RUN_TO_UNEXPECTED_STOP");
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "continue", "wait", "abort", "server_stop"]);
});

test("debug run_to does not continue twice when attach remained running", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.gdbConnect = async () => {
    calls.push("connect:false:true");
    return succeeded("gdb_connect", { targetExecutionStateAfterConnect: "running" });
  };
  const operations = taskOperations({ targets: { require: () => configuredTarget() }, sessions });

  const result = await operations.debug("C:\\project", "run_to", { location: "MainTask" });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(calls, ["server_start", "connect:false:true", "break", "wait", "backtrace", "delete:3", "list", "server_stop"]);
});

test("RTT window preserves an existing session and owns a temporary session otherwise", async () => {
  for (const alreadyConnected of [true, false]) {
    const calls: string[] = [];
    const sessions = sessionStub(calls);
    sessions.rttIsConnected = async () => alreadyConnected;
    const operations = taskOperations({ sessions });

    const result = await operations.trace("C:\\project", "rtt_window", { durationMs: 0, count: 7 });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(calls, alreadyConnected ? ["rtt_read:7"] : ["rtt_connect", "rtt_read:7", "rtt_disconnect"]);
    const data = result.data as { preservedExistingSession: boolean; steps: Array<Record<string, unknown>> };
    assert.equal(data.preservedExistingSession, alreadyConnected);
    assert.deepEqual(data.steps.find((step) => step.tool === "rtt_read")?.data, { lines: [] });
  }
});

test("RTT workflow effects never masquerade as a target write", async () => {
  const calls: string[] = [];
  const sessions = sessionStub(calls);
  sessions.rttConnect = async () => {
    calls.push("rtt_connect");
    return succeeded("rtt_connect", null, ["rtt_connected"]);
  };
  sessions.rttRead = async () => {
    calls.push("rtt_read:1");
    return failed("rtt_read", "RTT_READ_FAILED");
  };
  sessions.rttDisconnect = async () => {
    calls.push("rtt_disconnect");
    return succeeded("rtt_disconnect", null, ["rtt_disconnected"]);
  };
  const operations = taskOperations({ sessions });

  const result = await operations.trace("C:\\project", "rtt_window", { durationMs: 0, count: 1 });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "RTT_READ_FAILED");
  assert.equal(result.error?.writeIssued, false);
  assert.deepEqual(calls, ["rtt_connect", "rtt_read:1", "rtt_disconnect"]);
});

test("HSS window delegates preflight, timed capture, and final cleanup to DebugSequenceExecutor", async () => {
  let sequenceInput: Record<string, unknown> | undefined;
  const operations = taskOperations({
    sequence: {
      execute: async (input: Record<string, unknown>) => {
        sequenceInput = input;
        return succeeded("debug_sequence_execute", { captureId: "fixture" });
      },
    },
  });

  const result = await operations.trace("C:\\project", "hss_window", {
    variables: [{ ref: "counter" }],
    rateHz: 10,
    durationSec: 2,
    actions: [
      { atMs: 500, action: "write_variable", ref: "control", value: 1, verify: true },
      { atMs: 1_000, action: "read_variable", ref: "feedback" },
      { atMs: 1_500, action: "target_control", control: "continue" },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.tool, "trace");
  assert.deepEqual(sequenceInput?.steps, [
    {
      atMs: 0, action: "hss_start", variables: [{ ref: "counter" }, { ref: "feedback" }],
      writeVariables: ["control"], rateHz: 10, durationSec: 2,
    },
    { atMs: 500, action: "write_variable", ref: "control", value: 1, verify: true },
    { atMs: 1_000, action: "read_variable", ref: "feedback" },
    { atMs: 1_500, action: "target_control", control: "continue" },
    { atMs: 2_000, action: "hss_stop" },
  ]);
  assert.deepEqual(sequenceInput?.cleanup, [{ action: "hss_stop" }]);
});

test("HSS window rejects active halt, pause, reset, and recover actions before dispatch", async () => {
  let dispatched = false;
  const operations = taskOperations({
    sequence: {
      execute: async () => {
        dispatched = true;
        return succeeded("debug_sequence_execute");
      },
    },
  });

  for (const control of ["halt", "pause", "reset", "recover"]) {
    const result = await operations.trace("C:\\project", "hss_window", {
      variables: [{ ref: "counter" }], rateHz: 10, durationSec: 2,
      actions: [{ atMs: 500, action: "target_control", control }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "ACTION_INPUT_INVALID");
    assert.match(result.error?.message ?? "", /supports only resume or continue/);
  }
  assert.equal(dispatched, false);
});

function taskOperations(overrides: Record<string, unknown>): TaskOperations {
  const services = {
    discoveryProbe: {},
    targets: { require: () => configuredTarget() },
    direct: {},
    runtimes: {},
    artifacts: {},
    variables: {},
    registers: {},
    sessions: sessionStub([]),
    hss: {},
    captures: {},
    sequence: {},
    ...overrides,
  } as unknown as TaskOperationServices;
  return new TaskOperations(services);
}

function sessionStub(calls: string[]): Record<string, (...args: never[]) => Promise<unknown>> {
  return {
    gdbServerStart: async () => { calls.push("server_start"); return succeeded("gdb_server_start"); },
    gdbConnect: async (_root: never, _artifact: never, restore: never, retain: never) => {
      calls.push(`connect:${restore}:${retain}`);
      return succeeded("gdb_connect", { targetExecutionStateAfterConnect: "halted", retainedClassifiedAttachHaltForManagedBreakpoint: true });
    },
    gdbCommand: async (_root: never, command: never) => {
      if (command === "-exec-continue --all") {
        calls.push("continue");
        return succeeded("gdb_command", { observedTargetExecutionState: "running" });
      }
      calls.push("break");
      return succeeded("gdb_command", {
        output: "",
        rawOutput: '^done,bkpt={number="3",type="breakpoint",func="MainTask"}\r\n(gdb) \r\n',
      });
    },
    gdbWait: async () => { calls.push("wait"); return succeeded("gdb_wait", { stopReason: "breakpoint-hit breakpoint #3", observedTargetExecutionState: "halted" }); },
    gdbBacktrace: async () => { calls.push("backtrace"); return succeeded("gdb_backtrace", { frames: [] }); },
    gdbBreakpointDelete: async (_root: never, id: never) => { calls.push(`delete:${id}`); return succeeded("gdb_breakpoint_delete"); },
    gdbBreakpointList: async () => { calls.push("list"); return succeeded("gdb_breakpoint_list", { output: "No breakpoints or watchpoints." }); },
    gdbAbortManagedBreakpoint: async () => { calls.push("abort"); return succeeded("gdb_managed_breakpoint_abort"); },
    gdbServerStop: async () => { calls.push("server_stop"); return succeeded("gdb_server_stop"); },
    rttIsConnected: async () => false,
    rttConnect: async () => { calls.push("rtt_connect"); return succeeded("rtt_connect"); },
    rttRead: async (_root: never, count: never) => { calls.push(`rtt_read:${count}`); return succeeded("rtt_read", { lines: [] }); },
    rttSearch: async () => { calls.push("rtt_search"); return succeeded("rtt_search", { matches: [] }); },
    rttDisconnect: async () => { calls.push("rtt_disconnect"); return succeeded("rtt_disconnect"); },
  };
}

function configuredTarget(): Record<string, unknown> {
  return {
    projectRoot: "C:\\project",
    generation: "43000000-0000-4000-8000-000000000001",
    device: "TEST",
    gdbDevice: "Cortex-M4",
    probeSerial: "123456",
    interface: "SWD",
    speed: 1_000,
    artifact: { path: "C:\\project\\firmware.elf" },
  };
}

function succeeded(tool: string, data: unknown = null, observedEffects: string[] = []): OperationEnvelope {
  const envelope = createOperationEnvelope(tool);
  envelope.data = data;
  envelope.observedEffects = observedEffects;
  envelope.verification = { status: "verified", method: "fixture" };
  return finishEnvelope(envelope, true);
}

function failed(tool: string, code: string, stateUnknown = false, writeIssued = false): OperationEnvelope {
  return failEnvelope(createOperationEnvelope(tool), {
    code,
    stage: "fixture",
    message: code,
    retryable: false,
    writeIssued,
    stateUnknown,
  });
}
