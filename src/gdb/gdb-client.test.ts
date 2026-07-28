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
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const command = chunk.toString().trim();
      commands?.push(command);
      if (command.startsWith("target remote")) {
        setImmediate(() => child.stdout.write(connectOutput));
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
        setImmediate(() => child.stdout.write('^running\n*running,thread-id="all"\n(gdb)\n'));
      } else if (command === "show stopped-then-running") {
        setImmediate(() => child.stdout.write('*stopped,reason="breakpoint-hit"\n*running,thread-id="all"\n^done\n(gdb)\n'));
      } else if (command === "show running-then-exited") {
        setImmediate(() => child.stdout.write('*running,thread-id="all"\n=thread-group-exited,id="i1"\n^done\n(gdb)\n'));
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
