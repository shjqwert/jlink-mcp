import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
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

test("JLinkBackend does not auto-connect for probe-only raw commands", async () => {
  const scripts: string[] = [];
  const spawnedArgs: string[][] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    (_command, args) => {
      spawnedArgs.push([...args]);
      return successfulProcess(scripts);
    },
  );

  assert.equal((await backend.executeRaw(["showemulist"])).success, true);
  assert.equal((await backend.executeRaw(["showconf"])).success, true);
  assert.equal((await backend.executeRaw(["showemulist", "mem8 0x20000000, 1"])).success, true);
  assert.deepEqual(spawnedArgs.map((args) => args[args.indexOf("-autoconnect") + 1]), ["0", "0", "1"]);
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

test("JLinkBackend firmware Verify-only converts S-record data to VerifyBin and restores halted state", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-srec-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const srec = join(root, "app.s19");
  writeFileSync(srec, "S3090000C000010203042C\nS3090000C0040506070818\nS7050000C0003A\n", "ascii");
  const scripts: string[] = [];
  const commandArgs: string[][] = [];
  const verifiedBytes: Buffer[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    (_command, args) => {
      commandArgs.push([...args]);
      return successfulProcess(scripts, "O.K.\n", "", (script) => {
        const pathMatch = script.match(/VerifyBin "([^"]+)" 0xc000/i);
        if (pathMatch) verifiedBytes.push(readFileSync(pathMatch[1]));
      });
    },
  );

  const result = await backend.verifyFirmware(srec);

  assert.equal(result.success, true);
  assert.equal(result.writeIssued, false);
  assert.deepEqual(verifiedBytes, [Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);
  assert.match(scripts[0], /^exec SetRestartOnClose = 0\nhalt\nVerifyBin "[^"]+" 0xc000\nhalt\nexit\n$/);
  assert.doesNotMatch(scripts[0], /(?:^|\n)(?:verify|loadfile|erase|r)(?:\s|$)/i);
  assert.equal(commandArgs[0][commandArgs[0].indexOf("-ExitOnError") + 1], "0");
});

test("JLinkBackend firmware Verify-only rejects S-record data that crosses the 32-bit address space before spawn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-srec-overflow-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const srec = join(root, "overflow.s19");
  writeFileSync(srec, "S307FFFFFFFF0102F9\nS70500000000FA\n", "ascii");
  let spawnCount = 0;
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => {
      spawnCount += 1;
      return successfulProcess([]);
    },
  );

  const result = await backend.verifyFirmware(srec);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.INVALID_ARGUMENT);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
  assert.match(result.error ?? "", /32-bit target address space/i);
  assert.equal(spawnCount, 0);
});

test("JLinkBackend firmware Verify-only rejects malformed Intel HEX start-address records before spawn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-hex-control-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const hex = join(root, "invalid.hex");
  writeFileSync(hex, ":020000040800F2\n:0400100001020304E2\n:0400010500000000F6\n:00000001FF\n", "ascii");
  let spawnCount = 0;
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => {
      spawnCount += 1;
      return successfulProcess([]);
    },
  );

  const result = await backend.verifyFirmware(hex);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.INVALID_ARGUMENT);
  assert.equal(result.writeIssued, false);
  assert.match(result.error ?? "", /start-address record is invalid/i);
  assert.equal(spawnCount, 0);
});

test("JLinkBackend firmware Verify-only converts extended-address Intel HEX to VerifyBin", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-hex-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const hex = join(root, "app.hex");
  writeFileSync(hex, ":020000040800F2\n:0400100001020304E2\n:00000001FF\n", "ascii");
  const scripts: string[] = [];
  const verifiedBytes: Buffer[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts, "O.K.\n", "", (script) => {
      const pathMatch = script.match(/VerifyBin "([^"]+)" 0x8000010/i);
      if (pathMatch) verifiedBytes.push(readFileSync(pathMatch[1]));
    }),
  );

  const result = await backend.verifyFirmware(hex);

  assert.equal(result.success, true);
  assert.deepEqual(verifiedBytes, [Buffer.from([1, 2, 3, 4])]);
  assert.match(scripts[0], /\nhalt\nVerifyBin "[^"]+" 0x8000010\nhalt\n/);
});

test("JLinkBackend firmware Verify-only rejects Intel HEX checksum, EOF, and overlap errors before spawn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-hex-invalid-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = [
    [":020000040800F2\n:0400100001020304E3\n:00000001FF\n", /checksum/i],
    [":020000040800F2\n:0400100001020304E2\n", /EOF/i],
    [":020000040800F2\n:0400100001020304E2\n:0400120005060708D0\n:00000001FF\n", /overlapping/i],
  ] as const;
  let spawnCount = 0;
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => {
      spawnCount += 1;
      return successfulProcess([]);
    },
  );

  for (const [index, [contents, expected]] of cases.entries()) {
    const file = join(root, `invalid-${index}.hex`);
    writeFileSync(file, contents, "ascii");
    const result = await backend.verifyFirmware(file);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, ProbeErrorCode.INVALID_ARGUMENT);
    assert.match(result.error ?? "", expected);
  }
  assert.equal(spawnCount, 0);
});

