import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = resolve(process.cwd());
const packageJson = JSON.parse(readFileSync(resolve(workspace, "package.json"), "utf8"));
const version = String(packageJson.version);
const releaseDir = resolve(workspace, "release", `v${version}`);
const tgz = resolve(releaseDir, `jlink-mcp-${version}.tgz`);
const portableZip = resolve(releaseDir, `jlink-mcp-v${version}-windows-x64.zip`);
const testRoot = resolve(process.env.JLINK_MCP_TEST_ROOT ?? "D:\\User\\Jlink_MCP_TEST");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const installRoot = resolve(testRoot, `install-${stamp}`);
const portableInstallRoot = resolve(testRoot, `portable-${stamp}`);

if (!regularFile(tgz)) throw new Error(`release archive not found: ${tgz}`);
if (!regularFile(portableZip)) throw new Error(`portable release archive not found: ${portableZip}`);
mkdirSync(installRoot, { recursive: false });
writeFileSync(resolve(installRoot, "package.json"), JSON.stringify({
  name: "jlink-mcp-release-install-test",
  version: "1.0.0",
  private: true,
}, null, 2));

const install = runNpm([
  "install",
  "--omit=dev",
  "--no-audit",
  "--no-fund",
  "--foreground-scripts",
  tgz,
], installRoot, true);
process.stdout.write(install.stdout);
if (install.stderr) process.stderr.write(install.stderr);
if (/\bgyp info it worked\b|MSBuild\.exe|cmake(?:\.exe)? --build/i.test(`${install.stdout}\n${install.stderr}`)) {
  throw new Error("isolated installation invoked a local native build tool");
}

const installed = resolve(installRoot, "node_modules", "jlink-mcp");
const doctor = run(process.execPath, [resolve(installed, "out", "mcp", "doctor.js")], installRoot, true);
assertDoctorReport(doctor.stdout, "installed");
await assertMcpSurface(resolve(installed, "out", "mcp", "standalone.js"), installRoot, "installed");

const smoke = `
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const api = require(${JSON.stringify(resolve(installed, "out", "mcp", "standalone.js"))});
const root = fs.mkdtempSync(path.join(os.tmpdir(), "jlink-mcp-release-jcap-"));
const packageDir = path.join(root, "release-smoke.jcap");
api.writeJcapV0Raw({
  packageDir,
  provenance: {
    captureId: "41000000-0000-4000-8000-000000000000",
    backend: "release-test",
    runtime: {},
    target: {},
    script: { mode: "none" }
  },
  samples: [{ sampleIndex: 0, tick: "0", statusFlags: 0, values: { signal: 1 } }],
  events: [
    { eventId: "41000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "planned" },
    { eventId: "41000000-0000-4000-8000-000000000002", eventSequence: 1, type: "lifecycle", tick: "1", state: "active" },
    { eventId: "41000000-0000-4000-8000-000000000003", eventSequence: 2, type: "lifecycle", tick: "2", state: "finalizing" },
    { eventId: "41000000-0000-4000-8000-000000000004", eventSequence: 3, type: "lifecycle", tick: "3", state: "completed" }
  ]
});
api.rebuildJcapV0Index(packageDir)
  .then(() => api.verifyJcapV0Index(packageDir))
  .then((result) => {
    if (!result || result.indexStatus !== "ready" || result.captureState !== "completed") throw new Error("JCAP index did not become ready");
    process.stdout.write(JSON.stringify({ status: "ok", packageDir }));
  })
  .catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });
`;
const jcap = run(process.execPath, ["-e", smoke], installRoot, true);
const jcapResult = JSON.parse(jcap.stdout);
if (jcapResult.status !== "ok") throw new Error("installed JCAP smoke test failed");

const helper = resolve(installed, "native", "hss-helper", "bin", "hss_helper.exe");
const helperVersion = run(helper, ["version"], installRoot, true);
const helperResult = JSON.parse(helperVersion.stdout);
if (helperResult.status !== "ok" || helperResult.helperVersion !== version) {
  throw new Error("installed HSS Helper version check failed");
}

mkdirSync(portableInstallRoot, { recursive: false });
const powershell = process.env.SystemRoot
  ? resolve(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";
run(powershell, [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "& { param([string]$archive, [string]$destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination }",
  portableZip,
  portableInstallRoot,
], workspace);
const portableRoot = readdirSync(portableInstallRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(portableInstallRoot, entry.name))
  .find((entry) => regularFile(resolve(entry, "doctor.cmd")));
if (!portableRoot) throw new Error(`portable package root not found after extracting ${basename(portableZip)}`);
const portableDoctor = run(process.env.ComSpec ?? "cmd.exe", [
  "/d",
  "/s",
  "/c",
  resolve(portableRoot, "doctor.cmd"),
], portableRoot, true);
assertDoctorReport(portableDoctor.stdout, "portable");
await assertMcpSurface(
  resolve(portableRoot, "node_modules", "jlink-mcp", "out", "mcp", "standalone.js"),
  portableRoot,
  "portable",
);

process.stdout.write([
  `isolated release installation passed: ${installRoot}`,
  `portable release installation passed: ${portableRoot}`,
  "",
].join("\n"));

function assertDoctorReport(output, label) {
  const report = JSON.parse(output);
  for (const id of ["platform", "node", "standalone", "sqlite", "hss-helper"]) {
    const check = report.checks?.find((entry) => entry.id === id);
    if (check?.status !== "pass") throw new Error(`${label} doctor check failed: ${id}`);
  }
}

async function assertMcpSurface(standalone, cwd, label) {
  const localRoot = resolve(cwd, ".jlink-mcp-release-smoke");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [standalone],
    cwd,
    stderr: "pipe",
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
      JLINK_MCP_QUEUE_ROOT: resolve(localRoot, "queue"),
      JLINK_MCP_STORAGE_ROOT: resolve(localRoot, "storage"),
      JLINK_MCP_EVIDENCE_ROOT: resolve(localRoot, "evidence"),
    },
  });
  const client = new Client({ name: `jlink-mcp-${label}-release-smoke`, version: "1" });
  try {
    await client.connect(transport);
    if (client.getServerVersion()?.name !== "jlink-mcp") {
      throw new Error(`${label} MCP server identity mismatch`);
    }
    const tools = (await client.listTools()).tools;
    if (tools.length !== 36) throw new Error(`${label} MCP exposed ${tools.length} tools instead of 36`);
  } finally {
    await client.close();
  }
}

function runNpm(args, cwd, capture = false) {
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", `npm.cmd ${args.map(quoteWindowsArgument).join(" ")}`]
    : args;
  return run(command, commandArgs, cwd, capture);
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${String(result.status)}${result.stderr ? `: ${result.stderr}` : ""}`);
  }
  return result;
}

function quoteWindowsArgument(value) {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function regularFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
