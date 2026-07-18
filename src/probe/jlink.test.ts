import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ProcessManager } from "../utils/process-manager";
import { ProbeErrorCode, type CommandResult } from "./backend";
import { JLinkBackend, type JLinkSpawn } from "./jlink";

test("JLinkBackend timeout waits for JLinkExe exit before returning", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const backend = new JLinkBackend({ device: "TEST", serialNumber: "SERIAL", interface: "SWD", speed: 1000 }, new ProcessManager(), () => fakeProcess(signals));
  const invoke = (backend as unknown as { execRaw(commands: string[], timeoutMs: number): Promise<CommandResult> }).execRaw.bind(backend);
  const startedAt = Date.now();
  const result = await invoke(["mem8 0x20000000, 4"], 20);
  const elapsed = Date.now() - startedAt;

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.TIMEOUT);
  assert.equal(signals[0], "SIGTERM");
  assert.ok(elapsed >= 40, `Probe queue could be released before fake JLinkExe exit (${elapsed}ms)`);
});

test("JLinkBackend does not treat a kill error as process exit", async () => {
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const backend = new JLinkBackend({ device: "TEST", serialNumber: "SERIAL", interface: "SWD", speed: 1000 }, new ProcessManager(), () => fakeProcess(signals, true));
  const invoke = (backend as unknown as { execRaw(commands: string[], timeoutMs: number): Promise<CommandResult> }).execRaw.bind(backend);
  const startedAt = Date.now();
  const result = await invoke(["mem8 0x20000000, 4"], 20);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.errorCode, ProbeErrorCode.TIMEOUT);
  assert.ok(elapsed >= 40, `kill error released the Probe operation before exit (${elapsed}ms)`);
});

test("JLinkBackend disables close-time resume and uses noreset flash and erase forms", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts),
  );

  assert.equal((await backend.flash("C:\\firmware\\app.hex")).success, true);
  assert.equal((await backend.flash("C:\\firmware\\app.bin", 0x08000000)).success, true);
  assert.equal((await backend.erase()).success, true);
  assert.deepEqual(scripts, [
    "exec SetRestartOnClose = 0\nloadfile \"C:\\firmware\\app.hex\" 0x0 noreset\nexit\n",
    "exec SetRestartOnClose = 0\nloadfile \"C:\\firmware\\app.bin\" 0x8000000 noreset\nexit\n",
    "exec SetRestartOnClose = 0\nerase 0 0 noreset\nexit\n",
  ]);
});

test("JLinkBackend GDB Server arguments disable implicit reset, halt, and single-run exit", () => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
  );
  const args = (backend as unknown as { gdbServerArgs(): string[] }).gdbServerArgs();
  assert.ok(args.includes("-noreset"));
  assert.ok(args.includes("-nohalt"));
  assert.ok(args.includes("-noir"));
  assert.ok(args.includes("-nosinglerun"));
  assert.equal(args.includes("-singlerun"), false);
  assert.deepEqual(args.slice(-2), ["-select", "USB=123456"]);
});