test("JLinkBackend firmware Verify-only keeps an unconfirmed vendor mismatch fail-closed", async (context) => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { installDir: "Z:\\missing-jlink", memoryHelperPath: "Z:\\missing-helper.exe", device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts, "****** Error: Failed to verify @ address 0x0000C000\nO.K.\n"),
  );

  const bin = temporaryFirmwareBin(context, "mismatch");
  const result = await backend.verifyFirmware(bin, 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
  assert.match(result.error ?? "", /independently confirmed/i);
  assert.deepEqual(scripts, [
    `exec SetRestartOnClose = 0\nhalt\nVerifyBin "${bin}" 0xc000\nhalt\nexit\n`,
  ]);
});

test("JLinkBackend firmware Verify-only rejects dotted vendor Expected evidence that conflicts with the image", async (context) => {
  const backend = new JLinkBackend(
    { installDir: "Z:\\missing-jlink", memoryHelperPath: "Z:\\missing-helper.exe", device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(
      [],
      "Verify failed @ address 0x0000C000. Expected FF read 81\nERROR: Verify failed.\n",
      "",
      undefined,
      1,
    ),
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "expected-conflict"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
  assert.match(result.error ?? "", /does not identify a byte matching/i);
  assert.doesNotMatch(result.error ?? "", /independently confirmed/i);
});

test("JLinkBackend firmware Verify-only confirms each transient mismatch until a bounded full-image pass", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-confirm-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "hss_helper.exe");
  const dll = join(root, "JLink_x64.dll");
  writeFileSync(helper, "test");
  writeFileSync(dll, "test");
  const bin = join(root, "large.bin");
  const bytes = Buffer.alloc(8193, 0x21);
  bytes[0x123] = 0x5f;
  bytes[0x456] = 0xb2;
  writeFileSync(bin, bytes);
  const scripts: string[] = [];
  const independentlyReadAddresses: string[] = [];
  let commanderInvocation = 0;
  const backend = new JLinkBackend(
    {
      installDir: root,
      memoryHelperPath: helper,
      device: "TEST",
      serialNumber: "123456",
      interface: "SWD",
      speed: 1000,
    },
    new ProcessManager(),
    (command, args) => {
      if (command === helper) {
        const address = args[args.indexOf("--address") + 1];
        independentlyReadAddresses.push(address);
        assert.deepEqual(
          args.slice(args.indexOf("--preserve-debug-state-on-close")),
          ["--preserve-debug-state-on-close", "true"],
        );
        return helperProcess(JSON.stringify({
          status: "ok",
          probeSerial: 123456,
          memoryCacheDisabled: true,
          debugDeinitSkipped: true,
          targetWasHaltedRaw: 1,
          targetWasHaltedAfterReadRaw: 1,
          samples: [{ valid: true, bytes: address === "0xc123" ? "5f" : "b2" }],
        }));
      }
      commanderInvocation += 1;
      const diagnostic = commanderInvocation === 1
        ? "Verify failed @ address 0x0000C123. Expected 5F read DF\nERROR: Verify failed.\n"
        : commanderInvocation === 2
          ? "Verify failed @ address 0x0000C456. Expected B2 read B3\nERROR: Verify failed.\n"
          : "O.K.\n";
      return successfulProcess(
        scripts,
        diagnostic,
        "",
        undefined,
        commanderInvocation < 3 ? 1 : 0,
      );
    },
  );

  const result = await backend.verifyFirmware(bin, 0x0000c000);

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
  assert.equal(commanderInvocation, 3);
  assert.deepEqual(independentlyReadAddresses, ["0xc123", "0xc456"]);
  assert.equal((scripts[0].match(/\nVerifyBin /g) ?? []).length, 3);
  assert.match(result.output, /0x0000c123.*0x0000c456/i);
  assert.match(result.output, /full-image clean pass/i);
  assert.match(result.rawOutput, /attempt 1[\s\S]*0x0000c123[\s\S]*attempt 2[\s\S]*0x0000c456[\s\S]*attempt 3/i);
});

