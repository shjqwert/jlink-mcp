import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { HSS_SAFETY_FALSE, type HssCaptureMetadata, type HssResolvedSymbol, type HssScalarType, type HssValidationStatus } from "./hss-contract";
import { readHssCaptureEvents } from "./hss-events";
import { effectiveHssStatusFlags, readHssFlagIntervals } from "./hss-flag-overlay";
import { assertNoMvpAWriteFlags, HSS_STATUS_FLAGS } from "./hss-status-flags";
import { HSS_ERROR, HssError } from "./hss-errors";
import { assertInsideProject, hssProjectPaths } from "./project-paths";

export interface HssSampleRecord {
  sampleIndex: bigint;
  timestampTicks: bigint;
  statusFlags: number;
  rawValues: number[];
}

export interface HssQueryInput {
  captureId: string;
  metadataFile?: string;
  variables?: string[];
  startSec?: number;
  endSec?: number;
  buckets?: number;
  includeRawSamples?: boolean;
  maxSamples?: number;
  hmC095Profile?: boolean;
  mode?: "event_window";
  eventId?: string;
  windowBeforeMs?: number;
  windowAfterMs?: number;
  flagFilter?: {
    exclude?: Array<"write_in_progress" | "write_nearby" | "backend_busy">;
    includeNearby?: boolean;
  };
  summary?: Array<"avg" | "min" | "max" | "first" | "last" | "delta">;
}

const PAYLOAD_CHANGED_RATIO_PASS = 0.5;
const READ_ERROR_FAILED_RATIO = 0.01;

export async function writeInitialMetadata(input: {
  metadataFile: string;
  captureId: string;
  sessionName: string;
  projectRoot: string;
  artifact: HssCaptureMetadata["artifact"];
  target: HssCaptureMetadata["target"];
  probe?: HssCaptureMetadata["probe"];
  symbols: HssResolvedSymbol[];
  requestedRateHz: number;
  readMode?: "periodic" | "drain";
  resumeBeforeStart?: boolean;
  targetWasHaltedBeforeCapture?: boolean;
  warnings?: string[];
}): Promise<void> {
  const metadata: HssCaptureMetadata = {
    version: 1,
    captureId: input.captureId,
    sessionName: input.sessionName,
    projectRoot: input.projectRoot,
    backend: "jlink-hss",
    state: "failed",
    transportStatus: "failed",
    dataQualityStatus: "not_run",
    semanticValidationStatus: "not_run",
    payloadValidationStatus: "not_run",
    artifact: input.artifact,
    target: input.target,
    probe: input.probe ?? {},
    symbols: input.symbols,
    sampling: {
      requestedRateHz: input.requestedRateHz,
      actualRateHz: 0,
      hssIndexRateHz: 0,
      hostObservedRateHz: 0,
      helperReportedRateHz: 0,
      helperActualRateHz: 0,
      readMode: input.readMode ?? "periodic",
      durationSec: 0,
      timestampSource: "qpc",
      timestampFrequency: "1000000000",
    },
    layout: emptyLayout(input.symbols),
    targetState: {
      targetWasHaltedBeforeCapture: Boolean(input.targetWasHaltedBeforeCapture),
      resumeBeforeStart: Boolean(input.resumeBeforeStart),
      resumeIssued: false,
      targetWasHaltedAfterResume: null,
    },
    segments: [],
    quality: emptyQuality(),
    events: [],
    warnings: input.warnings ?? [],
    failures: [],
    safety: HSS_SAFETY_FALSE,
  };
  await writeFile(input.metadataFile, JSON.stringify(metadata, null, 2), "utf8");
}

