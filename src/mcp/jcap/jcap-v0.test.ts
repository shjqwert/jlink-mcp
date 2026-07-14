import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JCAP_V0_GOLDEN, JCAP_V0_PRESTART_FAILURE } from "./golden-corpus";
import {
  JcapBoundsError,
  jcapCaptureEventWindow,
  jcapCaptureList,
  jcapCaptureSeries,
  jcapCaptureSummary,
  readJcapV0Raw,
  rebuildJcapV0Index,
  verifyJcapV0Index,
  writeJcapV0Raw,
} from "./jcap-v0";

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jcap-v0-"));
}

function rawBytes(packageDir: string): Record<string, Buffer> {
  return Object.fromEntries(["samples.bin", "events.bin"].map((name) => [name, readFileSync(path.join(packageDir, "raw", name))]));
}

test("JCAP v0 round-trips raw through SQLite and bounded queries without default exports", async () => {
  const root = workspace();
  const packageDir = path.join(root, "golden.jcap");
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    const before = rawBytes(packageDir);
    const built = await rebuildJcapV0Index(packageDir);
    assert.equal(built.captureState, "completed");
    assert.equal(built.indexStatus, "ready");
    assert.equal(existsSync(path.join(packageDir, "capture.db.tmp")), false);
    assert.deepEqual(await verifyJcapV0Index(packageDir), { captureState: "completed", indexStatus: "ready" });

    const summary = await jcapCaptureSummary(packageDir);
    assert.equal(summary.captureState, "completed");
    assert.equal(summary.indexStatus, "ready");
    assert.equal(summary.sampleCount, 3);
    assert.equal((summary.provenance as typeof JCAP_V0_GOLDEN.provenance).script.sha256, JCAP_V0_GOLDEN.provenance.script.sha256);
    assert.deepEqual((summary.provenance as typeof JCAP_V0_GOLDEN.provenance).reset, JCAP_V0_GOLDEN.provenance.reset);

    const series = await jcapCaptureSeries({ packageDir, variables: ["counter", "feedback"], startTick: "10000000", endTick: "30000000", bucketCount: 2 });
    assert.equal(series.indexStatus, "ready");
    assert.ok((series.series as unknown[]).length >= 2);
    const window = await jcapCaptureEventWindow({ packageDir, eventId: "write", variables: ["counter"], beforeMs: 20, afterMs: 20, bucketCount: 2 });
    assert.equal((window.event as Record<string, unknown>).eventId, "write");
    assert.ok((window.relatedEvents as unknown[]).length > 0);
    assert.deepEqual((await jcapCaptureList(root)).captures, [{ name: "golden.jcap", captureState: "completed", indexStatus: "ready" }]);

    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "raw"]);
    await rebuildJcapV0Index(packageDir);
    assert.deepEqual(rawBytes(packageDir), before);
    assert.equal(existsSync(path.join(packageDir, "capture.db.tmp")), false);
    unlinkSync(path.join(packageDir, "capture.db"));
    assert.deepEqual(await verifyJcapV0Index(packageDir), { captureState: "completed", indexStatus: "rebuild_required" });
    await rebuildJcapV0Index(packageDir);
    assert.deepEqual(rawBytes(packageDir), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v0 rebuilds a pre-start failure with capture and index states kept separate", async () => {
  const root = workspace();
  const packageDir = path.join(root, "failed.jcap");
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_PRESTART_FAILURE });
    await rebuildJcapV0Index(packageDir);
    const summary = await jcapCaptureSummary(packageDir);
    assert.equal(summary.captureState, "failed");
    assert.equal(summary.indexStatus, "ready");
    assert.equal(summary.sampleCount, 0);
    assert.equal(summary.eventCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const damage of ["truncated_tail", "corrupt_suffix"] as const) {
  test(`JCAP v0 reports ${damage} and rebuilds only the immutable valid prefix`, async () => {
    const root = workspace();
    const packageDir = path.join(root, `${damage}.jcap`);
    try {
      writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
      const damagedFile = path.join(packageDir, "raw", damage === "truncated_tail" ? "samples.bin" : "events.bin");
      appendFileSync(damagedFile, damage === "truncated_tail" ? "{\"partial\"" : "{}\n");
      const before = rawBytes(packageDir);
      const parsed = readJcapV0Raw(packageDir);
      assert.equal(parsed.samples.length, 3);
      assert.equal(parsed.events.length, 6);
      assert.equal(parsed.diagnostics[0].reason, damage);
      const rebuilt = await rebuildJcapV0Index(packageDir);
      assert.equal(rebuilt.captureState, "completed");
      assert.equal(rebuilt.indexStatus, "failed");
      assert.deepEqual(rawBytes(packageDir), before);
      assert.equal((await jcapCaptureSummary(packageDir)).sampleCount, 3);
      await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: ["counter"], startTick: "0", endTick: "40000000", bucketCount: 10 }), /index is not ready/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("JCAP v0 query bounds reject instead of clamping", async () => {
  const root = workspace();
  const packageDir = path.join(root, "bounds.jcap");
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    await rebuildJcapV0Index(packageDir);
    await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: Array.from({ length: 33 }, (_, index) => `v${index}`), startTick: "0", endTick: "1", bucketCount: 1 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureEventWindow({ packageDir, eventId: "write", variables: ["counter"], beforeMs: 60001, afterMs: 0, bucketCount: 1 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureList(root, { limit: 101 }), JcapBoundsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
