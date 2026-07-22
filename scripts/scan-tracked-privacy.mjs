import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const workspace = resolve(process.cwd());
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: workspace }).toString("utf8").split("\0").filter(Boolean);
const textExtensions = new Set([".c", ".cc", ".cpp", ".h", ".json", ".md", ".mjs", ".js", ".ts", ".txt", ".xml", ".yaml", ".yml"]);
const sensitivePatterns = [
  ["machine_path", /(?:[A-Za-z]:[\\/]+(?:Users|Documents and Settings|FOC_Project|AI_Project)[\\/]+|\/(?:Users|home)\/[A-Za-z0-9_.-]+)/i],
  ["credential", /(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"']{8,}/i],
  ["private_artifact_hash", /(?:artifact(?:sha(?:256)?|hash)?|runtimeIdentitySha256|flash image|map)\b[^\r\n]{0,160}\b[0-9a-f]{64}\b/i],
  ["probe_identifier", /(?:probe(?:Serial|_serial)|serial(?:Number)?)[\s`"':=]*\d{7,}/i],
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
    if (
      (category === "private_artifact_hash" || category === "probe_identifier")
      && /\.(?:c|cc|cpp|h|mjs|js|ts)$/i.test(normalized)
    ) continue;
    const line = lines.findIndex((value) => pattern.test(value));
    if (line >= 0) findings.push(`${category} ${normalized}:${line + 1}`);
  }
}

if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("tracked-content privacy scan passed\n");
