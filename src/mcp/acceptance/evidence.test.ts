import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ACCEPTANCE_STATUSES,
  ACCEPTANCE_TEST_IDS,
  AcceptanceEvidenceError,
  AcceptanceEvidenceStore,
  acceptanceIndexSchema,
  captureManifest,
  summarizeAcceptance,
  type AcceptanceCase,
} from "./evidence";
import { isValidAcceptanceRunId } from "./run-id";
import { createOperationEnvelope, finishEnvelope } from "../runtime/operation-envelope";
import {
  createJcapV1Metadata,
  finalizeJcapV1Metadata,
  rebuildJcapV1Index,
  writeJcapV1Raw,
} from "../jcap/jcap-v1";

test("acceptance evidence schemas enforce fixed statuses and T01 through T20", () => {
  assert.deepEqual(ACCEPTANCE_STATUSES, ["PASS", "FAIL", "BLOCKED", "SKIPPED_WITH_REASON", "NOT_TESTED"]);
  assert.equal(isValidAcceptanceRunId("run-20260719T010203"), true);
  assert.equal(isValidAcceptanceRunId("r".repeat(96)), true);
  assert.equal(isValidAcceptanceRunId("r".repeat(97)), false);
  assert.equal(isValidAcceptanceRunId("captures"), false);
  assert.equal(isValidAcceptanceRunId("CON.txt"), false);
  const tests = ACCEPTANCE_TEST_IDS.map<AcceptanceCase>((testId) => ({
    testId,
    status: testId === "T01" ? "PASS" : "NOT_TESTED",
    requirements: ["acceptance-evidence"],
    automatedChecks: [],
    hardwarePrerequisites: [],
    evidence: [],
    blockers: [],
    subcases: [],
  }));
  const value = {
    schemaVersion: 1 as const,
    runId: "schema-run",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    codeCommit: null,
    tests,
    mergeRecommendation: "DO_NOT_RECOMMEND" as const,
    summary: summarizeAcceptance(tests, 0),
  };
  assert.equal(acceptanceIndexSchema.parse(value).tests.length, 20);
  assert.throws(() => acceptanceIndexSchema.parse({ ...value, tests: tests.slice(1) }));
  assert.throws(() => acceptanceIndexSchema.parse({ ...value, summary: { ...value.summary, PASS: 20 } }));
  assert.throws(() => acceptanceIndexSchema.parse({ ...value, summary: { ...value.summary, PASS: 2, NOT_TESTED: 18 } }));
  assert.throws(() => acceptanceIndexSchema.parse({ ...value, mergeRecommendation: "RECOMMEND" }));
  const passingTests = tests.map((entry) => ({ ...entry, status: "PASS" as const }));
  assert.equal(acceptanceIndexSchema.parse({ ...value, tests: passingTests, summary: summarizeAcceptance(passingTests, 0), mergeRecommendation: "RECOMMEND" }).mergeRecommendation, "RECOMMEND");
});

