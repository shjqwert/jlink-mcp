import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const workspace = resolve(process.cwd());
const packageJson = JSON.parse(readFileSync(resolve(workspace, "package.json"), "utf8"));
const version = String(packageJson.version);
const releaseDir = resolve(workspace, "release", `v${version}`);
const stageRoot = resolve(workspace, ".tmp", "jlink-mcp", `portable-v${version}`);
const portableRoot = resolve(stageRoot, `jlink-mcp-v${version}-windows-x64`);
const portableZip = resolve(releaseDir, `jlink-mcp-v${version}-windows-x64.zip`);
const sumsFile = resolve(releaseDir, "SHA256SUMS.txt");

if (version !== "1.1.2") throw new Error(`release package requires version 1.1.2, found ${version}`);
if (existsSync(releaseDir)) {
  throw new Error(`release output already exists; preserve or move it before rebuilding: ${releaseDir}`);
}

removeControlledStage(stageRoot);
mkdirSync(releaseDir, { recursive: true });
mkdirSync(portableRoot, { recursive: true });

runNpm(["run", "verify:release-files"], workspace);
const pack = runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", releaseDir], workspace, true);
const packResult = JSON.parse(pack.stdout)?.[0];
const tgz = resolve(releaseDir, String(packResult?.filename ?? ""));
if (!regularFile(tgz)) throw new Error(`npm pack did not produce the expected archive: ${tgz}`);

writeFileSync(resolve(portableRoot, "package.json"), JSON.stringify({
  name: "jlink-mcp-portable",
  version,
  private: true,
}, null, 2));
runNpm(["install", "--omit=dev", "--no-audit", "--no-fund", tgz], portableRoot);

const installedRoot = resolve(portableRoot, "node_modules", "jlink-mcp");
for (const required of [
  resolve(installedRoot, "out", "mcp", "standalone.js"),
  resolve(installedRoot, "out", "mcp", "doctor.js"),
  resolve(installedRoot, "native", "hss-helper", "bin", "hss_helper.exe"),
  resolve(portableRoot, "node_modules", "sqlite3", "build", "Release", "node_sqlite3.node"),
]) {
  if (!regularFile(required)) throw new Error(`portable package is missing ${required}`);
}

writeFileSync(resolve(portableRoot, "jlink-mcp.cmd"), [
  "@echo off",
  "node \"%~dp0node_modules\\jlink-mcp\\out\\mcp\\standalone.js\" %*",
  "",
].join("\r\n"), "utf8");
writeFileSync(resolve(portableRoot, "doctor.cmd"), [
  "@echo off",
  "node \"%~dp0node_modules\\jlink-mcp\\out\\mcp\\doctor.js\"",
  "",
].join("\r\n"), "utf8");
writeFileSync(resolve(portableRoot, "INSTALL.txt"), [
  `J-Link MCP v${version} portable package (Windows x64)`,
  "",
  "Requirements:",
  "- Node.js 22 or 24 x64",
  "- SEGGER J-Link Software",
  "",
  "Verify:",
  "  doctor.cmd",
  "",
  "Add to Codex (replace <extract-dir>):",
  "  codex mcp add jlink -- <extract-dir>\\jlink-mcp.cmd",
  "",
].join("\r\n"), "utf8");

const powershell = process.env.SystemRoot
  ? resolve(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : "powershell.exe";
run(powershell, [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "& { param([string]$source, [string]$destination) Compress-Archive -LiteralPath $source -DestinationPath $destination -CompressionLevel Optimal }",
  portableRoot,
  portableZip,
], workspace);
if (!regularFile(portableZip)) throw new Error(`portable ZIP was not created: ${portableZip}`);

const assets = [tgz, portableZip];
const sums = assets.map((asset) => `${sha256(asset)}  ${basename(asset)}`).join("\r\n");
writeFileSync(sumsFile, `${sums}\r\n`, "utf8");

process.stdout.write([
  `Release assets created in ${releaseDir}`,
  ...assets.map((asset) => `- ${basename(asset)} (${statSync(asset).size} bytes)`),
  `- ${basename(sumsFile)}`,
  "",
].join("\n"));

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

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function regularFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function removeControlledStage(target) {
  const expectedParent = resolve(workspace, ".tmp", "jlink-mcp");
  if (dirname(target) !== expectedParent || basename(target) !== `portable-v${version}`) {
    throw new Error(`refusing to remove unexpected portable stage: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}