test("JLinkBackend firmware Verify-only independently confirms every address reported by one full-image attempt", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-multi-report-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "hss_helper.exe");
  const dll = join(root, "JLink_x64.dll");
  writeFileSync(helper, "test");
  writeFileSync(dll, "test");
  const independentlyReadAddresses: string[] = [];
  let commanderInvocations = 0;
  const backend = new JLinkBackend(
    {
      installDir: root,
      memoryHelperPath: helper,
      device: "TEST",
      serialNumber: "123456",
      interface: "SWD",
      speed: 1000,
    },
    new ProcessManager(),
    (command, args) => {
      if (command === helper) {
        const address = args[args.indexOf("--address") + 1];
        independentlyReadAddresses.push(address);
        return helperProcess(JSON.stringify({
          status: "ok",
          probeSerial: 123456,
          memoryCacheDisabled: true,
          debugDeinitSkipped: true,
          targetWasHaltedRaw: 1,
          targetWasHaltedAfterReadRaw: 1,
          samples: [{ valid: true, bytes: address === "0xc000" ? "01" : "02" }],
        }));
      }
      commanderInvocations += 1;
      return successfulProcess(
        [],
        commanderInvocations === 1
          ? [
            "Verify failed @ address 0x0000C000. Expected 01 read 81",
            "Verify failed @ address 0x0000C001. Expected 02 read 82",
            "ERROR: Verify failed.",
          ].join("\n")
          : "O.K.\n",
        "",
        undefined,
        commanderInvocations === 1 ? 1 : 0,
      );
    },
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "multi-report"), 0x0000c000);

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(commanderInvocations, 2);
  assert.deepEqual(independentlyReadAddresses, ["0xc000", "0xc001"]);
  assert.match(result.output, /0x0000c000.*0x0000c001/i);
});

test("JLinkBackend firmware Verify-only fails closed when the transient-mismatch attempt budget is exhausted", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-budget-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "hss_helper.exe");
  const dll = join(root, "JLink_x64.dll");
  writeFileSync(helper, "test");
  writeFileSync(dll, "test");
  let commanderInvocations = 0;
  let independentReads = 0;
  const backend = new JLinkBackend(
    {
      installDir: root,
      memoryHelperPath: helper,
      device: "TEST",
      serialNumber: "123456",
      interface: "SWD",
      speed: 1000,
    },
    new ProcessManager(),
    (command) => {
      if (command === helper) {
        independentReads += 1;
        return helperProcess(JSON.stringify({
          status: "ok",
          probeSerial: 123456,
          memoryCacheDisabled: true,
          debugDeinitSkipped: true,
          targetWasHaltedRaw: 1,
          targetWasHaltedAfterReadRaw: 1,
          samples: [{ valid: true, bytes: "01" }],
        }));
      }
      commanderInvocations += 1;
      return successfulProcess(
        [],
        "Verify failed @ address 0x0000C000. Expected 01 read 81\nERROR: Verify failed.\n",
        "",
        undefined,
        1,
      );
    },
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "budget-exhausted"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
  assert.equal(commanderInvocations, 4);
  assert.equal(independentReads, 4);
  assert.match(result.error ?? "", /within 4 attempts/i);
  assert.match(result.rawOutput, /attempt 1\/4[\s\S]*attempt 4\/4/i);
});

test("JLinkBackend firmware Verify-only stops on a real mismatch after an earlier transient mismatch", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-real-mismatch-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "hss_helper.exe");
  const dll = join(root, "JLink_x64.dll");
  writeFileSync(helper, "test");
  writeFileSync(dll, "test");
  let commanderInvocations = 0;
  const backend = new JLinkBackend(
    {
      installDir: root,
      memoryHelperPath: helper,
      device: "TEST",
      serialNumber: "123456",
      interface: "SWD",
      speed: 1000,
    },
    new ProcessManager(),
    (command, args) => {
      if (command === helper) {
        const address = args[args.indexOf("--address") + 1];
        return helperProcess(JSON.stringify({
          status: "ok",
          probeSerial: 123456,
          memoryCacheDisabled: true,
          debugDeinitSkipped: true,
          targetWasHaltedRaw: 1,
          targetWasHaltedAfterReadRaw: 1,
          samples: [{ valid: true, bytes: address === "0xc000" ? "01" : "ff" }],
        }));
      }
      commanderInvocations += 1;
      return successfulProcess(
        [],
        commanderInvocations === 1
          ? "Verify failed @ address 0x0000C000. Expected 01 read 81\nERROR: Verify failed.\n"
          : "Verify failed @ address 0x0000C001. Expected 02 read 82\nERROR: Verify failed.\n",
        "",
        undefined,
        1,
      );
    },
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "confirmed-mismatch"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_VERIFY_MISMATCH);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
  assert.equal(commanderInvocations, 2);
  assert.match(result.error ?? "", /independently confirmed.*0x0000c001/i);
  assert.match(result.rawOutput, /attempt 1[\s\S]*0x0000c000[\s\S]*attempt 2[\s\S]*0x0000c001/i);
});

test("JLinkBackend firmware Verify-only treats an addressless contents-differ result as unconfirmed", async (context) => {
  const backend = new JLinkBackend(
    { installDir: "Z:\\missing-jlink", memoryHelperPath: "Z:\\missing-helper.exe", device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], "Contents differ\nO.K.\n"),
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "contents-differ"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, false);
  assert.match(result.error ?? "", /reported no independently readable address/i);
});

