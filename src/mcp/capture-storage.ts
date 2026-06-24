import { createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { once } from "node:events";
import {
  CaptureSymbol,
  MAX_QUERY_BUCKETS,
  ScalarType,
} from "./capture-contract";

const binaryHeaderSize = 52;
const binarySymbolSize = 464;
const binaryFrameSize = 184;
const binaryEventSize = 316;

export interface BinaryHeader {
  qpcFrequency: bigint;
  symbolCount: number;
  frameCount: bigint;
  eventCount: bigint;
  terminalState: number;
  symbols: CaptureSymbol[];
  frameOffset: number;
  eventOffset: number;
  fileSize: number;
}

interface DecodedFrame {
  index: bigint;
  scheduledQpc: bigint;
  readStartQpc: bigint;
  readEndQpc: bigint;
  readMidpointQpc: bigint;
  readDurationQpc: bigint;
  flags: number;
  valid: boolean;
  values: number[];
}

interface CaptureQueryOptions {
  variables?: string[];
  startSec?: number;
  endSec?: number;
  buckets?: number;
}

export interface CaptureSampleReadOptions {
  variables?: string[];
  startSec?: number;
  endSec?: number;
  maxSamples?: number;
}

export interface CaptureSampleReadResult {
  variables: Array<{ name: string; selector: string; alias?: string; unit?: string; type: ScalarType }>;
  samples: Array<{ timeSec: number; values: Record<string, number> }>;
  warnings: string[];
  firstQpc: bigint;
  qpcFrequency: bigint;
}

function readCString(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  return buffer.toString("utf8", offset, end < 0 || end >= offset + length ? offset + length : end);
}

function decodeValue(type: ScalarType, raw: number): number {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE(raw, 0);
  switch (type) {
    case "int8": return bytes.readInt8(0);
    case "uint8": return bytes.readUInt8(0);
    case "int16": return bytes.readInt16LE(0);
    case "uint16": return bytes.readUInt16LE(0);
    case "int32": return bytes.readInt32LE(0);
    case "uint32": return raw;
    case "float32": return bytes.readFloatLE(0);
  }
}

async function readExact(file: Awaited<ReturnType<typeof open>>, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error("Capture artifact is truncated");
  return buffer;
}

export async function readCaptureHeader(filePath: string): Promise<BinaryHeader> {
  const file = await open(filePath, "r");
  try {
    const size = Number((await file.stat()).size);
    const raw = await readExact(file, binaryHeaderSize, 0);
    if (raw.toString("ascii", 0, 4) !== "JLCP") throw new Error("Invalid capture magic");
    if (raw.readUInt32LE(4) !== 1 || raw.readUInt32LE(8) !== binaryHeaderSize) throw new Error("Unsupported capture format version");
    const qpcFrequency = raw.readBigInt64LE(12);
    const symbolCount = raw.readUInt32LE(20);
    const frameSize = raw.readUInt32LE(24);
    const frameCount = raw.readBigUInt64LE(28);
    const eventCount = raw.readBigUInt64LE(36);
    const terminalState = raw.readUInt32LE(44);
    if (qpcFrequency <= 0n || symbolCount < 1 || symbolCount > 32 || frameSize !== binaryFrameSize || frameCount > 2_000_000n || eventCount > 65_536n || terminalState < 1 || terminalState > 3) throw new Error("Invalid capture header bounds");
    const symbolBytes = await readExact(file, symbolCount * binarySymbolSize, binaryHeaderSize);
    const symbols: CaptureSymbol[] = [];
    const types: ScalarType[] = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "float32"];
    for (let index = 0; index < symbolCount; index += 1) {
      const offset = index * binarySymbolSize;
      const type = types[symbolBytes.readUInt32LE(offset + 460) - 1];
      if (!type) throw new Error("Invalid capture scalar type");
      symbols.push({
        name: readCString(symbolBytes, offset, 256),
        alias: readCString(symbolBytes, offset + 256, 128) || undefined,
        unit: readCString(symbolBytes, offset + 384, 64) || undefined,
        address: Number(symbolBytes.readBigUInt64LE(offset + 448)),
        size: symbolBytes.readUInt32LE(offset + 456),
        type,
      });
    }
    const frameOffset = binaryHeaderSize + symbolCount * binarySymbolSize;
    const eventOffset = frameOffset + Number(frameCount) * binaryFrameSize;
    const expectedSize = eventOffset + Number(eventCount) * binaryEventSize;
    if (!Number.isSafeInteger(expectedSize) || expectedSize !== size) throw new Error("Capture artifact size does not match header");
    return { qpcFrequency, symbolCount, frameCount, eventCount, terminalState, symbols, frameOffset, eventOffset, fileSize: size };
  } finally {
    await file.close();
  }
}

