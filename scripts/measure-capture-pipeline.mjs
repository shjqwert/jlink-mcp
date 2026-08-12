import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createJcapV1Metadata,
  finalizeJcapV1Metadata,
  jcapCaptureSeries,
  jcapCaptureSummary,
  rebuildJcapV1Index,
  writeJcapV1Raw,
} from "../out/mcp/jcap/jcap-v1.js";
import { CaptureQueryOperations } from "../out/mcp/runtime/capture-query-operations.js";

const sampleCount = 5_000;
const root = mkdtempSync(join(tmpdir(), "jlink-mcp-capture-measure-"));
try {
  const eagerId = randomUUID();
  const lazyId = randomUUID();
  const eagerDir = join(root, "captures", `${eagerId}.jcap`);
  const lazyDir = join(root, "captures", `${lazyId}.jcap`);
  writeFixture(eagerDir, eagerId);
  writeFixture(lazyDir, lazyId);

  const eagerStarted = performance.now();
  finalizeJcapV1Metadata(eagerDir, "stopped");
  await rebuildJcapV1Index(eagerDir);
  const eagerFinalizeMs = performance.now() - eagerStarted;

  const lazyStarted = performance.now();
  finalizeJcapV1Metadata(lazyDir, "stopped");
  const lazyFinalizeMs = performance.now() - lazyStarted;
  const lazyBeforeQuery = packageMetrics(lazyDir);
  const rawBeforeQuery = rawHashes(lazyDir);
  assert.deepEqual(lazyBeforeQuery.files, ["capture.json", "raw/events.bin", "raw/samples.bin"]);

  const firstQueryStarted = performance.now();
  const firstQuery = await new CaptureQueryOperations(root).summary(lazyId);
  const firstQueryMs = performance.now() - firstQueryStarted;
  assert.equal(firstQuery.ok, true, JSON.stringify(firstQuery.error));
  assert.equal(firstQuery.data.indexRebuilt, true);
  assert.deepEqual(rawHashes(lazyDir), rawBeforeQuery, "lazy index materialization must not change Raw");

  const eagerSummary = await jcapCaptureSummary(eagerDir);
  const lazySummary = await jcapCaptureSummary(lazyDir);
  const query = { variables: ["speed", "current", "voltage"], startTick: "0", endTick: String(sampleCount - 1), bucketCount: 64 };
  const eagerSeries = await jcapCaptureSeries({ packageDir: eagerDir, ...query });
  const lazySeries = await jcapCaptureSeries({ packageDir: lazyDir, ...query });
  assert.deepEqual(normalizeResult(lazySummary), normalizeResult(eagerSummary));
  assert.deepEqual(normalizeResult(lazySeries), normalizeResult(eagerSeries));

  const eagerMetrics = packageMetrics(eagerDir);
  const lazyAfterQuery = packageMetrics(lazyDir);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    scenario: { sampleCount, variableCount: 3, terminalState: "stopped" },
    eager: { finalizeMs: round(eagerFinalizeMs), ...eagerMetrics },
    saveOnly: { finalizeMs: round(lazyFinalizeMs), ...lazyBeforeQuery },
    firstExplicitQuery: { latencyMs: round(firstQueryMs), ...lazyAfterQuery },
    checks: {
      rawUnchangedAfterIndex: true,
      summaryEquivalent: true,
      seriesEquivalent: true,
      saveOnlyDatabaseCreated: false,
      firstQueryDatabaseCreated: true,
    },
  }, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeFixture(packageDir, captureId) {
  const variables = [
    descriptor("speed", "0x20000000"),
    descriptor("current", "0x20000004"),
    descriptor("voltage", "0x20000008"),
  ];
  writeJcapV1Raw({
    packageDir,
    metadata: createJcapV1Metadata({
      captureId,
      backend: "fake-jlink-hss",
      requestedRateHz: 1_000,
      durationSec: 5,
      variables,
      provenance: {
        captureId,
        backend: "fake-jlink-hss",
        runtime: { fixture: "measure-capture-pipeline" },
        target: {
          projectRoot: "C:\\fixture",
          generation: "63000000-0000-4000-8000-000000000001",
          device: "FIXTURE",
          probeSerial: "123456789",
          interface: "SWD",
          speed: 4_000,
        },
        script: { mode: "none" },
        artifact: { generation: "a".repeat(64), path: "C:\\fixture\\fixture.elf", sha256: "c".repeat(64) },
      },
    }),
    samples: Array.from({ length: sampleCount }, (_, sampleIndex) => ({
      sampleIndex,
      tick: String(sampleIndex),
      statusFlags: 1,
      values: { speed: sampleIndex, current: sampleIndex / 10, voltage: 48 },
    })),
    events: [
      { eventId: "62000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
      { eventId: "62000000-0000-4000-8000-000000000002", eventSequence: 1, type: "lifecycle", tick: String(sampleCount - 1), state: "finalizing" },
      { eventId: "62000000-0000-4000-8000-000000000003", eventSequence: 2, type: "lifecycle", tick: String(sampleCount), state: "stopped" },
    ],
  });
}

function descriptor(logicalIdentity, address) {
  return {
    logicalIdentity,
    type: "float32",
    address,
    size: 4,
    artifactGeneration: "a".repeat(64),
    layoutHash: "b".repeat(64),
  };
}

function rawHashes(packageDir) {
  return Object.fromEntries(["samples.bin", "events.bin"].map((file) => [
    file,
    createHash("sha256").update(readFileSync(join(packageDir, "raw", file))).digest("hex"),
  ]));
}

function packageMetrics(packageDir) {
  const files = [];
  let bytes = 0;
  visit(packageDir, "");
  return { fileCount: files.length, totalBytes: bytes, files: files.sort() };

  function visit(directory, prefix) {
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stats = statSync(absolute);
      if (stats.isDirectory()) visit(absolute, relative);
      else {
        files.push(relative);
        bytes += stats.size;
      }
    }
  }
}

function normalizeResult(value) {
  if (Array.isArray(value)) return value.map(normalizeResult);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (["captureId", "packageDir", "databaseFile", "indexRebuilt", "createdAt", "updatedAt"].includes(key)) continue;
    result[key] = normalizeResult(item);
  }
  return result;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
