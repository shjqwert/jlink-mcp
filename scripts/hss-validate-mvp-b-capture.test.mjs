import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "hss-validate-mvp-b-capture.mjs");

test("rejects failed write events even when metadata sidecars exist", () => {
  const file = capture({
    events: [{ type: "variable_write", ok: false, readbackOk: false }],
    state: "failed",
    transportStatus: "failed",
    dataQualityStatus: "failed",
    quality: { sampleCount: 500, validSamples: 3, readErrors: 497, timeouts: 0, droppedSamples: 0 },
    targetState: { targetWasHaltedBeforeCapture: true, targetWasHaltedAfterResume: true },
  });

  const result = run(file);

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).checks["all variable_write events succeeded"], false);
});

test("accepts successful write with clean capture quality and safety", () => {
  const file = capture({
    events: [{ type: "variable_write", ok: true, readbackOk: true }],
  });

  const result = run(file);

  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, "pass");
});

function run(file) {
  return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
}

function capture(overrides = {}) {
  const tmpRoot = resolve(".tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, "hss-mvp-b-validator-"));
  const file = join(dir, "capture.json");
  const metadata = {
    captureId: "test-capture",
    state: "stopped",
    transportStatus: "pass",
    dataQualityStatus: "pass",
    quality: { sampleCount: 10, validSamples: 10, readErrors: 0, timeouts: 0, droppedSamples: 0 },
    safety: { targetReset: false, resetIssued: false, haltIssued: false, flashIssued: false },
    targetState: { targetWasHaltedBeforeCapture: false, targetWasHaltedAfterResume: false },
    events: [{ type: "variable_write", ok: true, readbackOk: true }],
    flagIntervals: [{ reason: "write_nearby" }],
    segments: [{ file: "capture_0001.bin", sampleCount: 10 }],
    ...overrides,
  };
  writeFileSync(file, JSON.stringify(metadata), "utf8");
  writeFileSync(join(dir, "capture.events.jsonl"), "{}\n", "utf8");
  writeFileSync(join(dir, "capture.flags.jsonl"), "{}\n", "utf8");
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}
