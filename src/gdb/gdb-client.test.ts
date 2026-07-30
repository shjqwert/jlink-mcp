import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { GDBClient, type GdbSpawn } from "./gdb-client";

test("GDBClient reports caller timeout and observes client exit before returning", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const spawnProcess: GdbSpawn = () => createFakeGdbProcess(signals);
  const client = new GDBClient("fake-gdb", undefined, spawnProcess);
  const connected = await client.connect("localhost", 2331);
  assert.equal(connected.success, true);

  const startedAt = Date.now();
  const result = await client.command("maintenance hang", 20);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.success, false);
  assert.equal(result.code, "GDB_COMMAND_TIMEOUT");
  assert.equal(result.dispatchedCommand, "maintenance hang");
  assert.match(result.error ?? "", /20ms/);
  assert.equal(signals[0], "SIGTERM");
  assert.equal(client.isConnected(), false);
  assert.ok(elapsed >= 40, `command returned before fake process exit was observed (${elapsed}ms)`);
});

test("GDBClient does not treat an MI error containing connected text as success", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, '^error,msg="Remote is not connected"\n(gdb)\n'));
  const result = await client.connect("localhost", 2331);
  assert.equal(result.success, false);
  assert.match(result.rawOutput ?? "", /\^error/);
  assert.equal(client.isConnected(), false);
  assert.equal(signals[0], "SIGTERM");
});

test("GDBClient accepts the standard line-anchored MI connected result class", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, "^connected\n(gdb)\n"));
  const result = await client.connect("localhost", 2331);
  assert.equal(result.success, true);
  assert.equal(client.isConnected(), true);
  await client.disconnect();
});

test("GDBClient accepts an MI prompt with trailing horizontal whitespace", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient(
    "fake-gdb",
    undefined,
    () => createFakeGdbProcess(signals, "^connected\n(gdb) \r\n", false, false, undefined, false, "(gdb) \r\n"),
  );
  const result = await client.connect("localhost", 2331);
  assert.equal(result.success, true);
  assert.equal(client.isConnected(), true);
  await client.disconnect();
});

test("GDBClient uses the native MI breakpoint transaction while the target runs", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const child = createFakeGdbProcess(signals, undefined, false, false, commands);
  const client = new GDBClient("fake-gdb", undefined, () => child);

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.deepEqual(commands.slice(0, 2), ["-gdb-set mi-async on", "target remote localhost:2331"]);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);
  assert.equal(breakpoint.success, true);
  assert.match(breakpoint.rawOutput ?? "", /\^done[\s\S]*\*stopped,reason="signal-received",signal-name="SIGINT"[\s\S]*\^done[\s\S]*\^running/);
  assert.equal(breakpoint.dispatchedCommand, "-break-insert -- JlinkTestFixtureTask1ms");
  assert.deepEqual(commands.slice(-3), [
    "-exec-interrupt --all",
    "-break-insert -- JlinkTestFixtureTask1ms",
    "-exec-continue --all",
  ]);
  assert.equal(breakpoint.observedTargetExecutionState, "running");
  await client.disconnect();
});

test("GDBClient refuses breakpoint insertion and auto-resume after a non-SIGINT stop", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    { interruptStopOutput: '*stopped,reason="signal-received",signal-name="SIGSEGV",thread-id="1"\n' },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, false);
  assert.equal(breakpoint.code, "GDB_BREAKPOINT_TRANSACTION_STOP_UNSAFE");
  assert.equal(breakpoint.observedTargetExecutionState, "halted");
  assert.match(breakpoint.stopReason ?? "", /SIGSEGV/);
  assert.deepEqual(commands.slice(-1), ["-exec-interrupt --all"]);
  assert.equal(client.isConnected(), true);
  assert.deepEqual(signals, []);
  await client.disconnect();
});

test("GDBClient accepts the documented reasonless SIGINT stop from exec-interrupt", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    { interruptStopOutput: '*stopped,signal-name="SIGINT",thread-id="1"\n' },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, true);
  assert.equal(breakpoint.observedTargetExecutionState, "running");
  assert.deepEqual(commands.slice(-3), [
    "-exec-interrupt --all",
    "-break-insert -- JlinkTestFixtureTask1ms",
    "-exec-continue --all",
  ]);
  await client.disconnect();
});

