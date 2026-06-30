import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { HSS_SAFETY_FALSE, type HssCaptureMetadata, type HssResolvedSymbol, type HssScalarType } from "./hss-contract";
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
}

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
  warnings?: string[];
}): Promise<void> {
  const metadata: HssCaptureMetadata = {
    version: 1,
    captureId: input.captureId,
    sessionName: input.sessionName,
    projectRoot: input.projectRoot,
    backend: "jlink-hss",
    state: "failed",
    artifact: input.artifact,
    target: input.target,
    probe: input.probe ?? {},
    symbols: input.symbols,
    sampling: {
      requestedRateHz: input.requestedRateHz,
      actualRateHz: 0,
      durationSec: 0,
      timestampSource: "qpc",
      timestampFrequency: "1000000000",
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
  const records = await readHssRecords(input.segmentFile, metadata.symbols.length, recordSize);
  const segmentCrc = await crc32File(input.segmentFile);
  const actualRateHz = actualRate(records);
  metadata.state = input.state;
  metadata.sampling.actualRateHz = actualRateHz;
  metadata.sampling.durationSec = durationSec(records);
  metadata.segments = [{
    file: "capture_0001.bin",
    sampleStart: 0,
    sampleCount: records.length,
    recordSize,
    crc32: segmentCrc,
  }];
  metadata.quality = {
    sampleCount: records.length,
    validSamples: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.valid) !== 0).length,
    readErrors: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.read_error) !== 0).length,
    timeouts: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.timeout) !== 0).length,
    overflows: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.overflow) !== 0).length,
    droppedSamples: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.dropped_before_this_sample) !== 0).length,
    targetHaltedSamples: records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.target_halted) !== 0).length,
    actualRateHz,
  };
  if (input.failure) metadata.failures.push(input.failure);
  if (input.helperResult) metadata.events.push({ type: "helperResult", helperResult: input.helperResult });
  await writeFile(input.metadataFile, JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

export async function hssCaptureStatusFromMetadata(metadataFile: string): Promise<Record<string, unknown>> {
  const metadata = await readHssMetadata(metadataFile);
  return {
    captureId: metadata.captureId,
    state: metadata.state,
    elapsedSec: metadata.sampling.durationSec,
    requestedRateHz: metadata.sampling.requestedRateHz,
    actualRateHz: metadata.quality.actualRateHz,
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

export async function queryHssCapture(input: HssQueryInput, cwd = process.cwd()): Promise<Record<string, unknown>> {
  const metadata = await readMetadataForCapture(input.captureId, input.metadataFile, cwd);
  if (metadata.state !== "completed" && metadata.state !== "stopped" && metadata.state !== "failed") {
    throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_TERMINAL, "capture is not terminal");
  }
  const segment = metadata.segments[0];
  if (!segment) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "capture has no segment metadata");
  assertInsideProject(metadata.projectRoot, cwd);
  const segmentFile = join(hssProjectPaths(cwd).capturesDir, metadata.captureId, segment.file);
  assertInsideProject(segmentFile, cwd);
  const actualCrc = await crc32File(segmentFile);
  if (actualCrc !== segment.crc32) throw new HssError(HSS_ERROR.HSS_CRC_MISMATCH, "capture segment CRC mismatch", { expected: segment.crc32, actual: actualCrc });
  const records = await readHssRecords(segmentFile, metadata.symbols.length, segment.recordSize);
  const selected = selectSymbols(metadata.symbols, input.variables);
  const filtered = filterByTime(records, input.startSec, input.endSec);
  const buckets = bucketRecords(filtered, selected, metadata.sampling.actualRateHz, input.buckets ?? 100);
  const rawSamples = input.includeRawSamples ? decimateRaw(filtered, selected, input.maxSamples ?? 10000) : undefined;
  return {
    captureId: metadata.captureId,
    variables: selected.map(({ symbol }) => symbol),
    buckets,
    rawSamples,
    quality: metadata.quality,
    hmC095: input.hmC095Profile === false ? undefined : hmC095Validation(records, metadata.symbols, metadata.sampling.actualRateHz || metadata.sampling.requestedRateHz),
  };
}

export async function exportHssCapture(input: { captureId: string; metadataFile?: string; format?: "csv"; variables?: string[] }, cwd = process.cwd()): Promise<Record<string, unknown>> {
  if (input.format && input.format !== "csv") throw new Error("only CSV export is supported");
  const metadata = await readMetadataForCapture(input.captureId, input.metadataFile, cwd);
  const segment = metadata.segments[0];
  if (!segment) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "capture has no segment metadata");
  assertInsideProject(metadata.projectRoot, cwd);
  const segmentFile = join(hssProjectPaths(cwd).capturesDir, metadata.captureId, segment.file);
  assertInsideProject(segmentFile, cwd);
  if (await crc32File(segmentFile) !== segment.crc32) throw new HssError(HSS_ERROR.HSS_CRC_MISMATCH, "capture segment CRC mismatch");
  const records = await readHssRecords(segmentFile, metadata.symbols.length, segment.recordSize);
  const selected = selectSymbols(metadata.symbols, input.variables);
  const csvFile = join(hssProjectPaths(cwd).exportsDir, `${input.captureId}.csv`);
  const stream = createWriteStream(csvFile, { flags: "w", encoding: "utf8" });
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
    return { captureId: input.captureId, csvFile, rows: records.length };
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

function emptyQuality(): HssCaptureMetadata["quality"] {
  return { sampleCount: 0, validSamples: 0, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, targetHaltedSamples: 0, actualRateHz: 0 };
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
    values: Object.fromEntries(selected.map(({ symbol, index }) => [symbol.name, decodeValue(symbol.type, record.rawValues[index])])),
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

function hmC095Validation(records: HssSampleRecord[], symbols: HssResolvedSymbol[], actualRateHz: number): Record<string, unknown> {
  const counterIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgCounterFocIsr");
  const sawIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgSawFocIsr");
  const toggleIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgToggleFocIsr");
  const patternIndex = symbols.findIndex((symbol) => symbol.name === "g_hssDbgPatternFocIsr");
  const errorMask = HSS_STATUS_FLAGS.read_error
    | HSS_STATUS_FLAGS.timeout
    | HSS_STATUS_FLAGS.overflow
    | HSS_STATUS_FLAGS.dropped_before_this_sample;
  const validRecords = records.filter((record) => (record.statusFlags & HSS_STATUS_FLAGS.valid) !== 0 && (record.statusFlags & errorMask) === 0);
  const counter = counterIndex >= 0 ? validRecords.map((record) => record.rawValues[counterIndex] >>> 0) : [];
  const deltas = [];
  for (let index = 1; index < counter.length; index += 1) deltas.push((counter[index] - counter[index - 1]) >>> 0);
  const expected = actualRateHz > 0 ? 16000 / actualRateHz : null;
  const mean = deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null;
  const sawPass = sawIndex < 0 || counterIndex < 0 || (validRecords.length > 0 && validRecords.every((record) => (record.rawValues[sawIndex] & 0xffff) === (record.rawValues[counterIndex] & 0xffff)));
  const toggleValues = toggleIndex >= 0 ? new Set(validRecords.map((record) => record.rawValues[toggleIndex])) : new Set<number>();
  const patternValues = patternIndex >= 0 ? new Set(validRecords.map((record) => record.rawValues[patternIndex])) : new Set<number>();
  const allSamplesValid = records.length > 1 && validRecords.length === records.length;
  const deltaWithinTolerance = expected !== null && mean !== null && Math.abs(mean - expected) <= Math.max(1, expected * 0.25);
  return {
    focIsrFreqHz: 16000,
    validSamples: validRecords.length,
    invalidSamples: records.length - validRecords.length,
    counterDeltaExpected: expected,
    counterDeltaMean: mean,
    counterDeltaMin: deltas.length ? Math.min(...deltas) : null,
    counterDeltaMax: deltas.length ? Math.max(...deltas) : null,
    counterDeltaPass: allSamplesValid && counterIndex >= 0 && deltaWithinTolerance,
    sawFollowsCounterLow16: sawPass,
    toggleAliasWarning: toggleIndex >= 0 && toggleValues.size <= 1,
    patternChanges: patternIndex < 0 ? undefined : patternValues.size > 1,
  };
}

function writeLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> | void {
  if (!stream.write(line)) return once(stream, "drain").then(() => undefined);
}
