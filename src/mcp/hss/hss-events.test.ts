import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendHssWriteEvent, hssEventsFile, materializeHssCaptureEvents, readHssCaptureEvents } from "./hss-events";
import type { HssVariableWriteExecuteResult } from "./hss-write-execute";
import type { HssVariableWritePlan } from "./hss-write-plan";

test("capture write events append to jsonl and materialize into capture.json", async () => {
  const root = await tempProject();
  try {
    const metadataFile = await writeMetadata(root);
    const first = await appendHssWriteEvent(metadataFile, plan("Debug_IqRef"), result({ writeStartUs: 2000, newValue: 2 }), true);
    const second = await appendHssWriteEvent(metadataFile, plan("Debug_IqRef"), result({ writeStartUs: 1000, newValue: 1 }), false, "READBACK_MISMATCH");
    assert.equal(existsSync(hssEventsFile(metadataFile)), true);
    assert.deepEqual((await readHssCaptureEvents(metadataFile)).map((event) => event.eventId), [second.eventId, first.eventId]);
    await materializeHssCaptureEvents(metadataFile);
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(metadata.events.length, 2);
    assert.equal(metadata.events[0].eventId, second.eventId);
    assert.equal(metadata.events[0].ok, false);
    assert.equal(metadata.events[0].errorCode, "READBACK_MISMATCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large capture write events use sidecar artifacts", async () => {
  const root = await tempProject();
  try {
    const metadataFile = await writeMetadata(root);
    const event = await appendHssWriteEvent(metadataFile, plan("Debug_ProfileTable"), result({ newValues: Array.from({ length: 3000 }, (_, index) => index), readbackValues: Array.from({ length: 3000 }, (_, index) => index) }), true);
    assert.ok(event.sidecarArtifact);
    const sidecar = event.sidecarArtifact as { file: string; crc32: string };
    assert.equal(existsSync(sidecar.file), true);
    assert.match(sidecar.crc32, /^[0-9a-f]{8}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeMetadata(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const metadataFile = join(root, "capture.json");
  await writeFile(metadataFile, JSON.stringify({
    version: 1,
    captureId: "11111111-1111-4111-8111-111111111111",
    sessionName: "test",
    projectRoot: root,
    backend: "jlink-hss",
    state: "stopped",
    transportStatus: "pass",
    dataQualityStatus: "pass",
    semanticValidationStatus: "not_run",
    payloadValidationStatus: "pass",
    artifact: {},
    target: {},
    probe: {},
    symbols: [],
    sampling: {},
    layout: {},
    targetState: {},
    segments: [],
    quality: {},
    events: [],
    warnings: [],
    failures: [],
    safety: {},
  }), "utf8");
  return metadataFile;
}

function plan(path: string): HssVariableWritePlan {
  return {
    writePlanId: "wp_test",
    captureId: "11111111-1111-4111-8111-111111111111",
    captureGeneration: 1,
    targetRef: { kind: "scalar", path },
    canonicalTarget: path,
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

function result(overrides: Partial<HssVariableWriteExecuteResult>): HssVariableWriteExecuteResult {
  return {
    writeId: `wr_${Math.random()}`,
    eventId: `evt_${Math.random()}`,
    captureId: "11111111-1111-4111-8111-111111111111",
    targetRef: { kind: "scalar", path: "Debug_IqRef" },
    canonicalTarget: "Debug_IqRef",
    newValue: 1,
    readbackOk: true,
    mismatches: [],
    writeStartUs: 1,
    writeEndUs: 2,
    sampleIndexNear: null,
    risk: "R2",
    consumedWriteOps: 1,
    consumedElements: 1,
    ...overrides,
  };
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-events-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