test("GDBClient disconnect uses the MI exit command and observes graceful process exit", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, undefined, false, false, commands));
  assert.equal((await client.connect("localhost", 2331)).success, true);

  await client.disconnect();

  assert.equal(commands.at(-1), "-gdb-exit");
  assert.deepEqual(signals, []);
});

test("GDBClient refuses an un-tokened SIGTRAP stop whose interrupt causality is unproven", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    {
      interruptStopOutput: '*stopped,reason="signal-received",signal-name="SIGTRAP",stopped-threads="all"\n',
      interruptStopToken: "none",
    },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("-exec-continue --all")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, false, JSON.stringify(breakpoint));
  assert.equal(breakpoint.code, "GDB_BREAKPOINT_TRANSACTION_STOP_UNSAFE");
  assert.equal(breakpoint.observedTargetExecutionState, "halted");
  const interruptToken = breakpoint.rawOutput?.match(/(?:^|\n)(\d+)\^done(?:\r?\n)/)?.[1];
  const stoppedToken = breakpoint.rawOutput?.match(/(?:^|\n)(\d+)\*stopped,[^\r\n]*signal-name="SIGTRAP"/)?.[1];
  assert.ok(interruptToken);
  assert.equal(stoppedToken, undefined);
  assert.deepEqual(commands.slice(-1), ["-exec-interrupt --all"]);
  assert.equal(commands.filter((command) => command === "-exec-continue --all").length, 1);
  await client.disconnect();
});

test("GDBClient drains and rejects a stop that predates the MI interrupt transaction", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    {
      delayedIdleStopAfterContinue: '*stopped,reason="signal-received",signal-name="SIGTRAP",stopped-threads="all"\n',
      interruptSuppressStop: true,
    },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("-exec-continue --all")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, false, JSON.stringify({ breakpoint, commands }));
  assert.equal(breakpoint.code, "GDB_BREAKPOINT_TRANSACTION_STOP_UNSAFE");
  assert.equal(breakpoint.observedTargetExecutionState, "halted");
  assert.deepEqual(commands.slice(-1), ["-exec-continue --all"]);
  await client.disconnect();
});

test("GDBClient rejects every incomplete SIGTRAP interrupt isolation", async (t) => {
  const unsafeCases: Array<{
    name: string;
    interruptStopOutput: string;
    interruptStopToken?: "active" | "none" | "wrong";
    interruptStopBeforeDone?: boolean;
  }> = [
    {
      name: "wrong execution token",
      interruptStopOutput: '*stopped,reason="signal-received",signal-name="SIGTRAP",stopped-threads="all"\n',
      interruptStopToken: "wrong",
    },
    {
      name: "stop precedes interrupt result",
      interruptStopOutput: '*stopped,reason="signal-received",signal-name="SIGTRAP",stopped-threads="all"\n',
      interruptStopBeforeDone: true,
    },
    {
      name: "multiple stops",
      interruptStopOutput: [
        '*stopped,reason="signal-received",signal-name="SIGTRAP",stopped-threads="all"',
        '*stopped,reason="signal-received",signal-name="SIGTRAP",stopped-threads="all"',
        "",
      ].join("\n"),
    },
    {
      name: "wrong stop reason",
      interruptStopOutput: '*stopped,reason="breakpoint-hit",signal-name="SIGTRAP",stopped-threads="all"\n',
    },
    {
      name: "wrong signal",
      interruptStopOutput: '*stopped,reason="signal-received",signal-name="SIGSEGV",stopped-threads="all"\n',
    },
    {
      name: "missing all-thread scope",
      interruptStopOutput: '*stopped,reason="signal-received",signal-name="SIGTRAP",thread-id="1"\n',
    },
  ];

  for (const unsafeCase of unsafeCases) {
    await t.test(unsafeCase.name, async () => {
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const commands: string[] = [];
      const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
        signals,
        undefined,
        false,
        false,
        commands,
        false,
        "(gdb)\n",
        false,
        false,
        false,
        unsafeCase,
      ));

      assert.equal((await client.connect("localhost", 2331)).success, true);
      assert.equal((await client.command("-exec-continue --all")).observedTargetExecutionState, "running");
      const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

      assert.equal(breakpoint.success, false);
      assert.equal(breakpoint.code, "GDB_BREAKPOINT_TRANSACTION_STOP_UNSAFE");
      assert.equal(breakpoint.observedTargetExecutionState, "halted");
      assert.deepEqual(commands.slice(-1), ["-exec-interrupt --all"]);
      await client.disconnect();
    });
  }
});