export async function finalizeMetadata(input: {
  metadataFile: string;
  state: "completed" | "stopped" | "failed";
  segmentFile: string;
  helperResult?: Record<string, unknown>;
  failure?: string;
}): Promise<HssCaptureMetadata> {
  const metadata = await readHssMetadata(input.metadataFile);
  const recordSize = 24 + metadata.symbols.length * 4;
  let records: HssSampleRecord[] = [];
  let decodeFailure: string | undefined;
  try {
    records = await readHssRecords(input.segmentFile, metadata.symbols.length, recordSize);
  } catch (error) {
    decodeFailure = error instanceof Error ? error.message : String(error);
  }
  const helperResult = input.helperResult ?? {};
  const segmentCrc = existsSync(input.segmentFile) ? await crc32File(input.segmentFile) : "00000000";
  const hssIndexRateHz = actualRate(records);
  const helperActualRateHz = numberField(helperResult, "actualRateHz") ?? 0;
  const hostObservedRateHz = helperActualRateHz || hssIndexRateHz;
  metadata.state = input.state;
  metadata.sampling.actualRateHz = hssIndexRateHz;
  metadata.sampling.hssIndexRateHz = hssIndexRateHz;
  metadata.sampling.hostObservedRateHz = hostObservedRateHz;
  metadata.sampling.helperReportedRateHz = helperActualRateHz;
  metadata.sampling.helperActualRateHz = helperActualRateHz;
  metadata.sampling.readMode = textField(helperResult, "readMode", metadata.sampling.readMode) as "periodic" | "drain";
  metadata.sampling.durationSec = numberField(helperResult, "durationSec") ?? durationSec(records);
  metadata.segments = [{
    file: "capture_0001.bin",
    sampleStart: 0,
    sampleCount: records.length,
    recordSize,
    crc32: segmentCrc,
  }];
  metadata.quality = qualityFromRecords(records, hssIndexRateHz);
  metadata.layout = layoutFromRecords(records, metadata.symbols, helperResult);
  metadata.payloadValidationStatus = payloadValidationStatus(metadata.quality, metadata.layout);
  metadata.transportStatus = transportStatus(input.state, metadata.quality);
  metadata.dataQualityStatus = dataQualityStatus(metadata.quality, metadata.payloadValidationStatus, decodeFailure);
  metadata.safety = { ...HSS_SAFETY_FALSE, resumeIssued: boolField(helperResult, "resumeIssued") };
  metadata.targetState = {
    targetWasHaltedBeforeCapture: boolField(helperResult, "targetWasHaltedBeforeResume") || metadata.targetState.targetWasHaltedBeforeCapture,
    resumeBeforeStart: boolField(helperResult, "resumeBeforeStart") || metadata.targetState.resumeBeforeStart,
    resumeIssued: boolField(helperResult, "resumeIssued"),
    targetWasHaltedAfterResume: booleanOrNull(helperResult, "targetWasHaltedAfterResume"),
    targetWasHaltedBeforeResume: boolField(helperResult, "targetWasHaltedBeforeResume"),
    targetHaltedBeforeResumeRaw: numberField(helperResult, "targetHaltedBeforeResumeRaw"),
    targetHaltedAfterResumeRaw: numberField(helperResult, "targetHaltedAfterResumeRaw"),
  };
  metadata.hmC095 = hmC095Validation(records, metadata.symbols, hssIndexRateHz || metadata.sampling.requestedRateHz, metadata);
  metadata.semanticValidationStatus = semanticValidationStatus(metadata.hmC095);
  if (decodeFailure) metadata.failures.push(decodeFailure);
  if (input.failure) metadata.failures.push(input.failure);
  metadata.events = [...await readHssCaptureEvents(input.metadataFile), ...(input.helperResult ? [{ type: "helperResult", helperResult: input.helperResult }] : [])];
  metadata.flagIntervals = await readHssFlagIntervals(input.metadataFile);
  await writeFile(input.metadataFile, JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

export async function hssCaptureStatusFromMetadata(metadataFile: string): Promise<Record<string, unknown>> {
  if (!existsSync(metadataFile)) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "capture metadata was not found", { metadataFile });
  const metadata = await readHssMetadata(metadataFile);
  return {
    captureId: metadata.captureId,
    state: metadata.state,
    transportStatus: metadata.transportStatus,
    dataQualityStatus: metadata.dataQualityStatus,
    semanticValidationStatus: metadata.semanticValidationStatus,
    payloadValidationStatus: metadata.payloadValidationStatus,
    elapsedSec: metadata.sampling.durationSec,
    requestedRateHz: metadata.sampling.requestedRateHz,
    actualRateHz: metadata.quality.actualRateHz,
    sampling: metadata.sampling,
    sampleCount: metadata.quality.sampleCount,
    validSamples: metadata.quality.validSamples,
    readErrors: metadata.quality.readErrors,
    timeouts: metadata.quality.timeouts,
    overflows: metadata.quality.overflows,
    droppedSamples: metadata.quality.droppedSamples,
    currentSegment: metadata.segments[0]?.file ?? "capture_0001.bin",
    warnings: metadata.warnings,
  };
}

export async function hssCaptureStopFromMetadata(metadataFile: string): Promise<Record<string, unknown>> {
  if (!existsSync(metadataFile)) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "capture metadata was not found", { metadataFile });
  const metadata = await readHssMetadata(metadataFile);
  const captureDir = dirname(metadataFile);
  return {
    captureId: metadata.captureId,
    state: metadata.state,
    transportStatus: metadata.transportStatus,
    dataQualityStatus: metadata.dataQualityStatus,
    semanticValidationStatus: metadata.semanticValidationStatus,
    payloadValidationStatus: metadata.payloadValidationStatus,
    metadataFile,
    segments: metadata.segments.map((segment) => ({ ...segment, file: join(captureDir, segment.file) })),
    quality: metadata.quality,
    safety: metadata.safety,
    targetState: metadata.targetState,
    warnings: metadata.warnings,
  };
}

