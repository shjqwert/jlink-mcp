#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const metadataFile = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(metadataFile)) {
  console.error("usage: node scripts/hss-validate-mvp-b-capture.mjs <capture.json>");
  process.exit(2);
}

const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
const captureDir = dirname(metadataFile);
const writeEvents = Array.isArray(metadata.events) ? metadata.events.filter((event) => event.type === "variable_write") : [];
const quality = metadata.quality ?? {};
const safety = metadata.safety ?? {};
const targetState = metadata.targetState ?? {};
const checks = [
  ["metadata has variable_write events", writeEvents.length > 0],
  ["all variable_write events succeeded", writeEvents.length > 0 && writeEvents.every((event) => event.ok === true)],
  ["all variable_write events have readbackOk=true", writeEvents.length > 0 && writeEvents.every((event) => event.readbackOk === true)],
  ["metadata has flagIntervals", Array.isArray(metadata.flagIntervals) && metadata.flagIntervals.length > 0],
  ["capture.events.jsonl exists", existsSync(join(captureDir, "capture.events.jsonl"))],
  ["capture.flags.jsonl exists", existsSync(join(captureDir, "capture.flags.jsonl"))],
  ["segment metadata exists", Array.isArray(metadata.segments) && metadata.segments.length > 0],
  ["capture state is not failed", metadata.state !== "failed"],
  ["transportStatus is pass", metadata.transportStatus === "pass"],
  ["dataQualityStatus is pass", metadata.dataQualityStatus === "pass"],
  ["all samples are valid", quality.sampleCount > 0 && quality.validSamples === quality.sampleCount],
  ["no read errors/timeouts/drops", (quality.readErrors ?? 0) === 0 && (quality.timeouts ?? 0) === 0 && (quality.droppedSamples ?? 0) === 0],
  ["target was not halted before capture", targetState.targetWasHaltedBeforeCapture !== true],
  ["target was not halted after resume", targetState.targetWasHaltedAfterResume !== true],
  ["no reset/halt/flash issued", safety.targetReset !== true && safety.resetIssued !== true && safety.haltIssued !== true && safety.flashIssued !== true],
];

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  status: failed.length ? "failed" : "pass",
  captureId: metadata.captureId,
  checks: Object.fromEntries(checks),
}, null, 2));

if (failed.length) process.exit(1);
