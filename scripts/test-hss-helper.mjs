import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const executable = resolve("native", "hss-helper", "bin", "hss_helper.exe");
const result = spawnSync(executable, ["self-test"], { encoding: "utf8", windowsHide: true });

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
let response;
try {
  response = JSON.parse(lines.at(-1) ?? "");
} catch (error) {
  throw new Error(`HSS Helper self-test returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}
if (response.status !== "ok" || response.command !== "self-test") {
  throw new Error(`HSS Helper self-test failed: ${String(response.errorCode ?? response.reason ?? response.status)}`);
}
