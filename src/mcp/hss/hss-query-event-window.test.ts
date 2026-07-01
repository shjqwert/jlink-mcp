import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { appendHssWriteEvent, materializeHssCaptureEvents } from "./hss-events";
import { appendHssWriteFlagIntervals, materializeHssFlagIntervals } from "./hss-flag-overlay";
import { crc32File, encodeHssRecord, queryHssCapture } from "./hss-artifact";
import type { HssVariableWriteExecuteResult } from "./hss-write-execute";
import type { HssVariableWritePlan } from "./hss-write-plan";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";

test("hss_capture_query supports event_window with effective flags and summary", async () => {
  const root = await tempProject();
  try {
    const captureId = "11111111-1111-4111-8111-111111111111";
    const captureDir = join(root, ".jlink-mcp", "captures", captureId);
    await mkdir(captureDir, { recursive: true });
    const segmentFile = join(captureDir, "capture_0001.bin");
    const records = Array.from({ length: 10 }, (_, index) => encodeHssRecord({
      sampleIndex: BigInt(index),
      timestampTicks: BigInt(index * 10_000_000),
      statusFlags: HSS_STATUS_FLAGS.valid,
      rawValues: [index],
    }, 1));
    await writeFile(segmentFile, Buffer.concat(records));
    const metadataFile = join(captureDir, "capture.json");
    await writeMetadata(root, metadataFile, captureId, await crc32File(segmentFile));
    const plan = writePlan(captureId);
    const result = writeResult(captureId, { writeStartUs: 50_000, writeEndUs: 55_000 });
    await appendHssWriteEvent(metadataFile, plan, result, true);
    await appendHssWriteFlagIntervals(metadataFile, { eventId: result.eventId, writeStartUs: 50_000, writeEndUs: 55_000, requestedRateHz: 100 });
    await materializeHssCaptureEvents(metadataFile);
    await materializeHssFlagIntervals(metadataFile);
    const query = await queryHssCapture({
      captureId,
      metadataFile,
      mode: "event_window",
      eventId: result.eventId,
      windowBeforeMs: 20,
      windowAfterMs: 20,
      includeRawSamples: true,
      flagFilter: { exclude: ["write_in_progress"] },
    }, root);
    const window = query.eventWindow as { sampleCount: number; summary: Record<string, { first: number; last: number; delta: number }> };
    assert.equal(window.sampleCount, 4);
    assert.equal(window.summary.Debug_IqRef.first, 3);
    assert.equal(window.summary.Debug_IqRef.last, 7);
    assert.equal(window.summary.Debug_IqRef.delta, 4);
    const raw = query.rawSamples as Array<{ effectiveStatusFlags: number }>;
    assert.equal(raw.some((sample) => (sample.effectiveStatusFlags & HSS_STATUS_FLAGS.write_in_progress) !== 0), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeMetadata(root: string, metadataFile: string, captureId: string, crc32: string): Promise<void> {
  await writeFile(metadataFile, JSON.stringify({
    version: 1,
    captureId,
    sessionName: "test",
    projectRoot: root,
    backend: "jlink-hss",
    state: "stopped",
    transportStatus: "pass",
    dataQualityStatus: "pass",
    semanticValidationStatus: "not_run",
    payloadValidationStatus: "pass",
    artifact: { file: join(root, "FOC_SCM.out"), sha256: "sha", resolver: "iar-map" },
    target: { device: "Z20K146MC", interface: "SWD", speedKhz: 4000 },
    probe: {},
    symbols: [{ name: "Debug_IqRef", address: "0x20000000", size: 4, type: "int32", source: "iar-map" }],
    sampling: { requestedRateHz: 100, actualRateHz: 100, hssIndexRateHz: 100, hostObservedRateHz: 100, helperReportedRateHz: 100, helperActualRateHz: 100, readMode: "periodic", durationSec: 0.09, timestampSource: "qpc", timestampFrequency: "1000000000" },
    layout: {},
    targetState: {},
    segments: [{ file: "capture_0001.bin", sampleStart: 0, sampleCount: 10, recordSize: 28, crc32 }],
    quality: { sampleCount: 10, validSamples: 10, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, targetHaltedSamples: 0, actualRateHz: 100 },
    events: [],
    warnings: [],
    failures: [],
    safety: {},
  }), "utf8");
}

function writePlan(captureId: string): HssVariableWritePlan {
  return {
    writePlanId: "wp_test",
    captureId,
    captureGeneration: 1,
    targetRef: { kind: "scalar", path: "Debug_IqRef" },
    canonicalTarget: "Debug_IqRef",
    address: 0x20000000,
    dataType: "int32",
    byteSize: 4,
    writeElementCount: 1,
    writeByteCount: 4,
    risk: "R2",
    policyMatched: true,
    policyHash: "policy",
    symbolLayoutHash: "layout",
    readbackRequired: true,
    maxWriteOpsRemaining: 1,
    maxElementsRemaining: 1,
    willEnterCaptureQueue: true,
    executable: true,
    backend: "jlink-hss",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  };
}

function writeResult(captureId: string, overrides: Partial<HssVariableWriteExecuteResult>): HssVariableWriteExecuteResult {
  return {
    writeId: "wr_test",
    eventId: "evt_test",
    captureId,
    targetRef: { kind: "scalar", path: "Debug_IqRef" },
    canonicalTarget: "Debug_IqRef",
    oldValue: 0,
    newValue: 5,
    readback: 5,
    readbackOk: true,
    mismatches: [],
    writeStartUs: 50_000,
    writeEndUs: 55_000,
    sampleIndexNear: null,
    risk: "R2",
    consumedWriteOps: 1,
    consumedElements: 1,
    ...overrides,
  };
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-query-event-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
