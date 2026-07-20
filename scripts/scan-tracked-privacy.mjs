import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const workspace = resolve(process.cwd());
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: workspace }).toString("utf8").split("\0").filter(Boolean);
const textExtensions = new Set([".c", ".cc", ".cpp", ".h", ".json", ".md", ".mjs", ".js", ".ts", ".txt", ".xml", ".yaml", ".yml"]);
const sensitivePatterns = [
  ["machine_path", /(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:Users|home)\/)/i],
  ["credential", /(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"']{8,}/i],
  ["private_artifact_hash", /(?:artifact(?:sha256|hash)|runtimeIdentitySha256)\s*["':=]+[0-9a-f]{64}/i],
  ["probe_identifier", /(?:probe(?:Serial|_serial)|serial(?:Number)?)\s*["':=]+\d{7,}/i],
];
const findings = [];

for (const relativePath of tracked) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (/^reports\/p5\/hardware\//i.test(normalized)) {
    findings.push(`hardware_evidence ${normalized}:1`);
    continue;
  }
  if (!textExtensions.has(extname(normalized).toLowerCase())) continue;
  let text;
  try { text = readFileSync(resolve(workspace, relativePath), "utf8"); }
  catch { continue; }
  if (text.includes("\0")) continue;
  const lines = text.split(/\r?\n/);
  for (const [category, pattern] of sensitivePatterns) {
    const line = lines.findIndex((value) => pattern.test(value));
    if (line >= 0) findings.push(`${category} ${normalized}:${line + 1}`);
  }
}

if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("tracked-content privacy scan passed\n");
