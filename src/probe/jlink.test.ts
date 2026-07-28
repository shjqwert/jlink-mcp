import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { findJLinkInstallDir, getConfig, selectJLinkInstallDir } from "../utils/config";
import { ProcessManager } from "../utils/process-manager";
import { ProbeErrorCode, type CommandResult } from "./backend";
import { JLinkBackend, waitForGdbServerReady, type JLinkSpawn } from "./jlink";

test("J-Link installation discovery prefers an installation declaring the requested device", (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-discovery-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, "JLink");
  const compatible = join(root, "JLink_V884");
  for (const installDir of [legacy, compatible]) {
    mkdirSync(installDir);
    writeFileSync(join(installDir, "JLink.exe"), "test");
  }
  writeFileSync(join(compatible, "JLinkDevices.xml"), '<Database><ChipInfo Name="Z20K146M" /></Database>');

  assert.equal(selectJLinkInstallDir([legacy, compatible], "Z20K146M"), compatible);
});

test("J-Link installation discovery prefers a versioned candidate when device metadata is unavailable", (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-discovery-fallback-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const legacy = join(root, "JLink");
  const olderVersioned = join(root, "JLink_V884b");
  const newerVersioned = join(root, "JLink_V884c");
  for (const installDir of [legacy, olderVersioned, newerVersioned]) {
    mkdirSync(installDir);
    writeFileSync(join(installDir, "JLink.exe"), "test");
  }

  assert.equal(selectJLinkInstallDir([legacy, olderVersioned, newerVersioned], "UnknownDevice"), newerVersioned);
});

test("J-Link discovery recognizes version directories with release suffixes", (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-discovery-suffix-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const programFiles = join(root, "Program Files");
  const legacy = join(programFiles, "SEGGER", "JLink");
  const compatible = join(programFiles, "SEGGER", "JLink_V884b_x64");
  for (const installDir of [legacy, compatible]) {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "JLink.exe"), "test");
  }
  writeFileSync(join(compatible, "JLinkDevices.xml"), '<Database><ChipInfo Name="Z20K146M" /></Database>');

  const env = { ProgramFiles: programFiles, JLINK_DEVICE: "Z20K146M" } as NodeJS.ProcessEnv;
  assert.equal(findJLinkInstallDir("Z20K146M", env), compatible);
  assert.equal(getConfig(env).jlink.installDir, compatible);
});

test("J-Link environment install directory is an explicit override", (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-discovery-override-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const configured = join(root, "custom-jlink");

  assert.equal(findJLinkInstallDir("Z20K146M", { JLINK_INSTALL_DIR: configured }), configured);
  assert.equal(getConfig({ JLINK_INSTALL_DIR: configured }).jlink.installDir, configured);
});

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

test("JLinkBackend resets and halts in-session before noreset flash and erase forms", async () => {
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
    "exec SetRestartOnClose = 0\nr\nhalt\nloadfile \"C:\\firmware\\app.hex\" 0x0 noreset\nexit\n",
    "exec SetRestartOnClose = 0\nr\nhalt\nloadfile \"C:\\firmware\\app.bin\" 0x8000000 noreset\nexit\n",
    "exec SetRestartOnClose = 0\nr\nhalt\nerase 0 0 noreset\nexit\n",
  ]);
});

test("JLinkBackend fails a zero-exit erase when J-Link reports a fatal RAMCode diagnostic", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts, [
      "****** Error: Verification of RAMCode failed @ address 0x20000F80.",
      "Failed to prepare for programming.",
      "Failed to download RAMCode!",
      "Erasing done.",
      "O.K.",
    ].join("\n")),
  );

  const result = await backend.erase();

  assert.equal(result.success, false);
  assert.equal(result.errorCode, "JLINK_COMMAND_FAILED");
  assert.equal(result.stateUnknown, true);
  assert.match(result.error ?? "", /RAMCode/i);
});

test("JLinkBackend fails a zero-exit erase when J-Link reports a fatal RAMCode diagnostic on stderr", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts, "", "Failed to download RAMCode!"),
  );

  const result = await backend.erase();

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.stateUnknown, true);
});

test("JLinkBackend fails a zero-exit flash when J-Link reports an address verify failure", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts, [
      "Programming flash [100%] Done.",
      "****** Error: Failed to verify @ address 0x0000C000",
      "O.K.",
    ].join("\n")),
  );

  const result = await backend.flash("C:\\firmware\\app.hex");

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.stateUnknown, true);
  assert.match(result.error ?? "", /0x0000C000/i);
});

