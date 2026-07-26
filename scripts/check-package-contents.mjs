import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const allowed = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "out/mcp/doctor.js",
  "out/mcp/doctor.js.map",
  "out/mcp/standalone.js",
  "out/mcp/standalone.js.map",
  "native/hss-helper/bin/hss_helper.exe",
  "native/hss-helper/bin/hss_helper.exe.sha256",
]);
const required = [...allowed];
const findings = [];

if (packageJson.version !== "1.1.3") findings.push(`release version must be 1.1.3, found ${String(packageJson.version)}`);
if (packageJson.private !== true) findings.push("package must remain private to prevent npm Registry publication");
if (JSON.stringify(packageJson.os) !== JSON.stringify(["win32"])) findings.push("package os must be [\"win32\"]");
if (JSON.stringify(packageJson.cpu) !== JSON.stringify(["x64"])) findings.push("package cpu must be [\"x64\"]");
if (packageJson.engines?.node !== ">=22 <25") findings.push("package Node.js range must be >=22 <25");
for (const dependency of ["sqlite3"]) {
  if (!packageJson.dependencies?.[dependency]) findings.push(`missing runtime dependency: ${dependency}`);
}
for (const dependency of ["@modelcontextprotocol/sdk", "zod"]) {
  if (!packageJson.devDependencies?.[dependency]) findings.push(`missing bundled build dependency: ${dependency}`);
  if (packageJson.dependencies?.[dependency]) findings.push(`bundled dependency must not remain a runtime dependency: ${dependency}`);
}

const npm = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
const npmArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json --ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const packed = spawnSync(npm, npmArgs, { encoding: "utf8", windowsHide: true });
if (packed.error) throw packed.error;
if (packed.status !== 0) throw new Error(`npm pack --dry-run failed: ${packed.stderr || packed.stdout}`);

let entries;
try {
  entries = JSON.parse(packed.stdout);
} catch (error) {
  throw new Error(`npm pack --dry-run returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const files = new Set((entries?.[0]?.files ?? []).map((entry) => entry.path));
for (const path of required) if (!files.has(path)) findings.push(`missing required package file: ${path}`);
for (const path of files) if (!allowed.has(path)) findings.push(`unexpected package file: ${path}`);

const executable = resolve("native", "hss-helper", "bin", "hss_helper.exe");
const hashFile = `${executable}.sha256`;
try {
  const actual = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const declared = readFileSync(hashFile, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
  if (declared !== actual) findings.push("HSS Helper SHA-256 file does not match the executable");
} catch (error) {
  findings.push(`HSS Helper hash verification failed: ${error instanceof Error ? error.message : String(error)}`);
}

if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`package file gate passed (${files.size} files, exact whitelist)\n`);
