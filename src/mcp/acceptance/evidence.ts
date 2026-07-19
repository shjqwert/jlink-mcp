import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z, type ZodType } from "zod";
import type { OperationEnvelope } from "../runtime/operation-envelope";
import { withDirectoryLease } from "../runtime/file-lease";
import { readJcapV1Metadata, readJcapV1Raw, verifyJcapV1Index } from "../jcap/jcap-v1";
import { isValidAcceptanceRunId } from "./run-id";

export const ACCEPTANCE_STATUSES = ["PASS", "FAIL", "BLOCKED", "SKIPPED_WITH_REASON", "NOT_TESTED"] as const;
export const ACCEPTANCE_TEST_IDS = Array.from({ length: 20 }, (_, index) => `T${String(index + 1).padStart(2, "0")}`) as [string, ...string[]];
export type AcceptanceStatus = typeof ACCEPTANCE_STATUSES[number];

const isoTime = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const runId = z.string().refine(isValidAcceptanceRunId, "invalid acceptance runId");
const status = z.enum(ACCEPTANCE_STATUSES);
const testId = z.enum(ACCEPTANCE_TEST_IDS);
const evidenceReferences = z.array(z.string().min(1).max(4096)).max(256);

export const hashRecordSchema = z.object({
  path: z.string().min(1).max(4096),
  bytes: z.number().int().nonnegative(),
  sha256,
}).strict();
export const hashLedgerSchema = z.array(hashRecordSchema).max(100_000);

export const environmentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId,
  recordedAt: isoTime,
  repository: z.object({
    root: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    branch: z.string().min(1).nullable(),
    dirty: z.boolean(),
  }).strict(),
  runtime: z.object({
    platform: z.string().min(1),
    architecture: z.string().min(1),
    node: z.string().min(1),
  }).strict(),
  target: z.record(z.string(), z.unknown()).optional(),
  artifact: hashRecordSchema.optional(),
}).strict();

export const preconditionItemSchema = z.object({
  id: z.string().min(1).max(128),
  status,
  summary: z.string().min(1).max(4096),
  evidence: evidenceReferences.default([]),
}).strict();

export const preconditionsRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId,
  recordedAt: isoTime,
  allowErase: z.boolean(),
  items: z.array(preconditionItemSchema).min(1).max(128),
}).strict();

export const acceptanceSubcaseSchema = z.object({
  id: z.string().min(1).max(128),
  status,
  summary: z.string().min(1).max(4096),
  evidence: evidenceReferences.default([]),
  blockers: z.array(z.string().min(1).max(4096)).max(64).default([]),
}).strict();

export const acceptanceCaseSchema = z.object({
  testId,
  status,
  requirements: z.array(z.string().min(1).max(512)).min(1).max(64),
  automatedChecks: z.array(z.string().min(1).max(128)).max(64),
  hardwarePrerequisites: z.array(z.string().min(1).max(512)).max(64),
  evidence: evidenceReferences,
  blockers: z.array(z.string().min(1).max(4096)).max(64),
  subcases: z.array(acceptanceSubcaseSchema).max(32),
}).strict();