test("JLinkBackend firmware Verify-only keeps an addressless verify-failed summary fail-closed", async (context) => {
  const backend = new JLinkBackend(
    { installDir: "Z:\\missing-jlink", memoryHelperPath: "Z:\\missing-helper.exe", device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], "ERROR: Verify failed.\nO.K.\n"),
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "summary-only"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, true);
  assert.match(result.error ?? "", /ERROR: Verify failed/i);
});

test("JLinkBackend firmware Verify-only does not promote an address-only report without independent read evidence", async (context) => {
  const backend = new JLinkBackend(
    { installDir: "Z:\\missing-jlink", memoryHelperPath: "Z:\\missing-helper.exe", device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], "J-Link>Verify failed @ address 0x0000C000\nO.K.\n"),
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "reverse-mismatch"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.stateUnknown, false);
  assert.equal(result.writeIssued, false);
});

test("JLinkBackend firmware Verify-only fails closed on a zero-exit memory-read error", async (context) => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], "J-Link>J-Link>Could not read memory at 0x0000C000\nO.K.\n"),
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "read-error"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, true);
  assert.match(result.error ?? "", /could not read memory/i);
});

test("JLinkBackend firmware Verify-only lets a read failure override a co-reported address mismatch", async (context) => {
  const backend = new JLinkBackend(
    { installDir: "Z:\\missing-jlink", memoryHelperPath: "Z:\\missing-helper.exe", device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], [
      "Verify failed @ address 0x0000C000. Expected 01 read 81",
      "ERROR: Verify failed.",
      "Could not read memory at 0x0000C004",
    ].join("\n"), "", undefined, 1),
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "mismatch-with-read-failure"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.writeIssued, false);
  assert.equal(result.stateUnknown, true);
  assert.match(result.error ?? "", /could not read memory/i);
});

test("JLinkBackend firmware Verify-only does not classify a verification read error as content mismatch", async (context) => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], "J-Link>****** Error: Verification error: Could not read memory\nO.K.\n"),
  );

  const result = await backend.verifyFirmware(temporaryFirmwareBin(context, "verification-read-error"), 0x0000c000);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.notEqual(result.errorCode, ProbeErrorCode.JLINK_VERIFY_MISMATCH);
  assert.equal(result.stateUnknown, true);
});

test("JLinkBackend firmware Verify-only rejects raw BIN data that crosses the 32-bit address space before spawn", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-verify-bin-overflow-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "overflow.bin");
  writeFileSync(bin, Buffer.from([1, 2]));
  let spawnCount = 0;
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => {
      spawnCount += 1;
      return successfulProcess([]);
    },
  );

  const result = await backend.verifyFirmware(bin, 0xffff_ffff);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.INVALID_ARGUMENT);
  assert.equal(result.writeIssued, false);
  assert.match(result.error ?? "", /32-bit target address space/i);
  assert.equal(spawnCount, 0);
});

test("JLinkBackend uses J-Link-supported tokens for aliased core registers", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts),
  );

  for (const name of ["PC", "R15", "LR", "R14", "SP", "R13"]) {
    assert.equal((await backend.readRegister(name)).success, true);
  }
  for (const name of ["LR", "R14"]) {
    assert.equal((await backend.writeCoreRegister(name, 0x1234_5678)).success, true);
  }

  assert.deepEqual(scripts, [
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nrreg \"R15 (PC)\"\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nrreg \"R15 (PC)\"\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nrreg R14\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nrreg R14\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nrreg \"R13 (SP)\"\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nrreg \"R13 (SP)\"\nexit\n",
    "exec SetRestartOnClose = 0\nwreg R14, 0x12345678\nexit\n",
    "exec SetRestartOnClose = 0\nwreg R14, 0x12345678\nexit\n",
  ]);
});

test("JLinkBackend phases same-connection core-register write and readback for all aliases", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => registerTransactionProcess(scripts, "match"),
  );

  for (const name of ["R0", "PC", "R15", "LR", "R14", "SP", "R13"]) {
    const transaction = await backend.writeCoreRegisterTransaction(name, 0x1234_5678);
    assert.equal(transaction.command.success, true, name);
    assert.equal(transaction.command.writeIssued, true, name);
    assert.equal(transaction.readback?.success, true, name);
    assert.doesNotMatch(transaction.readback?.rawOutput ?? "", /wreg|write echo/i, name);
  }

  assert.deepEqual(scripts, [
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg R0, 0x12345678\nrreg R0\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg \"R15 (PC)\", 0x12345678\nrreg \"R15 (PC)\"\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg \"R15 (PC)\", 0x12345678\nrreg \"R15 (PC)\"\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg R14, 0x12345678\nrreg R14\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg R14, 0x12345678\nrreg R14\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg \"R13 (SP)\", 0x12345678\nrreg \"R13 (SP)\"\nexit\n",
    "exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg \"R13 (SP)\", 0x12345678\nrreg \"R13 (SP)\"\nexit\n",
  ]);
});

