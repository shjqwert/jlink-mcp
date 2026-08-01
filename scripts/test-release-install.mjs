import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = resolve(process.cwd());
const require = createRequire(import.meta.url);
const fixtureApi = require(resolve(workspace, "out", "mcp", "jcap", "jcap-v1.js"));
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
  version,
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
  const captureId = writeReleaseFixture(resolve(localRoot, "evidence", "captures"));
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
    if (tools.length !== 40) throw new Error(`${label} MCP exposed ${tools.length} tools instead of 40`);
    for (const requiredTool of ["mcp_init", "gdb_breakpoint_list", "gdb_breakpoint_delete"]) {
      if (!tools.some(({ name }) => name === requiredTool)) throw new Error(`${label} MCP did not expose ${requiredTool}`);
    }
    const initialized = parseEnvelope(await client.callTool({ name: "mcp_init", arguments: { projectRoot: cwd } }));
    if (!initialized.ok) throw new Error(`${label} MCP project initialization failed: ${JSON.stringify(initialized)}`);
    const listed = parseEnvelope(await client.callTool({ name: "capture_list", arguments: { limit: 10 } }));
    if (!listed.ok || !listed.data?.captures?.some((entry) => entry.captureId === captureId && entry.formatStatus === "supported")) {
      throw new Error(`${label} MCP did not list the JCAP v1 release fixture`);
    }
    const summary = parseEnvelope(await client.callTool({ name: "capture_summary", arguments: { captureId } }));
    if (!summary.ok || summary.data?.sampleCount !== 1 || summary.data?.indexStatus !== "ready") {
      throw new Error(`${label} MCP could not query and rebuild the JCAP v1 release fixture: ${JSON.stringify(summary)}`);
    }
  } finally {
    await client.close();
  }
}

function writeReleaseFixture(capturesDir) {
  const captureId = "41000000-0000-4000-8000-000000000099";
  const packageDir = resolve(capturesDir, `${captureId}.jcap`);
  const metadata = fixtureApi.createJcapV1Metadata({
    captureId,
    backend: "fake-jlink-hss",
    requestedRateHz: 1,
    durationSec: 1,
    variables: [{ logicalIdentity: "signal", type: "uint32", address: "0x20000000", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "b".repeat(64) }],
    provenance: {
      captureId,
      backend: "fake-jlink-hss",
      runtime: { helperProtocolVersion: 1 },
      target: { projectRoot: "C:\\release-fixture", generation: "43000000-0000-4000-8000-000000000099", device: "FIXTURE", probeSerial: "123456789", interface: "SWD", speed: 4000 },
      script: { mode: "none" },
      artifact: { path: "C:\\release-fixture\\firmware.elf", generation: "a".repeat(64), sha256: "e".repeat(64) },
    },
  });
  fixtureApi.writeJcapV1Raw({
    packageDir,
    metadata,
    samples: [{ sampleIndex: 0, tick: "1", statusFlags: 1, values: { signal: 1 } }],
    events: [
      { eventId: "42000000-0000-4000-8000-000000000091", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
      { eventId: "42000000-0000-4000-8000-000000000092", eventSequence: 1, type: "lifecycle", tick: "1", state: "finalizing" },
      { eventId: "42000000-0000-4000-8000-000000000093", eventSequence: 2, type: "lifecycle", tick: "2", state: "stopped" },
    ],
  });
  fixtureApi.finalizeJcapV1Metadata(packageDir, "stopped");
  return captureId;
}

function parseEnvelope(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP tool result did not include a text envelope");
  return JSON.parse(text);
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
