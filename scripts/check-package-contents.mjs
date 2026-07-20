import { spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
const npmArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm.cmd pack --dry-run --json --ignore-scripts"]
  : ["pack", "--dry-run", "--json", "--ignore-scripts"];
const packed = spawnSync(npm, npmArgs, { encoding: "utf8" });
if (packed.error) throw packed.error;
if (packed.status !== 0) throw new Error(`npm pack --dry-run failed: ${packed.stderr || packed.stdout}`);
let entries;
try {
  entries = JSON.parse(packed.stdout);
} catch (error) {
  throw new Error(`npm pack --dry-run returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const files = new Set((entries?.[0]?.files ?? []).map((entry) => entry.path));
const required = ["out/mcp/standalone.js", "native/hss-helper/bin/hss_helper.exe"];
const findings = [];
for (const path of required) if (!files.has(path)) findings.push(`missing required package file: ${path}`);
for (const path of files) {
  if (/^(?:test-output|reports\/p5\/hardware|\.jlink-mcp)\//i.test(path)) findings.push(`local evidence/config entered package: ${path}`);
  if (/\.dll$/i.test(path)) findings.push(`J-Link DLL entered package: ${path}`);
  if (/\.(?:elf|hex|srec)$/i.test(path)) findings.push(`target binary entered package: ${path}`);
  if (/\.bin$/i.test(path) && path !== "native/hss-helper/bin/hss_helper.exe") findings.push(`raw target/capture binary entered package: ${path}`);
}
if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`package file gate passed (${files.size} files)\n`);