test("JLinkBackend closes stdin before V8.84 releases buffered transaction output", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => registerTransactionProcess(scripts, "match", {
      initialPrompt: false,
      realisticStartupChunks: true,
      respondAfterEof: true,
    }),
  );
  const invoke = (backend as unknown as {
    execCoreRegisterTransaction(token: string, value: number, timeoutMs: number): Promise<import("./backend").ProbeCoreRegisterWriteResult>;
  }).execCoreRegisterTransaction.bind(backend);

  const result = await invoke("R0", 0x1234_5678, 200);

  assert.equal(result.command.success, true, JSON.stringify(result.command));
  assert.equal(result.command.writeIssued, true);
  assert.equal(result.readback?.success, true);
  assert.equal(result.readback?.stateUnknown, false);
  assert.deepEqual(scripts, ["exec SetRestartOnClose = 0\nexec SetSkipDebugDeInit = 1\nwreg R0, 0x12345678\nrreg R0\nexit\n"]);
});

test("JLinkBackend reports same-connection-only register persistence when a new Commander connection resets GPR state", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "jlink-register-lifecycle-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, "hss_helper.exe");
  const dll = join(root, "JLink_x64.dll");
  writeFileSync(helper, "test");
  writeFileSync(dll, "test");
  const registerState = { value: "00000000" };
  const scripts: string[] = [];
  const helperArgs: string[][] = [];
  let commanderConnections = 0;
  const spawnProcess: JLinkSpawn = (command, args) => {
    if (command === helper) {
      helperArgs.push([...args]);
      const preserve = args.includes("--preserve-debug-state-on-close");
      if (!preserve) registerState.value = "00000000";
      return helperProcess(JSON.stringify({
        status: "ok",
        probeSerial: 123456,
        memoryCacheDisabled: true,
        debugDeinitSkipped: preserve,
        targetWasHaltedRaw: 1,
        targetWasHaltedAfterReadRaw: 1,
        samples: [{ valid: true, bytes: "03000200" }],
      }));
    }
    commanderConnections += 1;
    if (commanderConnections > 1) registerState.value = "00000000";
    return registerTransactionProcess(scripts, "match", { registerState });
  };
  const backend = new JLinkBackend(
    { installDir: root, memoryHelperPath: helper, device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    spawnProcess,
  );

  const result = await backend.writeCoreRegisterTransaction("R4", 0x1357_9bdf);
  const after = await backend.observeTargetState({ preserveDebugStateOnClose: true });
  const independent = await backend.readRegister("R4");
  const secondIndependent = await backend.readRegister("R4");

  assert.equal(result.command.success, true, JSON.stringify(result.command));
  assert.equal(result.readback?.success, true, JSON.stringify(result.readback));
  assert.equal(after.state, "halted", JSON.stringify(after.result));
  assert.match(independent.rawOutput, /R4\s*=\s*0x00000000/i);
  assert.match(secondIndependent.rawOutput, /R4\s*=\s*0x00000000/i);
  assert.equal(backend.getCoreRegisterPersistenceCapability(), "same_connection_only");
  assert.match(scripts[0] ?? "", /SetRestartOnClose = 0[\s\S]*SetSkipDebugDeInit = 1[\s\S]*wreg R4[\s\S]*rreg R4[\s\S]*exit/);
  assert.match(scripts[1] ?? "", /SetRestartOnClose = 0[\s\S]*SetSkipDebugDeInit = 1[\s\S]*rreg R4[\s\S]*exit/);
  assert.match(scripts[2] ?? "", /SetRestartOnClose = 0[\s\S]*SetSkipDebugDeInit = 1[\s\S]*rreg R4[\s\S]*exit/);
  assert.ok(helperArgs[0]?.includes("--preserve-debug-state-on-close"));
});

