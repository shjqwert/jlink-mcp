import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ACCEPTANCE_TEST_IDS, summarizeAcceptance, type AcceptanceCase, type AcceptanceIndex, type AcceptanceStatus, type IssueRecord } from "./evidence";
import { publishAcceptanceSummary, publishedAcceptanceIndexSchema } from "./published-summary";

function createRepository(): { root: string; commit: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-published-summary-repository-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=JLink Test", "-c", "user.email=jlink-test@example.invalid", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  return { root, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };
}

function cases(statusFor = (testId: string): AcceptanceStatus => ["T01", "T02", "T03", "T05"].includes(testId) ? "PASS" : "NOT_TESTED"): AcceptanceCase[] {
  return ACCEPTANCE_TEST_IDS.map((testId) => {
    const status = statusFor(testId);
    return {
      testId,
      status,
      requirements: ["acceptance-evidence"],
      automatedChecks: [],
      hardwarePrerequisites: [],
      evidence: ["logs/private-local-path.log"],
      blockers: status === "PASS" ? [] : ["hardware acceptance has not been executed"],
      subcases: [{ id: "source", status: "PASS", summary: "local evidence is retained outside the published index", evidence: ["logs/private-local-path.log"], blockers: [] }],
    };
  }) as AcceptanceCase[];
}

function index(codeCommit: string | null, tests = cases(), mergeRecommendation: AcceptanceIndex["mergeRecommendation"] = "DO_NOT_RECOMMEND"): AcceptanceIndex {
  return {
    schemaVersion: 1,
    runId: "published-summary-test",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    codeCommit,
    tests,
    mergeRecommendation,
    summary: summarizeAcceptance(tests, 0),
  };
}

function issue(codeCommit: string, severity: "P0" | "P1"): IssueRecord {
  return {
    issueId: `${severity}-fixture`,
    discoveredAt: new Date().toISOString(),
    testId: "T01",
    severity,
    codeCommit,
    environment: {},
    preconditions: ["fixture"],
    reproduction: ["run fixture"],
    expected: "no issue",
    actual: "issue recorded",
    evidence: [],
    workaround: null,
    initialCause: null,
    blockingScope: "fixture",
    fixCommit: null,
    regressionResult: null,
  };
}

const checks: Record<string, AcceptanceStatus> = {
  build: "PASS",
  lint: "PASS",
  "unit-foundation": "PASS",
  "unit-acceptance": "PASS",
  "unit-artifact": "PASS",
  "unit-direct": "PASS",
  "unit-svd": "PASS",
  "unit-hss-jcap": "PASS",
  surface: "PASS",
  guidance: "PASS",
  "legacy-scan": "PASS",
  "hss-helper": "PASS",
  package: "PASS",
  privacy: "PASS",
};