function decodeFrame(buffer: Buffer, offset: number, symbols: CaptureSymbol[]): DecodedFrame {
  const values = symbols.map((symbol, index) => decodeValue(symbol.type, buffer.readUInt32LE(offset + 56 + index * 4)));
  return {
    index: buffer.readBigUInt64LE(offset),
    scheduledQpc: buffer.readBigInt64LE(offset + 8),
    readStartQpc: buffer.readBigInt64LE(offset + 16),
    readEndQpc: buffer.readBigInt64LE(offset + 24),
    readMidpointQpc: buffer.readBigInt64LE(offset + 32),
    readDurationQpc: buffer.readBigInt64LE(offset + 40),
    flags: buffer.readUInt32LE(offset + 48),
    valid: buffer.readUInt32LE(offset + 52) === 1,
    values,
  };
}

async function forEachFrame(filePath: string, header: BinaryHeader, callback: (frame: DecodedFrame) => void | Promise<void>): Promise<void> {
  const file = await open(filePath, "r");
  try {
    const framesPerChunk = 2048;
    for (let first = 0; first < Number(header.frameCount); first += framesPerChunk) {
      const count = Math.min(framesPerChunk, Number(header.frameCount) - first);
      const raw = await readExact(file, count * binaryFrameSize, header.frameOffset + first * binaryFrameSize);
      for (let index = 0; index < count; index += 1) {
        const pending = callback(decodeFrame(raw, index * binaryFrameSize, header.symbols));
        if (pending) await pending;
      }
    }
  } finally {
    await file.close();
  }
}

export async function readEvents(filePath: string, header: BinaryHeader): Promise<Array<{ qpc: string; type: string; success: boolean; detail: string }>> {
  const file = await open(filePath, "r");
  try {
    const raw = await readExact(file, Number(header.eventCount) * binaryEventSize, header.eventOffset);
    const events = [];
    for (let index = 0; index < Number(header.eventCount); index += 1) {
      const offset = index * binaryEventSize;
      events.push({
        qpc: raw.readBigInt64LE(offset).toString(),
        success: raw.readUInt32LE(offset + 8) === 1,
        type: readCString(raw, offset + 12, 48),
        detail: readCString(raw, offset + 60, 256),
      });
    }
    return events;
  } finally {
    await file.close();
  }
}

function csvValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return String(value);
}