test("GDBClient accepts an async SIGINT stop when exec-interrupt has no synchronous MI result or prompt", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    {
      interruptStopOutput: '*stopped,reason="signal-received",signal-name="SIGINT",thread-id="1"\n',
      interruptAsyncOnly: true,
    },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, true, JSON.stringify(breakpoint));
  assert.equal(breakpoint.observedTargetExecutionState, "running");
  assert.equal(client.isConnected(), true);
  assert.deepEqual(signals, []);
  assert.deepEqual(commands.slice(-3), [
    "-exec-interrupt --all",
    "-break-insert -- JlinkTestFixtureTask1ms",
    "-exec-continue --all",
  ]);
  await client.disconnect();
});

test("GDBClient distinguishes an empty interrupt MI window from process loss", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    { interruptNoOutput: true },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 50);

  assert.equal(breakpoint.success, false);
  assert.equal(breakpoint.code, "GDB_INTERRUPT_EMPTY_WINDOW");
  assert.equal(breakpoint.observedTargetExecutionState, "running");
  assert.equal(client.isConnected(), true);
  assert.deepEqual(signals, []);
  assert.deepEqual(commands.slice(-1), ["-exec-interrupt --all"]);
  const quarantined = await client.command("info registers");
  assert.equal(quarantined.success, false);
  assert.equal(quarantined.code, "GDB_CLEANUP_REQUIRED");
  assert.deepEqual(commands.slice(-1), ["-exec-interrupt --all"]);
  const backtrace = await client.backtrace();
  assert.equal(backtrace.success, false);
  assert.equal(backtrace.code, "GDB_CLEANUP_REQUIRED");
  assert.deepEqual(commands.slice(-1), ["-exec-interrupt --all"]);
  await client.disconnect();
});

test("GDBClient resumes but fails closed when breakpoint insertion lacks a done result", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    { breakpointInsertOutput: "(gdb)\n" },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, false);
  assert.equal(breakpoint.code, "GDB_BREAKPOINT_RESULT_MISSING");
  assert.equal(breakpoint.observedTargetExecutionState, "running");
  assert.deepEqual(commands.slice(-3), [
    "-exec-interrupt --all",
    "-break-insert -- JlinkTestFixtureTask1ms",
    "-exec-continue --all",
  ]);
  assert.equal(client.isConnected(), true);
  await client.disconnect();
});

test("GDBClient restores running state after a rejected breakpoint command", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    { breakpointInsertOutput: '^error,msg="No symbol"\n(gdb)\n' },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break MissingSymbol", 1000);

  assert.equal(breakpoint.success, false);
  assert.equal(breakpoint.code, "GDB_BREAKPOINT_COMMAND_FAILED");
  assert.equal(breakpoint.error, "No symbol");
  assert.equal(breakpoint.observedTargetExecutionState, "running");
  assert.deepEqual(commands.slice(-3), [
    "-exec-interrupt --all",
    "-break-insert -- MissingSymbol",
    "-exec-continue --all",
  ]);
  await client.disconnect();
});

test("GDBClient terminates after a breakpoint phase timeout and never auto-resumes", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    undefined,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    { breakpointInsertOutput: "" },
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, false);
  assert.equal(breakpoint.code, "GDB_COMMAND_TIMEOUT");
  assert.match(breakpoint.rawOutput ?? "", /SIGINT/);
  assert.deepEqual(commands.slice(-2), ["-exec-interrupt --all", "-break-insert -- JlinkTestFixtureTask1ms"]);
  assert.equal(client.isConnected(), false);
  assert.equal(signals[0], "SIGTERM");
});

test("GDBClient leaves complex and aliased CLI breakpoint commands exact", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, undefined, false, false, commands));
  assert.equal((await client.connect("localhost", 2331)).success, true);

  const exactCommands = ["b foo", "break foo if x", 'break "foo bar"', "break foo\\bar"];
  for (const command of exactCommands) {
    const result = await client.command(command);
    assert.equal(result.success, true);
    assert.equal(result.dispatchedCommand, command);
  }
  assert.deepEqual(commands.slice(-exactCommands.length), exactCommands);
  await client.disconnect();
});

