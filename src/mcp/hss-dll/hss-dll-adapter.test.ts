import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  discoverHssDll,
  hssDllBenchmark,
  hssDllGetCaps,
  hssDllPreflight,
  hssDllSearchPaths,
  hssDllSmoke,
  resolveHssRuntimeIdentity,
  resolveHssScriptIdentity,
  runHssHelperCommand,
  type HssHelperOptions,
} from "./hss-dll-adapter";

const TEST_RUNTIME_VERSIONS = {
  helperVersion: "1",
  helperProtocolVersion: 1,
  dllVersion: "88400",
} as const;

function tempDir(): string {
  fs.mkdirSync(path.join(process.cwd(), ".tmp"), { recursive: true });
  return fs.mkdtempSync(path.join(process.cwd(), ".tmp", "hss-dll-adapter-"));
}

function nodeHelper(
  dir: string,
  body: string,
  preflight: Record<string, unknown> = { status: "ok", exportsFound: true, dllVersion: 88400 },
  helperVersion = "1",
): { helperPath: string; helperArgsPrefix: string[] } {
  const script = path.join(dir, "helper.js");
  fs.writeFileSync(script, `
    const originalLog = console.log;
    console.log = (value) => {
      try {
        const parsed = JSON.parse(String(value));
        if (parsed.status === "ok" && process.argv[2] === "getcaps") {
          const pathIndex = process.argv.indexOf("--jlink-script-file");
          const hashIndex = process.argv.indexOf("--approved-jlink-script-sha256");
          const modeIndex = process.argv.indexOf("--jlink-script-mode");
          parsed.jlinkScriptMode = modeIndex >= 0 ? process.argv[modeIndex + 1] : undefined;
          parsed.jlinkScriptFile = pathIndex >= 0 ? process.argv[pathIndex + 1] : undefined;
          parsed.jlinkScriptSha256 = hashIndex >= 0 ? process.argv[hashIndex + 1] : undefined;
          parsed.jlinkScriptReturnCode = 0;
          return originalLog(JSON.stringify(parsed));
        }
      } catch {}
      originalLog(value);
    };
    if (process.argv[2] === "version") {
      console.log(JSON.stringify({ status: "ok", helperVersion: ${JSON.stringify(helperVersion)}, helperProtocolVersion: 1 }));
      process.exit(0);
    }
    if (process.argv[2] === "preflight") {
      console.log(JSON.stringify(${JSON.stringify(preflight)}));
      process.exit(0);
    }
    ${body}
  `);
  return { helperPath: process.execPath, helperArgsPrefix: [script] };
}

function approvedOptions(dll: string, dllSha256: string, options: HssHelperOptions = {}): HssHelperOptions {
  const scriptFile = options.env?.JLINK_SCRIPT_FILE ?? path.join(path.dirname(dll), "approved-reset.jlink");
  if (!fs.existsSync(scriptFile)) fs.writeFileSync(scriptFile, "// deterministic approved ScriptFile fixture\n");
  const scriptSha256 = createHash("sha256").update(fs.readFileSync(scriptFile)).digest("hex");
  const env = {
    ...(options.env ?? {}),
    JLINK_SCRIPT_FILE: scriptFile,
    JLINK_SCRIPT_SHA256: scriptSha256,
    JLINK_SCRIPT_SHA256_ALLOWLIST: scriptSha256,
  };
  const scriptIdentity = resolveHssScriptIdentity({}, env, { ...options, env, validatedJlinkScriptSha256: [scriptSha256] });
  assert.equal(scriptIdentity.validated, true);
  const base = { ...options, env, validatedDllSha256: [dllSha256], validatedJlinkScriptSha256: [scriptSha256], scriptIdentity };
  const identity = resolveHssRuntimeIdentity(discoverHssDll({ dllPath: dll }, env, base), env, base, TEST_RUNTIME_VERSIONS, true);
  assert.ok(identity.sha256);
  return { ...base, validatedRuntimeIdentitySha256: [identity.sha256] };
}

