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
const checks = [
  ["metadata has variable_write events", Array.isArray(metadata.events) && metadata.events.some((event) => event.type === "variable_write")],
  ["metadata has flagIntervals", Array.isArray(metadata.flagIntervals) && metadata.flagIntervals.length > 0],
  ["capture.events.jsonl exists", existsSync(join(captureDir, "capture.events.jsonl"))],
  ["capture.flags.jsonl exists", existsSync(join(captureDir, "capture.flags.jsonl"))],
  ["segment metadata exists", Array.isArray(metadata.segments) && metadata.segments.length > 0],
];

const failed = checks.filter(([, ok]) => !ok);
console.log(JSON.stringify({
  status: failed.length ? "failed" : "pass",
  captureId: metadata.captureId,
  checks: Object.fromEntries(checks),
}, null, 2));

if (failed.length) process.exit(1);