test("GDBClient preserves process-exit evidence while enabling MI async", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals, undefined, false, false, undefined, false, "(gdb)\n", true,
  ));

  const result = await client.connect("localhost", 2331);

  assert.equal(result.success, false);
  assert.equal(result.code, "GDB_PROCESS_EXITED");
  assert.equal(result.exitCode, 7);
  assert.equal(result.exitSignal, null);
});

test("GDBClient preserves live process-error evidence while enabling MI async", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals, undefined, false, false, undefined, false, "(gdb)\n", false, true,
  ));

  const result = await client.connect("localhost", 2331);

  assert.equal(result.success, false);
  assert.equal(result.code, "GDB_PROCESS_EXITED");
  assert.equal(result.exitError, "simulated async handshake process error");
  assert.equal(signals[0], "SIGTERM");
});

test("GDBClient consumes a split remote prompt before dispatching the first running-state command", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals, undefined, false, false, commands, false, "(gdb)\n", false, false, true,
  ));

  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const breakpoint = await client.command("break JlinkTestFixtureTask1ms", 1000);

  assert.equal(breakpoint.success, true);
  assert.deepEqual(commands.slice(-3), [
    "-exec-interrupt --all",
    "-break-insert -- JlinkTestFixtureTask1ms",
    "-exec-continue --all",
  ]);
  await client.disconnect();
});

test("GDBClient ignores kill-error as exit and waits for the real exit event", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, undefined, true));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  const startedAt = Date.now();
  const result = await client.command("maintenance hang", 20);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.code, "GDB_COMMAND_TIMEOUT");
  assert.ok(elapsed >= 40, `kill error released the GDB operation before exit (${elapsed}ms)`);
});

test("GDBClient reports an in-flight process exit with exact exit facts", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, undefined, false, true));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  const result = await client.command("maintenance crash", 5_000);
  assert.equal(result.success, false);
  assert.equal(result.code, "GDB_PROCESS_EXITED");
  assert.equal(result.dispatchedCommand, "maintenance crash");
  assert.equal(result.exitCode, 7);
  assert.equal(result.exitSignal, null);
  assert.equal(signals.length, 0);
});

test("GDBClient only treats line-anchored MI result records as command status", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, undefined, false, false, commands));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  const result = await client.command("show literal-mi-text");
  assert.equal(result.success, true);
  assert.match(result.rawOutput ?? "", /literal \^error and \^done/);
  await client.disconnect();
});

test("GDBClient loads newly requested symbols on an existing matching connection", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, undefined, false, false, commands));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  const loaded = await client.connect("localhost", 2331, "C:\\firmware\\app.elf");
  assert.equal(loaded.success, true);
  assert.ok(commands.some((command) => command.startsWith('file "C:\\\\firmware\\\\app.elf"')));
  const commandCount = commands.length;
  assert.equal((await client.connect("localhost", 2331, "C:\\firmware\\app.elf")).success, true);
  assert.equal(commands.length, commandCount, "same symbol binding should be an explicit no-op");
  const differentEndpoint = await client.connect("localhost", 2442, "C:\\firmware\\app.elf");
  assert.equal(differentEndpoint.success, false);
  assert.equal(differentEndpoint.code, "GDB_ALREADY_CONNECTED_DIFFERENT_TARGET");
  await client.disconnect();
});

test("GDBClient settles an in-flight command after a live-process error", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, undefined, false, false, undefined, true));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  const result = await client.command("maintenance live-error", 5_000);
  assert.equal(result.success, false);
  assert.equal(result.code, "GDB_PROCESS_EXITED");
  assert.equal(result.exitError, "simulated live process error");
  assert.equal(signals[0], "SIGTERM");
});

