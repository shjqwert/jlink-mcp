import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendHssWriteFlagIntervals, effectiveHssStatusFlags, hssFlagsFile, materializeHssFlagIntervals, readHssFlagIntervals } from "./hss-flag-overlay";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";

test("flag overlay appends write intervals and materializes capture.json", async () => {
  const root = await tempProject();
  try {
    const metadataFile = await writeMetadata(root);
    const intervals = await appendHssWriteFlagIntervals(metadataFile, { eventId: "evt_1", writeStartUs: 10_000, writeEndUs: 12_000, requestedRateHz: 1000, backendBusy: true });
    assert.equal(intervals.length, 3);
    assert.equal(existsSync(hssFlagsFile(metadataFile)), true);
    const loaded = await readHssFlagIntervals(metadataFile);
    assert.equal(loaded[0].reason, "write_nearby");
    assert.equal(loaded.some((interval) => interval.reason === "backend_busy"), true);
    assert.equal(effectiveHssStatusFlags(HSS_STATUS_FLAGS.valid, 10_500, loaded) & HSS_STATUS_FLAGS.write_in_progress, HSS_STATUS_FLAGS.write_in_progress);
    assert.equal(effectiveHssStatusFlags(HSS_STATUS_FLAGS.valid, 9_500, loaded) & HSS_STATUS_FLAGS.write_nearby, HSS_STATUS_FLAGS.write_nearby);
    await materializeHssFlagIntervals(metadataFile);
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    assert.equal(metadata.flagIntervals.length, 3);
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

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-flags-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
