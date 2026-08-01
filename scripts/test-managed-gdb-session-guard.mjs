import assert from "node:assert/strict";
import test from "node:test";
import {
  ManagedTransportGate,
  breakpointInsertionRequiresCleanup,
  completeManagedBreakpointCleanup,
  parseBacktraceFrames,
  parseBreakpointRecords,
  recoverManagedBreakpointFailure,
} from "./managed-gdb-session-guard.mjs";

function textResult(response) {
  return { content: [{ type: "text", text: JSON.stringify(response) }] };
}

function haltedList(output) {
  return {
    ok: true,
    data: {
      success: true,
      commandDispatched: true,
      dispatchedCommand: "info breakpoints",
      output,
      sideEffects: "read_only",
      targetExecutionState: "halted",
      preservedTargetExecutionState: "halted",
    },
    after: { targetExecutionState: "halted" },
    verification: { status: "observed", method: "typed_read_only_gdb_command" },
  };
}

function haltedDelete(breakpointId) {
  return {
    ok: true,
    data: {
      success: true,
      commandDispatched: true,
      dispatchedCommand: `-break-delete ${breakpointId}`,
      breakpointId,
      targetExecutionState: "halted",
      preservedTargetExecutionState: "halted",
    },
    after: { targetExecutionState: "halted" },
    verification: { status: "observed", method: "typed_gdb_breakpoint_delete_and_state_preservation" },
  };
}

test("strict GDB text parsers accept frames and breakpoint tables", () => {
  assert.deepEqual(parseBacktraceFrames("#0  fixture ()\n#1  caller ()"), [
    { index: 0, text: "fixture ()" },
    { index: 1, text: "caller ()" },
  ]);
  assert.equal(parseBacktraceFrames("#1  missing frame zero"), null);
  assert.deepEqual(parseBreakpointRecords("Num Type Disp Enb Address What\n1 breakpoint keep y 0x00001234 in fixture"), [
    { id: 1, text: "breakpoint keep y 0x00001234 in fixture" },
  ]);
  assert.deepEqual(parseBreakpointRecords(
    "Num     Type           Disp Enb Address    What\n"
      + "1       breakpoint     keep y   0x000207b0 in JlinkTestFixtureTask1ms\n"
      + "\tbreakpoint already hit 1 time",
  ), [
    { id: 1, text: "breakpoint     keep y   0x000207b0 in JlinkTestFixtureTask1ms\nbreakpoint already hit 1 time" },
  ]);
  assert.deepEqual(parseBreakpointRecords("No breakpoints or watchpoints."), []);
  assert.equal(parseBreakpointRecords("note: No breakpoints or watchpoints."), null);
});

test("managed cleanup keeps one transport through owner-null verification", async () => {
  const calls = [];
  const responses = {
    gdb_backtrace: {
      ok: true,
      data: { success: true, dispatchedCommand: "bt full", output: "#0  fixture ()" },
      after: { targetExecutionState: "halted" },
      verification: { status: "observed", method: "gdb_response" },
    },
    gdb_breakpoint_list: [
      haltedList("Num Type Disp Enb Address What\n1 breakpoint keep y 0x00001234 in fixture"),
      haltedList("No breakpoints or watchpoints."),
    ],
    gdb_breakpoint_delete: haltedDelete(1),
    gdb_command: {
      ok: true,
      data: {
        success: true,
        commandDispatched: true,
        dispatchedCommand: "continue",
        observedTargetExecutionState: "running",
      },
      after: { targetExecutionState: "running" },
    },
    gdb_close: { ok: true },
    target_status: { ok: true, data: { owner: null } },
  };
  const client = { closed: false, close: async () => { client.closed = true; } };
  const transport = { closed: false, close: async () => { transport.closed = true; } };
  const gate = new ManagedTransportGate({
    client,
    transport,
    callTool: async (name) => {
      calls.push(name);
      const response = Array.isArray(responses[name]) ? responses[name].shift() : responses[name];
      return textResult(response);
    },
  });
  gate.gdbOpened = true;
  gate.lastWaitResponse = { ok: true, data: { stopReason: "breakpoint-hit breakpoint #1 at fixture" } };

  const cleanup = await completeManagedBreakpointCleanup(gate, {
    projectRoot: "D:/target",
    breakpointId: 1,
    resumeBeforeClose: true,
  });
  assert.equal(cleanup.safeToClose, true);
  assert.deepEqual(calls, [
    "gdb_backtrace",
    "gdb_breakpoint_list",
    "gdb_breakpoint_delete",
    "gdb_breakpoint_list",
    "gdb_command",
    "gdb_close",
    "target_status",
  ]);
  await gate.closeIfSafe();
  assert.equal(client.closed, true);
  assert.equal(transport.closed, true);
});