test("GDBClient tracks only observed MI running and halted states", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const stopped = '*stopped,reason="signal-received",signal-name="SIGTRAP"\n(gdb)\n';
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, stopped));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal(client.getTargetExecutionState(), "halted");
  const alreadyHalted = await client.wait(1);
  assert.equal(alreadyHalted.success, true);
  assert.equal(alreadyHalted.stopReason, "signal-received signal SIGTRAP");
  assert.equal(client.getTargetExecutionState(), "halted");
  const unobserved = await client.command("monitor reset halt");
  assert.equal(unobserved.success, true);
  assert.equal(unobserved.observedTargetExecutionState, undefined);
  assert.equal(client.getTargetExecutionState(), "unknown");
  const unknownWait = await client.wait(1);
  assert.equal(unknownWait.success, false);
  assert.equal(unknownWait.code, "TARGET_STATE_UNKNOWN");
  assert.equal(client.getTargetExecutionState(), "unknown");
  const continued = await client.command("continue");
  assert.equal(continued.success, true);
  assert.equal(continued.observedTargetExecutionState, "running");
  assert.equal(client.getTargetExecutionState(), "running");
  const stillRunning = await client.wait(1);
  assert.equal(stillRunning.success, true);
  assert.equal(stillRunning.observedTargetExecutionState, "running");
  assert.equal(client.getTargetExecutionState(), "running");
  await client.disconnect();
  assert.equal(client.getTargetExecutionState(), "unknown");
});

test("GDBClient typed breakpoint commands preserve known halted state without weakening raw commands", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const stopped = '*stopped,reason="breakpoint-hit",bkptno="1"\n(gdb)\n';
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, stopped, false, false, commands));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal(client.getTargetExecutionState(), "halted");

  const disabledFlashBreakpoints = await client.disableFlashBreakpoints();
  assert.equal(disabledFlashBreakpoints.success, true);
  assert.equal(disabledFlashBreakpoints.commandDispatched, true);
  assert.equal(disabledFlashBreakpoints.preservedTargetExecutionState, "halted");
  assert.equal(
    disabledFlashBreakpoints.dispatchedCommand,
    '-interpreter-exec console "monitor flash breakpoints = 0"',
  );
  assert.match(disabledFlashBreakpoints.output, /Flash breakpoints disabled/i);
  assert.equal(client.getTargetExecutionState(), "halted");

  const listed = await client.listBreakpoints();
  assert.equal(listed.success, true);
  assert.equal(listed.observedTargetExecutionState, undefined);
  assert.equal(listed.preservedTargetExecutionState, "halted");
  assert.equal(listed.commandDispatched, true);
  assert.equal(client.getTargetExecutionState(), "halted");

  const deleted = await client.deleteBreakpoint(1);
  assert.equal(deleted.success, true);
  assert.equal(deleted.observedTargetExecutionState, undefined);
  assert.equal(deleted.preservedTargetExecutionState, "halted");
  assert.equal(deleted.commandDispatched, true);
  assert.equal(client.getTargetExecutionState(), "halted");

  const cleared = await client.clearAllBreakpoints();
  assert.equal(cleared.success, true);
  assert.equal(cleared.observedTargetExecutionState, undefined);
  assert.equal(cleared.preservedTargetExecutionState, "halted");
  assert.equal(cleared.commandDispatched, true);
  assert.equal(cleared.dispatchedCommand, '-interpreter-exec console "monitor clrbp"');
  assert.equal(client.getTargetExecutionState(), "halted");
  assert.ok(commands.some((command) => command.includes("info breakpoints")));
  assert.ok(commands.some((command) => command.includes("-break-delete 1")));
  assert.ok(commands.some((command) => command.includes('-interpreter-exec console "monitor clrbp"')));
  assert.ok(commands.some((command) => command.includes('monitor flash breakpoints = 0')));

  const inserted = await client.command("break OsUserConfig.c:60");
  assert.equal(inserted.success, true);
  assert.equal(inserted.dispatchedCommand, "-break-insert -- OsUserConfig.c:60");
  assert.equal(inserted.commandDispatched, true);

  const raw = await client.command("info breakpoints");
  assert.equal(raw.success, true);
  assert.equal(raw.preservedTargetExecutionState, undefined);
  assert.equal(client.getTargetExecutionState(), "unknown");
  const rejectedDelete = await client.deleteBreakpoint(1);
  assert.equal(rejectedDelete.success, false);
  assert.equal(rejectedDelete.code, "TARGET_STATE_UNKNOWN");
  assert.equal(rejectedDelete.commandDispatched, false);
  await client.disconnect();
});