function csvCell(value: string | number | bigint): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeStreamLine(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> | void {
  if (!stream.write(line)) return once(stream, "drain").then(() => undefined);
}

export async function queryCaptureFile(filePath: string, input: CaptureQueryOptions): Promise<Record<string, unknown>> {
  const header = await readCaptureHeader(filePath);
  const selected = selectVariables(header.symbols, input.variables);
  const requestedBuckets = input.buckets ?? MAX_QUERY_BUCKETS;
  if (!Number.isInteger(requestedBuckets) || requestedBuckets < 1 || requestedBuckets > MAX_QUERY_BUCKETS) throw new Error(`buckets must be 1..${MAX_QUERY_BUCKETS}`);
  if (header.frameCount === 0n) return { buckets: [], variables: selected.map((item) => item.symbol.name) };
  const bounds = await frameTimeBounds(filePath, header);
  const startSec = input.startSec ?? 0;
  const endSec = input.endSec ?? bounds.durationSec;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec < startSec) throw new Error("Invalid query time range");
  const bucketCount = Math.min(requestedBuckets, Number(header.frameCount));
  const width = Math.max((endSec - startSec) / bucketCount, Number.EPSILON);
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    startSec: startSec + index * width,
    endSec: startSec + (index + 1) * width,
    count: 0,
    values: selected.map(() => ({ min: Infinity, max: -Infinity, sum: 0, count: 0 })),
  }));
  await forEachFrame(filePath, header, (frame) => {
    if (!frame.valid) return;
    const timeSec = Number(frame.readMidpointQpc - bounds.firstQpc) / Number(header.qpcFrequency);
    if (timeSec < startSec || timeSec > endSec) return;
    const index = Math.min(bucketCount - 1, Math.floor((timeSec - startSec) / width));
    const bucket = buckets[index];
    bucket.count += 1;
    selected.forEach(({ index: valueIndex }, selectedIndex) => {
      const value = frame.values[valueIndex];
      if (Number.isNaN(value)) return;
      const aggregate = bucket.values[selectedIndex];
      aggregate.min = Math.min(aggregate.min, value);
      aggregate.max = Math.max(aggregate.max, value);
      aggregate.sum += value;
      aggregate.count += 1;
    });
  });
  return {
    variables: selected.map(({ symbol }) => ({ name: symbol.name, alias: symbol.alias, unit: symbol.unit, type: symbol.type })),
    buckets: buckets.filter((bucket) => bucket.count > 0).map((bucket) => ({
      startSec: bucket.startSec,
      endSec: bucket.endSec,
      count: bucket.count,
      values: Object.fromEntries(selected.map(({ symbol }, index) => {
        const aggregate = bucket.values[index];
        return [symbol.alias || symbol.name, aggregate.count ? { min: aggregate.min, max: aggregate.max, average: aggregate.sum / aggregate.count } : { min: null, max: null, average: null }];
      })),
    })),
  };
}

export async function readCaptureSamples(filePath: string, input: CaptureSampleReadOptions = {}): Promise<CaptureSampleReadResult> {
  if (!filePath.toLowerCase().endsWith(".jlcp")) throw new Error("Capture sample reader only accepts .jlcp artifacts");
  const header = await readCaptureHeader(filePath);
  const selected = selectVariables(header.symbols, input.variables);
  const maxSamples = input.maxSamples ?? 10000;
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 100000) throw new Error("maxSamples must be 1..100000");
  if (header.frameCount === 0n) return { variables: selected.map(variableInfo), samples: [], warnings: [], firstQpc: 0n, qpcFrequency: header.qpcFrequency };
  const bounds = await frameTimeBounds(filePath, header);
  const startSec = input.startSec ?? 0;
  const endSec = input.endSec ?? bounds.durationSec;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec < startSec) throw new Error("Invalid sample time range");
  const stride = Number(header.frameCount) > maxSamples ? Math.ceil(Number(header.frameCount) / maxSamples) : 1;
  const samples: CaptureSampleReadResult["samples"] = [];
  await forEachFrame(filePath, header, (frame) => {
    if (!frame.valid || Number(frame.index % BigInt(stride)) !== 0) return;
    const timeSec = Number(frame.readMidpointQpc - bounds.firstQpc) / Number(header.qpcFrequency);
    if (timeSec < startSec || timeSec > endSec) return;
    samples.push({
      timeSec,
      values: Object.fromEntries(selected.map(({ symbol, index }) => [captureSampleSignalName(symbol), frame.values[index]])),
    });
  });
  return {
    variables: selected.map(variableInfo),
    samples,
    warnings: stride > 1 ? [`capture samples decimated by stride ${stride} from ${header.frameCount.toString()} frames to at most ${maxSamples}`] : [],
    firstQpc: bounds.firstQpc,
    qpcFrequency: header.qpcFrequency,
  };
}

