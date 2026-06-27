import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const tests = [
  "out/mcp/capture.test.js",
  "out/mcp/experiment-contract.test.js",
  "out/mcp/analysis/profiles.test.js",
  "out/mcp/analysis/tools.test.js",
  "out/mcp/bridge/tools.test.js",
  "out/mcp/experiment-store.test.js",
  "out/mcp/capture-backends/capture-backends.test.js",
  "out/mcp/rtt-channel/rtt-channel.test.js",
  "out/mcp/rtt-protocols/traceagent.test.js",
  "out/mcp/preflight/temp-preflight.test.js",
  "out/mcp/hm-c095/hm-c095-runtime-analysis.test.js",
  "out/mcp/hm-c095/hm-c095-capture-artifact.test.js",
  "out/mcp/hm-c095/hm-c095-mcp-tools.test.js",
];

const reportsDir = join(process.cwd(), "reports");
const tempDir = join(process.cwd(), ".tmp", "jlink-mcp", "node-coverage-temp");
await mkdir(reportsDir, { recursive: true });
await mkdir(tempDir, { recursive: true });
const env = { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir };

const runtime = runCoverage("runtime analysis", [
  "--test-coverage-include=out/mcp/analysis/*.js",
  "--test-coverage-include=out/mcp/bridge/*.js",
  "--test-coverage-include=out/mcp/evidence/*.js",
  "--test-coverage-include=out/mcp/experiment-store.js",
  "--test-coverage-lines=95",
  ...tests,
]);

const write = runCoverage("write validation", [
  "--test-coverage-include=out/mcp/write/*.js",
  "--test-coverage-lines=95",
  "out/mcp/write/write-validation.test.js",
]);

const backends = runCoverage("backend/router/rtt/traceagent/preflight", [
  "--test-coverage-include=out/mcp/capture-backends/*.js",
  "--test-coverage-include=out/mcp/rtt-channel/*.js",
  "--test-coverage-include=out/mcp/rtt-protocols/*.js",
  "--test-coverage-include=out/mcp/preflight/*.js",
  "--test-coverage-lines=95",
  "out/mcp/capture-backends/capture-backends.test.js",
  "out/mcp/rtt-channel/rtt-channel.test.js",
  "out/mcp/rtt-protocols/traceagent.test.js",
  "out/mcp/preflight/temp-preflight.test.js",
]);

const full = runCoverage("full repo", [
  "--test-coverage-include=out/**/*.js",
  ...tests,
  "out/mcp/write/write-validation.test.js",
], false);

const runtimeLines = parseAllFilesLineCoverage(runtime.output);
const writeLines = parseAllFilesLineCoverage(write.output);
const backendLines = parseAllFilesLineCoverage(backends.output);
const fullLines = parseAllFilesLineCoverage(full.output);
const fullPass = fullLines >= 95;
await writeFile(join(reportsDir, "coverage-summary.md"), [
  "# Coverage Summary",
  "",
  "| Scope | Result | Evidence |",
  "| --- | --- | --- |",
  `| Runtime analysis modules | ${runtime.status === 0 ? "PASS" : "FAIL"} | ${coverageEvidence(runtimeLines)} |`,
  `| Write validation modules | ${write.status === 0 ? "PASS" : "FAIL"} | ${coverageEvidence(writeLines)} |`,
  `| Backend/router/RTT/TraceAgent/preflight modules | ${backends.status === 0 ? "PASS" : "FAIL"} | ${coverageEvidence(backendLines)} |`,
  `| Full repo | ${fullPass ? "PASS" : "GAP"} | line coverage ${Number.isFinite(fullLines) ? `${fullLines.toFixed(2)}%` : "not parsed"} |`,
  "",
  "No c8 dependency was added; Node 24 built-in coverage supplied the scoped gates.",
  "",
].join("\n"));

if (!fullPass) {
  await writeFile(join(reportsDir, "coverage-gap-report.md"), [
    "# Coverage Gap Report",
    "",
    `Full repo line coverage is ${Number.isFinite(fullLines) ? `${fullLines.toFixed(2)}%` : "not parsed"} after focused HM_C095/write validation tests.`,
    "",
    "The gap is expected because broad VS Code extension, probe, GDB, RTT, telnet, and hardware-facing modules are outside this offline HM_C095 validation scope.",
    "",
    "Scoped gates enforced in this run:",
    "",
    "- Runtime analysis modules >=95%",
    "- Write validation modules >=95%",
    "- Backend/router/RTT/TraceAgent/preflight modules >=95%",
    "",
    "No files were excluded to fake whole-repo coverage.",
    "",
  ].join("\n"));
}

if (runtime.status !== 0 || write.status !== 0 || backends.status !== 0 || full.status !== 0) {
  process.exit(1);
}

function runCoverage(label, args, requirePass = true) {
  const result = spawnSync(process.execPath, ["--test", "--experimental-test-coverage", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const output = `${result.stdout}${result.stderr}`;
  process.stdout.write(`\n=== coverage: ${label} ===\n${output}`);
  if (requirePass && result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
  return { status: result.status ?? 1, output };
}

function parseAllFilesLineCoverage(output) {
  const match = output.match(/all files\s+\|\s+([0-9.]+)/);
  return match ? Number(match[1]) : Number.NaN;
}

function coverageEvidence(lines) {
  return Number.isFinite(lines)
    ? `Node built-in line coverage ${lines.toFixed(2)}%, threshold >=95%`
    : "Node built-in line coverage threshold >=95%";
}