test("GDBClient reports a pre-dispatch guard rejection without breakpoint issue", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  let blocked: string | null = null;
  const client = new GDBClient("fake-gdb", () => blocked, () => createFakeGdbProcess(signals));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  blocked = "hardware access blocked";

  const result = await client.command("break OsUserConfig.c:60");

  assert.equal(result.success, false);
  assert.equal(result.commandDispatched, false);
  assert.equal(result.dispatchedCommand, undefined);
  await client.disconnect();
});

test("GDBClient fails closed when J-Link does not confirm FlashBP prevention", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const commands: string[] = [];
  const stopped = '*stopped,reason="breakpoint-hit",bkptno="1"\n(gdb)\n';
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(
    signals,
    stopped,
    false,
    false,
    commands,
    false,
    "(gdb)\n",
    false,
    false,
    false,
    { flashBreakpointDisableOutput: "^done\n(gdb)\n" },
  ));
  assert.equal((await client.connect("localhost", 2331)).success, true);

  const result = await client.disableFlashBreakpoints();

  assert.equal(result.success, false);
  assert.equal(result.code, "GDB_FLASH_BREAKPOINT_PREVENTION_UNCONFIRMED");
  assert.equal(result.commandDispatched, true);
  assert.equal(result.preservedTargetExecutionState, "halted");
  assert.equal(client.getTargetExecutionState(), "halted");
  assert.deepEqual(commands.filter((command) => command.includes("flash breakpoints")), [
    '-interpreter-exec console "monitor flash breakpoints = 0"',
  ]);
  await client.disconnect();
});

test("GDBClient wait reports an in-wait disconnect without inventing target state", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const stopped = '*stopped,reason="signal-received",signal-name="SIGTRAP"\n(gdb)\n';
  const child = createFakeGdbProcess(signals, stopped);
  const client = new GDBClient("fake-gdb", undefined, () => child);
  assert.equal((await client.connect("localhost", 2331)).success, true);
  assert.equal((await client.command("continue")).observedTargetExecutionState, "running");
  const waiting = client.wait(5_000);
  setTimeout(() => child.emit("exit", 9, null), 20);
  const result = await waiting;
  assert.equal(result.success, false);
  assert.equal(result.code, "GDB_NOT_CONNECTED");
  assert.equal(client.getTargetExecutionState(), "unknown");
});

test("GDBClient wait honors asynchronous unknown and reasonless-stopped records before timeout", async () => {
  const unknownSignals: Array<NodeJS.Signals | number | undefined> = [];
  const stopped = '*stopped,reason="signal-received",signal-name="SIGTRAP"\n(gdb)\n';
  const unknownChild = createFakeGdbProcess(unknownSignals, stopped);
  const unknownClient = new GDBClient("fake-gdb", undefined, () => unknownChild);
  assert.equal((await unknownClient.connect("localhost", 2331)).success, true);
  assert.equal((await unknownClient.command("continue")).observedTargetExecutionState, "running");
  const unknownWait = unknownClient.wait(1_000);
  setTimeout(() => (unknownChild.stdout as PassThrough | null)?.write('=thread-group-exited,id="i1"\n'), 20);
  const unknownResult = await unknownWait;
  assert.equal(unknownResult.success, false);
  assert.equal(unknownResult.code, "TARGET_STATE_UNKNOWN");
  assert.equal(unknownClient.getTargetExecutionState(), "unknown");
  await unknownClient.disconnect();

  const haltedSignals: Array<NodeJS.Signals | number | undefined> = [];
  const haltedChild = createFakeGdbProcess(haltedSignals, stopped);
  const haltedClient = new GDBClient("fake-gdb", undefined, () => haltedChild);
  assert.equal((await haltedClient.connect("localhost", 2331)).success, true);
  assert.equal((await haltedClient.command("continue")).observedTargetExecutionState, "running");
  const haltedWait = haltedClient.wait(1_000);
  setTimeout(() => (haltedChild.stdout as PassThrough | null)?.write('*stopped,thread-id="1"\n'), 20);
  const haltedResult = await haltedWait;
  assert.equal(haltedResult.success, true);
  assert.equal(haltedResult.stopReason, "stopped");
  assert.equal(haltedResult.observedTargetExecutionState, "halted");
  assert.equal(haltedClient.getTargetExecutionState(), "halted");
  await haltedClient.disconnect();
});