test("published acceptance summary is bound to a clean current commit and strips local evidence", () => {
  const repository = createRepository();
  const directory = mkdtempSync(path.join(os.tmpdir(), "jlink-published-summary-output-"));
  try {
    const result = publishAcceptanceSummary({ repositoryRoot: repository.root, outputDirectory: directory, index: index(repository.commit), checks, issues: [] });
    const parsed = publishedAcceptanceIndexSchema.parse(JSON.parse(readFileSync(result.indexPath, "utf8")));
    const markdown = readFileSync(result.summaryPath, "utf8");
    assert.equal(parsed.testedCommit, repository.commit);
    assert.equal(parsed.ci.privacy, "PASS");
    assert.equal(parsed.hss.capacityStatus, "NOT_TESTED");
    assert.equal(parsed.acceptance.runId, "published");
    assert.deepEqual(parsed.publication, { destinationMetadata: "not_supplied" });
    assert.match(parsed.acceptance.tests[0].evidence[0], /^digest:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(parsed).includes("private-local-path"), false);
    assert.match(markdown, /Merge recommendation: DO_NOT_RECOMMEND/);
    assert.equal(markdown.includes("private-local-path"), false);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published acceptance removes free-text paths, Probe IDs, and Artifact hashes before writing", () => {
  const repository = createRepository();
  const directory = mkdtempSync(path.join(os.tmpdir(), "jlink-published-summary-output-"));
  try {
    const source = index(repository.commit);
    const tempPath = ["C:", "Temp", "private"].join("\\");
    const projectPath = ["C:", "FOC_Project", "target.elf"].join("\\");
    const uncPath = ["", "", "server", "share", "target.bin"].join("\\");
    const probeId = ["JLink", "SN", "12345678"].join("");
    const artifactHash = "a".repeat(64);
    const runtimeHash = "b".repeat(64);
    source.runId = "a".repeat(64);
    source.tests[0] = {
      ...source.tests[0],
      requirements: [`${tempPath}\\requirement`],
      automatedChecks: [probeId],
      hardwarePrerequisites: [projectPath],
      evidence: [`${tempPath}\\evidence.log`],
      blockers: [["probe", "Serial=12345678 artifact", "Hash ", artifactHash].join("")],
      subcases: [{ id: probeId, status: "FAIL", summary: uncPath, evidence: [`${tempPath}\\subcase.log`], blockers: [["runtime", "IdentitySha256 ", runtimeHash].join("")] }],
    };
    const result = publishAcceptanceSummary({ repositoryRoot: repository.root, outputDirectory: directory, index: source, checks, issues: [] });
    const serialized = JSON.stringify(result.index);
    const markdown = readFileSync(result.summaryPath, "utf8");
    for (const privateValue of [tempPath, projectPath, uncPath, probeId, artifactHash, runtimeHash, "a".repeat(64)]) {
      assert.equal(serialized.includes(privateValue), false);
      assert.equal(markdown.includes(privateValue), false);
    }
    assert.throws(() => publishedAcceptanceIndexSchema.parse({ ...result.index, blockers: [tempPath] }), /local machine path/);
    assert.throws(() => publishedAcceptanceIndexSchema.parse({ ...result.index, acceptance: { ...result.index.acceptance, runId: "a".repeat(64) } }), /private run ID/);
    assert.throws(() => publishedAcceptanceIndexSchema.parse({
      ...result.index,
      acceptance: {
        ...result.index.acceptance,
        tests: result.index.acceptance.tests.map((entry) => ({ ...entry, evidence: [], subcases: entry.subcases.map((subcase) => ({ ...subcase, evidence: [] })) })),
      },
    }), /every test status to an evidence digest/);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published acceptance derives open P1, HSS quality, write source, and recommendation", () => {
  const repository = createRepository();
  const directory = mkdtempSync(path.join(os.tmpdir(), "jlink-published-summary-output-"));
  try {
    const result = publishAcceptanceSummary({
      repositoryRoot: repository.root,
      outputDirectory: directory,
      index: index(repository.commit, cases(() => "PASS"), "RECOMMEND"),
      checks,
      issues: [issue(repository.commit, "P1")],
      hssQuality: { status: "partial", source: "target_counter" },
      writeVerificationSource: "same_session",
      destinationMetadataSupplied: true,
    });
    assert.deepEqual(result.index.openCoreIssues, { P0: 0, P1: 1 });
    assert.deepEqual(result.index.hss, { capacityStatus: "PASS", qualityStatus: "partial", qualitySource: "target_counter" });
    assert.deepEqual(result.index.writeVerification, { status: "PASS", source: "same_session" });
    assert.equal(result.index.mergeRecommendation, "DO_NOT_RECOMMEND");
    assert.ok(result.index.blockers.includes("1 open P1 issue"));
    assert.ok(result.index.blockers.includes("T14 HSS quality is partial"));
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published schema blocks failed CI and an unqualified HSS source from recommending release", () => {
  const repository = createRepository();
  const directory = mkdtempSync(path.join(os.tmpdir(), "jlink-published-summary-output-"));
  try {
    const result = publishAcceptanceSummary({
      repositoryRoot: repository.root,
      outputDirectory: directory,
      index: index(repository.commit, cases(() => "PASS"), "RECOMMEND"),
      checks,
      issues: [],
      hssQuality: { status: "qualified", source: "jlink" },
      writeVerificationSource: "same_session",
      destinationMetadataSupplied: true,
    });
    assert.equal(result.index.mergeRecommendation, "RECOMMEND");
    assert.throws(() => publishedAcceptanceIndexSchema.parse({ ...result.index, hss: { ...result.index.hss, qualitySource: "none" } }), /qualified HSS quality requires a qualified source/);
    assert.throws(() => publishedAcceptanceIndexSchema.parse({ ...result.index, ci: { ...result.index.ci, privacy: "FAIL" } }), /merge recommendation/);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("published acceptance rejects missing, stale, or dirty commit bindings", () => {
  const repository = createRepository();
  const directory = mkdtempSync(path.join(os.tmpdir(), "jlink-published-summary-output-"));
  try {
    assert.throws(() => publishAcceptanceSummary({ repositoryRoot: repository.root, outputDirectory: directory, index: index(null), checks, issues: [] }), /tested Git commit/);
    assert.throws(() => publishAcceptanceSummary({ repositoryRoot: repository.root, outputDirectory: directory, index: index("a".repeat(40)), checks, issues: [] }), /exact tested Git commit/);
    writeFileSync(path.join(repository.root, "dirty.txt"), "dirty\n");
    assert.throws(() => publishAcceptanceSummary({ repositoryRoot: repository.root, outputDirectory: directory, index: index(repository.commit), checks, issues: [] }), /exact tested Git commit/);
  } finally {
    rmSync(repository.root, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
