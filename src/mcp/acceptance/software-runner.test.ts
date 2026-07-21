import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acceptanceIndexSchema } from "./evidence";
import { runSoftwareAcceptance, type CommandExecution, type CommandExecutor } from "./software-runner";

function successfulExecution(): CommandExecution {
  const now = new Date().toISOString();
  return { exitCode: 0, signal: null, stdout: "ok\n", stderr: "", startedAt: now, endedAt: now };
}

function initializeRepository(repository: string): void {
  execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
  writeFileSync(path.join(repository, ".gitignore"), "test-output/\n");
  writeFileSync(path.join(repository, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repository, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=JLink Test", "-c", "user.email=jlink-test@example.invalid", "commit", "-m", "fixture"], { cwd: repository, stdio: "ignore" });
}

test("software acceptance writes the complete ignored run layout and all T01-T20 statuses", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-software-acceptance-"));
  const repository = path.join(root, "repository");
  const project = path.join(root, "project");
  const output = path.join(repository, "test-output");
  mkdirSync(repository, { recursive: true });
  mkdirSync(project, { recursive: true });
  initializeRepository(repository);
  writeFileSync(path.join(project, "firmware.c"), "int main(void) { return 0; }\n");
  const executed: string[] = [];
  const execute: CommandExecutor = (check) => { executed.push(check.id); return successfulExecution(); };
  try {
    const result = await runSoftwareAcceptance({ runId: "software-pass", repositoryRoot: repository, evidenceRoot: output, projectRoot: project, execute });
    assert.equal(result.index.tests.length, 20);
    assert.equal(result.index.tests.find((entry) => entry.testId === "T01")?.status, "PASS");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T03")?.status, "PASS");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T05")?.status, "PASS");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T09")?.status, "BLOCKED");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T13")?.status, "SKIPPED_WITH_REASON");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T20")?.status, "BLOCKED");
    assert.equal(result.index.mergeRecommendation, "DO_NOT_RECOMMEND");
    assert.deepEqual(executed, [
      "ignored-output", "install", "build", "lint", "unit-foundation", "unit-acceptance", "unit-artifact", "unit-direct", "unit-svd", "unit-hss-jcap",
      "surface", "guidance", "legacy-scan", "hss-helper", "package", "privacy", "openspec",
    ]);
    assert.deepEqual(readdirSync(result.runDirectory).sort(), [
      "acceptance-index.json", "captures", "commands.ndjson", "environment.json", "hashes.json", "issue-ledger.json", "issue-ledger.md",
      "logs", "manifests", "preconditions.json", "run.json", "tests",
    ]);
    assert.equal(readdirSync(path.join(result.runDirectory, "tests")).length, 20);
    assert.deepEqual(readdirSync(path.join(result.runDirectory, "manifests")).sort(), ["project-after.json", "project-before.json"]);
    assert.equal(readFileSync(path.join(result.runDirectory, "commands.ndjson"), "utf8").trim().split(/\r?\n/).length, 17);
    assert.equal(result.checks.privacy, "PASS");
    assert.equal(acceptanceIndexSchema.parse(JSON.parse(readFileSync(path.join(result.runDirectory, "acceptance-index.json"), "utf8"))).tests.length, 20);
    assert.match(readFileSync(path.join(result.runDirectory, "issue-ledger.md"), "utf8"), /No issues recorded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("software failures and project mutation remain visible and block T20", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-software-acceptance-"));
  const repository = path.join(root, "repository");
  const project = path.join(root, "project");
  mkdirSync(repository, { recursive: true });
  mkdirSync(project, { recursive: true });
  initializeRepository(repository);
  writeFileSync(path.join(project, "firmware.c"), "before\n");
  const execute: CommandExecutor = (check) => {
    if (check.id === "unit-artifact") return { ...successfulExecution(), exitCode: 1, stderr: "simulated Artifact unit failure\n" };
    if (check.id === "build") writeFileSync(path.join(project, "firmware.c"), "unexpected mutation\n");
    return successfulExecution();
  };
  try {
    const result = await runSoftwareAcceptance({ runId: "software-fail", repositoryRoot: repository, projectRoot: project, execute });
    assert.equal(result.index.tests.find((entry) => entry.testId === "T01")?.status, "FAIL");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T03")?.status, "FAIL");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T13")?.status, "SKIPPED_WITH_REASON");
    assert.equal(result.index.tests.find((entry) => entry.testId === "T14")?.status, "NOT_TESTED");
    const t20 = result.index.tests.find((entry) => entry.testId === "T20")!;
    assert.equal(t20.status, "FAIL");
    assert.ok(t20.blockers.some((blocker) => blocker.includes("manifest changed")));
    assert.equal(result.index.summary.FAIL > 0, true);
    const issues = JSON.parse(readFileSync(path.join(result.runDirectory, "issue-ledger.json"), "utf8")) as Array<{ issueId: string; testId: string; reproduction: string[] }>;
    assert.deepEqual(issues.map((issue) => issue.issueId).sort(), ["AUTO-software-fail-project-manifest", "AUTO-software-fail-unit-artifact"]);
    assert.deepEqual(issues.map((issue) => issue.testId).sort(), ["T03", "T20"]);
    assert.deepEqual(issues.find((issue) => issue.issueId === "AUTO-software-fail-unit-artifact")?.reproduction, [
      "from the recorded repository root, rerun the unit-artifact command exactly as stored in commands.ndjson",
      "observe exitCode=1 signal=null",
    ]);
    assert.match(readFileSync(path.join(result.runDirectory, "issue-ledger.md"), "utf8"), /AUTO-software-fail-unit-artifact/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maximum-length run IDs still produce bounded automatic issue IDs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-software-acceptance-"));
  const repository = path.join(root, "repository");
  const runId = "r".repeat(96);
  mkdirSync(repository, { recursive: true });
  initializeRepository(repository);
  const execute: CommandExecutor = (check) => check.id === "unit-svd"
    ? { ...successfulExecution(), exitCode: 1, stderr: "simulated SVD unit failure\n" }
    : successfulExecution();
  try {
    const result = await runSoftwareAcceptance({ runId, repositoryRoot: repository, execute });
    const issues = JSON.parse(readFileSync(path.join(result.runDirectory, "issue-ledger.json"), "utf8")) as Array<{ issueId: string }>;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issueId, `AUTO-${runId}-unit-svd`);
    assert.equal(issues[0].issueId.length <= 128, true);
    await assert.rejects(runSoftwareAcceptance({ runId: "r".repeat(97), repositoryRoot: repository, execute }), /invalid acceptance runId/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("software acceptance rejects a dirty start or a repository changed during the run", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "jlink-software-acceptance-"));
  const repository = path.join(root, "repository");
  mkdirSync(repository, { recursive: true });
  initializeRepository(repository);
  const execute: CommandExecutor = (check) => {
    if (check.id === "build") writeFileSync(path.join(repository, "changed-during-run.txt"), "changed\n");
    return successfulExecution();
  };
  try {
    await assert.rejects(runSoftwareAcceptance({ runId: "repository-change", repositoryRoot: repository, execute }), /repository changed during the run/);
    rmSync(path.join(repository, "changed-during-run.txt"), { force: true });
    writeFileSync(path.join(repository, "dirty-before-run.txt"), "dirty\n");
    await assert.rejects(runSoftwareAcceptance({ runId: "repository-dirty", repositoryRoot: repository, execute: () => successfulExecution() }), /clean repository at HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
