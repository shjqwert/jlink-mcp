import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  JcapBoundsError,
  JcapCaptureAmbiguousError,
  JcapV1QueryService,
  JcapV1Writer,
  appendJcapV1Sample,
  createJcapV1Metadata,
  finalizeJcapV1Capture,
  finalizeJcapV1Metadata,
  jcapCaptureEventWindow,
  jcapCaptureExportCsv,
  jcapCaptureSeries,
  jcapCaptureSummary,
  readJcapV1Metadata,
  readJcapV1Raw,
  rebuildJcapV1Index,
  verifyJcapV1Index,
  writeJcapV1Raw,
  type JcapV1Event,
  type JcapV1Metadata,
  type JcapV1Sample,
} from "./jcap-v1";

const captureId = "41000000-0000-4000-8000-000000000001";
const eventId = (value: number) => `42000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const samples: JcapV1Sample[] = [
  { sampleIndex: 0, tick: "10", statusFlags: 1, values: { counter: 1, feedback: 4 } },
  { sampleIndex: 1, tick: "20", statusFlags: 1, values: { counter: 2, feedback: 5 } },
  { sampleIndex: 2, tick: "30", statusFlags: 1, values: { counter: 3, feedback: 6 } },
];

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jcap-v1-"));
}

function metadata(id = captureId, state: JcapV1Metadata["state"] = "active", durationSec = 1, requestedRateHz = 3): JcapV1Metadata {
  const value = createJcapV1Metadata({
    captureId: id,
    backend: "fake-jlink-hss",
    requestedRateHz,
    durationSec,
    variables: [
      { logicalIdentity: "counter", type: "uint32", address: "0x20000000", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "b".repeat(64) },
      { logicalIdentity: "feedback", type: "uint32", address: "0x20000004", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "c".repeat(64) },
    ],
    provenance: {
      captureId: id,
      backend: "fake-jlink-hss",
      runtime: { helperProtocolVersion: 1 },
      target: { projectRoot: "C:\\fixture-project", generation: "43000000-0000-4000-8000-000000000001", device: "FIXTURE", probeSerial: "123456789", interface: "SWD", speed: 4000 },
      script: { mode: "none" },
      artifact: { path: "C:\\fixture-project\\firmware.elf", generation: "a".repeat(64), sha256: "e".repeat(64) },
    },
  });
  return { ...value, state };
}

function fullShapeMetadata(id = captureId): JcapV1Metadata {
  return createJcapV1Metadata({
    captureId: id,
    backend: "fake-jlink-hss",
    requestedRateHz: 1_000,
    durationSec: 60,
    variables: Array.from({ length: 10 }, (_, index) => ({
      logicalIdentity: `var${index}`,
      type: "uint32" as const,
      address: `0x${(0x20000000 + index * 4).toString(16)}`,
      size: 4,
      artifactGeneration: "a".repeat(64),
      layoutHash: createHash("sha256").update(`var${index}`).digest("hex"),
    })),
    provenance: {
      captureId: id,
      backend: "fake-jlink-hss",
      runtime: { helperProtocolVersion: 1, fixture: "full-shape-60000x10" },
      target: { projectRoot: "C:\\fixture-project", generation: "43000000-0000-4000-8000-000000000001", device: "FIXTURE", probeSerial: "123456789", interface: "SWD", speed: 4000 },
      script: { mode: "none" },
      artifact: { path: "C:\\fixture-project\\firmware.elf", generation: "a".repeat(64), sha256: "e".repeat(64) },
    },
  });
}

function rawHashes(packageDir: string): Record<string, string> {
  return Object.fromEntries(["samples.bin", "events.bin"].map((name) => {
    const bytes = readFileSync(path.join(packageDir, "raw", name));
    return [name, createHash("sha256").update(bytes).digest("hex")];
  }));
}

function stableSummary(value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value);
  if (copy.metadata && typeof copy.metadata === "object" && !Array.isArray(copy.metadata)) delete (copy.metadata as Record<string, unknown>).updatedAt;
  return copy;
}

test("JCAP v1 finalizes exactly four durable files and round-trips bounded queries and rebuild", async () => {
  const root = workspace();
  const capturesDir = path.join(root, "captures");
  const packageDir = path.join(capturesDir, `${captureId}.jcap`);
  try {
    const writer = new JcapV1Writer({ packageDir, metadata: metadata() });
    writer.appendEvent({ eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
    for (const sample of samples) assert.equal(writer.appendSample(sample), true);
    writer.appendEvent({
      eventId: eventId(2), eventSequence: 1, type: "variable_write", tick: "20",
      logicalIdentity: "counter", selector: "counter",
      descriptor: { logicalIdentity: "counter", type: "uint32", address: "0x20000000", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "b".repeat(64) },
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.001Z",
      operationStartTick: "14", operationEndTick: "20", timingSource: "helper_qpc",
      writeAttempted: true, writeIssued: true, stateUnknown: false,
      old: { state: "not_requested", value: null, bytesHex: null },
      requested: { value: 9, bytesHex: "09000000" },
      readback: { state: "not_requested", value: null, bytesHex: null },
      restore: { state: "not_requested", attempted: false, writeIssued: false, stateUnknown: false, readback: null, readbackHex: null },
      verification: { state: "executed_unverified" },
      sampleAlignment: { method: "terminal_raw_nearest", status: "derive_on_rebuild" },
      outcome: "completed", error: null,
    });
    writer.appendEvent({
      eventId: eventId(3), eventSequence: 2, type: "quality", tick: "30", qualityStatus: "reported", qualitySource: "jlink",
      missingSamples: 0, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0,
      durationValidated: true, qualityEvidence: { source: "fixture" },
    });
    const built = await finalizeJcapV1Capture({
      writer,
      finalizingEvent: { eventId: eventId(4), eventSequence: 3, type: "lifecycle", tick: "30", state: "finalizing" },
      terminalEvent: { eventId: eventId(5), eventSequence: 4, type: "lifecycle", tick: "31", state: "completed" },
      interruptedEvent: { eventId: eventId(6), eventSequence: 4, type: "lifecycle", tick: "31", state: "interrupted" },
      quality: { missingSamples: 0, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 },
      qualityStatus: "reported",
    });
    assert.deepEqual({ captureState: built.captureState, indexStatus: built.indexStatus }, { captureState: "completed", indexStatus: "ready" });
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
    assert.deepEqual(readdirSync(path.join(packageDir, "raw")).sort(), ["events.bin", "samples.bin"]);
    const capture = readJcapV1Metadata(packageDir);
    assert.equal(capture.formatVersion, 1);
    assert.equal(capture.raw.samples.sha256?.length, 64);
    assert.equal(capture.raw.events.sha256?.length, 64);
    assert.equal(capture.sampleCount, 3);
    assert.throws(() => appendJcapV1Sample(packageDir, { sampleIndex: 3, tick: "40", statusFlags: 1, values: { counter: 4, feedback: 7 } }), (error: unknown) => (error as { code?: string }).code === "JCAP_CAPTURE_NOT_ACTIVE");
    const beforeHashes = rawHashes(packageDir);

    const summaryBefore = await jcapCaptureSummary(packageDir);
    assert.equal(summaryBefore.sampleCount, 3);
    const seriesBefore = await jcapCaptureSeries({ packageDir, variables: ["counter", "feedback"], startTick: "10", endTick: "30", bucketCount: 2 });
    assert.ok((seriesBefore.series as Array<Record<string, unknown>>).every((bucket) => ["min", "max", "average", "last", "count"].every((key) => key in bucket)));
    const windowBefore = await jcapCaptureEventWindow({ packageDir, eventId: eventId(2), variables: ["counter"], beforeMs: 0, afterMs: 0, bucketCount: 1 });
    const indexedWrite = windowBefore.event as Record<string, unknown>;
    assert.equal(indexedWrite.operationStartTick, "14");
    assert.deepEqual(indexedWrite.sampleAlignment, { method: "terminal_raw_nearest", status: "resolved" });
    assert.deepEqual(indexedWrite.neighbors, { before: { sampleIndex: 0, tick: "10" }, after: { sampleIndex: 1, tick: "20" } });

    const query = new JcapV1QueryService(root);
    unlinkSync(path.join(packageDir, "capture.db"));
    assert.equal((await query.summary({ captureId })).indexRebuilt, true);
    assert.deepEqual(rawHashes(packageDir), beforeHashes);
    assert.deepEqual(await jcapCaptureSeries({ packageDir, variables: ["counter", "feedback"], startTick: "10", endTick: "30", bucketCount: 2 }), seriesBefore);
    assert.deepEqual(await jcapCaptureEventWindow({ packageDir, eventId: eventId(2), variables: ["counter"], beforeMs: 0, afterMs: 0, bucketCount: 1 }), windowBefore);

    writeFileSync(path.join(packageDir, "capture.db"), "not a sqlite database");
    assert.equal((await query.series({ captureId, variables: ["counter"], startTick: "10", endTick: "30", bucketCount: 2 })).indexRebuilt, true);

    const exported = await jcapCaptureExportCsv(packageDir, path.join(root, "exports"));
    assert.equal(exported.rows, 6);
    assert.equal(path.dirname(exported.exportFile), path.join(root, "exports"));
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
    const listed = await query.list();
    assert.equal((listed.captures as Array<Record<string, unknown>>)[0].captureId, captureId);
    await assert.rejects(() => query.series({ captureId, variables: Array.from({ length: 33 }, (_, index) => `v${index}`), startTick: "0", endTick: "1", bucketCount: 1 }), JcapBoundsError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 rejects sample variables that do not match immutable descriptor order", () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  const writer = new JcapV1Writer({ packageDir, metadata: metadata() });
  try {
    writer.appendEvent({ eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
    assert.throws(() => writer.appendSample({ sampleIndex: 0, tick: "1", statusFlags: 1, values: { feedback: 1, counter: 2 } }), /descriptor order/);
  } finally {
    writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 recovery indexes a valid prefix without changing a truncated Raw tail", async () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  const events: JcapV1Event[] = [
    { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
    { eventId: eventId(2), eventSequence: 1, type: "quality", tick: "30", qualityStatus: "partial", qualitySource: "target_counter", missingSamples: 1, droppedSamples: null, overflows: null, readErrors: null, timeouts: null, durationValidated: null, qualityEvidence: { source: "fixture" } },
    { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "31", state: "interrupted" },
  ];
  try {
    writeJcapV1Raw({ packageDir, metadata: metadata(), samples, events });
    appendFileSync(path.join(packageDir, "raw", "samples.bin"), Buffer.from('{"formatVersion":1'));
    finalizeJcapV1Metadata(packageDir, "interrupted", { missingSamples: 1 }, "partial", "target_counter");
    const before = rawHashes(packageDir);
    const rebuilt = await rebuildJcapV1Index(packageDir);
    assert.equal(rebuilt.captureState, "interrupted");
    assert.equal(rebuilt.indexStatus, "ready");
    assert.equal(rebuilt.diagnostics[0].reason, "truncated_tail");
    assert.deepEqual(rawHashes(packageDir), before);
    assert.deepEqual(await verifyJcapV1Index(packageDir), { captureState: "interrupted", indexStatus: "ready" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 rebuild failure preserves an existing valid DB and rejects v0 metadata", async () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(),
      samples,
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "lifecycle", tick: "30", state: "finalizing" },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "31", state: "stopped" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "stopped");
    await rebuildJcapV1Index(packageDir);
    const databaseBefore = readFileSync(path.join(packageDir, "capture.db"));
    const samplesFile = path.join(packageDir, "raw", "samples.bin");
    const damaged = readFileSync(samplesFile);
    damaged[damaged.indexOf(0x0a) + 2] ^= 1;
    writeFileSync(samplesFile, damaged);
    await assert.rejects(() => rebuildJcapV1Index(packageDir), /identity|integrity|corrupt/i);
    assert.deepEqual(readFileSync(path.join(packageDir, "capture.db")), databaseBefore);
    assert.equal(existsSync(path.join(packageDir, "capture.db.tmp")), false);

    const oldDir = path.join(root, "captures", "43000000-0000-4000-8000-000000000001.jcap");
    mkdirSync(path.join(oldDir, "raw"), { recursive: true });
    writeFileSync(path.join(oldDir, "capture.json"), JSON.stringify({ formatVersion: 0 }));
    assert.throws(() => readJcapV1Metadata(oldDir), (error: unknown) => (error as { code?: string }).code === "JCAP_VERSION_UNSUPPORTED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 capture lookup rejects duplicate IDs across normal and run-scoped roots", async () => {
  const root = workspace();
  try {
    for (const capturesDir of [path.join(root, "captures"), path.join(root, "run-1", "captures")]) {
      const packageDir = path.join(capturesDir, `${captureId}.jcap`);
      writeJcapV1Raw({
        packageDir,
        metadata: metadata(),
        samples,
        events: [
          { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
          { eventId: eventId(2), eventSequence: 1, type: "lifecycle", tick: "30", state: "finalizing" },
          { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "31", state: "stopped" },
        ],
      });
      finalizeJcapV1Metadata(packageDir, "stopped");
    }
    await assert.rejects(() => new JcapV1QueryService(root).list(), JcapCaptureAmbiguousError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 metadata enforces the 60 second capture bound and exports into the owning run", async () => {
  const root = workspace();
  const packageDir = path.join(root, "run-1", "captures", `${captureId}.jcap`);
  try {
    assert.throws(() => metadata(captureId, "active", 61), /HSS bounds are invalid/);
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(captureId, "active", 60),
      samples,
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "lifecycle", tick: "30", state: "finalizing" },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "31", state: "stopped" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "stopped");
    await rebuildJcapV1Index(packageDir);
    assert.equal(readJcapV1Metadata(packageDir).durationSec, 60);
    const exported = await new JcapV1QueryService(root).exportCsv({ captureId });
    assert.equal(path.dirname(String(exported.exportFile)), path.join(root, "run-1", "exports"));
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 rejects a completed capture below the 95 percent planned sample threshold", async () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  const quality = { missingSamples: 59_997, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 };
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(captureId, "active", 60, 1_000),
      samples,
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "quality", tick: "30", qualityStatus: "reported", qualitySource: "jlink", ...quality, durationValidated: true, qualityEvidence: { source: "fixture" } },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "30", state: "finalizing" },
        { eventId: eventId(4), eventSequence: 3, type: "lifecycle", tick: "31", state: "completed" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "completed", quality, "reported");
    await assert.rejects(
      () => rebuildJcapV1Index(packageDir),
      (error: unknown) => (error as { code?: string }).code === "JCAP_SAMPLE_BUDGET_SHORT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 full ceiling shape round-trips 60,000 synchronized ten-variable frames through Raw, DB, bounded queries, and rebuild", { timeout: 300_000 }, async () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  const writer = new JcapV1Writer({ packageDir, metadata: fullShapeMetadata() });
  const variableNames = Array.from({ length: 10 }, (_, index) => `var${index}`);
  const quality = { missingSamples: 0, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 };
  let finalized = false;
  try {
    writer.appendEvent({ eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
    for (let sampleIndex = 0; sampleIndex < 60_000; sampleIndex += 1) {
      const values: Record<string, number> = {};
      for (let variableIndex = 0; variableIndex < variableNames.length; variableIndex += 1) values[variableNames[variableIndex]] = sampleIndex + variableIndex;
      assert.equal(writer.appendSample({
        sampleIndex,
        tick: (BigInt(sampleIndex) * 1_000_000n).toString(),
        statusFlags: 1,
        values,
      }), true);
    }
    writer.appendEvent({
      eventId: eventId(2), eventSequence: 1, type: "quality", tick: "60000000000", qualityStatus: "reported", qualitySource: "jlink",
      ...quality, durationValidated: true, qualityEvidence: { source: "full-shape-fixture", expectedFrames: 60_000 },
    });
    const built = await finalizeJcapV1Capture({
      writer,
      finalizingEvent: { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "60000000000", state: "finalizing" },
      terminalEvent: { eventId: eventId(4), eventSequence: 3, type: "lifecycle", tick: "60000000001", state: "completed" },
      interruptedEvent: { eventId: eventId(5), eventSequence: 3, type: "lifecycle", tick: "60000000001", state: "interrupted" },
      quality,
      qualityStatus: "reported",
    });
    finalized = true;
    assert.deepEqual({ captureState: built.captureState, indexStatus: built.indexStatus }, { captureState: "completed", indexStatus: "ready" });
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
    assert.equal(readJcapV1Metadata(packageDir).sampleCount, 60_000);
    const beforeHashes = rawHashes(packageDir);
    const summaryBefore = await jcapCaptureSummary(packageDir);
    const seriesBefore = await jcapCaptureSeries({ packageDir, variables: variableNames, startTick: "0", endTick: "59999000000", bucketCount: 64 });
    const windowBefore = await jcapCaptureEventWindow({ packageDir, eventId: eventId(2), variables: ["var0"], beforeMs: 1, afterMs: 0, bucketCount: 1 });
    assert.equal(summaryBefore.sampleCount, 60_000);
    assert.equal((seriesBefore.series as Array<Record<string, unknown>>).length, 640);

    unlinkSync(path.join(packageDir, "capture.db"));
    await rebuildJcapV1Index(packageDir);
    assert.deepEqual(rawHashes(packageDir), beforeHashes);
    assert.deepEqual(stableSummary(await jcapCaptureSummary(packageDir)), stableSummary(summaryBefore));
    assert.deepEqual(await jcapCaptureSeries({ packageDir, variables: variableNames, startTick: "0", endTick: "59999000000", bucketCount: 64 }), seriesBefore);
    assert.deepEqual(await jcapCaptureEventWindow({ packageDir, eventId: eventId(2), variables: ["var0"], beforeMs: 1, afterMs: 0, bucketCount: 1 }), windowBefore);
  } finally {
    if (!finalized) writer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