export async function writeCaptureCsv(filePath: string, csvFile: string): Promise<void> {
  const header = await readCaptureHeader(filePath);
  const stream = createWriteStream(csvFile, { flags: "wx", encoding: "utf8" });
  let opened = false;
  try {
    await once(stream, "open");
    opened = true;
    await writeStreamLine(stream, ["index", "scheduled_qpc", "read_start_qpc", "read_end_qpc", "read_midpoint_qpc", "read_duration_qpc", "flags", ...header.symbols.map((symbol) => symbol.alias || symbol.name)].map(csvCell).join(",") + "\n");
    await forEachFrame(filePath, header, (frame) => {
      if (!frame.valid) return;
      return writeStreamLine(stream, [frame.index, frame.scheduledQpc, frame.readStartQpc, frame.readEndQpc, frame.readMidpointQpc, frame.readDurationQpc, frame.flags, ...frame.values.map(csvValue)].map(csvCell).join(",") + "\n");
    });
    stream.end();
    await once(stream, "close");
  } catch (error) {
    stream.destroy();
    if (opened) await rm(csvFile, { force: true });
    throw error;
  }
}

export function selectSessionArtifacts(entries: string[], sessionId: string): string[] {
  if (!isSessionId(sessionId)) throw new Error("An exact capture session UUID is required");
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-${sessionId}\\.(?:jlcp|metadata\\.json|native\\.json|csv|json)$`, "i");
  return entries.filter((name) => pattern.test(name));
}

function selectVariables(symbols: CaptureSymbol[], requested?: string[]): Array<{ symbol: CaptureSymbol; index: number }> {
  if (!requested?.length) return symbols.map((symbol, index) => ({ symbol, index }));
  if (new Set(requested).size !== requested.length) throw new Error("Duplicate query variables are not allowed");
  return requested.map((name) => {
    const index = symbols.findIndex((symbol) => symbol.name === name || symbol.alias === name);
    if (index < 0) throw new Error(`Unknown capture variable: ${name}`);
    return { symbol: symbols[index], index };
  });
}

export function captureSampleSignalName(symbol: CaptureSymbol): string {
  return symbol.alias && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(symbol.alias) ? symbol.alias : symbol.name;
}

function variableInfo({ symbol }: { symbol: CaptureSymbol }): CaptureSampleReadResult["variables"][number] {
  return { name: captureSampleSignalName(symbol), selector: symbol.name, alias: symbol.alias, unit: symbol.unit, type: symbol.type };
}

async function frameTimeBounds(filePath: string, header: BinaryHeader): Promise<{ firstQpc: bigint; durationSec: number }> {
  const file = await open(filePath, "r");
  try {
    const first = await readExact(file, binaryFrameSize, header.frameOffset);
    const last = await readExact(file, binaryFrameSize, header.frameOffset + (Number(header.frameCount) - 1) * binaryFrameSize);
    const firstQpc = first.readBigInt64LE(32);
    const lastQpc = last.readBigInt64LE(32);
    return { firstQpc, durationSec: Number(lastQpc - firstQpc) / Number(header.qpcFrequency) };
  } finally {
    await file.close();
  }
}

export async function captureTiming(filePath: string, header: BinaryHeader): Promise<Record<string, number>> {
  let first = 0n;
  let last = 0n;
  const windows: number[] = [];
  let valid = 0;
  let scheduledFrames = 0;
  await forEachFrame(filePath, header, (frame) => {
    if (!frame.valid) return;
    if (valid === 0) first = frame.readMidpointQpc;
    last = frame.readMidpointQpc;
    scheduledFrames = Number(frame.index) + 1;
    valid += 1;
    windows.push(Number(frame.readDurationQpc) * 1_000_000 / Number(header.qpcFrequency));
  });
  windows.sort((left, right) => left - right);
  const pick = (p: number) => windows.length ? windows[Math.min(windows.length - 1, Math.ceil(windows.length * p) - 1)] : 0;
  const elapsed = valid > 1 ? Number(last - first) / Number(header.qpcFrequency) : 0;
  return {
    scheduledFrames,
    collectedFrames: valid,
    missedDeadlines: Math.max(0, scheduledFrames - valid),
    actualRateHz: elapsed > 0 ? (valid - 1) / elapsed : 0,
    readWindowMinUs: windows[0] ?? 0,
    readWindowMeanUs: windows.length ? windows.reduce((sum, value) => sum + value, 0) / windows.length : 0,
    readWindowMaxUs: windows.at(-1) ?? 0,
    readWindowP50Us: pick(0.5),
    readWindowP99Us: pick(0.99),
    readWindowP999Us: pick(0.999),
  };
}

function isSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