export async function queryHssCapture(input: HssQueryInput, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const metadataFile = metadataPathForCapture(input.captureId, input.metadataFile, cwd);
  const metadata = await readMetadataForCapture(input.captureId, metadataFile, cwd);
  if (metadata.state !== "completed" && metadata.state !== "stopped" && metadata.state !== "failed") {
    throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_TERMINAL, "capture is not terminal");
  }
  const segment = metadata.segments[0];
  if (!segment) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "capture has no segment metadata");
  assertInsideProject(metadata.projectRoot, cwd);
  const captureDir = dirname(metadataFile);
  assertInsideProject(captureDir, cwd);
  const segmentFile = join(captureDir, segment.file);
  assertInsideProject(segmentFile, captureDir);
  const actualCrc = await crc32File(segmentFile);
  if (actualCrc !== segment.crc32) throw new HssError(HSS_ERROR.HSS_CRC_MISMATCH, "capture segment CRC mismatch", { expected: segment.crc32, actual: actualCrc });
  const records = applyFlagOverlays(await readHssRecords(segmentFile, metadata.symbols.length, segment.recordSize), await readHssFlagIntervals(metadataFile));
  const selected = selectSymbols(metadata.symbols, input.variables);
  const eventWindow = input.mode === "event_window" ? eventWindowSelection(records, metadata.events, input) : undefined;
  const filteredByTime = eventWindow ? eventWindow.records : filterByTime(records, input.startSec, input.endSec);
  const filtered = filterByFlags(filteredByTime, input.flagFilter);
  const buckets = bucketRecords(filtered, selected, metadata.sampling.actualRateHz, input.buckets ?? 100);
  const rawSamples = input.includeRawSamples ? decimateRaw(filtered, selected, input.maxSamples ?? 10000) : undefined;
  const warnings = input.includeRawSamples && rawSamples && rawSamples.length < filtered.length
    ? [`raw samples decimated from ${filtered.length} to ${rawSamples.length}`]
    : [];
  if (eventWindow?.warnings.length) warnings.push(...eventWindow.warnings);
  return {
    captureId: metadata.captureId,
    variables: selected.map(({ symbol }) => symbol),
    buckets,
    rawSamples,
    sampling: metadata.sampling,
    quality: metadata.quality,
    transportStatus: metadata.transportStatus,
    dataQualityStatus: metadata.dataQualityStatus,
    semanticValidationStatus: metadata.semanticValidationStatus,
    payloadValidationStatus: metadata.payloadValidationStatus,
    layout: metadata.layout,
    eventWindow: eventWindow ? {
      eventId: input.eventId,
      startSec: eventWindow.startUs / 1_000_000,
      endSec: eventWindow.endUs / 1_000_000,
      sampleCount: filtered.length,
      summary: summarizeRecords(filtered, selected),
    } : undefined,
    warnings,
    hmC095: input.hmC095Profile === false ? undefined : hmC095Validation(records, metadata.symbols, metadata.sampling.hssIndexRateHz || metadata.sampling.actualRateHz || metadata.sampling.requestedRateHz, metadata),
  };
}