test("JLinkBackend permits a zero-exit flash with the nonfatal target-RAM PC diagnostic", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts, [
      "****** Error: PC of target system has unexpected value after checking target RAM. (PC = 0x00000000, expected 0x20000000)",
      "O.K.",
    ].join("\n")),
  );

  const result = await backend.flash("C:\\firmware\\app.hex");

  assert.equal(result.success, true);
  assert.notEqual(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
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

test("GDB Server readiness accepts stderr and text split across chunks", async () => {
  const processHandle = readinessProcess();
  const ready = waitForGdbServerReady(processHandle, 1_000);
  (processHandle.stderr as PassThrough).write("Waiting for connec");
  (processHandle.stderr as PassThrough).write("tion from GDB\n");
  assert.deepEqual(await ready, { ready: true, message: "ready output observed on stderr" });
  assert.equal(processHandle.stdout!.listenerCount("data"), 0);
  assert.equal(processHandle.stderr!.listenerCount("data"), 0);
  assert.equal(processHandle.listenerCount("exit"), 0);
  assert.equal(processHandle.listenerCount("error"), 0);
});

test("GDB Server readiness timeout retains bounded stdout and stderr diagnostics", async () => {
  const processHandle = readinessProcess();
  const ready = waitForGdbServerReady(processHandle, 10);
  (processHandle.stdout as PassThrough).write(`prefix-${"x".repeat(20_000)}`);
  (processHandle.stderr as PassThrough).write("vendor startup failed");
  const result = await ready;
  assert.equal(result.ready, false);
  assert.match(result.message, /no readiness output within 10ms/);
  assert.match(result.message, /vendor startup failed/);
  assert.ok(Buffer.byteLength(result.message, "utf8") < 18 * 1024);
});

test("GDB Server combined output remains bounded for stderr-heavy failures", () => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
  );
  const append = (backend as unknown as { appendGdbOutput(line: string): void }).appendGdbOutput.bind(backend);
  for (let index = 0; index < 2_000; index += 1) append(`[ERR] vendor diagnostic ${index}`);
  const output = backend.getGDBServerOutput(2_000);
  assert.equal(output.length, 1000);
  assert.equal(output[0], "[ERR] vendor diagnostic 1000");
  assert.equal(output.at(-1), "[ERR] vendor diagnostic 1999");
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
    memoryCacheDisabled: true,
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

  response = { ...response, memoryCacheDisabled: false };
  const cachePolicyMissing = await backend.readMemory(0x20000000, 4, 4);
  assert.equal(cachePolicyMissing.success, false);
  assert.match(cachePolicyMissing.error ?? "", /caching was disabled/i);

  response = { ...response, memoryCacheDisabled: true, targetWasHaltedAfterReadRaw: 1 };
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
    memoryCacheDisabled: true,
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

  response = {
    ...response,
    oldBytes: "00000000",
    verificationStartedAtUnixMs: 1_700_000_000_000,
    verificationEndedAtUnixMs: 1_700_000_000_010,
    readbacks: [{ index: 0, atUnixMs: 1_700_000_000_005, bytes: "01020304" }],
    restoreIssued: true,
    restoreWriteFailed: false,
    restoreReadFailed: false,
    restoreReadbackBytes: "00000000",
  };
  const transaction = await backend.writeMemoryTransaction({
    address: 0x20000000,
    bytes: Buffer.from([1, 2, 3, 4]),
    accessSize: 4,
    captureOld: true,
    verifyReads: 1,
    verifyIntervalMs: 0,
    verifyDurationMs: 0,
    restore: true,
    expectedTargetState: "running",
  });
  assert.equal(transaction.command.success, true);
  assert.equal(transaction.oldBytes?.toString("hex"), "00000000");
  assert.deepEqual(transaction.readbacks.map((bytes) => bytes.toString("hex")), ["01020304"]);
  assert.deepEqual(transaction.readbackObservedAt, ["2023-11-14T22:13:20.005Z"]);
  assert.equal(transaction.verificationStartedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(transaction.verificationEndedAt, "2023-11-14T22:13:20.010Z");
  assert.equal(transaction.restoreVerified, true);
  assert.equal(transaction.targetStateBefore, "running");
  assert.equal(transaction.targetStateAfter, "running");
  assert.deepEqual(invocations.at(-1)?.args.slice(invocations.at(-1)!.args.indexOf("--capture-old")), [
    "--capture-old", "true", "--verify-reads", "1", "--verify-interval-ms", "0", "--verify-duration-ms", "0", "--restore", "true", "--expected-target-state", "running",
  ]);

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

function successfulProcess(scripts: string[], stdout = "", stderr = ""): ChildProcess {
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
      if (stdout) child.stdout.write(stdout);
      child.stdout.end();
      if (stderr) child.stderr.write(stderr);
      child.stderr.end();
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

function readinessProcess(): ChildProcess {
  type MutableChild = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  const child = new EventEmitter() as MutableChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child as unknown as ChildProcess;
}