export const acceptanceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  runId,
  createdAt: isoTime,
  completedAt: isoTime,
  codeCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  tests: z.array(acceptanceCaseSchema).length(20),
  mergeRecommendation: z.enum(["RECOMMEND", "DO_NOT_RECOMMEND"]),
  summary: z.object({
    PASS: z.number().int().nonnegative(),
    FAIL: z.number().int().nonnegative(),
    BLOCKED: z.number().int().nonnegative(),
    SKIPPED_WITH_REASON: z.number().int().nonnegative(),
    NOT_TESTED: z.number().int().nonnegative(),
    openP0: z.number().int().nonnegative(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const ids = value.tests.map((entry) => entry.testId);
  if (new Set(ids).size !== 20 || ACCEPTANCE_TEST_IDS.some((id) => !ids.includes(id))) {
    context.addIssue({ code: "custom", message: "acceptance index must contain T01 through T20 exactly once", path: ["tests"] });
  }
  const total = ACCEPTANCE_STATUSES.reduce((sum, key) => sum + value.summary[key], 0);
  if (total !== 20) context.addIssue({ code: "custom", message: "acceptance status summary must total 20", path: ["summary"] });
  for (const key of ACCEPTANCE_STATUSES) {
    const actual = value.tests.filter((entry) => entry.status === key).length;
    if (value.summary[key] !== actual) context.addIssue({ code: "custom", message: `${key} summary does not match test statuses`, path: ["summary", key] });
  }
  const recommendationBlocked = value.summary.FAIL > 0 || value.summary.BLOCKED > 0 || value.summary.NOT_TESTED > 0 || value.summary.openP0 > 0;
  if (value.mergeRecommendation === "RECOMMEND" && recommendationBlocked) {
    context.addIssue({ code: "custom", message: "merge cannot be recommended while tests are failed, blocked, not tested, or an open P0 remains", path: ["mergeRecommendation"] });
  }
});

export const issueRecordSchema = z.object({
  issueId: z.string().min(1).max(128),
  discoveredAt: isoTime,
  testId,
  severity: z.enum(["P0", "P1", "P2"]),
  codeCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  environment: z.record(z.string(), z.unknown()),
  preconditions: z.array(z.string().min(1).max(4096)).max(128),
  reproduction: z.array(z.string().min(1).max(4096)).min(1).max(128),
  expected: z.string().min(1).max(16384),
  actual: z.string().min(1).max(16384),
  evidence: evidenceReferences,
  workaround: z.string().min(1).max(16384).nullable(),
  initialCause: z.string().min(1).max(16384).nullable(),
  blockingScope: z.string().min(1).max(16384),
  fixCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  regressionResult: z.string().min(1).max(16384).nullable(),
}).strict();

export const issueLedgerSchema = z.array(issueRecordSchema).max(10_000).superRefine((value, context) => {
  if (new Set(value.map((issue) => issue.issueId)).size !== value.length) context.addIssue({ code: "custom", message: "issue IDs must be unique" });
});

export const commandRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId,
  sequence: z.number().int().positive(),
  kind: z.enum(["mcp", "shell"]),
  recordedAt: isoTime,
  operationId: z.string().min(1).max(128),
  tool: z.string().min(1).max(256),
  request: z.unknown(),
  result: z.unknown(),
  timestamps: z.record(z.string(), z.unknown()),
  codeCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  target: z.unknown().nullable(),
  artifact: z.unknown().nullable(),
  outputHashes: z.array(hashRecordSchema).max(128),
}).strict();

export const manifestRecordSchema = z.object({
  schemaVersion: z.literal(1),
  root: z.string().min(1),
  recordedAt: isoTime,
  entries: z.array(hashRecordSchema).max(100_000),
  manifestSha256: sha256,
}).strict();

export const logRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId,
  checkId: z.string().min(1).max(128),
  recordedAt: isoTime,
  stdout: hashRecordSchema,
  stderr: hashRecordSchema,
}).strict();

export const testResultSchema = z.object({
  schemaVersion: z.literal(1),
  runId,
  testId,
  status,
  startedAt: isoTime,
  endedAt: isoTime,
  summary: z.string().min(1).max(16384),
  checks: z.array(z.object({
    id: z.string().min(1).max(128),
    status,
    exitCode: z.number().int().nullable(),
    evidence: evidenceReferences,
  }).strict()).max(128),
  blockers: z.array(z.string().min(1).max(4096)).max(64),
}).strict();

export const EVIDENCE_SCHEMAS = Object.freeze({
  environment: environmentRecordSchema,
  preconditions: preconditionsRecordSchema,
  acceptanceIndex: acceptanceIndexSchema,
  issueLedger: issueLedgerSchema,
  command: commandRecordSchema,
  manifest: manifestRecordSchema,
  log: logRecordSchema,
  hash: hashRecordSchema,
  hashLedger: hashLedgerSchema,
  testResult: testResultSchema,
});

export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;
export type PreconditionsRecord = z.infer<typeof preconditionsRecordSchema>;
export type AcceptanceCase = z.infer<typeof acceptanceCaseSchema>;
export type AcceptanceIndex = z.infer<typeof acceptanceIndexSchema>;
export type IssueRecord = z.infer<typeof issueRecordSchema>;
export type ManifestRecord = z.infer<typeof manifestRecordSchema>;
export type TestResult = z.infer<typeof testResultSchema>;
export type CommandRecordInput = Omit<z.infer<typeof commandRecordSchema>, "sequence">;
export interface RepositoryIdentity { root: string; commit: string | null; branch: string | null; dirty: boolean }

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_LOG_BYTES = 128 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_PACKAGES = 10_000;
const TERMINAL_CAPTURE_STATES = new Set(["completed", "stopped", "interrupted", "failed"]);