test("JLinkBackend uses helper bytes and rejects a read that changes target state", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-helper-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "hss_helper.exe");
  const dll = join(root, "JLink_x64.dll");
  writeFileSync(helper, "test");
  writeFileSync(dll, "test");
  const invocations: Array<{ command: string; args: readonly string[] }> = [];
  let response: Record<string, unknown> = {
    status: "ok",
    probeSerial: 123456,
    targetWasHaltedRaw: 0,
    targetWasHaltedAfterReadRaw: 0,
    samples: [{ valid: true, bytes: "11223344" }],
  };
  const spawnProcess: JLinkSpawn = (command, args) => {
    invocations.push({ command, args });
    return helperProcess(JSON.stringify(response));
  };
  const backend = new JLinkBackend({
    installDir: root,
    memoryHelperPath: helper,
    device: "TEST",
    serialNumber: "123456",
    interface: "SWD",
    speed: 1000,
  }, new ProcessManager(), spawnProcess);

  const result = await backend.readMemory(0x20000000, 4, 4);
  assert.equal(result.success, true);
  assert.equal(result.output, "20000000 = 11 22 33 44");
  assert.match(result.rawOutput, /targetWasHaltedAfterReadRaw/);
  assert.equal(invocations[0].command, helper);
  assert.deepEqual(invocations[0].args.slice(0, 2), ["read-ram-probe", "--dll"]);
  assert.ok(invocations[0].args.includes(dll));
  assert.deepEqual(invocations[0].args.slice(invocations[0].args.indexOf("--access-size"), invocations[0].args.indexOf("--access-size") + 2), ["--access-size", "4"]);

  response = { ...response, targetWasHaltedAfterReadRaw: 1 };
  const changed = await backend.readMemory(0x20000000, 4, 4);
  assert.equal(changed.success, false);
  assert.equal(changed.errorCode, ProbeErrorCode.HIDDEN_STATE_CHANGE);
  assert.equal(changed.stateUnknown, false);

  response = { ...response, targetWasHaltedAfterReadRaw: 0, probeSerial: 999999 };
  const wrongProbe = await backend.readMemory(0x20000000, 4, 4);
  assert.equal(wrongProbe.success, false);
  assert.equal(wrongProbe.errorCode, ProbeErrorCode.PROBE_IDENTITY_MISMATCH);
  assert.equal(wrongProbe.stateUnknown, true);

  response = {
    status: "error",
    errorCode: "JLINK_READMEM_FAILED",
    reason: "partial read",
    readFailed: true,
    stateUnknown: false,
  };
  const partialRead = await backend.readMemory(0x20000000, 4, 4);
  assert.equal(partialRead.success, false);
  assert.equal(partialRead.stateUnknown, false);

  response = {
    status: "ok",
    probeSerial: 123456,
    targetWasHaltedRaw: 0,
    targetWasHaltedAfterOperationRaw: 0,
    targetWritten: true,
    writeFailed: false,
    writeReturnCode: 0,
    writeIssued: true,
    samples: [],
  };
  const write = await backend.writeMemoryBytes(0x20000000, Buffer.from([1, 2, 3, 4]), 4);
  assert.equal(write.success, true);
  assert.deepEqual(invocations.at(-1)?.args.slice(0, 2), ["write-ram-probe", "--dll"]);
  assert.equal(invocations.at(-1)?.args.includes("--bytes-hex"), true);
  assert.equal(invocations.at(-1)?.args.includes("01020304"), true);
  assert.deepEqual(invocations.at(-1)?.args.slice(invocations.at(-1)!.args.indexOf("--access-size"), invocations.at(-1)!.args.indexOf("--access-size") + 2), ["--access-size", "4"]);
  assert.equal(invocations.at(-1)?.args.includes("--samples"), false);

  response = { ...response, targetWasHaltedAfterOperationRaw: 1 };
  const changedWrite = await backend.writeMemoryBytes(0x20000000, Buffer.from([1, 2, 3, 4]), 4);
  assert.equal(changedWrite.success, false);
  assert.equal(changedWrite.errorCode, ProbeErrorCode.HIDDEN_STATE_CHANGE);
  assert.equal(changedWrite.writeIssued, true);

  response = {
    status: "error",
    errorCode: "JLINK_PROBE_IDENTITY_MISMATCH",
    reason: "wrong Probe",
    writeIssued: false,
    targetWritten: false,
    stateUnknown: true,
  };
  const earlyFailure = await backend.writeMemoryBytes(0x20000000, Buffer.from([1, 2, 3, 4]), 4);
  assert.equal(earlyFailure.success, false);
  assert.equal(earlyFailure.writeIssued, false);
  assert.equal(earlyFailure.stateUnknown, true);

  response = {
    status: "error",
    errorCode: "JLINK_CLOSE_FAILED",
    reason: "close failed",
    writeIssued: true,
    targetWritten: true,
    closeFailed: true,
    stateUnknown: true,
  };
  const closeFailure = await backend.writeMemoryBytes(0x20000000, Buffer.from([1, 2, 3, 4]), 4);
  assert.equal(closeFailure.success, false);
  assert.equal(closeFailure.writeIssued, true);
  assert.equal(closeFailure.stateUnknown, true);
});

test("JLinkBackend reports a missing Native write helper as unissued", async () => {
  const backend = new JLinkBackend({ device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000, installDir: "Z:\\missing-jlink" }, new ProcessManager());
  const result = await backend.writeMemoryBytes(0x20000000, Buffer.from([1, 2, 3, 4]), 4);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
});

function fakeProcess(signals: Array<NodeJS.Signals | number | undefined>, emitKillError = false): ChildProcess {
  type MutableChild = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  const child = new EventEmitter() as MutableChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = process.pid;
  child.exitCode = null;
  child.signalCode = null;
  let terminationScheduled = false;
  child.kill = (signal) => {
    signals.push(signal);
    if (emitKillError) setImmediate(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })));
    if (!terminationScheduled) {
      terminationScheduled = true;
      setTimeout(() => {
        child.signalCode = typeof signal === "string" ? signal : "SIGTERM";
        child.emit("exit", null, child.signalCode);
        child.emit("close", null, child.signalCode);
      }, 30);
    }
    return true;
  };
  return child as unknown as ChildProcess;
}

function successfulProcess(scripts: string[]): ChildProcess {
  type MutableChild = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  const child = new EventEmitter() as MutableChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = process.pid;
  child.exitCode = null;
  child.signalCode = null;
  let script = "";
  child.stdin.on("data", (chunk: Buffer) => { script += chunk.toString(); });
  child.stdin.on("end", () => {
    scripts.push(script);
    setImmediate(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
  });
  child.kill = () => true;
  return child as unknown as ChildProcess;
}

function helperProcess(json: string): ChildProcess {
  type MutableChild = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
  };
  const child = new EventEmitter() as MutableChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = process.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  setImmediate(() => {
    child.stdout.write(json);
    child.stdout.end();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child as unknown as ChildProcess;
}
