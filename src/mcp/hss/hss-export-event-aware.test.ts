import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { appendHssWriteEvent, materializeHssCaptureEvents } from "./hss-events";
import { appendHssWriteFlagIntervals, materializeHssFlagIntervals } from "./hss-flag-overlay";
import { crc32File, encodeHssRecord, exportHssCapture } from "./hss-artifact";
import type { HssVariableWriteExecuteResult } from "./hss-write-execute";
import type { HssVariableWritePlan } from "./hss-write-plan";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";

test("hss_capture_export writes event-aware CSV without changing normal export", async () => {
  const root = await tempProject();
  try {
    const captureId = "11111111-1111-4111-8111-111111111111";
    const captureDir = join(root, ".jlink-mcp", "captures", captureId);
    await mkdir(captureDir, { recursive: true });
    const segmentFile = join(captureDir, "capture_0001.bin");
    await writeFile(segmentFile, Buffer.concat(Array.from({ length: 6 }, (_, index) => encodeHssRecord({
      sampleIndex: BigInt(index),
      timestampTicks: BigInt(index * 10_000),
      statusFlags: HSS_STATUS_FLAGS.valid,
      rawValues: [index],
    }, 1))));
    const metadataFile = join(captureDir, "capture.json");
    await writeMetadata(root, metadataFile, captureId, await crc32File(segmentFile));
    const result = writeResult(captureId);
    await appendHssWriteEvent(metadataFile, writePlan(captureId), result, true);
    await appendHssWriteFlagIntervals(metadataFile, { eventId: result.eventId, writeStartUs: 20, writeEndUs: 30, requestedRateHz: 100000 });
    await materializeHssCaptureEvents(metadataFile);
    await materializeHssFlagIntervals(metadataFile);
    const normal = await exportHssCapture({ captureId, metadataFile }, root);
    assert.match(await readFile(normal.csvFile as string, "utf8"), /^sampleIndex,timeSec,timestampTicks,statusFlags,Debug_IqRef/m);
    const exported = await exportHssCapture({ captureId, metadataFile, eventAware: true, eventId: result.eventId, windowBeforeMs: 1, windowAfterMs: 1 }, root);
    const csv = await readFile(exported.csvFile as string, "utf8");
    assert.match(csv, /^sampleIndex,timeUs,statusFlags,effectiveStatusFlags,eventMarker,eventId,Debug_IqRef/m);
    assert.match(csv, /write_in_progress|write_nearby/);
    assert.notEqual(exported.csvFile, normal.csvFile);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeMetadata(root: string, metadataFile: string, captureId: string, crc32: string): Promise<void> {
  await mkdir(join(root, ".jlink-mcp", "exports"), { recursive: true });
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
    sampling: { requestedRateHz: 100000, actualRateHz: 100000, hssIndexRateHz: 100000, hostObservedRateHz: 100000, helperReportedRateHz: 100000, helperActualRateHz: 100000, readMode: "periodic", durationSec: 0.00005, timestampSource: "qpc", timestampFrequency: "1000000000" },
    layout: {},
    targetState: {},
    segments: [{ file: "capture_0001.bin", sampleStart: 0, sampleCount: 6, recordSize: 28, crc32 }],
    quality: { sampleCount: 6, validSamples: 6, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, targetHaltedSamples: 0, actualRateHz: 100000 },
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

function writeResult(captureId: string): HssVariableWriteExecuteResult {
  return {
    writeId: "wr_test",
    eventId: "evt_test",
    captureId,
    targetRef: { kind: "scalar", path: "Debug_IqRef" },
    canonicalTarget: "Debug_IqRef",
    newValue: 2,
    readbackOk: true,
    mismatches: [],
    writeStartUs: 20,
    writeEndUs: 30,
    sampleIndexNear: null,
    risk: "R2",
    consumedWriteOps: 1,
    consumedElements: 1,
  };
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-export-event-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