export async function exportHssCapture(input: { captureId: string; metadataFile?: string; format?: "csv"; variables?: string[] }, cwd = process.cwd()): Promise<Record<string, unknown>> {
  if (input.format && input.format !== "csv") throw new Error("only CSV export is supported");
  const metadataFile = metadataPathForCapture(input.captureId, input.metadataFile, cwd);
  const metadata = await readMetadataForCapture(input.captureId, metadataFile, cwd);
  if (metadata.state !== "completed" && metadata.state !== "stopped" && metadata.state !== "failed") throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_TERMINAL, "capture is not terminal");
  const segment = metadata.segments[0];
  if (!segment) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "capture has no segment metadata");
  assertInsideProject(metadata.projectRoot, cwd);
  const paths = hssProjectPaths(cwd);
  const captureDir = dirname(metadataFile);
  assertInsideProject(captureDir, cwd);
  const segmentFile = join(captureDir, segment.file);
  assertInsideProject(segmentFile, captureDir);
  if (await crc32File(segmentFile) !== segment.crc32) throw new HssError(HSS_ERROR.HSS_CRC_MISMATCH, "capture segment CRC mismatch");
  const records = await readHssRecords(segmentFile, metadata.symbols.length, segment.recordSize);
  const selected = selectSymbols(metadata.symbols, input.variables);
  const csvFile = nextCsvFile(paths.exportsDir, input.captureId);
  assertInsideProject(csvFile, paths.exportsDir);
  await mkdir(paths.exportsDir, { recursive: true });
  const stream = createWriteStream(csvFile, { flags: "wx", encoding: "utf8" });
  try {
    await once(stream, "open");
    await writeLine(stream, ["sampleIndex", "timeSec", "timestampTicks", "statusFlags", ...selected.map(({ symbol }) => symbol.name)].join(",") + "\n");
    const firstTicks = records[0]?.timestampTicks ?? 0n;
    for (const record of records) {
      await writeLine(stream, [
        record.sampleIndex.toString(),
        String(Number(record.timestampTicks - firstTicks) / 1_000_000_000),
        record.timestampTicks.toString(),
        String(record.statusFlags),
        ...selected.map(({ index, symbol }) => String(decodeValue(symbol.type, record.rawValues[index]))),
      ].join(",") + "\n");
    }
    stream.end();
    await once(stream, "close");
    return {
      captureId: input.captureId,
      csvFile,
      rows: records.length,
      readMode: metadata.sampling.readMode,
      sampling: metadata.sampling,
      transportStatus: metadata.transportStatus,
      dataQualityStatus: metadata.dataQualityStatus,
      semanticValidationStatus: metadata.semanticValidationStatus,
      payloadValidationStatus: metadata.payloadValidationStatus,
    };
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

export async function readHssMetadata(file: string): Promise<HssCaptureMetadata> {
  return JSON.parse(await readFile(file, "utf8")) as HssCaptureMetadata;
}

export async function readMetadataForCapture(captureId: string, metadataFile: string | undefined, cwd = process.cwd()): Promise<HssCaptureMetadata> {
  const file = metadataFile ?? join(hssProjectPaths(cwd).capturesDir, captureId, "capture.json");
  assertInsideProject(file, cwd);
  const metadata = await readHssMetadata(file);
  if (metadata.captureId !== captureId) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "captureId does not match metadata");
  return metadata;
}

function metadataPathForCapture(captureId: string, metadataFile: string | undefined, cwd: string): string {
  const paths = hssProjectPaths(cwd);
  assertInsideProject(join(paths.capturesDir, captureId), paths.capturesDir);
  const file = metadataFile ?? join(paths.capturesDir, captureId, "capture.json");
  assertInsideProject(file, cwd);
  return file;
}

export async function readHssRecords(file: string, symbolCount: number, recordSize: number): Promise<HssSampleRecord[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file)) chunks.push(chunk as Buffer);
  const data = Buffer.concat(chunks);
  if (data.length % recordSize !== 0) throw new Error("capture segment has partial record");
  const records: HssSampleRecord[] = [];
  for (let offset = 0; offset < data.length; offset += recordSize) {
    const statusFlags = data.readUInt32LE(offset + 16);
    assertNoMvpAWriteFlags(statusFlags);
    records.push({
      sampleIndex: data.readBigUInt64LE(offset),
      timestampTicks: data.readBigInt64LE(offset + 8),
      statusFlags,
      rawValues: Array.from({ length: symbolCount }, (_, index) => data.readUInt32LE(offset + 24 + index * 4)),
    });
  }
  return records;
}

export function encodeHssRecord(record: HssSampleRecord, symbolCount: number): Buffer {
  const buffer = Buffer.alloc(24 + symbolCount * 4);
  buffer.writeBigUInt64LE(record.sampleIndex, 0);
  buffer.writeBigInt64LE(record.timestampTicks, 8);
  buffer.writeUInt32LE(record.statusFlags, 16);
  buffer.writeUInt32LE(0, 20);
  record.rawValues.forEach((value, index) => buffer.writeUInt32LE(value >>> 0, 24 + index * 4));
  return buffer;
}

export async function crc32File(file: string): Promise<string> {
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(file)) {
    for (const byte of chunk as Buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

function qualityFromRecords(records: HssSampleRecord[], actualRateHz: number): HssCaptureMetadata["quality"] {
  return {
    sampleCount: records.length,
    validSamples: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.valid) !== 0).length,
    readErrors: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.read_error) !== 0).length,
    timeouts: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.timeout) !== 0).length,
    overflows: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.overflow) !== 0).length,
    droppedSamples: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.dropped_before_this_sample) !== 0).length,
    targetHaltedSamples: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.target_halted) !== 0).length,
    actualRateHz,
  };
}

function emptyQuality(): HssCaptureMetadata["quality"] {
  return { sampleCount: 0, validSamples: 0, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, targetHaltedSamples: 0, actualRateHz: 0 };
}