test("GDBClient applies multiple MI state records in output order", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const stopped = '*stopped,reason="signal-received",signal-name="SIGTRAP"\n(gdb)\n';
  const client = new GDBClient("fake-gdb", undefined, () => createFakeGdbProcess(signals, stopped));
  assert.equal((await client.connect("localhost", 2331)).success, true);

  const stoppedThenRunning = await client.command("show stopped-then-running");
  assert.equal(stoppedThenRunning.success, true);
  assert.equal(stoppedThenRunning.observedTargetExecutionState, "running");
  assert.equal(stoppedThenRunning.stopReason, undefined);
  assert.equal(client.getTargetExecutionState(), "running");

  const runningThenExited = await client.command("show running-then-exited");
  assert.equal(runningThenExited.success, true);
  assert.equal(runningThenExited.observedTargetExecutionState, "unknown");
  assert.equal(runningThenExited.stopReason, undefined);
  assert.equal(client.getTargetExecutionState(), "unknown");
  await client.disconnect();
});

test("GDBClient reports an unexpected idle client exit exactly once", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const child = createFakeGdbProcess(signals);
  const client = new GDBClient("fake-gdb", undefined, () => child);
  const exits: Array<{ exitCode: number | null }> = [];
  client.onUnexpectedExit((event) => exits.push(event));
  assert.equal((await client.connect("localhost", 2331)).success, true);
  (child as unknown as { exitCode: number | null }).exitCode = 9;
  child.emit("exit", 9, null);
  child.emit("close", 9, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(exits, [{ exitCode: 9, exitSignal: null, exitError: undefined }]);
  assert.equal(client.getTargetExecutionState(), "unknown");
});