test("cleanup failure refuses to close a live transport", async () => {
  const gate = new ManagedTransportGate({
    client: { close: async () => assert.fail("client must remain open") },
    transport: { close: async () => assert.fail("transport must remain open") },
    callTool: async (name) => {
      if (name === "gdb_backtrace") {
        return textResult({
          ok: true,
          data: { success: true, dispatchedCommand: "bt full", output: "#0  fixture ()" },
          after: { targetExecutionState: "halted" },
          verification: { status: "observed", method: "gdb_response" },
        });
      }
      if (name === "gdb_breakpoint_list") return textResult(haltedList("No breakpoints or watchpoints."));
      throw new Error(`unexpected call ${name}`);
    },
  });
  gate.gdbOpened = true;
  gate.lastWaitResponse = { ok: true, data: { stopReason: "breakpoint-hit breakpoint #1 at fixture" } };

  await assert.rejects(
    completeManagedBreakpointCleanup(gate, { projectRoot: "D:/target", breakpointId: 1 }),
    /GDB_BREAKPOINT_LIST_MISSING_EXPECTED_ID/,
  );
  assert.equal(gate.preserveLiveTransport, true);
  await assert.rejects(gate.closeIfSafe(), /LIVE_TRANSPORT_MUST_BE_PRESERVED/);
});

test("cleanup rejects a delete response without typed dispatch evidence", async () => {
  const gate = new ManagedTransportGate({
    client: { close: async () => assert.fail("client must remain open") },
    transport: { close: async () => assert.fail("transport must remain open") },
    callTool: async (name) => {
      if (name === "gdb_backtrace") {
        return textResult({
          ok: true,
          data: { success: true, dispatchedCommand: "bt full", output: "#0  fixture ()" },
          after: { targetExecutionState: "halted" },
          verification: { status: "observed", method: "gdb_response" },
        });
      }
      if (name === "gdb_breakpoint_list") {
        return textResult(haltedList("Num Type Disp Enb Address What\n1 breakpoint keep y 0x00001234 in fixture"));
      }
      if (name === "gdb_breakpoint_delete") return textResult({ ok: true, data: { breakpointId: 1 } });
      throw new Error(`unexpected call ${name}`);
    },
  });
  gate.gdbOpened = true;
  gate.lastWaitResponse = { ok: true, data: { stopReason: "breakpoint-hit breakpoint #1 at fixture" } };

  await assert.rejects(
    completeManagedBreakpointCleanup(gate, { projectRoot: "D:/target", breakpointId: 1 }),
    /GDB_BREAKPOINT_DELETE_EVIDENCE_UNCONFIRMED/,
  );
  await assert.rejects(gate.closeIfSafe(), /LIVE_TRANSPORT_MUST_BE_PRESERVED/);
});

test("failed MCP calls retain the parsed response for deterministic cleanup", async () => {
  const gate = new ManagedTransportGate({
    client: { close: async () => undefined },
    transport: { close: async () => undefined },
    callTool: async () => textResult({
      ok: false,
      error: { code: "HIDDEN_STATE_CHANGE" },
      observedEffects: ["gdb_server_stopped", "gdb_owner_released"],
    }),
  });

  await assert.rejects(
    gate.call("gdb_open", { projectRoot: "D:/target" }),
    (error) => error.call?.response?.error?.code === "HIDDEN_STATE_CHANGE",
  );
  assert.equal(gate.preserveLiveTransport, true);
});

test("ambiguous breakpoint insertion failures remain cleanup-required", () => {
  assert.equal(breakpointInsertionRequiresCleanup({ attempted: false, succeeded: false }), false);
  assert.equal(breakpointInsertionRequiresCleanup({
    attempted: true,
    succeeded: false,
    error: {
      call: {
        name: "gdb_command",
        response: { error: { writeIssued: false }, data: { commandDispatched: false } },
      },
    },
  }), false);
  assert.equal(breakpointInsertionRequiresCleanup({
    attempted: true,
    succeeded: false,
    error: {
      call: {
        name: "gdb_command",
        response: { error: { writeIssued: false }, data: { commandDispatched: true } },
      },
    },
  }), true);
  assert.equal(breakpointInsertionRequiresCleanup({
    attempted: true,
    succeeded: false,
    error: new Error("transport timed out after possible dispatch"),
  }), true);
  assert.equal(breakpointInsertionRequiresCleanup({ attempted: true, succeeded: true }), true);
});

test("breakpoint failure recovery reuses an already completed first close", async () => {
  const calls = [];
  const close = {
    name: "gdb_close",
    response: {
      ok: false,
      after: {
        owner: null,
        probe: { gdbServer: { running: false } },
      },
      observedEffects: ["gdb_server_stopped", "gdb_owner_released"],
      data: {
        flashBreakpointCleanup: {
          success: true,
          commandDispatched: true,
          preservedTargetExecutionState: "halted",
        },
      },
    },
  };
  const originalError = Object.assign(new Error("gdb_close HIDDEN_STATE_CHANGE"), { call: close });
  const gate = new ManagedTransportGate({
    client: { close: async () => undefined },
    transport: { close: async () => undefined },
    callTool: async (name) => {
      calls.push(name);
      if (name !== "target_status") throw new Error(`unexpected repeated call ${name}`);
      return textResult({ ok: true, data: { owner: null } });
    },
  });
  gate.gdbOpened = true;
  gate.preserveLiveTransport = true;

  const recovery = await recoverManagedBreakpointFailure(gate, {
    projectRoot: "D:/target",
    originalError,
  });

  assert.equal(recovery.reusedOriginalClose, true);
  assert.equal(recovery.close, close);
  assert.deepEqual(calls, ["target_status"]);
  assert.equal(gate.gdbCloseConfirmed, true);
  assert.equal(gate.ownerNullConfirmed, true);
  assert.equal(gate.preserveLiveTransport, false);
});