function emptyLayout(symbols: HssResolvedSymbol[]): HssCaptureMetadata["layout"] {
  const bytesPerSample = symbols.reduce((sum, symbol) => sum + symbol.size, 0);
  return {
    hssSampleHeaderBytes: 4,
    hssSampleStrideBytes: 4 + bytesPerSample,
    bytesPerSample,
    hssBlockCount: 0,
    readBufferBytes: 0,
    firstChangedOffset: null,
    firstChangedBytes: "",
    headerChangedRatio: 0,
    payloadChangedRatio: 0,
    payloadFirstChangedOffset: null,
    payloadFirstChangedBytes: "",
    payloadAllConstant: true,
    payloadAllZero: true,
  };
}

function layoutFromRecords(records: HssSampleRecord[], symbols: HssResolvedSymbol[], helperResult: Record<string, unknown>): HssCaptureMetadata["layout"] {
  const layout = emptyLayout(symbols);
  layout.hssSampleHeaderBytes = numberField(helperResult, "hssSampleHeaderBytes") ?? layout.hssSampleHeaderBytes;
  layout.hssSampleStrideBytes = numberField(helperResult, "hssSampleStrideBytes") ?? layout.hssSampleStrideBytes;
  layout.bytesPerSample = numberField(helperResult, "bytesPerSample") ?? layout.bytesPerSample;
  layout.hssBlockCount = numberField(helperResult, "hssBlockCount") ?? layout.hssBlockCount;
  layout.readBufferBytes = numberField(helperResult, "readBufferBytes") ?? layout.readBufferBytes;
  const firstChangedOffset = numberField(helperResult, "firstChangedOffset");
  layout.firstChangedOffset = firstChangedOffset !== undefined && firstChangedOffset >= 0 ? firstChangedOffset : null;
  layout.firstChangedBytes = textField(helperResult, "firstChangedBytes", "");

  const validRecords = validPayloadRecords(records);
  layout.headerChangedRatio = ratioOfChanges(validRecords.map((record) => Number(record.sampleIndex & 0xffffffffn)));
  layout.payloadChangedRatio = ratioOfChanges(validRecords.map((record) => record.rawValues.join(",")));
  layout.payloadAllConstant = layout.payloadChangedRatio === 0;
  layout.payloadAllZero = validRecords.length === 0 || validRecords.every((record) => record.rawValues.every((value) => value === 0));

  const helperHeaderRatio = numberField(helperResult, "headerChangedRatio");
  const helperPayloadRatio = numberField(helperResult, "payloadChangedRatio");
  if (helperHeaderRatio !== undefined) layout.headerChangedRatio = helperHeaderRatio;
  if (helperPayloadRatio !== undefined) layout.payloadChangedRatio = helperPayloadRatio;

  const helperPayloadOffset = numberField(helperResult, "payloadFirstChangedOffset");
  layout.payloadFirstChangedOffset = helperPayloadOffset !== undefined && helperPayloadOffset >= 0 ? helperPayloadOffset : firstPayloadChangedOffset(validRecords, symbols);
  layout.payloadFirstChangedBytes = textField(helperResult, "payloadFirstChangedBytes", firstPayloadChangedBytes(validRecords, symbols));
  if (layout.firstChangedOffset === null && layout.headerChangedRatio > 0) layout.firstChangedOffset = 0;
  return layout;
}

function payloadValidationStatus(quality: HssCaptureMetadata["quality"], layout: HssCaptureMetadata["layout"]): HssValidationStatus {
  if (quality.sampleCount === 0 || quality.validSamples === 0) return "failed";
  if (layout.payloadAllZero || layout.payloadAllConstant) return "failed";
  if (layout.payloadChangedRatio >= PAYLOAD_CHANGED_RATIO_PASS) return "pass";
  return layout.payloadChangedRatio > 0 ? "warning" : "failed";
}

function transportStatus(state: HssCaptureMetadata["state"], quality: HssCaptureMetadata["quality"]): HssCaptureMetadata["transportStatus"] {
  return state !== "failed" && quality.sampleCount > 0 ? "pass" : "failed";
}

function dataQualityStatus(quality: HssCaptureMetadata["quality"], payloadStatus: HssValidationStatus, decodeFailure?: string): HssValidationStatus {
  if (decodeFailure || quality.sampleCount === 0 || quality.validSamples === 0 || payloadStatus === "failed") return "failed";
  const readErrorRatio = quality.readErrors / quality.sampleCount;
  if (readErrorRatio > READ_ERROR_FAILED_RATIO) return "failed";
  if (quality.readErrors > 0 || payloadStatus === "warning" || quality.validSamples / quality.sampleCount < 0.99) return "warning";
  return "pass";
}