function createFakeGdbProcess(
  signals: Array<NodeJS.Signals | number | undefined>,
  connectOutput = '~"Remote debugging using localhost\\n"\n^done\n(gdb)\n',
  emitKillError = false,
  exitOnCommand = false,
  commands?: string[],
  emitLiveErrorOnCommand = false,
  initialPrompt = "(gdb)\n",
  exitOnMiAsync = false,
  errorOnMiAsync = false,
  splitConnectPrompt = false,
  transaction?: {
    interruptStopOutput?: string;
    interruptStopToken?: "active" | "none" | "wrong";
    interruptStopBeforeDone?: boolean;
    interruptSuppressStop?: boolean;
    delayedIdleStopAfterContinue?: string;
    interruptAsyncOnly?: boolean;
    interruptNoOutput?: boolean;
    breakpointInsertOutput?: string;
    flashBreakpointDisableOutput?: string;
  },
): ChildProcess {
  type MutableChild = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  const child = new EventEmitter() as MutableChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = process.pid;
  let terminationScheduled = false;
  let miAsyncEnabled = false;
  let targetRunning = false;
  let activeExecutionToken: string | undefined;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const wireCommand = chunk.toString().trim();
      const tokenMatch = /^(\d+)(-.*)$/.exec(wireCommand);
      const miToken = tokenMatch?.[1];
      const command = tokenMatch?.[2] ?? wireCommand;
      commands?.push(command);
      if (command === "-gdb-set mi-async on") {
        if (errorOnMiAsync) {
          setImmediate(() => child.emit("error", new Error("simulated async handshake process error")));
          callback();
          return;
        }
        if (exitOnMiAsync) {
          setImmediate(() => {
            child.exitCode = 7;
            child.emit("exit", 7, null);
          });
          callback();
          return;
        }
        miAsyncEnabled = true;
        setImmediate(() => {
          child.stdout.write("^done\n");
          setTimeout(() => child.stdout.write("(gdb)\n"), 5);
        });
      } else if (command.startsWith("target remote")) {
        setImmediate(() => {
          if (!splitConnectPrompt) {
            child.stdout.write(connectOutput);
            return;
          }
          child.stdout.write(connectOutput.replace(/\(gdb\)[^\r\n]*(?:\r?\n)?$/, ""));
          setTimeout(() => child.stdout.write("(gdb)\n"), 20);
        });
      } else if (emitLiveErrorOnCommand) {
        setImmediate(() => child.emit("error", new Error("simulated live process error")));
      } else if (exitOnCommand) {
        setTimeout(() => {
          child.exitCode = 7;
          child.emit("exit", 7, null);
          child.emit("close", 7, null);
        }, 20);
      } else if (command === "show literal-mi-text") {
        setImmediate(() => child.stdout.write('~"literal ^error and ^done\\n"\n^done\n(gdb)\n'));
      } else if (command === "continue") {
        targetRunning = true;
        setImmediate(() => child.stdout.write('^running\n*running,thread-id="all"\n(gdb)\n'));
      } else if (command === "-exec-interrupt --all") {
        setImmediate(() => {
          if (transaction?.interruptNoOutput) return;
          const stopOutput = transaction?.interruptStopOutput
            ?? '*stopped,reason="signal-received",signal-name="SIGINT",thread-id="1"\n';
          const stopToken = transaction?.interruptStopToken === "none"
            ? undefined
            : transaction?.interruptStopToken === "wrong"
              ? "999"
              : activeExecutionToken;
          const correlatedStopOutput = stopToken && stopOutput.startsWith("*") ? `${stopToken}${stopOutput}` : stopOutput;
          if (transaction?.interruptAsyncOnly) {
            if (targetRunning) {
              targetRunning = false;
              child.stdout.write(correlatedStopOutput);
            }
            return;
          }
          if (transaction?.interruptStopBeforeDone && targetRunning) {
            targetRunning = false;
            child.stdout.write(`${correlatedStopOutput}${miToken ?? ""}^done\n(gdb)\n`);
            return;
          }
          child.stdout.write(`${miToken ?? ""}^done\n(gdb)\n`);
          if (transaction?.interruptSuppressStop) return;
          if (targetRunning) {
            setTimeout(() => {
              targetRunning = false;
              child.stdout.write(correlatedStopOutput);
              setImmediate(() => child.stdout.write("(gdb)\n"));
            }, 5);
          }
        });
      } else if (command.startsWith("-break-insert -- ")) {
        const output = transaction?.breakpointInsertOutput ?? "^done\n(gdb)\n";
        if (!targetRunning && output) setTimeout(() => child.stdout.write(output), 5);
      } else if (command === '-interpreter-exec console "monitor flash breakpoints = 0"') {
        setImmediate(() => child.stdout.write(
          transaction?.flashBreakpointDisableOutput
            ?? '~"Flash breakpoints disabled\\n"\n^done\n(gdb)\n',
        ));
      } else if (command === "-exec-continue --all") {
        targetRunning = true;
        activeExecutionToken = miToken;
        setImmediate(() => {
          child.stdout.write(`${miToken ?? ""}^running\n${miToken ?? ""}*running,thread-id="all"\n(gdb)\n`);
          if (transaction?.delayedIdleStopAfterContinue) {
            setTimeout(() => {
              targetRunning = false;
              child.stdout.write(`${transaction.delayedIdleStopAfterContinue}(gdb)\n`);
            }, 60);
          }
        });
      } else if (command === "break JlinkTestFixtureTask1ms") {
        // Direct CLI breakpoint compatibility can remain synchronous even
        // when MI async is enabled, matching the running-target zero-output hang.
      } else if (command === "show stopped-then-running") {
        setImmediate(() => child.stdout.write('*stopped,reason="breakpoint-hit"\n*running,thread-id="all"\n^done\n(gdb)\n'));
      } else if (command === "show running-then-exited") {
        setImmediate(() => child.stdout.write('*running,thread-id="all"\n=thread-group-exited,id="i1"\n^done\n(gdb)\n'));
      } else if (command === "-gdb-exit") {
        setImmediate(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        });
      } else if (command && command !== "maintenance hang" && command !== "quit") {
        setImmediate(() => child.stdout.write("^done\n(gdb)\n"));
      }
      callback();
    },
  });
  child.kill = (signal) => {
    signals.push(signal);
    if (emitKillError) setImmediate(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
    if (!terminationScheduled) {
      terminationScheduled = true;
      setTimeout(() => {
        child.signalCode = typeof signal === "string" ? signal : "SIGTERM";
        child.emit("exit", null, child.signalCode);
      }, 30);
    }
    return true;
  };
  setImmediate(() => child.stdout.write(initialPrompt));
  return child as unknown as ChildProcess;
}
