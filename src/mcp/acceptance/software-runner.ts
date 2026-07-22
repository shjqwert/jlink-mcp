import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  ACCEPTANCE_TEST_IDS,
  AcceptanceEvidenceStore,
  acceptanceIndexSchema,
  captureFileHash,
  captureManifest,
  preconditionsRecordSchema,
  readRepositoryIdentity,
  summarizeAcceptance,
  type AcceptanceCase,
  type AcceptanceIndex,
  type AcceptanceStatus,
  type IssueRecord,
  type TestResult,
} from "./evidence";
import { publishAcceptanceSummary } from "./published-summary";
import { isValidAcceptanceRunId } from "./run-id";

interface CheckDefinition {
  id: string;
  command: string;
  args: string[];
}

export interface CommandExecution {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
}

export type CommandExecutor = (check: CheckDefinition, cwd: string) => CommandExecution;

export interface SoftwareAcceptanceOptions {
  runId: string;
  repositoryRoot: string;
  evidenceRoot?: string;
  projectRoot?: string;
  artifactPath?: string;
  allowErase?: boolean;
  svdAvailable?: boolean;
  issues?: IssueRecord[];
  execute?: CommandExecutor;
}

export interface SoftwareAcceptanceResult {
  runDirectory: string;
  index: AcceptanceIndex;
  checks: Record<string, AcceptanceStatus>;
  issues: IssueRecord[];
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeTests = (id: string, files: string[]): CheckDefinition => ({ id, command: process.execPath, args: ["scripts/run-tests.mjs", ...files] });
const UNIT_CHECKS = ["unit-foundation", "unit-acceptance", "unit-artifact", "unit-direct", "unit-svd", "unit-hss-jcap"];
const CHECKS: CheckDefinition[] = [
  { id: "install", command: npm, args: ["install"] },
  { id: "build", command: npm, args: ["run", "build"] },
  { id: "lint", command: npm, args: ["run", "lint"] },
  nodeTests("unit-foundation", [
    "out/probe/backend.test.js", "out/probe/jlink.test.js", "out/gdb/gdb-client.test.js", "out/gdb/elf-resolver.test.js",
    "out/mcp/jcap/analysis-v0.test.js", "out/mcp/jcap/jcap-v0.test.js", "out/mcp/preflight/temp-preflight.test.js", "out/mcp/rtt-channel/rtt-channel.test.js",
  ]),
  nodeTests("unit-acceptance", ["out/mcp/acceptance/evidence.test.js", "out/mcp/acceptance/software-runner.test.js"]),
  nodeTests("unit-artifact", [
    "out/mcp/artifact/artifact-catalog.test.js", "out/mcp/artifact/hot-variables.test.js", "out/mcp/artifact/symbol-catalog.test.js",
    "out/mcp/runtime/target-store.test.js", "out/mcp/runtime/artifact-operations.test.js",
  ]),
  nodeTests("unit-direct", [
    "out/mcp/runtime/probe-queue.test.js", "out/mcp/runtime/memory-session.test.js", "out/mcp/runtime/direct-operations.test.js", "out/mcp/runtime/file-lease.test.js", "out/mcp/runtime/session-operations.test.js",
  ]),
  nodeTests("unit-svd", ["out/mcp/runtime/svd-operations.test.js", "out/mcp/svd/svd-catalog.test.js"]),
  nodeTests("unit-hss-jcap", [
    "out/mcp/hss/hss-typed-value.test.js", "out/mcp/hss-dll/hss-api-candidate.test.js", "out/mcp/jcap/jcap-v1.test.js",
    "out/mcp/runtime/hss-helper-adapter.test.js", "out/mcp/runtime/hss-operations.test.js", "out/mcp/sqlite-runtime.test.js", "out/utils/atomic-file.test.js",
  ]),
  { id: "surface", command: npm, args: ["run", "test:surface"] },
  { id: "guidance", command: npm, args: ["run", "test:guidance"] },
  { id: "legacy-scan", command: npm, args: ["run", "test:legacy-scan"] },
  { id: "hss-helper", command: npm, args: ["run", "test:hss-helper"] },
  { id: "package", command: npm, args: ["run", "test:package"] },
  { id: "privacy", command: npm, args: ["run", "test:privacy"] },
];

const REQUIREMENTS: Record<string, string[]> = {
  T01: ["standalone-agent-mcp / Standalone stdio and exact direct surface"],
  T02: ["standalone-agent-mcp / Legacy control planes do not execute"],
  T03: ["artifact-symbol-variable-access / Content-driven bounded discovery"],
  T04: ["artifact-symbol-variable-access / Supported typed selectors"],
  T05: ["artifact-symbol-variable-access / Artifact generation and Hot Variables"],
  T06: ["artifact-symbol-variable-access / Variable reads preserve target state"],
  T07: ["artifact-symbol-variable-access / Structured writes and comparators"],
  T08: ["artifact-symbol-variable-access / Restore protects the prior value"],
  T09: ["artifact-symbol-variable-access; direct-mcu-operations; svd-register-access / Safe failures"],
  T10: ["target-context-and-serialization / Physical operations serialize by Probe"],
  T11: ["direct-mcu-operations / CPU controls have explicit final states"],
  T12: ["direct-mcu-operations / Strict flash verification and Artifact match"],
  T13: ["direct-mcu-operations / Explicit erase and immediate recovery"],
  T14: ["hss-backend; acceptance-evidence / Direct lifecycle and declared ceiling"],
  T15: ["hss-backend; acceptance-evidence / Capture-time verified write and restore"],
  T16: ["jcap-v1-store / Interrupted valid-prefix recovery"],
  T17: ["jcap-v1-store / Four files and authoritative Raw integrity"],
  T18: ["jcap-v1-store; capture-query-index / Atomic equivalent DB rebuild"],
  T19: ["capture-query-index / Bounded AI and UI queries"],
  T20: ["ai-debug-workflow / Evidence-backed Agent debugging loop"],
};

const CHECKS_BY_TEST: Record<string, string[]> = Object.fromEntries(ACCEPTANCE_TEST_IDS.map((id) => [id, []]));
CHECKS_BY_TEST.T01 = ["ignored-output", "install", "build", "lint", ...UNIT_CHECKS, "surface", "guidance", "package", "privacy"];
CHECKS_BY_TEST.T02 = ["legacy-scan", "surface"];
for (const id of ["T03", "T04", "T05"]) CHECKS_BY_TEST[id] = ["unit-artifact"];
for (const id of ["T06", "T07", "T08"]) CHECKS_BY_TEST[id] = ["unit-artifact", "unit-direct"];
CHECKS_BY_TEST.T09 = ["unit-artifact", "unit-direct", "unit-svd"];
CHECKS_BY_TEST.T10 = ["unit-direct", "unit-hss-jcap"];
for (const id of ["T11", "T12", "T13"]) CHECKS_BY_TEST[id] = ["unit-direct"];
for (const id of ["T14", "T15"]) CHECKS_BY_TEST[id] = ["unit-hss-jcap", "hss-helper"];
for (const id of ["T16", "T17", "T18", "T19"]) CHECKS_BY_TEST[id] = ["unit-hss-jcap"];
CHECKS_BY_TEST.T20 = [];

const HARDWARE_PREREQUISITES: Record<string, string[]> = Object.fromEntries(ACCEPTANCE_TEST_IDS.map((id) => [id, []]));
for (const id of ["T04", "T06", "T07", "T08", "T09", "T10", "T11"]) HARDWARE_PREREQUISITES[id] = ["configured board and Probe", "frozen matching Artifact"];
HARDWARE_PREREQUISITES.T12 = ["associated flash image", "stable Probe connection", "recovery method"];
HARDWARE_PREREQUISITES.T13 = ["allowErase=true", "associated recovery image"];
for (const id of ["T14", "T15", "T16", "T17", "T18", "T19"]) HARDWARE_PREREQUISITES[id] = ["verified live Artifact generation", "confirmed HSS variables"];
HARDWARE_PREREQUISITES.T20 = ["all applicable T03-T19 dependencies completed"];

const SOFTWARE_COMPLETE = new Set(["T01", "T02", "T03", "T05"]);

export async function runSoftwareAcceptance(options: SoftwareAcceptanceOptions): Promise<SoftwareAcceptanceResult> {
  if (!isValidAcceptanceRunId(options.runId)) throw new Error("invalid acceptance runId");
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const evidenceRoot = path.resolve(options.evidenceRoot ?? path.join(repositoryRoot, "test-output"));
  const identity = readRepositoryIdentity(repositoryRoot);
  if (!identity.commit || identity.dirty) throw new Error("software acceptance requires a clean repository at HEAD");
  const store = new AcceptanceEvidenceStore(evidenceRoot, identity.commit);
  const runDirectory = store.createRun(options.runId);
  const createdAt = new Date().toISOString();
  const projectBefore = options.projectRoot ? captureManifest(options.projectRoot) : undefined;
  const artifact = options.artifactPath && existsSync(options.artifactPath) ? captureFileHash(options.artifactPath) : undefined;
  const execute = options.execute ?? executeCommand;
  const checkResults = new Map<string, { status: AcceptanceStatus; execution: CommandExecution; evidence: string[] }>();
  const hashRecords = artifact ? [artifact] : [];

  await store.writeEnvironment({
    schemaVersion: 1,
    runId: options.runId,
    recordedAt: new Date().toISOString(),
    repository: identity,
    runtime: { platform: process.platform, architecture: process.arch, node: process.version },
    ...(options.projectRoot ? { target: { projectRoot: path.resolve(options.projectRoot) } } : {}),
    ...(artifact ? { artifact } : {}),
  });

  const ignoredDefinition = { id: "ignored-output", command: "git", args: ["check-ignore", "--quiet", path.join("test-output", options.runId, "acceptance-index.json")] };
  const ignored = execute(ignoredDefinition, repositoryRoot);
  await store.writePreconditions(preconditionsRecordSchema.parse({
    schemaVersion: 1,
    runId: options.runId,
    recordedAt: new Date().toISOString(),
    allowErase: options.allowErase ?? false,
    items: [
      { id: "repository", status: identity.commit ? "PASS" : "BLOCKED", summary: identity.commit ? `repository commit ${identity.commit}` : "repository commit unavailable", evidence: [] },
      { id: "ignored-output", status: ignored.exitCode === 0 ? "PASS" : "FAIL", summary: ignored.exitCode === 0 ? "test-output is Git-ignored" : "test-output ignore check failed", evidence: [] },
      { id: "target-project", status: options.projectRoot ? "PASS" : "NOT_TESTED", summary: options.projectRoot ? "explicit projectRoot supplied" : "no hardware project supplied to software run", evidence: [] },
      { id: "artifact", status: artifact ? "PASS" : "NOT_TESTED", summary: artifact ? "explicit Artifact hashed locally" : "no hardware Artifact supplied to software run", evidence: [] },
      { id: "svd", status: options.svdAvailable ? "PASS" : "BLOCKED", summary: options.svdAvailable ? "validated exact SVD declared available" : "validated exact SVD unavailable", evidence: [] },
      { id: "hardware", status: "NOT_TESTED", summary: "software runner performs no real target operation", evidence: [] },
      { id: "erase", status: options.allowErase ? "PASS" : "SKIPPED_WITH_REASON", summary: options.allowErase ? "run explicitly permits erase" : "allowErase was not enabled", evidence: [] },
    ],
  }));

  const ignoredLog = await store.writeLog(options.runId, ignoredDefinition.id, ignored.stdout, ignored.stderr);
  hashRecords.push(ignoredLog.stdout, ignoredLog.stderr);
  checkResults.set(ignoredDefinition.id, { status: ignored.exitCode === 0 ? "PASS" : "FAIL", execution: ignored, evidence: ["logs/ignored-output.json", "logs/ignored-output.stdout.log", "logs/ignored-output.stderr.log"] });
  await store.appendCommand({
    schemaVersion: 1,
    runId: options.runId,
    kind: "shell",
    recordedAt: new Date().toISOString(),
    operationId: randomUUID(),
    tool: ignoredDefinition.id,
    request: { cwd: repositoryRoot, command: ignoredDefinition.command, args: ignoredDefinition.args },
    result: { exitCode: ignored.exitCode, signal: ignored.signal },
    timestamps: { startedAt: ignored.startedAt, endedAt: ignored.endedAt },
    codeCommit: identity.commit,
    target: options.projectRoot ? { projectRoot: path.resolve(options.projectRoot) } : null,
    artifact: artifact ?? null,
    outputHashes: [ignoredLog.stdout, ignoredLog.stderr],
  });

  for (const check of CHECKS) {
    const execution = execute(check, repositoryRoot);
    const log = await store.writeLog(options.runId, check.id, execution.stdout, execution.stderr);
    hashRecords.push(log.stdout, log.stderr);
    const checkStatus: AcceptanceStatus = execution.exitCode === 0 ? "PASS" : "FAIL";
    const evidence = [`logs/${check.id}.json`, `logs/${check.id}.stdout.log`, `logs/${check.id}.stderr.log`];
    checkResults.set(check.id, { status: checkStatus, execution, evidence });
    await store.appendCommand({
      schemaVersion: 1,
      runId: options.runId,
      kind: "shell",
      recordedAt: new Date().toISOString(),
      operationId: randomUUID(),
      tool: check.id,
      request: { cwd: repositoryRoot, command: check.command, args: check.args },
      result: { exitCode: execution.exitCode, signal: execution.signal },
      timestamps: { startedAt: execution.startedAt, endedAt: execution.endedAt },
      codeCommit: identity.commit,
      target: options.projectRoot ? { projectRoot: path.resolve(options.projectRoot) } : null,
      artifact: artifact ?? null,
      outputHashes: [log.stdout, log.stderr],
    });
  }

  const completedIdentity = readRepositoryIdentity(repositoryRoot);
  if (!completedIdentity.commit || completedIdentity.commit !== identity.commit || completedIdentity.dirty) {
    throw new Error("software acceptance repository changed during the run");
  }

  let projectAfter: ReturnType<typeof captureManifest> | undefined;
  if (options.projectRoot) {
    projectAfter = captureManifest(options.projectRoot);
    const beforeFile = await store.writeManifest(options.runId, "project-before", projectBefore!);
    const afterFile = await store.writeManifest(options.runId, "project-after", projectAfter);
    hashRecords.push(captureFileHash(beforeFile, "manifests/project-before.json"), captureFileHash(afterFile, "manifests/project-after.json"));
  }

  const tests = ACCEPTANCE_TEST_IDS.filter((id) => id !== "T20").map((id) => createCase(id, checkResults, options));
  tests.push(createT20Case(tests, projectBefore, projectAfter));
  const completedAt = new Date().toISOString();
  for (const entry of tests) {
    const checks = CHECKS_BY_TEST[entry.testId].map((id) => {
      const result = checkResults.get(id)!;
      return { id, status: result.status, exitCode: result.execution.exitCode, evidence: result.evidence };
    });
    const result: TestResult = {
      schemaVersion: 1,
      runId: options.runId,
      testId: entry.testId,
      status: entry.status,
      startedAt: createdAt,
      endedAt: completedAt,
      summary: entry.subcases.map((subcase) => `${subcase.id}: ${subcase.status} — ${subcase.summary}`).join("; ") || entry.blockers.join("; ") || entry.status,
      checks,
      blockers: entry.blockers,
    };
    await store.writeTestResult(result);
  }
  await store.writeHashes(options.runId, hashRecords);
  const generatedIssues = [...checkResults.entries()].flatMap<IssueRecord>(([checkId, result]) => result.status === "FAIL" ? [{
    issueId: `AUTO-${options.runId}-${checkId}`,
    discoveredAt: result.execution.endedAt,
    testId: primaryTestForCheck(checkId),
    severity: ["install", "build"].includes(checkId) || checkId.startsWith("unit-") ? "P1" : "P2",
    codeCommit: identity.commit,
    environment: { platform: process.platform, architecture: process.arch, node: process.version, repositoryDirty: identity.dirty },
    preconditions: ["software acceptance run created", "no real hardware operation issued"],
    reproduction: [
      `from the recorded repository root, rerun the ${checkId} command exactly as stored in commands.ndjson`,
      `observe exitCode=${String(result.execution.exitCode)} signal=${String(result.execution.signal)}`,
    ],
    expected: `${checkId} exits with code 0`,
    actual: boundedIssueText(result.execution.stderr || result.execution.stdout || `exitCode=${String(result.execution.exitCode)} signal=${String(result.execution.signal)}`),
    evidence: result.evidence,
    workaround: null,
    initialCause: null,
    blockingScope: `software acceptance check ${checkId} and every mapped test`,
    fixCommit: null,
    regressionResult: null,
  }] : []);
  const t20 = tests.find((entry) => entry.testId === "T20")!;
  if (t20.status === "FAIL") generatedIssues.push({
    issueId: `AUTO-${options.runId}-project-manifest`,
    discoveredAt: completedAt,
    testId: "T20",
    severity: "P1",
    codeCommit: identity.commit,
    environment: { platform: process.platform, architecture: process.arch, node: process.version, repositoryDirty: identity.dirty },
    preconditions: ["projectRoot supplied", "before and after manifests captured"],
    reproduction: ["run the acceptance command with the recorded projectRoot"],
    expected: "project manifest remains byte-identical",
    actual: `manifest changed from ${projectBefore?.manifestSha256 ?? "missing"} to ${projectAfter?.manifestSha256 ?? "missing"}`,
    evidence: t20.evidence,
    workaround: null,
    initialCause: null,
    blockingScope: "T20 and merge recommendation",
    fixCommit: null,
    regressionResult: null,
  });
  const issues = [...(options.issues ?? []), ...generatedIssues];
  await store.writeIssueLedger(options.runId, issues);
  const index = acceptanceIndexSchema.parse({
    schemaVersion: 1,
    runId: options.runId,
    createdAt,
    completedAt,
    codeCommit: identity.commit,
    tests,
    mergeRecommendation: "DO_NOT_RECOMMEND",
    summary: summarizeAcceptance(tests, issues.filter((issue) => issue.severity === "P0" && issue.fixCommit === null).length),
  });
  await store.writeAcceptanceIndex(index);
  return { runDirectory, index, checks: Object.fromEntries([...checkResults.entries()].map(([id, result]) => [id, result.status])), issues };
}

function primaryTestForCheck(checkId: string): string {
  if (checkId === "legacy-scan") return "T02";
  if (checkId === "hss-helper") return "T14";
  if (checkId === "unit-artifact") return "T03";
  if (checkId === "unit-direct") return "T10";
  if (checkId === "unit-svd") return "T09";
  if (checkId === "unit-hss-jcap") return "T14";
  return "T01";
}

function boundedIssueText(value: string): string {
  const text = value.trim() || "check failed without process output";
  return text.length <= 16_384 ? text : `${text.slice(0, 16_300)}\n...[truncated]`;
}

function createCase(id: string, checks: Map<string, { status: AcceptanceStatus; execution: CommandExecution; evidence: string[] }>, options: SoftwareAcceptanceOptions): AcceptanceCase {
  const checkIds = CHECKS_BY_TEST[id];
  const failed = checkIds.filter((checkId) => checks.get(checkId)?.status !== "PASS");
  const evidence = checkIds.flatMap((checkId) => checks.get(checkId)?.evidence ?? []);
  const softwareStatus: AcceptanceStatus = failed.length ? "FAIL" : "PASS";
  let resultStatus: AcceptanceStatus;
  const blockers: string[] = [];
  if (id === "T13" && !options.allowErase) {
    resultStatus = "SKIPPED_WITH_REASON";
    blockers.push("allowErase was not enabled; no erase command was issued");
  } else if (softwareStatus === "FAIL") resultStatus = "FAIL";
  else if (id === "T09" && !options.svdAvailable) {
    resultStatus = "BLOCKED";
    blockers.push("validated exact SVD is unavailable; raw memory does not count as SVD coverage");
  } else if (SOFTWARE_COMPLETE.has(id)) resultStatus = "PASS";
  else {
    resultStatus = "NOT_TESTED";
    blockers.push("real hardware acceptance has not been executed");
  }
  return {
    testId: id,
    status: resultStatus,
    requirements: REQUIREMENTS[id],
    automatedChecks: checkIds,
    hardwarePrerequisites: HARDWARE_PREREQUISITES[id],
    evidence,
    blockers,
    subcases: [{
      id: "software-simulated",
      status: softwareStatus,
      summary: failed.length ? `failed checks: ${failed.join(", ")}` : "all mapped software and simulated checks passed",
      evidence,
      blockers: failed,
    }],
  };
}

export function createT20Case(dependencies: AcceptanceCase[], before?: ReturnType<typeof captureManifest>, after?: ReturnType<typeof captureManifest>): AcceptanceCase {
  const failed = dependencies.filter((entry) => entry.status === "FAIL").map((entry) => entry.testId);
  const incomplete = dependencies.filter((entry) => !["PASS", "SKIPPED_WITH_REASON"].includes(entry.status)).map((entry) => entry.testId);
  const manifestChanged = Boolean(before && after && before.manifestSha256 !== after.manifestSha256);
  const blockers = [
    ...(failed.length ? [`failed dependencies: ${failed.join(", ")}`] : []),
    ...(incomplete.length ? [`incomplete dependencies: ${incomplete.join(", ")}`] : []),
    ...(!before || !after ? ["project before/after manifests were not supplied"] : []),
    ...(manifestChanged ? ["project manifest changed during the run"] : []),
    "the real Agent debugging loop has not been executed",
  ];
  return {
    testId: "T20",
    status: manifestChanged ? "FAIL" : "BLOCKED",
    requirements: REQUIREMENTS.T20,
    automatedChecks: [],
    hardwarePrerequisites: HARDWARE_PREREQUISITES.T20,
    evidence: before && after ? ["manifests/project-before.json", "manifests/project-after.json"] : [],
    blockers,
    subcases: [{
      id: "dependency-and-manifest-gate",
      status: manifestChanged || failed.length ? "FAIL" : "BLOCKED",
      summary: manifestChanged ? "project manifest changed" : "dependency gate retained without executing hardware operations",
      evidence: before && after ? ["manifests/project-before.json", "manifests/project-after.json"] : [],
      blockers,
    }],
  };
}

function executeCommand(check: CheckDefinition, cwd: string): CommandExecution {
  const startedAt = new Date().toISOString();
  const isWindowsWrapper = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(check.command);
  const command = isWindowsWrapper ? process.env.ComSpec ?? "cmd.exe" : check.command;
  const args = isWindowsWrapper
    ? ["/d", "/s", "/c", check.command, ...check.args]
    : check.args;
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${result.error ? `${result.error.message}\n` : ""}`,
    startedAt,
    endedAt: new Date().toISOString(),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  const runId = argument("--run-id");
  if (!runId) {
    process.stderr.write("Usage: software-runner --run-id <id> [--project-root <path>] [--artifact <path>] [--allow-erase] [--svd-available] [--publish-summary] [--publish-directory <path>]\n");
    process.exitCode = 2;
  } else {
    void runSoftwareAcceptance({
      runId,
      repositoryRoot: process.cwd(),
      projectRoot: argument("--project-root"),
      artifactPath: argument("--artifact"),
      allowErase: process.argv.includes("--allow-erase"),
      svdAvailable: process.argv.includes("--svd-available"),
    }).then((result) => {
      const published = process.argv.includes("--publish-summary")
        ? publishAcceptanceSummary({ repositoryRoot: process.cwd(), outputDirectory: argument("--publish-directory") ?? "test-output/published", index: result.index, checks: result.checks, issues: result.issues })
        : undefined;
      process.stdout.write(`${JSON.stringify({ runDirectory: result.runDirectory, summary: result.index.summary, mergeRecommendation: result.index.mergeRecommendation, ...(published ? { published: { indexPath: published.indexPath, summaryPath: published.summaryPath } } : {}) }, null, 2)}\n`);
      if (result.index.summary.FAIL > 0) process.exitCode = 1;
    }).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