function semanticValidationStatus(hmC095: Record<string, unknown> | undefined): HssValidationStatus {
  if (!hmC095 || hmC095.counterPresent === false || hmC095.counterDeltaPass === undefined) return "not_run";
  return hmC095.semanticPass === true ? "pass" : "failed";
}


function actualRate(records: HssSampleRecord[]): number {
  if (records.length < 2) return 0;
  const elapsedSec = durationSec(records);
  return elapsedSec > 0 ? (records.length - 1) / elapsedSec : 0;
}

function durationSec(records: HssSampleRecord[]): number {
  if (records.length < 2) return 0;
  return Number(records.at(-1)!.timestampTicks - records[0].timestampTicks) / 1_000_000_000;
}

function selectSymbols(symbols: HssResolvedSymbol[], requested?: string[]): Array<{ symbol: HssResolvedSymbol; index: number }> {
  if (!requested?.length) return symbols.map((symbol, index) => ({ symbol, index }));
  return requested.map((name) => {
    const index = symbols.findIndex((symbol) => symbol.name === name || symbol.alias === name);
    if (index < 0) throw new HssError(HSS_ERROR.SYMBOL_NOT_FOUND, `unknown capture variable: ${name}`);
    return { symbol: symbols[index], index };
  });
}

function filterByTime(records: HssSampleRecord[], startSec = 0, endSec = Number.POSITIVE_INFINITY): HssSampleRecord[] {
  const first = records[0]?.timestampTicks ?? 0n;
  return records.filter((record) => {
    const timeSec = Number(record.timestampTicks - first) / 1_000_000_000;
    return timeSec >= startSec && timeSec <= endSec;
  });
}

function bucketRecords(records: HssSampleRecord[], selected: Array<{ symbol: HssResolvedSymbol; index: number }>, actualRateHz: number, buckets: number): Array<Record<string, unknown>> {
  if (!records.length) return [];
  const bucketCount = Math.min(Math.max(1, buckets), records.length);
  const result = Array.from({ length: bucketCount }, (_, index) => ({ index, count: 0, values: selected.map(() => ({ min: Infinity, max: -Infinity, sum: 0 })) }));
  records.forEach((record, recordIndex) => {
    const bucket = result[Math.min(bucketCount - 1, Math.floor(recordIndex * bucketCount / records.length))];
    bucket.count += 1;
    selected.forEach(({ symbol, index }, selectedIndex) => {
      const value = decodeValue(symbol.type, record.rawValues[index]);
      bucket.values[selectedIndex].min = Math.min(bucket.values[selectedIndex].min, value);
      bucket.values[selectedIndex].max = Math.max(bucket.values[selectedIndex].max, value);
      bucket.values[selectedIndex].sum += value;
    });
  });
  return result.map((bucket) => ({
    startSec: actualRateHz > 0 ? bucket.index * records.length / bucketCount / actualRateHz : bucket.index,
    count: bucket.count,
    values: Object.fromEntries(selected.map(({ symbol }, index) => {
      const value = bucket.values[index];
      return [symbol.name, { min: value.min, max: value.max, average: bucket.count ? value.sum / bucket.count : null }];
    })),
  }));
}

function decimateRaw(records: HssSampleRecord[], selected: Array<{ symbol: HssResolvedSymbol; index: number }>, maxSamples: number): Array<Record<string, unknown>> {
  const stride = records.length > maxSamples ? Math.ceil(records.length / maxSamples) : 1;
  const first = records[0]?.timestampTicks ?? 0n;
  return records.filter((_, index) => index % stride === 0).map((record) => ({
    sampleIndex: record.sampleIndex.toString(),
    timeSec: Number(record.timestampTicks - first) / 1_000_000_000,
    statusFlags: record.statusFlags,
    effectiveStatusFlags: record.statusFlags,
    values: Object.fromEntries(selected.map(({ symbol, index }) => [symbol.name, decodeValue(symbol.type, record.rawValues[index])])),
  }));
}

function applyFlagOverlays(records: HssSampleRecord[], intervals: NonNullable<HssCaptureMetadata["flagIntervals"]>): HssSampleRecord[] {
  if (!intervals.length || !records.length) return records;
  const firstTicks = records[0].timestampTicks;
  return records.map((record) => ({
    ...record,
    statusFlags: effectiveHssStatusFlags(record.statusFlags, Number(record.timestampTicks - firstTicks) / 1000, intervals),
  }));
}