export class AcceptanceEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AcceptanceEvidenceError";
  }
}

export class AcceptanceEvidenceStore {
  readonly root: string;
  private readonly activeRun = new AsyncLocalStorage<string>();

  constructor(root: string, private readonly codeCommit: string | null = null) {
    this.root = resolve(root);
  }

  createRun(runIdValue: string): string {
    const directory = this.runDirectory(runIdValue);
    mkdirSync(this.root, { recursive: true });
    try { mkdirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AcceptanceEvidenceError("RUN_ID_EXISTS", `runId already exists: ${runIdValue}`);
      throw error;
    }
    this.initializeRun(directory, runIdValue);
    return directory;
  }

  ensureRun(runIdValue: string): string {
    const directory = this.runDirectory(runIdValue);
    mkdirSync(directory, { recursive: true });
    this.initializeRun(directory, runIdValue);
    return directory;
  }

  writeEnvironment(value: EnvironmentRecord): Promise<string> {
    return this.withOpenRun(value.runId, async (directory) => this.writeRunJsonOnce(directory, "environment.json", environmentRecordSchema, value));
  }

  writePreconditions(value: PreconditionsRecord): Promise<string> {
    return this.withOpenRun(value.runId, async (directory) => this.writeRunJsonOnce(directory, "preconditions.json", preconditionsRecordSchema, value));
  }

  writeAcceptanceIndex(value: AcceptanceIndex): Promise<string> {
    return this.withOpenRun(value.runId, async (directory) => {
      await assertRunCapturesTerminal(directory);
      return this.writeRunJsonOnce(directory, "acceptance-index.json", acceptanceIndexSchema, value);
    });
  }

  guardRunMutation<T>(runIdValue: string, operation: () => Promise<T>): Promise<T> {
    const activeRun = this.activeRun.getStore();
    if (activeRun && activeRun !== runIdValue) {
      throw new AcceptanceEvidenceError("RUN_ID_CAPTURE_MISMATCH", `capture belongs to run ${runIdValue}, not active request run ${activeRun}`);
    }
    return this.withOpenRun(runIdValue, async () => operation());
  }

  writeIssueLedger(runIdValue: string, value: IssueRecord[]): Promise<string> {
    return this.withOpenRun(runIdValue, async (directory) => {
      const jsonFile = this.writeRunJsonOnce(directory, "issue-ledger.json", issueLedgerSchema, value);
      const markdown = value.length ? ["# Issue Ledger", "", ...value.flatMap((issue) => [
        `## ${issue.issueId} — ${issue.testId} / ${issue.severity}`,
        "",
        `- Discovered: ${issue.discoveredAt}`,
        `- Code commit: ${issue.codeCommit ?? "UNAVAILABLE"}`,
        `- Environment: ${JSON.stringify(issue.environment)}`,
        `- Preconditions: ${issue.preconditions.join("; ") || "NONE"}`,
        `- Reproduction: ${issue.reproduction.join("; ")}`,
        `- Expected: ${issue.expected}`,
        `- Actual: ${issue.actual}`,
        `- Evidence: ${issue.evidence.join("; ") || "NONE"}`,
        `- Workaround: ${issue.workaround ?? "NONE"}`,
        `- Initial cause: ${issue.initialCause ?? "UNKNOWN"}`,
        `- Blocking scope: ${issue.blockingScope}`,
        `- Fix commit: ${issue.fixCommit ?? "OPEN"}`,
        `- Regression: ${issue.regressionResult ?? "NOT_TESTED"}`,
        "",
      ])].join("\n") : "# Issue Ledger\n\nNo issues recorded.\n";
      writeExclusive(join(directory, "issue-ledger.md"), boundedUtf8(markdown, MAX_JSON_BYTES, "issue-ledger.md"));
      return jsonFile;
    });
  }

  writeHashes(runIdValue: string, value: z.infer<typeof hashLedgerSchema>): Promise<string> {
    return this.withOpenRun(runIdValue, async (directory) => this.writeRunJsonOnce(directory, "hashes.json", hashLedgerSchema, value));
  }

