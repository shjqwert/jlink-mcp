import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const result = spawnSync(process.execPath, [resolve("out", "mcp", "doctor.js")], {
  encoding: "utf8",
  windowsHide: true,
});
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`doctor exited ${String(result.status)}: ${result.stdout}`);

const report = JSON.parse(result.stdout);
if (report.status !== "ok" || report.version !== "1.1.3") {
  throw new Error(`doctor returned an invalid release report: ${result.stdout}`);
}
for (const id of ["platform", "node", "standalone", "sqlite", "hss-helper"]) {
  const check = report.checks?.find((entry) => entry.id === id);
  if (check?.status !== "pass") throw new Error(`doctor check failed: ${id}`);
}
process.stdout.write("release doctor passed\n");