test("run evidence is local, append-only for commands, bounded, and immutable for result files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-acceptance-evidence-"));
  const output = path.join(root, "test-output");
  const store = new AcceptanceEvidenceStore(output, "a".repeat(40));
  try {
    const runDir = store.createRun("run-001");
    assert.deepEqual(readdirSync(runDir).sort(), ["captures", "logs", "manifests", "run.json", "tests"]);
    assert.throws(() => store.createRun("run-001"), (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "RUN_ID_EXISTS");
    const first = await store.appendCommand({
      schemaVersion: 1,
      runId: "run-001",
      kind: "shell",
      recordedAt: new Date().toISOString(),
      operationId: "check-build",
      tool: "npm run build",
      request: { command: "npm run build" },
      result: { exitCode: 0 },
      timestamps: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
      codeCommit: "a".repeat(40),
      target: null,
      artifact: null,
      outputHashes: [],
    });
    const { sequence: _firstSequence, ...firstInput } = first;
    const second = await store.appendCommand({ ...firstInput, operationId: "check-lint", tool: "npm run lint" });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    const lines = readFileSync(path.join(runDir, "commands.ndjson"), "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    const environment = {
      schemaVersion: 1 as const,
      runId: "run-001",
      recordedAt: new Date().toISOString(),
      repository: { root, commit: "a".repeat(40), branch: "test", dirty: false },
      runtime: { platform: process.platform, architecture: process.arch, node: process.version },
    };
    await store.writeEnvironment(environment);
    await assert.rejects(store.writeEnvironment(environment), (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "EVIDENCE_IMMUTABLE");

    const missingOutput = createOperationEnvelope("missing-output");
    missingOutput.outputFiles = [path.join(root, "missing-output.bin")];
    await assert.rejects(
      store.recordMcpCommand("run-001", "missing-output", {}, missingOutput),
      (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "OUTPUT_HASH_FAILED",
    );
    assert.equal(readFileSync(path.join(runDir, "commands.ndjson"), "utf8").trim().split(/\r?\n/).length, 2);
    const guarded = await store.executeAndRecordMcpCommand("run-001", "guarded-mutation", {}, async () => {
      await store.guardRunMutation("run-001", async () => undefined);
      return finishEnvelope(createOperationEnvelope("guarded-mutation"), true);
    });
    assert.equal(guarded.evidenceError, undefined);

    const completedTests = ACCEPTANCE_TEST_IDS.map<AcceptanceCase>((testId) => ({
      testId,
      status: "PASS",
      requirements: ["acceptance-evidence"],
      automatedChecks: [],
      hardwarePrerequisites: [],
      evidence: [],
      blockers: [],
      subcases: [],
    }));
    const completedIndex = acceptanceIndexSchema.parse({
      schemaVersion: 1,
      runId: "run-001",
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      codeCommit: "a".repeat(40),
      tests: completedTests,
      mergeRecommendation: "RECOMMEND",
      summary: summarizeAcceptance(completedTests, 0),
    });
    const captureRun = store.createRun("run-active-capture");
    const captureId = "00000000-0000-4000-8000-000000000001";
    const captureDirectory = path.join(captureRun, "captures", `${captureId}.jcap`);
    const captureMetadata = path.join(captureDirectory, "capture.json");
    mkdirSync(captureDirectory, { recursive: true });
    const activeMetadata = createJcapV1Metadata({
      captureId,
      backend: "fake-jlink-hss",
      requestedRateHz: 1,
      durationSec: 1,
      variables: [{ logicalIdentity: "counter", type: "uint32", address: "0x20000000", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "b".repeat(64) }],
      provenance: {
        captureId,
        backend: "fake-jlink-hss",
        runtime: { helperProtocolVersion: 1 },
        target: { projectRoot: "C:\\fixture-project", generation: "43000000-0000-4000-8000-000000000001", device: "FIXTURE", probeSerial: "123456789", interface: "SWD", speed: 1000 },
        script: { mode: "none" },
        artifact: { path: "C:\\fixture-project\\firmware.elf", generation: "a".repeat(64), sha256: "c".repeat(64) },
      },
    });
    writeFileSync(captureMetadata, `${JSON.stringify(activeMetadata)}\n`);
    await assert.rejects(
      store.writeAcceptanceIndex({ ...completedIndex, runId: "run-active-capture" }),
      (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "RUN_CAPTURE_NOT_TERMINAL",
    );
    assert.equal(existsSync(path.join(captureRun, "acceptance-index.json")), false);
    writeFileSync(captureMetadata, `${JSON.stringify({ ...activeMetadata, state: "completed", indexStatus: "ready" })}\n`);
    await assert.rejects(
      store.writeAcceptanceIndex({ ...completedIndex, runId: "run-active-capture" }),
      (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "RUN_CAPTURE_NOT_TERMINAL",
    );
    rmSync(captureDirectory, { recursive: true, force: true });
    writeJcapV1Raw({
      packageDir: captureDirectory,
      metadata: activeMetadata,
      samples: [{ sampleIndex: 0, tick: "1", statusFlags: 1, values: { counter: 1 } }],
      events: [
        { eventId: "42000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: "42000000-0000-4000-8000-000000000002", eventSequence: 1, type: "lifecycle", tick: "2", state: "finalizing" },
        { eventId: "42000000-0000-4000-8000-000000000003", eventSequence: 2, type: "lifecycle", tick: "3", state: "stopped" },
      ],
    });
    finalizeJcapV1Metadata(captureDirectory, "stopped");
    await assert.rejects(
      store.writeAcceptanceIndex({ ...completedIndex, runId: "run-active-capture" }),
      (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "RUN_CAPTURE_NOT_TERMINAL",
    );
    await rebuildJcapV1Index(captureDirectory);
    const captureDatabase = path.join(captureDirectory, "capture.db");
    const validDatabase = readFileSync(captureDatabase);
    writeFileSync(captureDatabase, "not a sqlite database");
    await assert.rejects(
      store.writeAcceptanceIndex({ ...completedIndex, runId: "run-active-capture" }),
      (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "RUN_CAPTURE_NOT_TERMINAL",
    );
    writeFileSync(captureDatabase, validDatabase);
    await store.writeAcceptanceIndex({ ...completedIndex, runId: "run-active-capture" });
    assert.equal(existsSync(path.join(captureRun, "acceptance-index.json")), true);
    let releaseExecution!: () => void;
    let reportExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => { reportExecutionStarted = resolve; });
    const releaseExecutionPromise = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const inFlightEnvelope = finishEnvelope(createOperationEnvelope("in-flight"), true);
    const inFlight = store.executeAndRecordMcpCommand("run-001", "in-flight", {}, async () => {
      reportExecutionStarted();
      await releaseExecutionPromise;
      return inFlightEnvelope;
    });
    await executionStarted;
    let completionSettled = false;
    const completion = store.writeAcceptanceIndex(completedIndex).then((result) => { completionSettled = true; return result; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completionSettled, false);
    releaseExecution();
    const recorded = await inFlight;
    assert.equal(recorded.evidenceError, undefined);
    await completion;
    assert.equal(completionSettled, true);
    await assert.rejects(
      store.appendCommand({ ...firstInput, operationId: "check-after-completion", tool: "npm test" }),
      (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "RUN_ID_COMPLETE",
    );
    await assert.rejects(store.writeHashes("run-001", []), (error: unknown) => error instanceof AcceptanceEvidenceError && error.code === "RUN_ID_COMPLETE");
    assert.equal(readFileSync(path.join(runDir, "commands.ndjson"), "utf8").trim().split(/\r?\n/).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project manifests are deterministic and detect source changes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-acceptance-manifest-"));
  try {
    writeFileSync(path.join(root, "a.txt"), "a");
    writeFileSync(path.join(root, "b.txt"), "b");
    const first = captureManifest(root);
    const second = captureManifest(root);
    assert.equal(first.manifestSha256, second.manifestSha256);
    writeFileSync(path.join(root, "b.txt"), "changed");
    assert.notEqual(captureManifest(root).manifestSha256, first.manifestSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