  writeManifest(runIdValue: string, name: string, value: ManifestRecord): Promise<string> {
    const safeName = checkedEvidenceName(name);
    return this.withOpenRun(runIdValue, async (directory) => this.writeRunJsonOnce(directory, join("manifests", `${safeName}.json`), manifestRecordSchema, value));
  }

  writeTestResult(value: TestResult): Promise<string> {
    return this.withOpenRun(value.runId, async (directory) => this.writeRunJsonOnce(directory, join("tests", value.testId, "result.json"), testResultSchema, value));
  }

  writeLog(runIdValue: string, checkIdValue: string, stdoutValue: string, stderrValue: string): Promise<z.infer<typeof logRecordSchema>> {
    const checkId = checkedEvidenceName(checkIdValue);
    return this.withOpenRun(runIdValue, async (directory) => {
      const logs = join(directory, "logs");
      const stdout = boundedUtf8(stdoutValue, MAX_LOG_BYTES, "stdout log");
      const stderr = boundedUtf8(stderrValue, MAX_LOG_BYTES, "stderr log");
      const stdoutPath = join(logs, `${checkId}.stdout.log`);
      const stderrPath = join(logs, `${checkId}.stderr.log`);
      writeExclusive(stdoutPath, stdout);
      writeExclusive(stderrPath, stderr);
      const record = logRecordSchema.parse({
        schemaVersion: 1,
        runId: runIdValue,
        checkId,
        recordedAt: new Date().toISOString(),
        stdout: hashRecord(stdoutPath, relative(directory, stdoutPath).replaceAll("\\", "/")),
        stderr: hashRecord(stderrPath, relative(directory, stderrPath).replaceAll("\\", "/")),
      });
      this.writeRunJsonOnce(directory, join("logs", `${checkId}.json`), logRecordSchema, record);
      return record;
    });
  }

  async appendCommand(input: CommandRecordInput): Promise<z.infer<typeof commandRecordSchema>> {
    return this.withOpenRun(input.runId, async (directory) => this.appendCommandUnlocked(directory, input), "COMMAND_LOG_BUSY");
  }

  async recordMcpCommand(runIdValue: string, tool: string, request: Record<string, unknown>, envelope: OperationEnvelope): Promise<void> {
    await this.withOpenRun(runIdValue, async (directory) => {
      this.recordMcpCommandUnlocked(directory, runIdValue, tool, request, envelope);
    }, "COMMAND_LOG_BUSY");
  }

  async executeAndRecordMcpCommand(
    runIdValue: string,
    tool: string,
    request: Record<string, unknown>,
    execute: () => Promise<OperationEnvelope>,
  ): Promise<{ envelope: OperationEnvelope; evidenceError?: unknown }> {
    return this.withOpenRun(runIdValue, async (directory) => {
      const envelope = await execute();
      try {
        this.recordMcpCommandUnlocked(directory, runIdValue, tool, request, envelope);
        return { envelope };
      } catch (evidenceError) {
        return { envelope, evidenceError };
      }
    }, "COMMAND_LOG_BUSY");
  }

  private recordMcpCommandUnlocked(directory: string, runIdValue: string, tool: string, request: Record<string, unknown>, envelope: OperationEnvelope): void {
    const outputHashes = envelope.outputFiles.map((file) => hashRecord(file));
    this.appendCommandUnlocked(directory, {
      schemaVersion: 1,
      runId: runIdValue,
      kind: "mcp",
      recordedAt: new Date().toISOString(),
      operationId: envelope.operationId,
      tool,
      request,
      result: envelope,
      timestamps: envelope.timestamps,
      codeCommit: this.codeCommit,
      target: envelope.target,
      artifact: envelope.artifact,
      outputHashes,
    });
  }

  private appendCommandUnlocked(directory: string, input: CommandRecordInput): z.infer<typeof commandRecordSchema> {
    const commandsPath = join(directory, "commands.ndjson");
    const sequence = nextCommandSequence(commandsPath);
    const record = commandRecordSchema.parse({ ...input, sequence });
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (encoded.length > MAX_COMMAND_BYTES) throw new AcceptanceEvidenceError("COMMAND_RECORD_TOO_LARGE", `command record exceeds ${MAX_COMMAND_BYTES} bytes`);
    const currentBytes = existsSync(commandsPath) ? statSync(commandsPath).size : 0;
    if (currentBytes + encoded.length > MAX_COMMAND_LOG_BYTES) throw new AcceptanceEvidenceError("COMMAND_LOG_TOO_LARGE", `commands.ndjson exceeds ${MAX_COMMAND_LOG_BYTES} bytes`);
    appendFileSync(commandsPath, encoded);
    fsyncFile(commandsPath);
    return record;
  }