test("JLinkBackend separates V8.84 consecutive-prompt write echo from 0x readback", async () => {
  const transcript = [
    "SEGGER J-Link Commander V8.84",
    "J-Link>J-Link>R0 = 13579BDF",
    "J-Link>R0 = 0x13579BDF",
    "J-Link>",
  ].join("\r\n");
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], transcript),
  );

  const result = await backend.writeCoreRegisterTransaction("R0", 0x1357_9bdf);

  assert.equal(result.command.success, true, JSON.stringify(result.command));
  assert.equal(result.command.writeIssued, true);
  assert.equal(result.readback?.success, true, JSON.stringify(result.readback));
  assert.match(result.readback?.rawOutput ?? "", /R0\s*=\s*0x13579BDF/i);
  assert.doesNotMatch(result.readback?.rawOutput ?? "", /R0\s*=\s*13579BDF/i);

  const writeEchoOnly = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], "J-Link>J-Link>R0 = 13579BDF\r\nJ-Link>"),
  );
  const missing = await writeEchoOnly.writeCoreRegisterTransaction("R0", 0x1357_9bdf);
  assert.equal(missing.command.success, true);
  assert.equal(missing.readback?.success, false);
  assert.equal(missing.readback?.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);

  const prefixedAssignmentOnly = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], "J-Link>R0 = 0x13579BDF\r\nJ-Link>"),
  );
  const ambiguous = await prefixedAssignmentOnly.writeCoreRegisterTransaction("R0", 0x1357_9bdf);
  assert.equal(ambiguous.command.success, true);
  assert.equal(ambiguous.readback?.success, false);
  assert.equal(ambiguous.readback?.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);

  const unpromptedAssignments = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess([], [
      "SetupTarget note",
      "R0 = 13579BDF",
      "unrelated diagnostic",
      "R0 = 0x13579BDF",
    ].join("\r\n")),
  );
  const untrusted = await unpromptedAssignments.writeCoreRegisterTransaction("R0", 0x1357_9bdf);
  assert.equal(untrusted.command.success, true);
  assert.equal(untrusted.readback?.success, false);
  assert.equal(untrusted.readback?.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
});

test("JLinkBackend treats a timeout after submitting the EOF batch as an uncertain write", async () => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => registerTransactionProcess([], "batch_silent", { initialPrompt: false, respondAfterEof: true }),
  );
  const invoke = (backend as unknown as {
    execCoreRegisterTransaction(token: string, value: number, timeoutMs: number): Promise<import("./backend").ProbeCoreRegisterWriteResult>;
  }).execCoreRegisterTransaction.bind(backend);

  const result = await invoke("R0", 0x1234_5678, 20);

  assert.equal(result.command.errorCode, ProbeErrorCode.TIMEOUT);
  assert.equal(result.command.writeIssued, true);
  assert.equal(result.command.stateUnknown, true);
  assert.equal(result.readback?.success, false);
  assert.equal(result.readback?.stateUnknown, true);
});

test("JLinkBackend keeps a failed process spawn unissued", async () => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => {
      const child = registerTransactionProcess([], "batch_silent", { initialPrompt: false, respondAfterEof: true });
      setImmediate(() => {
        child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        child.kill();
      });
      return child;
    },
  );

  const result = await backend.writeCoreRegisterTransaction("R0", 0x1234_5678);

  assert.equal(result.command.errorCode, ProbeErrorCode.PROBE_NOT_FOUND);
  assert.equal(result.command.writeIssued, false);
  assert.equal(result.command.stateUnknown, false);
  assert.equal(result.readback, undefined);
});

test("JLinkBackend never promotes write echo to readback and preserves readback failure dispatch", async () => {
  const echoOnly = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => registerTransactionProcess([], "write_echo_only"),
  );
  const missing = await echoOnly.writeCoreRegisterTransaction("R0", 0x1234_5678);
  assert.equal(missing.command.success, true);
  assert.equal(missing.readback?.success, true);
  assert.doesNotMatch(missing.readback?.rawOutput ?? "", /R0\s*=/i);

  const failedReadback = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => registerTransactionProcess([], "readback_failure"),
  );
  const failed = await failedReadback.writeCoreRegisterTransaction("R0", 0x1234_5678);
  assert.equal(failed.command.success, true);
  assert.equal(failed.command.writeIssued, true);
  assert.equal(failed.command.stateUnknown, false);
  assert.equal(failed.readback?.success, false);
  assert.equal(failed.readback?.errorCode, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(failed.readback?.writeIssued, true);
  assert.equal(failed.readback?.stateUnknown, true);
});

test("JLinkBackend treats a late target failure without command echoes as a possible write", async () => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => registerTransactionProcess([], "readback_failure_no_echo"),
  );

  const result = await backend.writeCoreRegisterTransaction("R0", 0x1234_5678);

  assert.equal(result.command.success, false);
  assert.equal(result.command.errorCode, ProbeErrorCode.TARGET_UNREACHABLE);
  assert.equal(result.command.writeIssued, true);
  assert.equal(result.command.stateUnknown, true);
  assert.equal(result.readback?.success, false);
  assert.equal(result.readback?.writeIssued, true);
  assert.equal(result.readback?.stateUnknown, true);
});

test("JLinkBackend lets a fatal stderr diagnostic override completed write and readback prompts", async () => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => registerTransactionProcess([], "stderr_fatal"),
  );

  const result = await backend.writeCoreRegisterTransaction("R0", 0x1234_5678);

  assert.equal(result.command.success, false);
  assert.equal(result.command.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.command.writeIssued, true);
  assert.equal(result.command.stateUnknown, true);
  assert.equal(result.readback?.success, false);
  assert.equal(result.readback?.stateUnknown, true);
});

