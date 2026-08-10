import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const executable = resolve("native", "hss-helper", "bin", "hss_helper.exe");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const expectedHelper = packageJson.jlinkMcp?.hssHelper;
if (!expectedHelper || !/^[0-9a-f]{64}$/.test(String(expectedHelper.sha256 ?? ""))) {
  throw new Error("package.json does not declare the pinned HSS Helper component");
}

const version = spawnSync(executable, ["version"], { encoding: "utf8", windowsHide: true });
if (version.stdout) process.stdout.write(version.stdout);
if (version.stderr) process.stderr.write(version.stderr);
if (version.error) throw version.error;
if (version.status !== 0) process.exit(version.status ?? 1);

const versionResponse = parseJson(version.stdout, "HSS Helper version");
if (versionResponse.status !== "ok"
  || versionResponse.helperProtocolVersion !== 3
  || versionResponse.architecture !== "x64"
  || versionResponse.helperVersion !== expectedHelper.version
  || versionResponse.helperProtocolVersion !== expectedHelper.protocolVersion
  || versionResponse.architecture !== expectedHelper.architecture) {
  throw new Error(`HSS Helper version mismatch: ${JSON.stringify(versionResponse)}`);
}
const helperSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
if (helperSha256 !== expectedHelper.sha256) throw new Error(`HSS Helper SHA-256 mismatch: ${helperSha256}`);

const result = spawnSync(executable, ["self-test"], { encoding: "utf8", windowsHide: true });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const response = parseJson(result.stdout, "HSS Helper self-test");
if (response.status !== "ok"
  || response.command !== "self-test"
  || response.captureTransitionValidated !== true
  || response.debugDeinitSkipValidated !== true
  || response.readyJournalValidated !== true
  || response.hssStartFrequencyValidated !== true
  || response.memorySessionControlValidated !== true
  || response.memorySessionProtocolValidated !== true) {
  throw new Error(`HSS Helper self-test failed: ${String(response.errorCode ?? response.reason ?? response.status)}`);
}

verifyStaticRuntime();

const memorySessionArgs = [
  "memory-session",
  "--dll", resolve(".tmp", "missing-JLink_x64.dll"),
  "--device", "Z20K146M",
  "--interface", "SWD",
  "--serial", "1",
  "--speed", "4000",
];

expectMemorySession("{\"op\":\"activate\"}\n", "HSS_DLL_LOAD_FAILED", "activated memory-session");
expectMemorySession("", "MEMORY_SESSION_ACTIVATION_STREAM_CLOSED", "inactive memory-session");
expectMemorySession("{\"op\":\"activate\",\"extra\":true}\n", "MEMORY_SESSION_ACTIVATION_INVALID", "invalid memory-session activation");

const timeoutResponse = await waitForActivationTimeout();
if (timeoutResponse.status !== "error" || timeoutResponse.errorCode !== "MEMORY_SESSION_ACTIVATION_TIMEOUT") {
  throw new Error(`memory-session did not time out before J-Link startup: ${String(timeoutResponse.errorCode ?? timeoutResponse.status)}`);
}

function expectMemorySession(input, expectedErrorCode, label) {
  const session = spawnSync(executable, memorySessionArgs, { encoding: "utf8", windowsHide: true, input });
  if (session.error) throw session.error;
  if (session.status !== 0) throw new Error(`${label} exited ${String(session.status)}`);
  const parsed = parseJson(session.stdout, label);
  if (parsed.status !== "error" || parsed.errorCode !== expectedErrorCode) {
    throw new Error(`${label} returned ${String(parsed.errorCode ?? parsed.status)} instead of ${expectedErrorCode}`);
  }
}

async function waitForActivationTimeout() {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const child = spawn(executable, memorySessionArgs, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const watchdog = setTimeout(() => {
      child.kill();
      rejectTimeout(new Error("memory-session activation did not time out"));
    }, 12_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(watchdog);
      rejectTimeout(error);
    });
    child.once("close", (status) => {
      clearTimeout(watchdog);
      if (status !== 0) {
        rejectTimeout(new Error(`memory-session activation timeout exited ${String(status)}: ${stderr}`));
        return;
      }
      try {
        resolveTimeout(parseJson(stdout, "timed-out memory-session"));
      } catch (error) {
        rejectTimeout(error);
      }
    });
  });
}

function parseJson(output, label) {
  try {
    return JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifyStaticRuntime() {
  const vswhere = resolve(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) throw new Error("vswhere.exe is required to inspect HSS Helper dependencies");
  const found = spawnSync(vswhere, [
    "-latest",
    "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-find", "**\\Hostx64\\x64\\dumpbin.exe",
  ], { encoding: "utf8", windowsHide: true });
  const dumpbin = found.stdout?.split(/\r?\n/).find(Boolean);
  if (found.status !== 0 || !dumpbin || !existsSync(dumpbin)) {
    throw new Error("dumpbin.exe was not found in the selected Visual Studio installation");
  }
  const dependencies = spawnSync(dumpbin, ["/DEPENDENTS", executable], { encoding: "utf8", windowsHide: true });
  if (dependencies.error) throw dependencies.error;
  if (dependencies.status !== 0) throw new Error(`dumpbin exited ${String(dependencies.status)}`);
  if (/\b(?:MSVCP|VCRUNTIME|UCRTBASED)\d*[^ \r\n]*\.dll\b/i.test(dependencies.stdout)) {
    throw new Error(`HSS Helper still depends on a dynamic Visual C++ runtime:\n${dependencies.stdout}`);
  }
  process.stdout.write("HSS Helper static runtime dependency gate passed\n");
}