  private runDirectory(runIdValue: string): string {
    if (!isValidAcceptanceRunId(runIdValue)) throw new AcceptanceEvidenceError("RUN_ID_INVALID", "runId must be a bounded immutable non-reserved directory name");
    const directory = resolve(this.root, runIdValue);
    const rel = relative(this.root, directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new AcceptanceEvidenceError("RUN_ID_INVALID", "runId escapes the evidence root");
    return directory;
  }

  private initializeRun(directory: string, runIdValue: string): void {
    for (const name of ["tests", "captures", "manifests", "logs"]) mkdirSync(join(directory, name), { recursive: true });
    const marker = join(directory, "run.json");
    try { writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, runId: runIdValue })}\n`, { encoding: "utf8", flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const parsed = JSON.parse(readBounded(marker, MAX_JSON_BYTES)) as { schemaVersion?: unknown; runId?: unknown };
    if (parsed.schemaVersion !== 1 || parsed.runId !== runIdValue) throw new AcceptanceEvidenceError("RUN_ID_CONFLICT", `run marker does not match ${runIdValue}`);
  }

  private assertRunOpen(directory: string): void {
    if (existsSync(join(directory, "acceptance-index.json"))) {
      throw new AcceptanceEvidenceError("RUN_ID_COMPLETE", `completed evidence run is immutable: ${basename(directory)}`);
    }
  }

  private writeRunJsonOnce<T>(directory: string, relativePath: string, schema: ZodType<T>, value: T): string {
    const file = resolve(directory, relativePath);
    const rel = relative(directory, file);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new AcceptanceEvidenceError("EVIDENCE_PATH_INVALID", "evidence path escapes the run directory");
    mkdirSync(dirname(file), { recursive: true });
    const parsed = schema.parse(value);
    const encoded = boundedUtf8(`${JSON.stringify(parsed, null, 2)}\n`, MAX_JSON_BYTES, relativePath);
    writeExclusive(file, encoded);
    return file;
  }

  private withOpenRun<T>(runIdValue: string, operation: (directory: string) => Promise<T>, errorCode = "EVIDENCE_RUN_BUSY"): Promise<T> {
    const directory = this.ensureRun(runIdValue);
    if (this.activeRun.getStore() === runIdValue) {
      this.assertRunOpen(directory);
      return operation(directory);
    }
    return withDirectoryLease(this.runLockPath(runIdValue), async () => {
      return this.activeRun.run(runIdValue, async () => {
        this.assertRunOpen(directory);
        return operation(directory);
      });
    }, { errorCode });
  }

  private runLockPath(runIdValue: string): string {
    return join(this.root, ".locks", `${runIdValue}.lock`);
  }
}

async function assertRunCapturesTerminal(runDirectory: string): Promise<void> {
  const capturesDirectory = join(runDirectory, "captures");
  if (!existsSync(capturesDirectory)) return;
  const entries = readdirSync(capturesDirectory, { withFileTypes: true });
  if (entries.length > MAX_CAPTURE_PACKAGES) {
    throw new AcceptanceEvidenceError("RUN_CAPTURE_SCAN_LIMIT", `run contains more than ${MAX_CAPTURE_PACKAGES} capture entries`);
  }
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".jcap")) continue;
    if (!entry.isDirectory()) {
      throw new AcceptanceEvidenceError("RUN_CAPTURE_NOT_TERMINAL", `capture ${entry.name} is not a stable JCAP directory`);
    }
    const packageDirectory = join(capturesDirectory, entry.name);
    try {
      const metadata = readJcapV1Metadata(packageDirectory);
      if (!TERMINAL_CAPTURE_STATES.has(metadata.state)) {
        throw new Error(`capture state is not terminal (${String(metadata.state)}/${String(metadata.indexStatus)})`);
      }
      if (metadata.state === "failed") {
        const raw = readJcapV1Raw(packageDirectory);
        const lastLifecycle = raw.events.filter((event) => event.type === "lifecycle").at(-1);
        if (metadata.indexStatus !== "failed" || lastLifecycle?.state !== "failed") {
          throw new Error(`failed capture is not durably terminal (${String(metadata.indexStatus)}/${String(lastLifecycle?.state)})`);
        }
      } else {
        const index = await verifyJcapV1Index(packageDirectory);
        if (metadata.indexStatus !== "ready" || index.captureState !== metadata.state || index.indexStatus !== "ready") {
          throw new Error(`terminal capture index is not valid and ready (${String(metadata.state)}/${String(index.indexStatus)})`);
        }
      }
    } catch (error) {
      throw new AcceptanceEvidenceError("RUN_CAPTURE_NOT_TERMINAL", `capture ${entry.name} is unavailable, invalid, or not ready: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function captureManifest(rootValue: string, excludedDirectories: ReadonlySet<string> = new Set([".git", "node_modules", "out", "test-output", ".jlink-mcp"])): ManifestRecord {
  const root = resolve(rootValue);
  const entries: z.infer<typeof hashRecordSchema>[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.isSymbolicLink()) continue;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(file);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entries.length >= 100_000) throw new AcceptanceEvidenceError("MANIFEST_FILE_LIMIT", "manifest exceeds 100000 files");
      entries.push(hashRecord(file, relative(root, file).replaceAll("\\", "/")));
    }
  };
  visit(root);
  const manifestSha256 = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return manifestRecordSchema.parse({ schemaVersion: 1, root, recordedAt: new Date().toISOString(), entries, manifestSha256 });
}

