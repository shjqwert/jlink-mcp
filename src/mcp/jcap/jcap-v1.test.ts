import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import {
  JcapV1Writer,
  appendJcapV1Sample,
  createJcapV1Metadata,
  finalizeJcapV1Capture,
  finalizeJcapV1Metadata,
  finalizeJcapV2FromV1Package,
  inspectCapturePackage,
  jcapCaptureEventWindow,
  jcapCaptureExportCsv,
  jcapCaptureSeries,
  jcapCaptureSummary,
  jcapV2CaptureEventWindow,
  jcapV2CaptureSeries,
  jcapV2CaptureSummary,
  readJcapV1Metadata,
  readJcapV1Raw,
  rebuildJcapV1Index,
  verifyJcapV1Index,
  verifyJcapV2,
  writeJcapV1Raw,
  type JcapV1Event,
  type JcapV1Metadata,
  type JcapV1Sample,
} from "./jcap-v1";
import { CaptureQueryOperations } from "../runtime/capture-query-operations";
import type { OperationEnvelope } from "../runtime/operation-envelope";

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

function dataOf(envelope: OperationEnvelope): Record<string, unknown> {
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  return envelope.data as Record<string, unknown>;
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

function nativeMetadata(id: string, requestedRateHz: number): JcapV1Metadata {
  const base = metadata(id, "active", 60, requestedRateHz);
  return {
    ...base,
    backend: "jlink-hss",
    provenance: {
      ...base.provenance,
      backend: "jlink-hss",
      runtime: { ...base.provenance.runtime, helperProtocolVersion: 3, helperSha256: "d".repeat(64), runtimeSha256: "f".repeat(64) },
    },
  };
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

test("JCAP v2 finalizes one SQLite file and supports bounded aligned queries", async () => {
  const root = workspace();
  const id = "44000000-0000-4000-8000-000000000001";
  const workingDir = path.join(root, "work", `${id}.jcap`);
  const captureFile = path.join(root, "captures", `${id}.jcap`);
  const captureEventId = eventId(50);
  const writer = new JcapV1Writer({
    packageDir: workingDir,
    metadata: metadata(id, "active", 1, 300),
  });
  try {
    writer.appendEvent({ eventId: eventId(49), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
    for (let sampleIndex = 0; sampleIndex < 300; sampleIndex += 1) {
      assert.equal(writer.appendSample({
        sampleIndex,
        tick: String(sampleIndex * 1_000_000),
        statusFlags: 1,
        values: { counter: sampleIndex, feedback: sampleIndex + 1_000 },
      }), true);
    }
    writer.appendEvent({ eventId: captureEventId, eventSequence: 1, type: "lifecycle", tick: "150000000", state: "finalizing" });
    writer.appendEvent({
      eventId: eventId(51),
      eventSequence: 2,
      type: "quality",
      tick: "299000000",
      qualityStatus: "reported",
      qualitySource: "jlink",
      missingSamples: 3,
      droppedSamples: 0,
      overflows: 0,
      readErrors: 0,
      timeouts: 0,
      durationValidated: true,
      qualityEvidence: { source: "fixture" },
    });
    writer.appendEvent({ eventId: eventId(52), eventSequence: 3, type: "lifecycle", tick: "299000000", state: "completed" });
    writer.close();
    finalizeJcapV1Metadata(
      workingDir,
      "completed",
      { missingSamples: 3, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 },
      "reported",
    );

    const finalized = await finalizeJcapV2FromV1Package({
      packageDir: workingDir,
      captureFile,
      backend: "hss",
      intrusive: false,
      requestedRateHz: 300,
      actualRateHz: 300,
      pauseTotalUs: 0,
    });
    assert.deepEqual(
      { sampleCount: finalized.sampleCount, eventCount: finalized.eventCount, state: finalized.state },
      { sampleCount: 300, eventCount: 4, state: "completed" },
    );
    assert.equal((await verifyJcapV2(captureFile)).chunkCount > 0, true);
    assert.deepEqual(readdirSync(path.dirname(captureFile)).sort(), [`${id}.jcap`]);
    assert.equal(existsSync(`${captureFile}-wal`), false);
    assert.equal(existsSync(`${captureFile}-shm`), false);

    const summary = await jcapV2CaptureSummary(captureFile);
    assert.equal(summary.captureId, id);
    assert.equal(summary.sampleCount, 300);
    assert.deepEqual((summary.variables as Array<Record<string, unknown>>).map((variable) => variable.name), ["counter", "feedback"]);

    const raw = await jcapV2CaptureSeries({
      captureFile,
      captureId: id,
      variables: ["counter", "feedback"],
      timeRange: { startMs: 100, endMs: 110 },
      resolution: { mode: "raw" },
      statistics: ["last"],
    });
    assert.deepEqual((raw.time as Record<string, unknown>).start, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    assert.deepEqual((raw.variables as Array<Record<string, unknown>>)[0]!.last, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    assert.equal((raw.quality as Record<string, unknown>).missing, 3);

    const interval = await jcapV2CaptureSeries({
      captureFile,
      captureId: id,
      variables: ["counter"],
      timeRange: { startMs: 0, endMs: 100 },
      resolution: { mode: "interval", intervalMs: 10 },
      statistics: ["last", "min", "max"],
    });
    assert.deepEqual((interval.variables as Array<Record<string, unknown>>)[0]!.last, [9, 19, 29, 39, 49, 59, 69, 79, 89, 99]);
    assert.deepEqual((interval.variables as Array<Record<string, unknown>>)[0]!.min, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);

    const points = await jcapV2CaptureSeries({
      captureFile,
      captureId: id,
      variables: ["counter"],
      timeRange: { startMs: 0, endMs: 100 },
      resolution: { mode: "points", maxPoints: 5 },
      statistics: ["max"],
    });
    assert.equal((points.time as Record<string, unknown>).start instanceof Array, true);
    assert.equal(((points.time as Record<string, unknown>).start as unknown[]).length, 5);

    const missing = await jcapV2CaptureSeries({
      captureFile,
      captureId: id,
      variables: ["counter", "feedback"],
      timeRange: { startMs: 300, endMs: 320 },
      resolution: { mode: "interval", intervalMs: 10 },
      statistics: ["last", "min", "max"],
    });
    assert.deepEqual((missing.variables as Array<Record<string, unknown>>)[0]!.last, [null, null]);
    assert.equal((missing.quality as Record<string, unknown>).missing, 7);

    let cursor: string | undefined;
    let returnedPoints = 0;
    do {
      const page = await jcapV2CaptureSeries({
        captureFile,
        captureId: id,
        variables: ["counter", "feedback"],
        timeRange: { startMs: 0, endMs: 300 },
        resolution: { mode: "raw" },
        statistics: ["last", "min", "max"],
        maxBytes: 1_024,
        cursor,
      });
      assert.equal(Buffer.byteLength(JSON.stringify(page), "utf8") <= 1_024, true);
      returnedPoints += ((page.time as Record<string, unknown>).start as unknown[]).length;
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor);
    assert.equal(returnedPoints, 300);

    const eventWindow = await jcapV2CaptureEventWindow({
      captureFile,
      captureId: id,
      eventId: captureEventId,
      variables: ["counter"],
      beforeMs: 5,
      afterMs: 5,
      resolution: { mode: "raw" },
      statistics: ["last"],
    });
    assert.equal((eventWindow.event as Record<string, unknown>).eventId, captureEventId);

    await assert.rejects(() => jcapV2CaptureSeries({
      captureFile,
      captureId: id,
      variables: ["counter"],
      timeRange: { startMs: 0, endMs: 10 },
      startTick: "0",
      endTick: "10",
      bucketCount: 1,
    }), /conflicts/);
  } finally {
    writer.close();
    if (existsSync(captureFile)) chmodSync(captureFile, 0o666);
    rmSync(root, { recursive: true, force: true });
  }
});

function updateIndexSchemaVersion(databaseFile: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databaseFile, (openError) => {
      if (openError) return reject(openError);
      database.run("UPDATE meta SET value=? WHERE key='schema_version'", [version], (runError) => {
        database.close((closeError) => runError || closeError ? reject(runError ?? closeError) : resolve());
      });
    });
  });
}

function rewriteRawSampleTick(databaseFile: string, sampleIndex: number, tick: string): void {
  const lines = readFileSync(databaseFile, "utf8").split("\n");
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const payload = JSON.parse(lines[index + 1]) as JcapV1Sample;
    if (payload.sampleIndex !== sampleIndex) continue;
    payload.tick = tick;
    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const header = JSON.parse(lines[index]) as Record<string, unknown>;
    header.payloadBytes = payloadBytes.length;
    header.payloadSha256 = createHash("sha256").update(payloadBytes).digest("hex");
    header.payloadCrc32 = crc32HexForTest(payloadBytes);
    lines[index] = JSON.stringify(header);
    lines[index + 1] = payloadBytes.toString("utf8");
    writeFileSync(databaseFile, lines.join("\n"), "utf8");
    return;
  }
  throw new Error(`sample ${sampleIndex} was not found`);
}

function crc32HexForTest(value: Buffer): string {
  let crc = 0xffff_ffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return ((crc ^ 0xffff_ffff) >>> 0).toString(16).padStart(8, "0");
}

function writeLegacyV0Signature(packageDir: string): void {
  const rawDir = path.join(packageDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const header = {
    formatVersion: 0,
    status: "experimental",
    kind: "event",
    payloadEncoding: "json",
    payloadBytes: 2,
    payloadSha256: createHash("sha256").update("{}").digest("hex"),
  };
  writeFileSync(path.join(rawDir, "events.bin"), `${JSON.stringify(header)}\n{}\n`);
}

function writeActiveV1Fixture(packageDir: string, id: string): void {
  writeJcapV1Raw({
    packageDir,
    metadata: metadata(id),
    samples: [],
    events: [{ eventId: eventId(Number(id.at(-1) ?? "1")), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" }],
  });
}

test("JCAP v1 package inspection isolates legacy, invalid, and unknown packages", async () => {
  const root = workspace();
  const capturesDir = path.join(root, "captures");
  const ids = {
    v1: "41000000-0000-4000-8000-000000000001",
    v0: "41000000-0000-4000-8000-000000000002",
    invalid: "41000000-0000-4000-8000-000000000003",
    unknown: "41000000-0000-4000-8000-000000000004",
    missing: "41000000-0000-4000-8000-000000000005",
  };
  try {
    writeActiveV1Fixture(path.join(capturesDir, `${ids.v1}.jcap`), ids.v1);
    const legacyDir = path.join(capturesDir, `${ids.v0}.jcap`);
    writeLegacyV0Signature(legacyDir);
    const invalidDir = path.join(capturesDir, `${ids.invalid}.jcap`);
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(path.join(invalidDir, "capture.json"), "{\"formatVersion\":1");
    const unknownDir = path.join(capturesDir, `${ids.unknown}.jcap`);
    mkdirSync(path.join(unknownDir, "raw"), { recursive: true });
    writeFileSync(path.join(unknownDir, "raw", "events.bin"), "{}\n");
    const missingDir = path.join(capturesDir, `${ids.missing}.jcap`);
    writeActiveV1Fixture(missingDir, ids.missing);
    unlinkSync(path.join(missingDir, "capture.json"));

    assert.equal(inspectCapturePackage(path.join(capturesDir, `${ids.v1}.jcap`)).kind, "v1");
    assert.equal(inspectCapturePackage(legacyDir).kind, "legacy_v0");
    assert.equal(inspectCapturePackage(invalidDir).kind, "invalid_v1");
    assert.equal(inspectCapturePackage(unknownDir).kind, "unknown");
    assert.equal(inspectCapturePackage(missingDir).kind, "invalid_v1");

    const query = new CaptureQueryOperations(root);
    const listed: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    do {
      const page = dataOf(await query.list({ limit: 2, cursor }));
      listed.push(...page.captures as Array<Record<string, unknown>>);
      cursor = page.nextCursor as string | undefined;
    } while (cursor);
    assert.deepEqual(listed.map((entry) => entry.captureId), Object.values(ids));
    assert.deepEqual(listed.map((entry) => [entry.captureId, entry.formatStatus, entry.detectedFormat]), [
      [ids.v1, "supported", undefined],
      [ids.v0, "unsupported", "legacy_v0"],
      [ids.invalid, "invalid", "invalid_v1"],
      [ids.unknown, "unsupported", "unknown"],
      [ids.missing, "invalid", "invalid_v1"],
    ]);

    const before = readFileSync(path.join(legacyDir, "raw", "events.bin"));
    for (const operation of [
      () => query.summary(ids.v0),
      () => query.series({ captureId: ids.v0, variables: ["counter"], startTick: "0", endTick: "1", bucketCount: 1 }),
      () => query.eventWindow({ captureId: ids.v0, eventId: eventId(1), variables: [], beforeMs: 0, afterMs: 0, bucketCount: 1 }),
      () => query.exportCsv(ids.v0),
    ]) {
      const result = await operation();
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, "JCAP_VERSION_UNSUPPORTED");
    }
    assert.deepEqual(readFileSync(path.join(legacyDir, "raw", "events.bin")), before);
    assert.equal(existsSync(path.join(legacyDir, "capture.db")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP package inspection rejects conflicting metadata and Raw versions", () => {
  const root = workspace();
  const capturesDir = path.join(root, "captures");
  const metadataV0RawV1Id = "41000000-0000-4000-8000-000000000006";
  const metadataV1RawV0Id = "41000000-0000-4000-8000-000000000007";
  try {
    const metadataV0RawV1Dir = path.join(capturesDir, `${metadataV0RawV1Id}.jcap`);
    writeActiveV1Fixture(metadataV0RawV1Dir, metadataV0RawV1Id);
    writeFileSync(path.join(metadataV0RawV1Dir, "capture.json"), JSON.stringify({ formatVersion: 0 }));
    const metadataV0RawV1 = inspectCapturePackage(metadataV0RawV1Dir);
    assert.equal(metadataV0RawV1.kind, "invalid_v1");
    assert.match(metadataV0RawV1.reason, /versions conflict/i);

    const metadataV1RawV0Dir = path.join(capturesDir, `${metadataV1RawV0Id}.jcap`);
    writeLegacyV0Signature(metadataV1RawV0Dir);
    writeFileSync(path.join(metadataV1RawV0Dir, "capture.json"), `${JSON.stringify(metadata(metadataV1RawV0Id), null, 2)}\n`);
    const metadataV1RawV0 = inspectCapturePackage(metadataV1RawV0Dir);
    assert.equal(metadataV1RawV0.kind, "invalid_v1");
    assert.match(metadataV1RawV0.reason, /versions conflict/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture_list reports a missing terminal v1 index without rebuilding it", async () => {
  const root = workspace();
  const captureIdWithoutIndex = "41000000-0000-4000-8000-000000000008";
  const packageDir = path.join(root, "captures", `${captureIdWithoutIndex}.jcap`);
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(captureIdWithoutIndex),
      samples: [{ sampleIndex: 0, tick: "10", statusFlags: 1, values: { counter: 1, feedback: 4 } }],
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "lifecycle", tick: "10", state: "finalizing" },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "11", state: "stopped" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "stopped");

    const query = new CaptureQueryOperations(root);
    const listed = dataOf(await query.list({ limit: 10 }));
    const item = (listed.captures as Array<Record<string, unknown>>)
      .find((candidate) => candidate.captureId === captureIdWithoutIndex);
    assert.equal(item?.formatStatus, "supported");
    assert.equal(item?.indexStatus, "rebuild_required");
    assert.equal(existsSync(path.join(packageDir, "capture.db")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture_list rejects cursors that were not issued by the server", async () => {
  const root = workspace();
  try {
    const query = new CaptureQueryOperations(root);
    for (const cursor of [
      "not-a-valid-cursor",
      "ABCDEF00-0000-4000-8000-000000000001\0",
      `${captureId}\0run\0extra`,
      `${captureId}`,
      `${captureId}\0${"x".repeat(1024)}`,
    ]) {
      const listed = await query.list({ cursor, limit: 10 });
      assert.equal(listed.ok, false);
      assert.equal(listed.error?.code, "INVALID_CURSOR");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capture_list normalizes uppercase package UUIDs before issuing cursors", async () => {
  const root = workspace();
  const lowerFirst = "41000000-0000-4000-8000-000000000001";
  const upperSecond = "AB000000-0000-4000-8000-000000000002";
  try {
    writeActiveV1Fixture(path.join(root, "captures", `${lowerFirst}.jcap`), lowerFirst);
    writeActiveV1Fixture(path.join(root, "captures", `${upperSecond}.jcap`), upperSecond.toLowerCase());
    const query = new CaptureQueryOperations(root);
    const first = dataOf(await query.list({ limit: 1 }));
    const cursor = first.nextCursor;
    assert.equal(typeof cursor, "string");
    assert.match(String(cursor), /^[0-9a-f-]+\0/);
    const second = dataOf(await query.list({ limit: 1, cursor: String(cursor) }));
    assert.deepEqual((second.captures as Array<Record<string, unknown>>).map((entry) => entry.captureId), [upperSecond.toLowerCase()]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const persistedWrite = readJcapV1Raw(packageDir).events[1];
    assert.throws(() => writer.appendEvent({
      ...persistedWrite,
      eventId: eventId(7), eventSequence: 2, tick: "21", operationEndTick: "21",
      outcome: "failed", stateUnknown: true,
      error: { code: "WRITE_FAILED", message: "fixture", writeIssued: false, stateUnknown: false },
    }), /error evidence/);
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

    const query = new CaptureQueryOperations(root);
    unlinkSync(path.join(packageDir, "capture.db"));
    assert.equal(dataOf(await query.summary(captureId)).indexRebuilt, true);
    assert.deepEqual(rawHashes(packageDir), beforeHashes);
    assert.deepEqual(await jcapCaptureSeries({ packageDir, variables: ["counter", "feedback"], startTick: "10", endTick: "30", bucketCount: 2 }), seriesBefore);
    assert.deepEqual(await jcapCaptureEventWindow({ packageDir, eventId: eventId(2), variables: ["counter"], beforeMs: 0, afterMs: 0, bucketCount: 1 }), windowBefore);

    writeFileSync(path.join(packageDir, "capture.db"), "not a sqlite database");
    assert.equal(dataOf(await query.series({ captureId, variables: ["counter"], startTick: "10", endTick: "30", bucketCount: 2 })).indexRebuilt, true);

    const exported = await jcapCaptureExportCsv(packageDir, path.join(root, "exports"));
    assert.equal(exported.rows, 6);
    assert.equal(path.dirname(exported.exportFile), path.join(root, "exports"));
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
    const listed = dataOf(await query.list());
    assert.equal((listed.captures as Array<Record<string, unknown>>)[0].captureId, captureId);
    const bounded = await query.series({ captureId, variables: Array.from({ length: 33 }, (_, index) => `v${index}`), startTick: "0", endTick: "1", bucketCount: 1 });
    assert.equal(bounded.ok, false);
    assert.equal(bounded.error?.code, "JCAP_BOUNDS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 persists and strictly validates capture-owner target-control events", () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  try {
    const writer = new JcapV1Writer({ packageDir, metadata: metadata() });
    writer.appendEvent({ eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
    const controlEvent = {
      eventId: eventId(2), eventSequence: 1, type: "target_control", tick: "20",
      requestedAction: "continue", action: "resume",
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:00.001Z",
      operationStartTick: "10", operationEndTick: "20", timingSource: "helper_qpc",
      helperOperationStartTick: "10", helperOperationEndTick: "20", timingDegraded: false,
      operationId: eventId(7), ipcRequestIds: [eventId(8)],
      controlAttempted: true, controlIssued: true, resumeIssued: true, stateUnknown: false,
      beforeState: "halted", afterState: "running", outcome: "completed", error: null,
    } as const;
    writer.appendEvent(controlEvent);
    const persisted = readJcapV1Raw(packageDir).events[1];
    assert.equal(persisted.type, "target_control");
    assert.equal(persisted.requestedAction, "continue");
    assert.equal(persisted.afterState, "running");

    assert.throws(() => writer.appendEvent({ ...controlEvent, eventId: eventId(3), eventSequence: 2, tick: "21", operationEndTick: "21", requestedAction: "reset" }), /target_control action/);
    assert.throws(() => writer.appendEvent({ ...controlEvent, eventId: eventId(4), eventSequence: 2, tick: "21", operationEndTick: "21", afterState: "halted" }), /completed outcome/);
    assert.throws(() => writer.appendEvent({ ...controlEvent, eventId: eventId(5), eventSequence: 2, tick: "21", operationEndTick: "21", timingSource: "controller_fallback", timingDegraded: false }), /timing-source evidence/);
    assert.throws(() => writer.appendEvent({
      ...controlEvent, eventId: eventId(6), eventSequence: 2, tick: "21", operationEndTick: "21",
      outcome: "failed", stateUnknown: true,
      error: { code: "CONTROL_FAILED", message: "fixture", controlIssued: false, stateUnknown: false },
    }), /error evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 rebuild normalizes legacy low-rate HSS sample ticks without changing Raw", async () => {
  const root = workspace();
  const id = "43000000-0000-4000-8000-000000000017";
  const packageDir = path.join(root, "captures", `${id}.jcap`);
  const captureMetadata = nativeMetadata(id, 100);
  const descriptor = captureMetadata.variables[0];
  const rawSamples: JcapV1Sample[] = [
    { sampleIndex: 0, tick: "5714963700", statusFlags: 1, values: { counter: 0xa5a55a5a, feedback: 1 } },
    { sampleIndex: 1, tick: "5715963700", statusFlags: 1, values: { counter: 0xa5a55a5a, feedback: 2 } },
    { sampleIndex: 2, tick: "5716963700", statusFlags: 1, values: { counter: 0x55aa55aa, feedback: 3 } },
    { sampleIndex: 3, tick: "5717963700", statusFlags: 1, values: { counter: 0x55aa55aa, feedback: 4 } },
    { sampleIndex: 4, tick: "5718963700", statusFlags: 1, values: { counter: 0xa5a55a5a, feedback: 5 } },
    { sampleIndex: 5, tick: "5719963700", statusFlags: 1, values: { counter: 0xa5a55a5a, feedback: 6 } },
  ];
  const writeEvent = {
    eventId: eventId(17), eventSequence: 1, type: "variable_write" as const, tick: "5740000000",
    logicalIdentity: descriptor.logicalIdentity, selector: descriptor.logicalIdentity, descriptor,
    startedAt: "2026-07-29T01:41:40.687Z", endedAt: "2026-07-29T01:41:40.839Z",
    operationStartTick: "5739000000", operationEndTick: "5740000000", timingSource: "helper_qpc",
    writeAttempted: true, writeIssued: true, stateUnknown: false,
    old: { state: "captured", value: 0xa5a55a5a, bytesHex: "5a5aa5a5" },
    requested: { value: 0x55aa55aa, bytesHex: "aa55aa55" },
    readback: { state: "observed", value: 0x55aa55aa, bytesHex: "aa55aa55" },
    restore: { state: "restored", attempted: true, writeIssued: true, stateUnknown: false, readback: 0xa5a55a5a, readbackHex: "5a5aa5a5" },
    verification: { state: "verified" },
    sampleAlignment: { method: "terminal_raw_nearest", status: "derive_on_rebuild" },
    outcome: "completed", error: null,
  };
  try {
    const writer = new JcapV1Writer({ packageDir, metadata: captureMetadata });
    writer.appendEvent({ eventId: eventId(16), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
    for (const sample of rawSamples) assert.equal(writer.appendSample(sample), true);
    writer.appendEvent(writeEvent);
    writer.appendEvent({ ...writeEvent, eventId: eventId(18), eventSequence: 2, tick: "8000000000", operationStartTick: "7999000000", operationEndTick: "8000000000" });
    writer.appendEvent({ eventId: eventId(19), eventSequence: 3, type: "lifecycle", tick: "8000000000", state: "finalizing" });
    writer.appendEvent({ eventId: eventId(20), eventSequence: 4, type: "lifecycle", tick: "8000000000", state: "stopped" });
    writer.close();
    finalizeJcapV1Metadata(packageDir, "stopped");
    const beforeHashes = rawHashes(packageDir);

    await rebuildJcapV1Index(packageDir);
    assert.deepEqual(rawHashes(packageDir), beforeHashes);
    const summary = await jcapCaptureSummary(packageDir);
    assert.equal(summary.startTick, "5714963700");
    assert.equal(summary.endTick, "5764963700");

    const window = await jcapCaptureEventWindow({ packageDir, eventId: eventId(17), variables: ["counter"], beforeMs: 20, afterMs: 20, bucketCount: 4 });
    assert.deepEqual(window.sampleCoverage, { status: "covered", startTick: "5714963700", endTick: "5764963700" });
    assert.equal((window.event as Record<string, unknown>).tick, "5740000000");
    assert.deepEqual((window.event as Record<string, unknown>).sampleAlignment, { method: "capture_rate_normalized_index", status: "resolved" });
    assert.deepEqual(
      ((window.series as Record<string, unknown>).series as Array<Record<string, unknown>>).map((bucket) => bucket.last),
      [0xa5a55a5a, 0x55aa55aa, 0x55aa55aa, 0xa5a55a5a],
    );
    assert.notEqual((window.nearestSample as Record<string, unknown>).tick, (window.nearestSample as Record<string, unknown>).raw_tick);

    const emptyInside = await jcapCaptureEventWindow({ packageDir, eventId: eventId(17), variables: ["counter"], beforeMs: 0, afterMs: 0, bucketCount: 1 });
    assert.deepEqual(emptyInside.sampleCoverage, { status: "no_samples_in_window", startTick: "5714963700", endTick: "5764963700" });
    assert.equal(emptyInside.nearestSample, undefined);
    assert.deepEqual((emptyInside.series as Record<string, unknown>).series, []);

    const outside = await jcapCaptureEventWindow({ packageDir, eventId: eventId(18), variables: ["counter"], beforeMs: 0, afterMs: 0, bucketCount: 1 });
    assert.deepEqual(outside.sampleCoverage, { status: "outside_sample_range", startTick: "5714963700", endTick: "5764963700" });
    assert.deepEqual((outside.event as Record<string, unknown>).sampleAlignment, { method: "capture_rate_normalized_index", status: "outside_sample_range" });
    assert.equal(outside.nearestSample, undefined);
    assert.deepEqual((outside.series as Record<string, unknown>).series, []);
    assert.deepEqual(rawHashes(packageDir), beforeHashes);

    await updateIndexSchemaVersion(path.join(packageDir, "capture.db"), "1");
    const repaired = dataOf(await new CaptureQueryOperations(root).summary(id));
    assert.equal(repaired.indexRebuilt, true);
    assert.equal(repaired.endTick, "5764963700");
    assert.deepEqual(rawHashes(packageDir), beforeHashes);

    const correctId = "43000000-0000-4000-8000-000000000021";
    const correctPackage = path.join(root, "captures", `${correctId}.jcap`);
    const correctMetadata = nativeMetadata(correctId, 100);
    const correctWriter = new JcapV1Writer({ packageDir: correctPackage, metadata: correctMetadata });
    correctWriter.appendEvent({ eventId: eventId(21), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" });
    for (const [sampleIndex, tick] of ["5714963700", "5724963700", "5734963700"].entries()) {
      assert.equal(correctWriter.appendSample({ sampleIndex, tick, statusFlags: 1, values: { counter: sampleIndex, feedback: sampleIndex } }), true);
    }
    correctWriter.appendEvent({ eventId: eventId(22), eventSequence: 1, type: "lifecycle", tick: "5734963700", state: "finalizing" });
    correctWriter.appendEvent({ eventId: eventId(23), eventSequence: 2, type: "lifecycle", tick: "5734963700", state: "stopped" });
    correctWriter.close();
    finalizeJcapV1Metadata(correctPackage, "stopped");
    await rebuildJcapV1Index(correctPackage);
    const correctSummary = await jcapCaptureSummary(correctPackage);
    assert.equal(correctSummary.startTick, "5714963700");
    assert.equal(correctSummary.endTick, "5734963700");

    // Hardware capture d04b... has Raw SHA-256 d4001896.../87aeab7a... and
    // cadence {0 ms duplicates, 1 ms ordinal steps, sparse 2 ms gaps}.
    const duplicateId = "43000000-0000-4000-8000-000000000030";
    const duplicatePackage = path.join(root, "captures", `${duplicateId}.jcap`);
    const duplicateTicks = ["5714963700", "5715963700", "5715963700", "5717963700", "5718963700", "5719963700"];
    writeJcapV1Raw({
      packageDir: duplicatePackage,
      metadata: nativeMetadata(duplicateId, 100),
      samples: duplicateTicks.map((tick, sampleIndex) => ({ sampleIndex, tick, statusFlags: 1, values: { counter: sampleIndex, feedback: sampleIndex } })),
      events: [
        { eventId: eventId(30), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(31), eventSequence: 1, type: "lifecycle", tick: duplicateTicks.at(-1)!, state: "finalizing" },
        { eventId: eventId(32), eventSequence: 2, type: "lifecycle", tick: duplicateTicks.at(-1)!, state: "stopped" },
      ],
    });
    finalizeJcapV1Metadata(duplicatePackage, "stopped");
    const duplicateRawHashes = rawHashes(duplicatePackage);
    await rebuildJcapV1Index(duplicatePackage);
    assert.deepEqual(rawHashes(duplicatePackage), duplicateRawHashes);
    const duplicateSummary = await jcapCaptureSummary(duplicatePackage);
    assert.equal(duplicateSummary.startTick, "5714963700");
    assert.equal(duplicateSummary.endTick, "5764963700");

    const regressionId = "43000000-0000-4000-8000-000000000033";
    const regressionPackage = path.join(root, "captures", `${regressionId}.jcap`);
    const regressionRaw = writeJcapV1Raw({
      packageDir: regressionPackage,
      metadata: nativeMetadata(regressionId, 100),
      samples: ["5714963700", "5715963700", "5717963700", "5718963700"].map((tick, sampleIndex) => ({
        sampleIndex, tick, statusFlags: 1, values: { counter: sampleIndex, feedback: sampleIndex },
      })),
      events: [
        { eventId: eventId(33), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(34), eventSequence: 1, type: "lifecycle", tick: "5718963700", state: "finalizing" },
        { eventId: eventId(35), eventSequence: 2, type: "lifecycle", tick: "5718963700", state: "stopped" },
      ],
    });
    rewriteRawSampleTick(regressionRaw.samplesFile, 3, "5716963700");
    finalizeJcapV1Metadata(regressionPackage, "stopped");
    const regressionHashes = rawHashes(regressionPackage);
    await assert.rejects(
      () => rebuildJcapV1Index(regressionPackage),
      /Raw corruption|sample tick regressed/,
    );
    assert.deepEqual(rawHashes(regressionPackage), regressionHashes);

    for (const [ambiguousId, ticks] of [
      ["43000000-0000-4000-8000-000000000024", ["5714963700", "5715963700", "5725963700"]],
      ["43000000-0000-4000-8000-000000000027", ["5714963700", "5714963700", "5714963700"]],
    ] as const) {
      const ambiguousPackage = path.join(root, "captures", `${ambiguousId}.jcap`);
      writeJcapV1Raw({
        packageDir: ambiguousPackage,
        metadata: nativeMetadata(ambiguousId, 100),
        samples: ticks.map((tick, sampleIndex) => ({ sampleIndex, tick, statusFlags: 1, values: { counter: sampleIndex, feedback: sampleIndex } })),
        events: [
          { eventId: eventId(24 + Number(ambiguousId.endsWith("27")) * 3), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
          { eventId: eventId(25 + Number(ambiguousId.endsWith("27")) * 3), eventSequence: 1, type: "lifecycle", tick: ticks.at(-1)!, state: "finalizing" },
          { eventId: eventId(26 + Number(ambiguousId.endsWith("27")) * 3), eventSequence: 2, type: "lifecycle", tick: ticks.at(-1)!, state: "stopped" },
        ],
      });
      finalizeJcapV1Metadata(ambiguousPackage, "stopped");
      await assert.rejects(
        () => rebuildJcapV1Index(ambiguousPackage),
        (error: unknown) => (error as { message?: string }).message?.includes("low-rate J-Link HSS") === true,
      );
    }
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

test("JCAP v1 rebuild opens a Windows package path beyond MAX_PATH", { skip: process.platform !== "win32" }, async () => {
  const base = workspace();
  let root = base;
  while (path.join(root, "captures", `${captureId}.jcap`, "capture.db.tmp").length <= 270) {
    root = path.join(root, "portable-release-segment");
  }
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(),
      samples: [samples[0]],
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "lifecycle", tick: "10", state: "finalizing" },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "11", state: "stopped" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "stopped");
    const rebuilt = await rebuildJcapV1Index(packageDir);
    assert.equal(rebuilt.indexStatus, "ready");
    assert.equal(existsSync(path.join(packageDir, "capture.db")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
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
    const listed = await new CaptureQueryOperations(root).list();
    assert.equal(listed.ok, false);
    assert.equal(listed.error?.code, "JCAP_CAPTURE_AMBIGUOUS");
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
    const exported = dataOf(await new CaptureQueryOperations(root).exportCsv(captureId));
    assert.equal(path.dirname(String(exported.exportFile)), path.join(root, "run-1", "exports"));
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "capture.json", "raw"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 indexes a 560/1000 completed capture when the planned deficit is explicitly reported", async () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  const partialSamples = Array.from({ length: 560 }, (_, sampleIndex): JcapV1Sample => ({
    sampleIndex,
    tick: String(sampleIndex * 1_000_000),
    statusFlags: 1,
    values: { counter: sampleIndex, feedback: sampleIndex + 1 },
  }));
  const quality = { missingSamples: 440, droppedSamples: 0, overflows: 0, readErrors: 0, timeouts: 0 };
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(captureId, "active", 1, 1_000),
      samples: partialSamples,
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "quality", tick: "30", qualityStatus: "reported", qualitySource: "jlink", ...quality, durationValidated: true, qualityEvidence: { source: "fixture" } },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "30", state: "finalizing" },
        { eventId: eventId(4), eventSequence: 3, type: "lifecycle", tick: "31", state: "completed" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "completed", quality, "reported");
    await assert.doesNotReject(() => rebuildJcapV1Index(packageDir));
    assert.equal((await jcapCaptureSummary(packageDir)).sampleCount, 560);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 rejects a completed capture whose planned deficit is not reported", async () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  const quality = { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null };
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(captureId, "active", 1, 3),
      samples: samples.slice(0, 2),
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "quality", tick: "20", qualityStatus: "partial", qualitySource: "none", ...quality, durationValidated: true, qualityEvidence: { source: "fixture" } },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "20", state: "finalizing" },
        { eventId: eventId(4), eventSequence: 3, type: "lifecycle", tick: "21", state: "completed" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "completed", quality, "partial", "none");
    await assert.rejects(
      () => rebuildJcapV1Index(packageDir),
      (error: unknown) => (error as { code?: string }).code === "JCAP_SAMPLE_BUDGET_UNREPORTED",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("JCAP v1 accepts a completed capture with no planned deficit when optional loss counters are unavailable", async () => {
  const root = workspace();
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  const quality = { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null };
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(captureId, "active", 1, 3),
      samples,
      events: [
        { eventId: eventId(1), eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: eventId(2), eventSequence: 1, type: "quality", tick: "30", qualityStatus: "partial", qualitySource: "target_counter", ...quality, durationValidated: true, qualityEvidence: { source: "fixture" } },
        { eventId: eventId(3), eventSequence: 2, type: "lifecycle", tick: "30", state: "finalizing" },
        { eventId: eventId(4), eventSequence: 3, type: "lifecycle", tick: "31", state: "completed" },
      ],
    });
    finalizeJcapV1Metadata(packageDir, "completed", quality, "partial", "target_counter");
    await assert.doesNotReject(() => rebuildJcapV1Index(packageDir));
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
