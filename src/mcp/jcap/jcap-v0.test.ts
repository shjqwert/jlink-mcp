import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JCAP_V0_GOLDEN, JCAP_V0_PRESTART_FAILURE } from "./golden-corpus";
import {
  JcapBoundsError,
  JcapV0Writer,
  finalizeJcapV0Capture,
  jcapCaptureEventWindow,
  jcapCaptureExportCsv,
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

function nativeFrame(kind: string, payloadText: string, override: Record<string, unknown> = {}): Buffer {
  const payload = Buffer.from(payloadText, "utf8");
  const header = {
    formatVersion: 0,
    status: "experimental",
    kind,
    payloadEncoding: "json",
    payloadBytes: payload.length,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
    ...override,
  };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), payload, Buffer.from("\n")]);
}

const writeEventId = JCAP_V0_GOLDEN.events.find((event) => event.type === "variable_write")!.eventId;
const resetEventId = JCAP_V0_GOLDEN.events.find((event) => event.type === "target_control")!.eventId;

test("JCAP v0 accepts native exact UTF-8 payload bytes without reserializing for hash validation", async () => {
  const root = workspace();
  const packageDir = path.join(root, "native.jcap");
  try {
    const rawDir = path.join(packageDir, "raw");
    mkdirSync(rawDir, { recursive: true });
    const sampleText = JSON.stringify(JCAP_V0_GOLDEN.samples[0], null, 2);
    writeFileSync(path.join(rawDir, "samples.bin"), nativeFrame("sample", sampleText));
    writeFileSync(path.join(rawDir, "events.bin"), Buffer.concat([
      nativeFrame("provenance", JSON.stringify(JCAP_V0_GOLDEN.provenance)),
      ...JCAP_V0_GOLDEN.events.map((event) => nativeFrame("event", JSON.stringify(event, null, 2))),
    ]));
    const parsed = readJcapV0Raw(packageDir);
    assert.equal(parsed.samples.length, 1);
    assert.deepEqual(parsed.samples[0], JCAP_V0_GOLDEN.samples[0]);
    assert.deepEqual(parsed.diagnostics, []);
    assert.ok(readFileSync(path.join(rawDir, "samples.bin")).includes(Buffer.from(sampleText)));
    assert.deepEqual((await jcapCaptureList(root)).captures, [{ name: "native.jcap", captureState: "completed", indexStatus: "rebuild_required" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v0 persists Artifact match provenance without packaging external session files", async () => {
  const root = workspace();
  const packageDir = path.join(root, "artifact-match.jcap");
  try {
    const captureId = "31000000-0000-4000-8000-000000000000";
    const id = (suffix: number) => `31000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
    writeJcapV0Raw({
      packageDir,
      provenance: { ...JCAP_V0_GOLDEN.provenance, captureId, artifact: { generation: "a".repeat(64) }, variables: [{ qualifiedName: "g_counter", layoutHash: "b".repeat(64) }], artifactMatch: { targetArtifactMatch: "unverified", status: "pending" } },
      samples: [],
      events: [
        { eventId: id(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "planned" },
        { eventId: id(2), eventSequence: 1, type: "artifact_match", tick: "0", targetArtifactMatch: "unverified", captureId, helperPid: 42, connectOrdinal: 1 },
        { eventId: id(3), eventSequence: 2, type: "lifecycle", tick: "1", state: "active" },
        { eventId: id(4), eventSequence: 3, type: "lifecycle", tick: "2", state: "finalizing" },
        { eventId: id(5), eventSequence: 4, type: "lifecycle", tick: "3", state: "completed" },
      ],
    });
    await rebuildJcapV0Index(packageDir);
    const summary = await jcapCaptureSummary(packageDir);
    const provenance = summary.provenance as { artifactMatch: { targetArtifactMatch: string; helperPid: number }; warnings: string[] };
    assert.equal(provenance.artifactMatch.targetArtifactMatch, "unverified");
    assert.equal(provenance.artifactMatch.helperPid, 42);
    assert.match(provenance.warnings[0], /unverified/);
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "raw"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v0 single writer enforces sequence, budget, one journal pair, and close ordering", async () => {
  const root = workspace();
  const packageDir = path.join(root, "writer.jcap");
  try {
    const writer = new JcapV0Writer({ packageDir, provenance: JCAP_V0_GOLDEN.provenance, maxSamplesBytes: 1 });
    assert.throws(() => writer.closeEvents(), /close samples/);
    assert.throws(() => writer.appendSample({ ...JCAP_V0_GOLDEN.samples[0], values: { counter: Number.NaN } }), /invalid/);
    assert.throws(() => writer.appendSample({ ...JCAP_V0_GOLDEN.samples[0], sampleIndex: Number.MAX_SAFE_INTEGER + 1 }), /invalid/);
    assert.equal(writer.appendSample(JCAP_V0_GOLDEN.samples[0]), false);
    writer.appendEvent(JCAP_V0_GOLDEN.events[0]);
    assert.throws(() => writer.appendEvent({ ...JCAP_V0_GOLDEN.events[1], eventSequence: 0 }), /event sequence/);
    await assert.rejects(() => rebuildJcapV0Index(packageDir), /close the JCAP raw writer/);
    writer.closeSamples();
    assert.throws(() => writer.appendSample(JCAP_V0_GOLDEN.samples[0]), /closed/);
    writer.appendEvent({ ...JCAP_V0_PRESTART_FAILURE.events[2], eventSequence: 1 });
    writer.closeEvents();
    assert.deepEqual(readdirSync(path.join(packageDir, "raw")).sort(), ["events.bin", "samples.bin"]);
    assert.equal(readJcapV0Raw(packageDir).samples.length, 0);
    assert.throws(() => new JcapV0Writer({ packageDir, provenance: JCAP_V0_GOLDEN.provenance }), /already contains/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v0 finalization closes samples, validates finalizing raw, appends terminal, then publishes the index", async () => {
  const root = workspace();
  const packageDir = path.join(root, "finalize.jcap");
  try {
    const writer = new JcapV0Writer({ packageDir, provenance: JCAP_V0_GOLDEN.provenance });
    for (const event of JCAP_V0_GOLDEN.events.slice(0, 4)) writer.appendEvent(event);
    for (const sample of JCAP_V0_GOLDEN.samples) assert.equal(writer.appendSample(sample), true);
    const result = await finalizeJcapV0Capture({
      writer,
      finalizingEvent: JCAP_V0_GOLDEN.events[4],
      terminalEvent: JCAP_V0_GOLDEN.events[5],
      recoverableEvent: { eventId: "10000000-0000-4000-8000-000000000007", eventSequence: 5, type: "lifecycle", tick: "32000000", state: "recoverable" },
    });
    assert.equal(result.captureState, "completed");
    assert.equal(result.indexStatus, "ready");
    assert.equal(readJcapV0Raw(packageDir).events.at(-1)?.state, "completed");
    assert.deepEqual(await verifyJcapV0Index(packageDir), { captureState: "completed", indexStatus: "ready" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.equal(summary.startTick, "10000000");
    assert.equal(summary.endTick, "30000000");
    assert.equal((summary.provenance as typeof JCAP_V0_GOLDEN.provenance).script.sha256, JCAP_V0_GOLDEN.provenance.script.sha256);
    assert.deepEqual((summary.provenance as typeof JCAP_V0_GOLDEN.provenance).reset, JCAP_V0_GOLDEN.provenance.reset);

    const series = await jcapCaptureSeries({ packageDir, variables: ["counter", "feedback"], startTick: "10000000", endTick: "30000000", bucketCount: 2 });
    assert.equal(series.indexStatus, "ready");
    assert.ok((series.series as Array<Record<string, unknown>>).every((bucket) => "bucketStartTick" in bucket && "bucketEndTick" in bucket && "min" in bucket && "max" in bucket));
    const window = await jcapCaptureEventWindow({ packageDir, eventId: writeEventId, variables: ["counter"], beforeMs: 20, afterMs: 20, bucketCount: 2 });
    assert.equal(window.captureState, "completed");
    assert.equal(window.indexStatus, "ready");
    assert.equal((window.event as Record<string, unknown>).eventId, writeEventId);
    assert.ok((window.relatedEvents as unknown[]).length > 0);
    const resetWindow = await jcapCaptureEventWindow({ packageDir, eventId: resetEventId, variables: [], beforeMs: 0, afterMs: 20, bucketCount: 1 });
    assert.equal((resetWindow.nearestSample as Record<string, unknown>).sample_index, 0);
    assert.deepEqual((await jcapCaptureList(root)).captures, [{ name: "golden.jcap", captureState: "completed", indexStatus: "ready" }]);

    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "raw"]);
    assert.deepEqual(readdirSync(path.join(packageDir, "raw")).sort(), ["events.bin", "samples.bin"]);
    const exported = await jcapCaptureExportCsv(packageDir);
    assert.equal(exported.rows, 6);
    assert.equal(existsSync(exported.exportFile), true);
    const exportedBytes = readFileSync(exported.exportFile);
    assert.equal(exportedBytes.toString("utf8").split("\r\n").filter(Boolean).length, 7);
    await assert.rejects(() => jcapCaptureExportCsv(packageDir), /EEXIST/);
    assert.deepEqual(readFileSync(exported.exportFile), exportedBytes);

    await rebuildJcapV0Index(packageDir);
    assert.deepEqual(rawBytes(packageDir), before);
    assert.deepEqual(await jcapCaptureSummary(packageDir), summary);
    assert.deepEqual(await jcapCaptureSeries({ packageDir, variables: ["counter", "feedback"], startTick: "10000000", endTick: "30000000", bucketCount: 2 }), series);
    assert.equal(existsSync(path.join(packageDir, "capture.db.tmp")), false);
    unlinkSync(path.join(packageDir, "capture.db"));
    assert.deepEqual(await verifyJcapV0Index(packageDir), { captureState: "completed", indexStatus: "rebuild_required" });
    assert.deepEqual((await jcapCaptureList(root)).captures, [{ name: "golden.jcap", captureState: "completed", indexStatus: "rebuild_required" }]);
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
    await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: ["counter"], startTick: "0", endTick: "1", bucketCount: 1 }), /not queryable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v0 derives recoverable from an active crash suffix without mutating raw", async () => {
  const root = workspace();
  const packageDir = path.join(root, "recoverable.jcap");
  const events = [
    { eventId: "30000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle" as const, tick: "0", state: "planned" },
    { eventId: "30000000-0000-4000-8000-000000000002", eventSequence: 1, type: "lifecycle" as const, tick: "1", state: "active" },
  ];
  try {
    writeJcapV0Raw({ packageDir, provenance: { ...JCAP_V0_GOLDEN.provenance, captureId: "30000000-0000-4000-8000-000000000000" }, samples: [], events });
    appendFileSync(path.join(packageDir, "raw", "samples.bin"), "crash-tail");
    const before = rawBytes(packageDir);
    const rebuilt = await rebuildJcapV0Index(packageDir);
    assert.equal(rebuilt.captureState, "recoverable");
    assert.equal(rebuilt.indexStatus, "failed");
    assert.deepEqual(rawBytes(packageDir), before);
    assert.equal((await jcapCaptureSummary(packageDir)).captureState, "recoverable");
    await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: ["counter"], startTick: "0", endTick: "2", bucketCount: 1 }), /not queryable/);
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
      await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: ["counter"], startTick: "0", endTick: "40000000", bucketCount: 10 }), /not queryable/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, override] of [
  ["version", { formatVersion: 1 }],
  ["kind", { kind: "event" }],
  ["encoding", { payloadEncoding: "cbor" }],
] as const) {
  test(`JCAP v0 rejects an unknown frame ${name} as a corrupt suffix`, () => {
    const root = workspace();
    const packageDir = path.join(root, `${name}.jcap`);
    try {
      writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
      appendFileSync(path.join(packageDir, "raw", "samples.bin"), nativeFrame("sample", JSON.stringify({ sampleIndex: 3, tick: "40000000", statusFlags: 0, values: { counter: 13 } }), override));
      const raw = readJcapV0Raw(packageDir);
      assert.equal(raw.samples.length, 3);
      assert.equal(raw.diagnostics[0].reason, "corrupt_suffix");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("JCAP v0 detects a stale source hash and withholds stale indexed data", async () => {
  const root = workspace();
  const packageDir = path.join(root, "stale.jcap");
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    await rebuildJcapV0Index(packageDir);
    appendFileSync(path.join(packageDir, "raw", "samples.bin"), "partial");
    assert.deepEqual(await verifyJcapV0Index(packageDir), { captureState: "completed", indexStatus: "rebuild_required" });
    assert.deepEqual(await jcapCaptureSummary(packageDir), { captureState: "completed", indexStatus: "rebuild_required" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v0 treats a corrupt SQLite index as rebuildable without changing raw", async () => {
  const root = workspace();
  const packageDir = path.join(root, "bad-index.jcap");
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    await rebuildJcapV0Index(packageDir);
    const before = rawBytes(packageDir);
    writeFileSync(path.join(packageDir, "capture.db"), "not sqlite");
    assert.deepEqual(await verifyJcapV0Index(packageDir), { captureState: "completed", indexStatus: "rebuild_required" });
    await rebuildJcapV0Index(packageDir);
    assert.deepEqual(rawBytes(packageDir), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v0 query bounds reject instead of clamping", async () => {
  const root = workspace();
  const packageDir = path.join(root, "bounds.jcap");
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    await rebuildJcapV0Index(packageDir);
    const narrow = await jcapCaptureSeries({ packageDir, variables: ["counter"], startTick: "10000000", endTick: "10000000", bucketCount: 4096 });
    assert.deepEqual((narrow.series as Array<Record<string, unknown>>).map(({ bucketStartTick, bucketEndTick }) => ({ bucketStartTick, bucketEndTick })), [{ bucketStartTick: "10000000", bucketEndTick: "10000000" }]);
    await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: Array.from({ length: 33 }, (_, index) => `v${index}`), startTick: "0", endTick: "1", bucketCount: 1 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: Array.from({ length: 32 }, (_, index) => `v${index}`), startTick: "0", endTick: "1", bucketCount: 4096 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureSeries({ packageDir, variables: ["counter"], startTick: "0", endTick: "18446744073709551616", bucketCount: 1 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureEventWindow({ packageDir, eventId: writeEventId, variables: ["counter"], beforeMs: 60001, afterMs: 0, bucketCount: 1 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureEventWindow({ packageDir, eventId: "not-a-uuid", variables: [], beforeMs: 0, afterMs: 0, bucketCount: 1 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureList(root, { limit: 101 }), JcapBoundsError);
    await assert.rejects(() => jcapCaptureList(root, { cursor: "😀".repeat(300) }), JcapBoundsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