test("JLinkBackend reports a busy core-register transaction as unissued without spawning", async () => {
  let spawns = 0;
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => {
      spawns += 1;
      return registerTransactionProcess([], "match");
    },
  );
  assert.equal(backend.acquireExclusive("fixture-owner"), true);

  const result = await backend.writeCoreRegisterTransaction("R0", 0x1234_5678);

  assert.equal(result.command.errorCode, ProbeErrorCode.PROBE_BUSY);
  assert.equal(result.command.writeIssued, false);
  assert.equal(result.command.stateUnknown, false);
  assert.equal(spawns, 0);
});

test("JLinkBackend uses the explicit GDB attach profile instead of the Flash device", () => {
  const backend = new JLinkBackend(
    { device: "Z20K146M", gdbDevice: "Cortex-M4", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
  );
  const args = (backend as unknown as { gdbServerArgs(): string[] }).gdbServerArgs();
  assert.equal(args[args.indexOf("-device") + 1], "Cortex-M4");
});

test("JLinkBackend uses the explicit non-invasive attach profile for register snapshots", async () => {
  const spawnedArgs: string[][] = [];
  const backend = new JLinkBackend(
    { device: "Z20K146M", gdbDevice: "Cortex-M4", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    (_command, args) => {
      spawnedArgs.push([...args]);
      return successfulProcess([]);
    },
  );

  assert.equal((await backend.readAllRegisters()).success, true);
  assert.equal(spawnedArgs[0][spawnedArgs[0].indexOf("-device") + 1], "Cortex-M4");
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

test("JLinkBackend fails a zero-exit raw command when J-Link reports an unknown command", async () => {
  const scripts: string[] = [];
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
    () => successfulProcess(scripts, "J-Link>Unknown command. '?' for help."),
  );

  const result = await backend.executeRaw(["verify C:\\firmware\\app.s19"]);

  assert.equal(result.success, false);
  assert.equal(result.errorCode, ProbeErrorCode.JLINK_COMMAND_FAILED);
  assert.equal(result.stateUnknown, true);
  assert.match(result.error ?? "", /Unknown command/i);
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

test("JLinkBackend GDB Server arguments use valueless compatibility flags", () => {
  const backend = new JLinkBackend(
    { device: "TEST", serialNumber: "123456", interface: "SWD", speed: 1000 },
    new ProcessManager(),
  );
  const args = (backend as unknown as { gdbServerArgs(): string[] }).gdbServerArgs();
  assert.ok(args.includes("-noreset"));
  assert.ok(args.includes("-nohalt"));
  assert.ok(args.includes("-noir"));
  assert.ok(args.includes("-singlerun"));
  assert.equal(args.includes("-nosinglerun"), false);
  for (const option of ["-LocalhostOnly", "-NoGui"]) {
    const optionIndex = args.indexOf(option);
    assert.notEqual(optionIndex, -1);
    assert.match(args[optionIndex + 1] ?? "", /^-/);
  }
  assert.deepEqual(args.slice(-2), ["-select", "USB=123456"]);
});

test("ProcessManager preserves natural child exit facts for GDB Server cleanup", async () => {
  const manager = new ProcessManager();
  manager.spawn("clean-exit", process.execPath, ["-e", "setTimeout(() => process.exit(0), 20)"]);
  const clean = await manager.waitForExit("clean-exit", 2_000);
  assert.deepEqual(clean, { found: true, exited: true, exitCode: 0, signal: null });

  const failedExit = new Promise<void>((resolve) => {
    const listener = (name: string) => {
      if (name !== "failed-exit") return;
      manager.off("processExit", listener);
      resolve();
    };
    manager.on("processExit", listener);
  });
  manager.spawn("failed-exit", process.execPath, ["-e", "setTimeout(() => process.exit(3), 20)"]);
  await failedExit;
  const failed = await manager.waitForExit("failed-exit", 2_000);
  assert.deepEqual(failed, { found: true, exited: true, exitCode: 3, signal: null });
});

test("ProcessManager waits for Node exit facts after the OS process is already gone", async () => {
  const manager = new ProcessManager();
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 2_147_483_647,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  (manager as unknown as { processes: Map<string, { process: ChildProcess; name: string; kill(): void }> }).processes.set(
    "delayed-exit-event",
    { process: child, name: "delayed-exit-event", kill: () => undefined },
  );

  const waiting = manager.waitForExit("delayed-exit-event", 1_000);
  setImmediate(() => {
    Object.defineProperty(child, "exitCode", { value: 0, writable: true });
    child.emit("exit", 0, null);
  });

  assert.deepEqual(await waiting, { found: true, exited: true, exitCode: 0, signal: null });
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

  response = { ...response, targetWasHaltedRaw: 1, targetWasHaltedAfterReadRaw: 1 };
  const staleHelperObservation = await backend.observeTargetState({ preserveDebugStateOnClose: true });
  assert.equal(staleHelperObservation.state, "unknown");
  assert.match(staleHelperObservation.result.error ?? "", /debug de-initialization was skipped/i);
  assert.equal(staleHelperObservation.result.stateUnknown, true);
  assert.deepEqual(
    invocations[1].args.slice(invocations[1].args.indexOf("--preserve-debug-state-on-close")),
    ["--preserve-debug-state-on-close", "true"],
  );

  response = { ...response, memoryCacheDisabled: false, targetWasHaltedRaw: 0, targetWasHaltedAfterReadRaw: 0 };
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

function registerTransactionProcess(
  scripts: string[],
  mode: "match" | "write_echo_only" | "readback_failure" | "readback_failure_no_echo" | "stderr_fatal" | "batch_silent",
  options: {
    initialPrompt?: boolean;
    realisticStartupChunks?: boolean;
    respondAfterEof?: boolean;
    registerState?: { value: string };
  } = {},
): ChildProcess {
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
  let input = "";
  let token = "";
  let requested = "";
  let closed = false;
  const close = (code: number) => {
    if (closed) return;
    closed = true;
    scripts.push(script);
    child.stdout.end();
    child.stderr.end();
    child.exitCode = code;
    child.emit("exit", code, null);
    child.emit("close", code, null);
  };
  const respond = (text: string) => child.stdout.write(text);
  const respondChunks = (chunks: string[]) => {
    for (const chunk of chunks) child.stdout.write(chunk);
  };
  const processInput = () => {
    if (mode === "batch_silent") return;
    while (input.includes("\n")) {
      const newline = input.indexOf("\n");
      const command = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (!command) continue;
      if (command === "exec SetRestartOnClose = 0") {
        if (options.realisticStartupChunks) {
          respondChunks([
            "SEGGER J-Link Commander V8.84\r\n",
            "DLL version V8.84\r\nJ-L",
            "ink>exec SetRestartOnClose = 0\r\n",
            "O.",
            "K.\r\nJ-Link",
            ">",
          ]);
        } else {
          respond("O.K.\nJ-Link>");
        }
      } else if (command.startsWith("wreg ")) {
        const match = command.match(/^wreg (.+), 0x([0-9a-f]+)$/i);
        token = match?.[1] ?? "R0";
        requested = match?.[2] ?? "00000000";
        respond(mode === "readback_failure_no_echo"
          ? "O.K.\r\nJ-Link>"
          : `${command}\r\nwrite echo: ${token} = ${requested}\r\nJ-Link>`);
      } else if (command.startsWith("rreg ")) {
        const readToken = command.slice("rreg ".length).trim();
        if (!token) token = readToken;
        const readValue = requested || options.registerState?.value || "00000000";
        if (mode === "readback_failure" || mode === "readback_failure_no_echo") {
          setImmediate(() => {
            child.stdout.write(mode === "readback_failure_no_echo"
              ? "****** Error: Cannot connect to target\r\n"
              : `${command}\r\n****** Error: Cannot connect to target\r\n`);
            close(1);
          });
        } else if (mode === "write_echo_only") {
          respond(`${command}\r\nO.K.\r\nJ-Link>`);
        } else {
          respond(`${command}\r\n${token} = 0x${readValue}\r\nJ-Link>`);
        }
      } else if (command === "exit") {
        setImmediate(() => {
          if (mode === "stderr_fatal") child.stderr.write("Unknown command. '?' for help.\n");
          if (options.registerState) {
            if (/exec SetSkipDebugDeInit\s*=\s*1/i.test(script)) {
              if (requested) options.registerState.value = requested;
            } else {
              options.registerState.value = "00000000";
            }
          }
          close(0);
        });
      }
    }
  };
  child.stdin.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    script += text;
    input += text;
    if (!options.respondAfterEof) processInput();
  });
  child.stdin.on("end", processInput);
  child.kill = () => {
    setImmediate(() => close(1));
    return true;
  };
  if (options.initialPrompt !== false && !options.respondAfterEof) respond("SEGGER J-Link Commander\nJ-Link>");
  return child as unknown as ChildProcess;
}

function temporaryFirmwareBin(context: TestContext, name: string): string {
  const root = mkdtempSync(join(tmpdir(), `jlink-verify-${name}-test-`));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "app.bin");
  writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  return file;
}

function successfulProcess(
  scripts: string[],
  stdout = "",
  stderr = "",
  onScript?: (script: string) => void,
  exitCode = 0,
): ChildProcess {
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
    onScript?.(script);
    setImmediate(() => {
      if (stdout) child.stdout.write(stdout);
      child.stdout.end();
      if (stderr) child.stderr.write(stderr);
      child.stderr.end();
      child.exitCode = exitCode;
      child.emit("exit", exitCode, null);
      child.emit("close", exitCode, null);
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