function writeFakeDll(file: string, machine = 0x8664, exports = [
  "JLINK_HSS_GetCaps",
  "JLINK_HSS_Start",
  "JLINK_HSS_Read",
  "JLINK_HSS_Stop",
]): string {
  const data = Buffer.alloc(1024);
  data.write("MZ", 0, "ascii");
  data.writeUInt32LE(0x80, 0x3c);
  data.write("PE\0\0", 0x80, "ascii");
  data.writeUInt16LE(machine, 0x84);
  data.write(exports.join("\0"), 0x100, "ascii");
  fs.writeFileSync(file, data);
  return createHash("sha256").update(data).digest("hex");
}

test("HSS DLL discovery records search paths and candidate exports", () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const discovery = discoverHssDll({ dllPath: dll }, {});
    assert.equal(discovery.selectedDllPath, dll);
    assert.equal(discovery.exportsFound, true);
    assert.equal(discovery.officialSdkHeaderFound, false);
    assert.equal(discovery.publicPrototypeCandidate, true);
    const partial = path.join(dir, "partial.dll");
    writeFakeDll(partial, 0x8664, ["JLINK_HSS_GetCaps"]);
    assert.deepEqual(discoverHssDll({ dllPath: partial }, {}).exportsFound, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL resolver honors explicit, environment, registry, PATH, and common order", () => {
  const dir = tempDir();
  try {
    const locations = Object.fromEntries(["explicit", "environment", "registry", "path", "common"].map((name) => {
      const installDir = path.join(dir, name);
      fs.mkdirSync(installDir, { recursive: true });
      const dll = path.join(installDir, "JLink_x64.dll");
      writeFakeDll(dll);
      return [name, { installDir, dll }];
    })) as Record<string, { installDir: string; dll: string }>;
    fs.writeFileSync(path.join(locations.path.installDir, "JLink.exe"), "fixture");

    const options = {
      registryInstallDirs: [locations.registry.installDir],
      commonInstallDirs: [locations.common.installDir],
    };
    const env = {
      JLINK_DLL_PATH: locations.environment.dll,
      PATH: locations.path.installDir,
    };

    assert.equal(discoverHssDll({ dllPath: locations.explicit.dll }, env, options).resolutionSource, "explicit");
    assert.equal(discoverHssDll({}, env, options).resolutionSource, "environment");
    assert.equal(discoverHssDll({}, { PATH: locations.path.installDir }, options).resolutionSource, "registry");
    assert.equal(discoverHssDll({}, { PATH: locations.path.installDir }, { ...options, registryInstallDirs: [] }).resolutionSource, "path");
    assert.equal(discoverHssDll({}, {}, { ...options, registryInstallDirs: [] }).resolutionSource, "common");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL resolver rejects non-x64 and unvalidated identities", () => {
  const dir = tempDir();
  try {
    const x64 = path.join(dir, "JLink_x64.dll");
    const x64Sha256 = writeFakeDll(x64);
    const validated = discoverHssDll({ dllPath: x64 }, {}, { validatedDllSha256: [x64Sha256] });
    assert.equal(validated.architecture, "x64");
    assert.equal(validated.sha256, x64Sha256);
    assert.equal(validated.identityValidated, true);
    assert.equal(validated.availability, "candidate");

    const unknown = discoverHssDll({ dllPath: x64 }, {});
    assert.equal(unknown.availability, "unavailable");
    assert.equal(unknown.unavailableCode, "HSS_DLL_IDENTITY_UNVALIDATED");

    const x86 = path.join(dir, "JLink_x86.dll");
    writeFakeDll(x86, 0x014c);
    const wrongArchitecture = discoverHssDll({ dllPath: x86 }, {}, { validatedDllSha256: [x64Sha256] });
    assert.equal(wrongArchitecture.architecture, "x86");
    assert.equal(wrongArchitecture.availability, "unavailable");
    assert.equal(wrongArchitecture.unavailableCode, "HSS_DLL_ARCH_UNSUPPORTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS runtime identity approval is invalidated by DLL, helper, or adapter changes", () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const helperPath = path.join(dir, "hss_helper.exe");
    const adapterPath = path.join(dir, "adapter.js");
    const dllSha256 = writeFakeDll(dll);
    fs.writeFileSync(helperPath, "helper-v1");
    fs.writeFileSync(adapterPath, "adapter-v1");
    const base = { helperPath, adapterPath, validatedDllSha256: [dllSha256], scriptIdentity: {
      mode: "none" as const,
      approvalSha256: createHash("sha256").update("none").digest("hex"),
      approvalSource: "trust-validation" as const,
      validated: true,
    } };
    const discovery = discoverHssDll({ dllPath: dll }, {}, base);
    const identity = resolveHssRuntimeIdentity(discovery, {}, base, TEST_RUNTIME_VERSIONS, true);
    assert.ok(identity.sha256);
    assert.equal(resolveHssRuntimeIdentity(discovery, {}, { ...base, validatedRuntimeIdentitySha256: [identity.sha256] }, TEST_RUNTIME_VERSIONS, true).validated, true);

    fs.writeFileSync(helperPath, "helper-v2-changed");
    assert.equal(resolveHssRuntimeIdentity(discovery, {}, { ...base, validatedRuntimeIdentitySha256: [identity.sha256] }, TEST_RUNTIME_VERSIONS, true).validated, false);
    fs.writeFileSync(helperPath, "helper-v1");
    fs.writeFileSync(adapterPath, "adapter-v2-changed");
    assert.equal(resolveHssRuntimeIdentity(discovery, {}, { ...base, validatedRuntimeIdentitySha256: [identity.sha256] }, TEST_RUNTIME_VERSIONS, true).validated, false);

    const changedDll = fs.readFileSync(dll);
    changedDll[changedDll.length - 1] = 1;
    fs.writeFileSync(dll, changedDll);
    const changedDllSha256 = createHash("sha256").update(changedDll).digest("hex");
    const changedDiscovery = discoverHssDll({ dllPath: dll }, {}, { ...base, validatedDllSha256: [changedDllSha256] });
    assert.equal(resolveHssRuntimeIdentity(changedDiscovery, {}, { ...base, validatedRuntimeIdentitySha256: [identity.sha256] }, TEST_RUNTIME_VERSIONS, true).validated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL resolver rejects unsupported hosts and non-file candidates", () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const unsupportedHost = discoverHssDll({ dllPath: dll }, {}, {
      validatedDllSha256: [sha256],
      runtimePlatform: "linux",
      runtimeArchitecture: "x64",
    });
    assert.equal(unsupportedHost.availability, "unavailable");
    assert.equal(unsupportedHost.unavailableCode, "HSS_PLATFORM_UNSUPPORTED");

    const invalidFile = discoverHssDll({ dllPath: dir }, {}, {
      validatedDllSha256: [sha256],
      runtimePlatform: "win32",
      runtimeArchitecture: "x64",
    });
    assert.equal(invalidFile.availability, "unavailable");
    assert.equal(invalidFile.unavailableCode, "HSS_DLL_INVALID_FILE");
    assert.equal(invalidFile.sha256, undefined);
    assert.equal(invalidFile.identityValidated, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL discovery uses generic common installs and ignores legacy overrides", () => {
  const paths = hssDllSearchPaths({
    JLINK_MCP_HSS_DLL_PATH: "C:\\legacy\\JLink_x64.dll",
    JLINK_INSTALL_DIR: "C:\\legacy-install",
  }, undefined, { registryInstallDirs: [], commonInstallDirs: ["C:\\Program Files\\SEGGER\\JLink"] });
  assert.deepEqual(paths, ["C:\\Program Files\\SEGGER\\JLink\\JLink_x64.dll"]);
});

test("HSS DLL preflight reports candidate without a helper", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const preflight = await hssDllPreflight({ dllPath: dll }, {
      env: {},
      helperPath: path.join(dir, "missing.exe"),
      validatedDllSha256: [sha256],
    });
    assert.equal(preflight.status, "candidate");
    assert.equal(preflight.getcapsAllowed, false);
    assert.equal(preflight.benchmarkReady, false);
    assert.equal("helperPreflight" in preflight, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL preflight runs connect-preflight when device and helper are available", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const helper = nodeHelper(dir, `
      const command = process.argv[2];
      if (command === 'connect-preflight') console.log(JSON.stringify({ status: 'ok', targetWasHalted: true }));
      else console.log(JSON.stringify({ status: 'ok', exportsFound: true }));
    `);
    const preflight = await hssDllPreflight(
      { dllPath: dll, device: "Z20K146MC", interface: "SWD", speedKhz: 4000, serial: "1" },
      approvedOptions(dll, sha256, { env: {}, ...helper }),
    );
    assert.equal((preflight.connectPreflight as { targetWasHalted?: boolean }).targetWasHalted, true);
    assert.equal(preflight.safetyStatus, "HSS_SAFETY_FAIL");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL preflight returns structured unavailable when native export validation fails", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const helper = nodeHelper(dir, "console.log(JSON.stringify({ status: 'ok' }));", { status: "ok", exportsFound: false, dllVersion: 88400 });
    const preflight = await hssDllPreflight(
      { dllPath: dll, device: "fixture-device" },
      approvedOptions(dll, sha256, { env: {}, ...helper }),
    );
    assert.equal(preflight.status, "unavailable");
    assert.equal(preflight.errorCode, "HSS_DLL_EXPORTS_MISSING");
    assert.equal(preflight.connectPreflight, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS getcaps returns structured errors for missing exports, helper crash, timeout, and bad JSON", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const partial = path.join(dir, "partial.dll");
    writeFakeDll(partial, 0x8664, ["JLINK_HSS_GetCaps"]);
    const missingExport = await hssDllGetCaps({ dllPath: partial }, { env: {} });
    assert.equal(missingExport.errorCode, "HSS_DLL_EXPORTS_MISSING");

    const okHelper = nodeHelper(dir, "console.log(JSON.stringify({ status: 'ok' }));");
    const missingDevice = await hssDllGetCaps({ dllPath: dll }, approvedOptions(dll, sha256, { env: {}, ...okHelper }));
    assert.equal(missingDevice.errorCode, "HSS_GETCAPS_DEVICE_REQUIRED");

    const badJson = nodeHelper(dir, "console.log('not json');");
    const parse = await hssDllGetCaps({ dllPath: dll, device: "Z20K146MC" }, approvedOptions(dll, sha256, { env: {}, ...badJson }));
    assert.equal(parse.errorCode, "HSS_HELPER_JSON_PARSE_FAILED");

    const timeoutHelper = nodeHelper(dir, "setTimeout(() => {}, 10000);");
    const timeout = await hssDllGetCaps({ dllPath: dll, device: "Z20K146MC" }, approvedOptions(dll, sha256, { env: {}, timeoutMs: 500, ...timeoutHelper }));
    assert.equal(timeout.errorCode, "HSS_HELPER_TIMEOUT");

    const crashHelper = nodeHelper(dir, "process.exit(2);");
    const crash = await hssDllGetCaps({ dllPath: dll, device: "Z20K146MC" }, approvedOptions(dll, sha256, { env: {}, ...crashHelper }));
    assert.equal(crash.errorCode, "HSS_HELPER_JSON_PARSE_FAILED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS getcaps does not invoke a helper for an unvalidated identity", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const marker = path.join(dir, "helper-invoked");
    const helper = nodeHelper(dir, `
      if (process.argv[2] === "getcaps") require("fs").writeFileSync(process.env.HSS_HELPER_MARKER, "invoked");
      console.log(JSON.stringify({ status: "ok", returnCode: 0, caps: { maxBlocks: 1, maxFreq: 1000 }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 }));
    `);
    const input = { dllPath: dll, device: "fixture-device" };
    const blocked = await hssDllGetCaps(input, {
      env: { HSS_HELPER_MARKER: marker },
      ...helper,
    });
    assert.equal(blocked.status, "unavailable");
    assert.equal(blocked.errorCode, "HSS_DLL_IDENTITY_UNVALIDATED");
    assert.equal(fs.existsSync(marker), false);

    const dllOnly = await hssDllGetCaps(input, {
      ...approvedOptions(dll, sha256, {
      env: { HSS_HELPER_MARKER: marker },
      ...helper,
      }),
      validatedRuntimeIdentitySha256: [],
    });
    assert.equal(dllOnly.status, "unavailable");
    assert.equal(dllOnly.errorCode, "HSS_RUNTIME_IDENTITY_UNVALIDATED");
    assert.equal(fs.existsSync(marker), false);

    const validated = await hssDllGetCaps(input, approvedOptions(dll, sha256, {
      env: { HSS_HELPER_MARKER: marker },
      ...helper,
    }));
    assert.equal(validated.status, "ok");
    assert.equal(fs.existsSync(marker), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS getcaps passes only dedicated approved J-Link script selection arguments", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const argvFile = path.join(dir, "argv.json");
    const scriptFile = path.join(dir, "批准脚本.JLinkScript");
    fs.writeFileSync(scriptFile, "// non-ASCII 路径选择 fixture\n");
    const scriptSha256 = createHash("sha256").update(fs.readFileSync(scriptFile)).digest("hex");
    const helper = nodeHelper(dir, `
      require("fs").writeFileSync(process.env.HSS_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
      console.log(JSON.stringify({ status: "ok", returnCode: 0, caps: { maxBlocks: 1, maxFreq: 1000 }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 }));
    `);
    const result = await hssDllGetCaps({
      dllPath: dll,
      device: "fixture-device",
      jlinkScriptFile: scriptFile,
      approvedJlinkScriptSha256: scriptSha256,
    }, approvedOptions(dll, sha256, {
      env: { HSS_ARGV_LOG: argvFile, JLINK_SCRIPT_FILE: scriptFile },
      ...helper,
    }));
    assert.equal(result.status, "ok");
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
    const runtime = result.runtimeIdentity as { jlinkScriptFile: string };
    assert.deepEqual(argv.slice(-6), [
      "--jlink-script-mode",
      "file",
      "--jlink-script-file",
      runtime.jlinkScriptFile,
      "--approved-jlink-script-sha256",
      scriptSha256,
    ]);
    assert.notEqual(runtime.jlinkScriptFile, scriptFile);
    assert.equal(argv.some((value) => /raw|execcommand/i.test(value)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS getcaps rejects negative return codes and helper version mismatches", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const negative = nodeHelper(dir, "console.log(JSON.stringify({ status: 'ok', returnCode: -1, caps: { maxBlocks: 1, maxFreq: 1000 }, dllVersion: 88400, helperVersion: '1', helperProtocolVersion: 1 }));");
    const rejected = await hssDllGetCaps({ dllPath: dll, device: "fixture-device" }, approvedOptions(dll, sha256, { env: {}, ...negative }));
    assert.equal(rejected.status, "error");
    assert.equal(rejected.errorCode, "HSS_GETCAPS_FAILED");

    const mismatch = nodeHelper(dir, "console.log(JSON.stringify({ status: 'ok' }));", undefined, "2");
    const unavailable = await hssDllGetCaps({ dllPath: dll, device: "fixture-device" }, approvedOptions(dll, sha256, { env: {}, ...mismatch }));
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.errorCode, "HSS_RUNTIME_IDENTITY_UNVALIDATED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS getcaps fails closed when runtime identity changes during helper execution", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const adapterPath = path.join(dir, "adapter.js");
    fs.writeFileSync(adapterPath, "adapter-v1");
    const sha256 = writeFakeDll(dll);
    const helper = nodeHelper(dir, `
      require("fs").writeFileSync(process.env.HSS_ADAPTER_PATH, "adapter-v2");
      console.log(JSON.stringify({ status: "ok", returnCode: 0, caps: { maxBlocks: 1, maxFreq: 1000 }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 }));
    `);
    const result = await hssDllGetCaps({ dllPath: dll, device: "fixture-device" }, approvedOptions(dll, sha256, {
      env: { HSS_ADAPTER_PATH: adapterPath },
      adapterPath,
      ...helper,
    }));
    assert.equal(result.status, "unavailable");
    assert.equal(result.errorCode, "HSS_RUNTIME_IDENTITY_CHANGED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS getcaps and connect preflight do not invoke a helper on an unsupported host", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const marker = path.join(dir, "helper-invoked");
    const helper = nodeHelper(dir, `
      if (process.argv[2] === "getcaps" || process.argv[2] === "connect-preflight") {
        require("fs").writeFileSync(process.env.HSS_HELPER_MARKER, "invoked");
      }
      console.log(JSON.stringify({ status: "ok" }));
    `);
    const options = {
      env: { HSS_HELPER_MARKER: marker },
      validatedDllSha256: [sha256],
      runtimePlatform: "linux",
      runtimeArchitecture: "x64",
      ...helper,
    };
    const input = { dllPath: dll, device: "fixture-device" };
    const getCaps = await hssDllGetCaps(input, options);
    assert.equal(getCaps.status, "unavailable");
    assert.equal(getCaps.errorCode, "HSS_PLATFORM_UNSUPPORTED");
    assert.equal(fs.existsSync(marker), false);

    const preflight = await hssDllPreflight(input, options);
    assert.equal(preflight.connectPreflight, undefined);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS wrapper accepts helper JSON and rejects unsafe smoke/benchmark variables", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    const sha256 = writeFakeDll(dll);
    const okHelper = nodeHelper(dir, `
      const command = process.argv[2];
      console.log(JSON.stringify(command === "getcaps"
        ? { status: "ok", command, returnCode: 0, caps: { maxBlocks: 1, maxFreq: 1000 }, dllVersion: 88400, helperVersion: "1", helperProtocolVersion: 1 }
        : { status: "ok", command }));
    `);
    const env = {};
    const approved = approvedOptions(dll, sha256, { env, ...okHelper });
    assert.equal((await hssDllGetCaps({ dllPath: dll, device: "Z20K146MC" }, approved)).status, "ok");
    assert.equal((await hssDllSmoke({ dllPath: dll, symbol: "s_traceAliveCounter", address: "0x20006bdc", size: 4, device: "Z20K146MC", elf: "x.elf" }, approved)).status, "ok");
    assert.equal((await hssDllBenchmark({ dllPath: dll, variables: [{ name: "s_traceAliveCounter", address: "0x20006bdc", size: 4 }], device: "Z20K146MC" }, approved)).status, "ok");
    assert.rejects(() => hssDllSmoke({ dllPath: dll, symbol: "bMotorStarted" }, { env, ...okHelper }), /unsafe HSS/);
    assert.rejects(() => hssDllBenchmark({ dllPath: dll, variables: [{ name: "gstMotorCtrl.run", address: "0x20000000", size: 4 }] }, { env, ...okHelper }), /unsafe HSS/);
    assert.equal((await runHssHelperCommand("getcaps", [], { helperPath: path.join(dir, "missing.exe") })).errorCode, "HSS_HELPER_MISSING");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
