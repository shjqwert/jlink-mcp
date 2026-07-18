import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const workspace = resolve(process.cwd());
const sourceRoots = ["src", "scripts", "native"].map((path) => resolve(workspace, path));
const extensions = new Set([".ts", ".mjs", ".js", ".cpp", ".h", ".json"]);
const excluded = new Set(["src/mcp/ui.test.ts", "scripts/scan-legacy-control-plane.mjs"]);
const forbidden = [
  /approval-broker/i,
  /approvalBroker/,
  /requiresUserApproval/,
  /approvalToken/,
  /challengeId/,
  /nonceSha256/,
  /risk-operations/i,
  /trust-profile/i,
  /trustProfile/,
  /variable_write_(?:plan|execute)/,
  /variable-write-r4/,
  /(?:flash|erase|gdb_command|probe_command)_plan/,
  /\bgdb_load\b/,
  /registerPrompt|\.prompt\s*\(/,
  /jlink:\/\/discovery\/catalog/,
  /from\s+["']vscode["']|require\s*\(\s*["']vscode["']\s*\)/,
];

const findings = [];
for (const file of sourceRoots.flatMap(walk)) {
  const name = relative(workspace, file).replaceAll("\\", "/");
  if (excluded.has(name) || !extensions.has(extname(file))) continue;
  const content = readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) findings.push(`${name}: ${pattern}`);
  }
  if (/\bR[0-5]\b/.test(content) && !["src/jlink/commander.ts", "src/probe/backend.ts"].includes(name)) {
    findings.push(`${name}: legacy R0-R5 identifier`);
  }
}

const packageText = readFileSync(resolve(workspace, "package.json"), "utf8");
for (const token of ["activationEvents", '"contributes"', "@types/vscode", "@vscode/vsce", "vscode:prepublish", "vsix"]) {
  if (packageText.includes(token)) findings.push(`package.json: ${token}`);
}
for (const file of ["src/extension.ts", ".vscodeignore", "out/extension.js"]) {
  if (existsSync(resolve(workspace, file))) findings.push(`${file}: must not exist`);
}

if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("legacy control-plane scan passed\n");

function walk(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) result.push(...walk(path));
    else result.push(path);
  }
  return result;
}
