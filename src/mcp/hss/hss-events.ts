import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { HSS_ERROR, HssError } from "./hss-errors";
import type { HssCaptureMetadata } from "./hss-contract";
import type { HssVariableWriteExecuteResult } from "./hss-write-execute";
import type { HssVariableWritePlan } from "./hss-write-plan";

export interface HssWriteEvent extends Record<string, unknown> {
  eventId: string;
  type: "variable_write";
  writeKind: "scalar" | "array_element" | "array_slice";
  writeId: string;
  captureId: string;
  canonicalTarget: string;
  targetRef: HssVariableWritePlan["targetRef"];
  ok: boolean;
  errorCode?: string;
}

const SIDECAR_LIMIT_BYTES = 4096;

export function hssEventsFile(metadataFile: string): string {
  return join(dirname(metadataFile), "capture.events.jsonl");
}

export async function appendHssWriteEvent(metadataFile: string, plan: HssVariableWritePlan, result: HssVariableWriteExecuteResult | undefined, ok: boolean, errorCode?: string): Promise<HssWriteEvent> {
  const event = await maybeSidecar(metadataFile, {
    eventId: result?.eventId ?? `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: "variable_write",
    writeKind: plan.targetRef.kind,
    writeId: result?.writeId ?? `wr_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    captureId: plan.captureId,
    target: plan.canonicalTarget,
    canonicalTarget: plan.canonicalTarget,
    targetRef: plan.targetRef,
    basePath: plan.targetRef.path,
    address: plan.address,
    baseAddress: plan.baseAddress,
    elementAddress: plan.elementAddress,
    dataType: plan.dataType,
    elementType: plan.elementType,
    byteSize: plan.byteSize,
    elementSize: plan.elementSize,
    arrayLength: plan.arrayLength,
    index: plan.targetRef.kind === "array_element" ? plan.targetRef.index : undefined,
    startIndex: plan.targetRef.kind === "array_slice" ? plan.targetRef.startIndex : undefined,
    elementCount: plan.writeElementCount,
    writeByteCount: plan.writeByteCount,
    oldValue: result?.oldValue,
    oldValues: result?.oldValues,
    newValue: result?.newValue,
    newValues: result?.newValues,
    readback: result?.readback,
    readbackValues: result?.readbackValues,
    readbackOk: result?.readbackOk ?? false,
    mismatches: result?.mismatches ?? [],
    writeStartUs: result?.writeStartUs ?? Date.now() * 1000,
    writeEndUs: result?.writeEndUs ?? Date.now() * 1000,
    sampleIndexNear: result?.sampleIndexNear ?? null,
    risk: plan.risk,
    policyHash: plan.policyHash,
    symbolLayoutHash: plan.symbolLayoutHash,
    ok,
    errorCode,
  });
  try {
    await appendFile(hssEventsFile(metadataFile), JSON.stringify(event) + "\n", "utf8");
  } catch (error) {
    throw new HssError(HSS_ERROR.WRITE_EVENT_APPEND_FAILED, "failed to append capture write event", { metadataFile, reason: error instanceof Error ? error.message : String(error) });
  }
  return event;
}

export async function readHssCaptureEvents(metadataFile: string): Promise<HssWriteEvent[]> {
  const file = hssEventsFile(metadataFile);
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HssWriteEvent)
    .sort((left, right) => Number(left.writeStartUs ?? 0) - Number(right.writeStartUs ?? 0));
}

export async function materializeHssCaptureEvents(metadataFile: string): Promise<void> {
  const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as HssCaptureMetadata;
  const helperEvents = metadata.events.filter((event) => event.type !== "variable_write");
  metadata.events = [...await readHssCaptureEvents(metadataFile), ...helperEvents];
  const tmp = `${metadataFile}.tmp`;
  await writeFile(tmp, JSON.stringify(metadata, null, 2), "utf8");
  await rename(tmp, metadataFile);
}

async function maybeSidecar(metadataFile: string, event: HssWriteEvent): Promise<HssWriteEvent> {
  const text = JSON.stringify(event);
  if (text.length <= SIDECAR_LIMIT_BYTES) return event;
  const eventDir = join(dirname(metadataFile), "events");
  await mkdir(eventDir, { recursive: true });
  const sidecarFile = join(eventDir, `${event.eventId}.json`);
  await writeFile(sidecarFile, text, "utf8");
  return {
    ...event,
    oldValues: undefined,
    newValues: undefined,
    readbackValues: undefined,
    mismatches: undefined,
    sidecarArtifact: {
      file: sidecarFile,
      crc32: crc32(Buffer.from(text)),
    },
  };
}

function crc32(buffer: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}
