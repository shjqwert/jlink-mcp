import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  discoverHssDll,
  hssDllBenchmark,
  hssDllGetCaps,
  hssDllPreflight,
  hssDllSmoke,
  runHssHelperCommand,
} from "./hss-dll-adapter";

function tempDir(): string {
  fs.mkdirSync(path.join(process.cwd(), ".tmp"), { recursive: true });
  return fs.mkdtempSync(path.join(process.cwd(), ".tmp", "hss-dll-adapter-"));
}

function nodeHelper(dir: string, body: string): { helperPath: string; helperArgsPrefix: string[] } {
  const script = path.join(dir, "helper.js");
  fs.writeFileSync(script, body);
  return { helperPath: process.execPath, helperArgsPrefix: [script] };
}

test("HSS DLL discovery records search paths and candidate exports", () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    fs.writeFileSync(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop");
    const discovery = discoverHssDll({ dllPath: dll }, {});
    assert.equal(discovery.selectedDllPath, dll);
    assert.equal(discovery.exportsFound, true);
    assert.equal(discovery.officialSdkHeaderFound, false);
    assert.equal(discovery.publicPrototypeCandidate, true);
    const partial = path.join(dir, "partial.dll");
    fs.writeFileSync(partial, "JLINK_HSS_GetCaps");
    assert.deepEqual(discoverHssDll({ dllPath: partial }, {}).exportsFound, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL preflight is gated and does not call helper when env is disabled", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    fs.writeFileSync(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop");
    const preflight = await hssDllPreflight({ dllPath: dll }, { env: {}, helperPath: path.join(dir, "missing.exe") });
    assert.equal(preflight.status, "candidate");
    assert.equal(preflight.experimentalEnvEnabled, false);
    assert.equal(preflight.getcapsAllowed, false);
    assert.equal(preflight.benchmarkReady, false);
    assert.equal("helperPreflight" in preflight, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS DLL preflight runs connect-preflight only when real smoke env is enabled", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    fs.writeFileSync(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop");
    const helper = nodeHelper(dir, `
      const command = process.argv[2];
      if (command === 'connect-preflight') console.log(JSON.stringify({ status: 'ok', targetWasHalted: true }));
      else console.log(JSON.stringify({ status: 'ok', exportsFound: true }));
    `);
    const preflight = await hssDllPreflight({ dllPath: dll, device: "Z20K146MC", interface: "SWD", speedKhz: 4000, serial: "1" }, {
      env: { JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API: "1", JLINK_MCP_REAL_HW_SMOKE: "1" },
      ...helper,
    });
    assert.equal((preflight.connectPreflight as { targetWasHalted?: boolean }).targetWasHalted, true);
    assert.equal(preflight.safetyStatus, "HSS_SAFETY_FAIL");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS getcaps returns structured errors for missing env, helper crash, timeout, and bad JSON", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    fs.writeFileSync(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop");
    const disabled = await hssDllGetCaps({ dllPath: dll }, { env: {} });
    assert.equal(disabled.errorCode, "HSS_EXPERIMENTAL_ENV_DISABLED");
    const partial = path.join(dir, "partial.dll");
    fs.writeFileSync(partial, "JLINK_HSS_GetCaps");
    const missingExport = await hssDllGetCaps({ dllPath: partial }, { env: { JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API: "1" } });
    assert.equal(missingExport.errorCode, "HSS_DLL_EXPORTS_MISSING");

    const badJson = nodeHelper(dir, "console.log('not json');");
    const parse = await hssDllGetCaps({ dllPath: dll }, { env: { JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API: "1" }, ...badJson });
    assert.equal(parse.errorCode, "HSS_HELPER_JSON_PARSE_FAILED");

    const timeoutHelper = nodeHelper(dir, "setTimeout(() => {}, 10000);");
    const timeout = await hssDllGetCaps({ dllPath: dll }, { env: { JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API: "1" }, timeoutMs: 50, ...timeoutHelper });
    assert.equal(timeout.errorCode, "HSS_HELPER_TIMEOUT");

    const crashHelper = nodeHelper(dir, "process.exit(2);");
    const crash = await hssDllGetCaps({ dllPath: dll }, { env: { JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API: "1" }, ...crashHelper });
    assert.equal(crash.errorCode, "HSS_HELPER_JSON_PARSE_FAILED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("HSS wrapper accepts helper JSON and rejects unsafe smoke/benchmark variables", async () => {
  const dir = tempDir();
  try {
    const dll = path.join(dir, "JLink_x64.dll");
    fs.writeFileSync(dll, "JLINK_HSS_GetCaps\0JLINK_HSS_Start\0JLINK_HSS_Read\0JLINK_HSS_Stop");
    const okHelper = nodeHelper(dir, "console.log(JSON.stringify({ status: 'ok', command: process.argv[2] }));");
    const env = { JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API: "1" };
    assert.equal((await hssDllGetCaps({ dllPath: dll }, { env, ...okHelper })).status, "ok");
    assert.equal((await hssDllSmoke({ dllPath: dll, symbol: "s_traceAliveCounter", address: "0x20006bdc", size: 4, device: "Z20K146MC", elf: "x.elf" }, { env, ...okHelper })).status, "ok");
    assert.equal((await hssDllBenchmark({ dllPath: dll, variables: [{ name: "s_traceAliveCounter", address: "0x20006bdc", size: 4 }], device: "Z20K146MC" }, { env, ...okHelper })).status, "ok");
    assert.rejects(() => hssDllSmoke({ dllPath: dll, symbol: "bMotorStarted" }, { env, ...okHelper }), /unsafe HSS/);
    assert.rejects(() => hssDllBenchmark({ dllPath: dll, variables: [{ name: "gstMotorCtrl.run", address: "0x20000000", size: 4 }] }, { env, ...okHelper }), /unsafe HSS/);
    assert.equal((await runHssHelperCommand("getcaps", [], { helperPath: path.join(dir, "missing.exe") })).errorCode, "HSS_HELPER_MISSING");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
