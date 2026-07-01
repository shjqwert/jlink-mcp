import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HssCaptureMetadata, HssFlagInterval } from "./hss-contract";
import { HSS_STATUS_FLAGS } from "./hss-status-flags";

export function hssFlagsFile(metadataFile: string): string {
  return join(dirname(metadataFile), "capture.flags.jsonl");
}

export async function appendHssWriteFlagIntervals(metadataFile: string, input: { eventId?: string; writeStartUs: number; writeEndUs: number; requestedRateHz: number; backendBusy?: boolean }): Promise<HssFlagInterval[]> {
  const samplePeriodUs = input.requestedRateHz > 0 ? 1_000_000 / input.requestedRateHz : 1000;
  const nearbyWindowUs = Math.max(samplePeriodUs, 1000);
  const intervals: HssFlagInterval[] = [
    { eventId: input.eventId, startUs: input.writeStartUs, endUs: input.writeEndUs, flags: HSS_STATUS_FLAGS.write_in_progress, reason: "write_in_progress" },
    { eventId: input.eventId, startUs: Math.max(0, input.writeStartUs - nearbyWindowUs), endUs: input.writeEndUs + nearbyWindowUs, flags: HSS_STATUS_FLAGS.write_nearby, reason: "write_nearby" },
  ];
  if (input.backendBusy) intervals.push({ eventId: input.eventId, startUs: input.writeStartUs, endUs: input.writeEndUs, flags: HSS_STATUS_FLAGS.backend_busy, reason: "backend_busy" });
  await appendFile(hssFlagsFile(metadataFile), intervals.map((interval) => JSON.stringify(interval)).join("\n") + "\n", "utf8");
  return intervals;
}

export async function readHssFlagIntervals(metadataFile: string): Promise<HssFlagInterval[]> {
  const file = hssFlagsFile(metadataFile);
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HssFlagInterval)
    .sort((left, right) => left.startUs - right.startUs);
}

export async function materializeHssFlagIntervals(metadataFile: string): Promise<void> {
  const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as HssCaptureMetadata;
  metadata.flagIntervals = await readHssFlagIntervals(metadataFile);
  const tmp = `${metadataFile}.tmp`;
  await writeFile(tmp, JSON.stringify(metadata, null, 2), "utf8");
  await rename(tmp, metadataFile);
}

export function effectiveHssStatusFlags(baseFlags: number, sampleTimeUs: number, intervals: HssFlagInterval[]): number {
  let flags = baseFlags;
  for (const interval of intervals) {
    if (sampleTimeUs >= interval.startUs && sampleTimeUs <= interval.endUs) flags |= interval.flags;
  }
  return flags;
}