function eventWindowSelection(records: HssSampleRecord[], events: Array<Record<string, unknown>>, input: HssQueryInput): { records: HssSampleRecord[]; startUs: number; endUs: number; warnings: string[] } {
  if (!input.eventId) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "eventId is required for event_window query");
  const event = events.find((candidate) => candidate.type === "variable_write" && candidate.eventId === input.eventId);
  if (!event) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "capture event was not found", { eventId: input.eventId });
  const firstTicks = records[0]?.timestampTicks ?? 0n;
  const bySampleIndex = typeof event.sampleIndexNear === "number"
    ? records.find((record) => Number(record.sampleIndex) === event.sampleIndexNear)
    : undefined;
  const centerUs = bySampleIndex
    ? Number(bySampleIndex.timestampTicks - firstTicks) / 1000
    : Number(event.writeStartUs ?? 0);
  const startUs = Math.max(0, centerUs - (input.windowBeforeMs ?? 100) * 1000);
  const endUs = centerUs + (input.windowAfterMs ?? 100) * 1000;
  const selected = records.filter((record) => {
    const timeUs = Number(record.timestampTicks - firstTicks) / 1000;
    return timeUs >= startUs && timeUs <= endUs;
  });
  const warnings: string[] = [];
  if (!selected.length) warnings.push("event window contains no samples");
  if (records.length && startUs < Number(records[0].timestampTicks - firstTicks) / 1000) warnings.push("before window is incomplete");
  if (records.length && endUs > Number(records.at(-1)!.timestampTicks - firstTicks) / 1000) warnings.push("after window is incomplete");
  return { records: selected, startUs, endUs, warnings };
}

function filterByFlags(records: HssSampleRecord[], flagFilter?: HssQueryInput["flagFilter"]): HssSampleRecord[] {
  const exclude = flagFilter?.exclude ?? [];
  if (!exclude.length) return records;
  const mask = exclude.reduce((flags, name) => flags | HSS_STATUS_FLAGS[name], 0);
  return records.filter((record) => (record.statusFlags & mask) === 0);
}

function summarizeRecords(records: HssSampleRecord[], selected: Array<{ symbol: HssResolvedSymbol; index: number }>): Record<string, unknown> {
  return Object.fromEntries(selected.map(({ symbol, index }) => {
    const values = records.map((record) => decodeValue(symbol.type, record.rawValues[index]));
    if (!values.length) return [symbol.name, { count: 0 }];
    return [symbol.name, {
      count: values.length,
      first: values[0],
      last: values.at(-1),
      delta: values.at(-1)! - values[0],
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    }];
  }));
}

function decodeValue(type: HssScalarType, raw: number): number {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(raw >>> 0, 0);
  switch (type) {
    case "int8": return buffer.readInt8(0);
    case "uint8": return buffer.readUInt8(0);
    case "int16": return buffer.readInt16LE(0);
    case "uint16": return buffer.readUInt16LE(0);
    case "int32": return buffer.readInt32LE(0);
    case "uint32": return raw >>> 0;
    case "float32": return buffer.readFloatLE(0);
  }
}

function validPayloadRecords(records: HssSampleRecord[]): HssSampleRecord[] {
  const errorMask = HSS_STATUS_FLAGS.read_error
    | HSS_STATUS_FLAGS.timeout
    | HSS_STATUS_FLAGS.overflow
    | HSS_STATUS_FLAGS.dropped_before_this_sample;
  return records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.valid) !== 0 && (record.statusFlags & errorMask) === 0);
}

function ratioOfChanges<T>(values: T[]): number {
  if (values.length < 2) return 0;
  let changed = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1]) changed += 1;
  }
  return changed / (values.length - 1);
}

function symbolPayloadOffsets(symbols: HssResolvedSymbol[]): number[] {
  const parsed = symbols.map((symbol, index) => ({ index, address: Number.parseInt(symbol.address.slice(2), 16), size: symbol.size }));
  parsed.sort((left, right) => left.address === right.address ? left.index - right.index : left.address - right.address);
  const offsets = Array.from({ length: symbols.length }, () => 0);
  let offset = 0;
  for (const item of parsed) {
    offsets[item.index] = offset;
    offset += item.size;
  }
  return offsets;
}

function firstPayloadChangedOffset(records: HssSampleRecord[], symbols: HssResolvedSymbol[]): number | null {
  const offsets = symbolPayloadOffsets(symbols);
  for (let recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
    for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
      if (records[recordIndex].rawValues[symbolIndex] !== records[recordIndex - 1].rawValues[symbolIndex]) return 4 + offsets[symbolIndex];
    }
  }
  return null;
}