export function captureFileHash(file: string, recordedPath = resolve(file)): z.infer<typeof hashRecordSchema> {
  return hashRecord(file, recordedPath);
}

export function summarizeAcceptance(tests: AcceptanceCase[], openP0: number): AcceptanceIndex["summary"] {
  const counts = Object.fromEntries(ACCEPTANCE_STATUSES.map((key) => [key, tests.filter((entry) => entry.status === key).length])) as Record<AcceptanceStatus, number>;
  return { ...counts, openP0 };
}

export function readRepositoryIdentity(rootValue: string): RepositoryIdentity {
  const root = resolve(rootValue);
  const git = (args: string[]): string | null => {
    try { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; }
    catch { return null; }
  };
  const commit = git(["rev-parse", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  const statusText = git(["status", "--porcelain"]);
  return {
    root,
    commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    branch,
    dirty: statusText !== null && statusText.length > 0,
  };
}

function hashRecord(file: string, recordedPath = resolve(file)): z.infer<typeof hashRecordSchema> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const snapshot = fstatSync(descriptor);
    if (!snapshot.isFile() || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0) throw new Error("output is not a bounded regular file");
    const prefixBytes = snapshot.size;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < prefixBytes) {
      const bytes = readSync(descriptor, buffer, 0, Math.min(buffer.length, prefixBytes - position), position);
      if (bytes === 0) throw new Error("output became shorter than its recorded prefix");
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
    return hashRecordSchema.parse({ path: recordedPath, bytes: prefixBytes, sha256: hash.digest("hex") });
  } catch (error) {
    throw new AcceptanceEvidenceError("OUTPUT_HASH_FAILED", `cannot hash output ${recordedPath}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nextCommandSequence(file: string): number {
  if (!existsSync(file)) return 1;
  const text = readBounded(file, MAX_COMMAND_LOG_BYTES);
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return 1;
  const last = commandRecordSchema.parse(JSON.parse(lines.at(-1)!));
  return last.sequence + 1;
}

function checkedEvidenceName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new AcceptanceEvidenceError("EVIDENCE_NAME_INVALID", `invalid evidence name: ${value}`);
  return value;
}

function writeExclusive(file: string, bytes: Buffer): void {
  try { writeFileSync(file, bytes, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new AcceptanceEvidenceError("EVIDENCE_IMMUTABLE", `evidence already exists: ${file}`);
    throw error;
  }
  fsyncFile(file);
}

function fsyncFile(file: string): void {
  const descriptor = openSync(file, "r+");
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function boundedUtf8(value: string, limit: number, label: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > limit) throw new AcceptanceEvidenceError("EVIDENCE_TOO_LARGE", `${label} exceeds ${limit} bytes`);
  return bytes;
}

function readBounded(file: string, limit: number): string {
  const size = statSync(file).size;
  if (size > limit) throw new AcceptanceEvidenceError("EVIDENCE_TOO_LARGE", `${file} exceeds ${limit} bytes`);
  return readFileSync(file, "utf8");
}