function firstPayloadChangedBytes(records: HssSampleRecord[], symbols: HssResolvedSymbol[]): string {
  for (let recordIndex = 1; recordIndex < records.length; recordIndex += 1) {
    for (let symbolIndex = 0; symbolIndex < symbols.length; symbolIndex += 1) {
      if (records[recordIndex].rawValues[symbolIndex] !== records[recordIndex - 1].rawValues[symbolIndex]) {
        const buffer = Buffer.allocUnsafe(4);
        buffer.writeUInt32LE(records[recordIndex].rawValues[symbolIndex] >>> 0, 0);
        return buffer.subarray(0, symbols[symbolIndex].size).toString("hex");
      }
    }
  }
  return "";
}

function numberField(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolField(source: Record<string, unknown>, name: string): boolean {
  return source[name] === true;
}

function booleanOrNull(source: Record<string, unknown>, name: string): boolean | null {
  return typeof source[name] === "boolean" ? source[name] as boolean : null;
}

function textField(source: Record<string, unknown>, name: string, fallback: string): string {
  return typeof source[name] === "string" ? source[name] : fallback;
}

function nextCsvFile(exportsDir: string, captureId: string): string {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `_${String(index).padStart(3, "0")}`;
    const file = join(exportsDir, `${captureId}${suffix}.csv`);
    if (!existsSync(file)) return file;
  }
  throw new HssError(HSS_ERROR.HSS_EXPORT_EXISTS, "all CSV export names for this capture already exist", { captureId, exportsDir });
}

function hmC095Validation(records: HssSampleRecord[], symbols: HssResolvedSymbol[], actualRateHz: number, metadata?: HssCaptureMetadata): Record<string, unknown> {
  const counterIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgCounterFocIsr");
  const sawIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgSawFocIsr");
  const toggleIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgToggleFocIsr");
  const patternIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgPatternFocIsr");
  const validRecords = validPayloadRecords(records);
  const counter = counterIndex >= 0 ? validRecords.map((record) => record.rawValues[counterIndex] >>> 0) : [];
  const deltas: number[] = [];
  for (let index = 1; index < counter.length; index += 1) deltas.push((counter[index] - counter[index - 1]) >>> 0);
  const expected = actualRateHz > 0 ? 16000 / actualRateHz : null;
  const mean = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null;
  const nonZeroDeltaRatio = deltas.length ? deltas.filter((value) => value > 0).length / deltas.length : 0;
  const counterChangedRatio = ratioOfChanges(counter);
  const counterAllConstant = counter.length > 0 && counterChangedRatio === 0;
  const sawPass = sawIndex < 0 || counterIndex < 0 || (validRecords.length > 0 && validRecords.every((record) => (record.rawValues[sawIndex] & 0xffff) === (record.rawValues[counterIndex] & 0xffff)));
  const toggleValues = toggleIndex >= 0 ? new Set(validRecords.map((record) => record.rawValues[toggleIndex])) : new Set<number>();
  const patternValues = patternIndex >= 0 ? new Set(validRecords.map((record) => record.rawValues[patternIndex])) : new Set<number>();
  const allSamplesValid = records.length > 1 && validRecords.length === records.length;
  const highRateCounterPass = mean !== null && mean >= 0.5 && mean <= 1.5 && nonZeroDeltaRatio >= 0.5;
  const lowRateCounterPass = expected !== null && mean !== null && Math.abs(mean - expected) <= Math.max(1, expected * 0.25) && nonZeroDeltaRatio >= 0.8;
  const counterDeltaPass = allSamplesValid
    && counterIndex >= 0
    && mean !== null
    && mean > 0
    && !counterAllConstant
    && (actualRateHz >= 12000 ? highRateCounterPass : lowRateCounterPass);
  const patternChanges = patternIndex < 0 ? undefined : patternValues.size > 1;
  const semanticPass = counterDeltaPass && sawPass && (patternChanges ?? true);
  return {
    focIsrFreqHz: 16000,
    counterPresent: counterIndex >= 0,
    transportPass: metadata?.transportStatus === "pass",
    payloadPass: metadata?.payloadValidationStatus === "pass",
    semanticPass,
    validSamples: validRecords.length,
    invalidSamples: records.length - validRecords.length,
    counterDeltaExpected: expected,
    counterDeltaMean: mean,
    counterDeltaMin: deltas.length ? Math.min(...deltas) : null,
    counterDeltaMax: deltas.length ? Math.max(...deltas) : null,
    nonZeroDeltaRatio,
    counterChangedRatio,
    counterAllConstant,
    counterDeltaPass,
    sawFollowsCounterLow16: sawPass,
    toggleAliasWarning: toggleIndex >= 0 && toggleValues.size <= 1,
    patternChanges,
  };
}

function writeLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> | void {
  if (!stream.write(line)) return once(stream, "drain").then(() => undefined);
}
