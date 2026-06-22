import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { ProbeBackend, CaptureProbeConfig } from "../probe/backend";
import { ManagedProcess, ProcessManager } from "../utils/process-manager";
import { log, logError } from "../utils/logger";
import {
  CaptureIpcMessage,
  CaptureMetadata,
  CaptureState,
  CaptureSymbol,
  MAX_QUERY_BUCKETS,
  ProjectControlConfig,
  ScalarType,
  decodeCaptureIpc,
  encodeCaptureIpc,
} from "./capture-contract";
import {
  ElfResolution,
  RequestedCaptureSymbol,
  loadProjectControlConfig,
  resolveElfSymbols,
} from "../gdb/elf-resolver";

const captureServerProcess = "jlink-capture-gdb-server";
const captureHelperProcess = "jlink-capture-helper";
const binaryHeaderSize = 52;
const binarySymbolSize = 464;
const binaryFrameSize = 184;
const binaryEventSize = 316;

export interface CapturePrepareInput {
  elfFile: string;
  configFile: string;
  symbols: RequestedCaptureSymbol[];
  rateHz?: number;
  durationSec?: number;
  resetOnFailure?: boolean;
  outputDir?: string;
}

export interface CaptureQueryInput {
  sessionId: string;
  variables?: string[];
  startSec?: number;
  endSec?: number;
  buckets?: number;
}

const allowedTransitions: Record<CaptureState, CaptureState[]> = {
  idle: ["preparing"],
  preparing: ["armed", "failed"],
  armed: ["capturing", "stopped", "failed"],
  capturing: ["completed", "stopped", "failed"],
  completed: [],
  stopped: [],
  failed: [],
};

export function transitionCaptureState(current: CaptureState, next: CaptureState): CaptureState {
  if (!allowedTransitions[current].includes(next)) throw new Error(`Invalid capture state transition: ${current} -> ${next}`);
  return next;
}

export function validateRequestedSymbols(symbols: RequestedCaptureSymbol[]): void {
  if (symbols.length < 1 || symbols.length > 32) throw new Error("symbols must contain 1..32 entries");
  if (new Set(symbols.map((symbol) => symbol.name)).size !== symbols.length) throw new Error("Duplicate capture selectors are not allowed");
  const identifiers = new Set<string>();
  for (const symbol of symbols) {
    if (Buffer.byteLength(symbol.name, "utf8") > 255) throw new Error("Capture selector exceeds the 255-byte artifact limit");
    if (symbol.alias && Buffer.byteLength(symbol.alias, "utf8") > 127) throw new Error("Capture alias exceeds the 127-byte artifact limit");
    if (symbol.unit && Buffer.byteLength(symbol.unit, "utf8") > 63) throw new Error("Capture unit exceeds the 63-byte artifact limit");
    for (const identifier of [symbol.name, symbol.alias].filter((value): value is string => !!value)) {
      if (identifiers.has(identifier)) throw new Error(`Duplicate capture name or alias: ${identifier}`);
      identifiers.add(identifier);
    }
  }
}

interface Session {
  id: string;
  state: CaptureState;
  outputDir: string;
  binaryFile: string;
  metadataFile: string;
  elf: ElfResolution;
  configPath: string;
  control: ProjectControlConfig;
  probe: CaptureProbeConfig;
  probeSerial: string;
  probeModel: string;
  serverVersion: string;
  capabilities: string[];
  helper?: CaptureHelperClient;
  failures: string[];
  terminationReason: string;
}

interface HelperResponse {
  [key: string]: unknown;
}

interface NativeMetadata {
  version: 1;
  sessionId: string;
  state: "completed" | "stopped" | "failed";
  elfPath: string;
  elfSha256: string;
  configPath: string;
  device: string;
  probeModel: string;
  probeSerial: string;
  swdRateKhz: number;
  gdbServerPath: string;
  gdbServerVersion: string;
  binaryFile: string;
  terminationReason: string;
  capabilities: string;
}

class CaptureHelperClient {
  private process: ManagedProcess | null = null;
  private pending = new Map<string, { resolve: (value: HelperResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void> | null = null;
  private eventHandler: (type: string, payload: HelperResponse) => void;
  private shuttingDown = false;

  constructor(private processManager: ProcessManager, eventHandler: (type: string, payload: HelperResponse) => void) {
    this.eventHandler = eventHandler;
  }

  async start(): Promise<void> {
    const executable = await findHelperExecutable();
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      try {
        this.process = this.processManager.spawn(captureHelperProcess, executable, ["--parent-pid", String(process.pid)]);
        const child = this.process.process;
        const lines = createInterface({ input: child.stdout! });
        lines.on("line", (line) => {
          try {
            const message = decodeCaptureIpc(line);
            if (message.type === "ready") {
              if (!settled) { settled = true; resolveReady(); }
              return;
            }
            if (message.id === "event") {
              this.eventHandler(message.type, message.payload as HelperResponse);
              return;
            }
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.type === "error") pending.reject(new Error(String((message.payload as { message?: unknown }).message ?? "Native helper error")));
            else pending.resolve(message.payload as HelperResponse);
          } catch (error) {
            logError("Capture helper emitted invalid IPC", error);
            this.initiateSafetyShutdown("invalid_helper_ipc");
          }
        });
        child.stderr?.on("data", (data: Buffer) => logError(`[Capture helper] ${data.toString().trim()}`));
        child.once("error", (error) => {
          if (!settled) { settled = true; rejectReady(error); }
          this.rejectAll(error);
          this.reportUnexpectedExit(error.message);
        });
        child.once("exit", (code) => {
          const error = new Error(`Capture helper exited with code ${code}`);
          if (!settled) { settled = true; rejectReady(error); }
          this.rejectAll(error);
          this.process = null;
          this.reportUnexpectedExit(error.message);
        });
      } catch (error) {
        settled = true;
        rejectReady(error);
      }
    });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Capture helper startup timed out")), 5000));
    await Promise.race([this.ready, timeout]);
  }

  request(type: string, payload: unknown, timeoutMs = 30000): Promise<HelperResponse> {
    if (!this.process?.process.stdin) return Promise.reject(new Error("Capture helper is not running"));
    const id = randomUUID();
    return new Promise<HelperResponse>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Capture helper ${type} timed out`));
        this.initiateSafetyShutdown(`request_timeout:${type}`);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      const message: CaptureIpcMessage = { version: 1, id, type, payload };
      this.process!.process.stdin!.write(encodeCaptureIpc(message), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error);
      });
    });
  }

  async close(safe = true): Promise<void> {
    if (!this.process) return;
    this.shuttingDown = true;
    if (safe) {
      try { await this.request("shutdown", {}, 5000); } catch { /* helper parent-loss path handles safety */ }
    }
    this.processManager.kill(captureHelperProcess);
    this.process = null;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private initiateSafetyShutdown(reason: string): void {
    if (this.shuttingDown || !this.process?.process.stdin) return;
    this.shuttingDown = true;
    this.eventHandler("ipc_failure", { reason });
    const message: CaptureIpcMessage = { version: 1, id: `safety-${Date.now()}`, type: "shutdown", payload: { reason } };
    this.process.process.stdin.write(encodeCaptureIpc(message));
    const timer = setTimeout(() => this.processManager.kill(captureHelperProcess), 5000);
    timer.unref();
  }

  private reportUnexpectedExit(reason: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.eventHandler("helper_exit", { reason });
  }
}

interface BinaryHeader {
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

async function readEvents(filePath: string, header: BinaryHeader): Promise<Array<{ qpc: string; type: string; success: boolean; detail: string }>> {
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

export async function queryCaptureFile(
  filePath: string,
  input: Pick<CaptureQueryInput, "variables" | "startSec" | "endSec" | "buckets">,
): Promise<Record<string, unknown>> {
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

async function findHelperExecutable(): Promise<string> {
  if (process.env.JLINK_CAPTURE_HELPER) return realpath(process.env.JLINK_CAPTURE_HELPER);
  const executable = process.platform === "win32" ? "jlink-capture-helper.exe" : "jlink-capture-helper";
  const candidates = [
    join(__dirname, "..", "..", "native", "capture-helper", "bin", executable),
    join(__dirname, "..", "native", "capture-helper", "bin", executable),
    join(__dirname, "..", "..", "native", "capture-helper", "build", "Release", executable),
    join(__dirname, "..", "native", "capture-helper", "build", "Release", executable),
    join(process.cwd(), "native", "capture-helper", "build", "Release", executable),
    join(process.cwd(), "native", "capture-helper", "bin", executable),
  ];
  for (const candidate of candidates) {
    try { return await realpath(candidate); } catch { /* next */ }
  }
  throw new Error("Native capture helper is unavailable; run npm run build:capture or set JLINK_CAPTURE_HELPER");
}

async function listJLinkSerials(executable: string): Promise<{ serials: string[]; output: string }> {
  return new Promise((resolveList, rejectList) => {
    const child = spawn(executable, ["-NoGui", "1"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const timer = setTimeout(() => { child.kill(); rejectList(new Error("J-Link probe discovery timed out")); }, 10000);
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.once("error", (error) => { clearTimeout(timer); rejectList(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return rejectList(new Error(`J-Link probe discovery failed: ${output.trim()}`));
      const serials = [...output.matchAll(/(?:S\/N|Serial(?: number)?)\s*[:=]\s*(\d+)/gi)].map((match) => match[1]);
      resolveList({ serials: [...new Set(serials)], output });
    });
    child.stdin.write("ShowEmuList\nexit\n");
    child.stdin.end();
  });
}

export class CaptureService {
  private session: Session | null = null;
  private knownOutputDirs = new Set<string>();
  private finalizing: Promise<void> | null = null;

  constructor(
    private probe: ProbeBackend,
    private processManager: ProcessManager,
    private gdbPath: string,
  ) {
    this.knownOutputDirs.add(join(tmpdir(), "jlink-mcp-captures"));
  }

  async prepare(input: CapturePrepareInput): Promise<Record<string, unknown>> {
    if (this.session && ["preparing", "armed", "capturing"].includes(this.session.state)) throw new Error(`Capture session ${this.session.id} is already active`);
    const probe = this.probe.getCaptureConfig();
    if (!probe) throw new Error("Variable capture currently requires the J-Link backend");
    if (!this.probe.isDeviceConfigured()) throw new Error("A concrete J-Link target device must be configured before capture_prepare");
    if (this.probe.isGDBServerRunning()) throw new Error("The MCP-owned debug GDB server is running; stop it only after explicit user approval, then retry capture_prepare");
    const rateHz = input.rateHz ?? 1000;
    const durationSec = input.durationSec ?? 60;
    if (!Number.isInteger(rateHz) || rateHz < 1 || rateHz > 1000) throw new Error("rateHz must be 1..1000");
    if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 600) throw new Error("durationSec must be 1..600");
    validateRequestedSymbols(input.symbols);

    const outputDir = await prepareOutputDirectory(input.outputDir);
    this.knownOutputDirs.add(outputDir);
    const id = randomUUID();
    const prefix = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}`;
    const binaryFile = join(outputDir, `${prefix}.jlcp`);
    const metadataFile = join(outputDir, `${prefix}.metadata.json`);
    const owner = `capture:${id}`;
    if (!this.probe.acquireExclusive(owner)) throw new Error(`Probe is already owned by ${this.probe.getExclusiveOwner()}`);

    let helper: CaptureHelperClient | undefined;
    try {
      const loadedConfig = await loadProjectControlConfig(input.configFile);
      const requested = buildRequestedSymbols(input.symbols, loadedConfig.config);
      const elf = await resolveElfSymbols(this.gdbPath, input.elfFile, requested);
      const resolved = new Map(elf.symbols.map((symbol) => [symbol.name, symbol]));
      validateDeclaredTypes(loadedConfig.config, resolved);

      const discovered = await listJLinkSerials(probe.jlinkExePath);
      const serial = selectProbeSerial(probe.serialNumber, discovered.serials);

      this.session = {
        id,
        state: transitionCaptureState("idle", "preparing"),
        outputDir,
        binaryFile,
        metadataFile,
        elf,
        configPath: loadedConfig.path,
        control: loadedConfig.config,
        probe,
        probeSerial: serial,
        probeModel: "J-Link (model pending server identity)",
        serverVersion: "unknown",
        capabilities: [],
        failures: [],
        terminationReason: "",
      };

      const server = await this.startCaptureServer(probe, serial);
      helper = new CaptureHelperClient(this.processManager, (type, payload) => void this.handleHelperEvent(type, payload));
      this.session.helper = helper;
      await helper.start();
      const response = await helper.request("prepare", {
        host: "127.0.0.1",
        port: probe.gdbPort,
        outputFile: binaryFile,
        rateHz,
        durationSec,
        preStartMs: loadedConfig.config.preStartMs,
        postStopMs: loadedConfig.config.postStopMs,
        resetOnFailure: input.resetOnFailure ?? false,
        symbols: input.symbols.map((symbol) => resolved.get(symbol.name)),
        ramRanges: elf.ramRanges,
        flashSections: elf.flashSections.map((section) => ({ address: section.start, dataHex: section.dataHex })),
        control: helperControlPayload(loadedConfig.config, resolved),
      }, 120000);
      const identity = validateServerIdentity([...server.output, discovered.output], String(response.targetStatus ?? ""), probe.device, serial);
      this.session.probeModel = identity.model;
      this.session.serverVersion = identity.version;
      this.session.capabilities = String(response.capabilities ?? "").split(";").filter(Boolean);
      await helper.request("metadata", {
        version: 1,
        sessionId: id,
        elfPath: elf.elfPath,
        elfSha256: elf.elfSha256,
        configPath: loadedConfig.path,
        device: probe.device,
        probeModel: identity.model,
        probeSerial: serial,
        swdRateKhz: probe.speed,
        gdbServerPath: probe.gdbServerPath,
        gdbServerVersion: identity.version,
      });
      this.session.state = transitionCaptureState(this.session.state, "armed");
      return {
        sessionId: id,
        state: "armed",
        calibration: response.calibration,
        probe: { model: identity.model, serial, voltage: identity.voltage },
        target: { device: probe.device, running: true },
        elfSha256: elf.elfSha256,
        resetOnFailure: input.resetOnFailure ?? false,
        warning: "Motor start remains forbidden until the user explicitly requests it in this current session.",
      };
    } catch (error) {
      if (helper && this.session?.state === "preparing") {
        try { await helper.request("abort_prepare", { reason: "node_preflight_failed" }, 5000); } catch { /* no reset/write path */ }
      }
      await helper?.close(false);
      this.processManager.kill(captureServerProcess);
      this.probe.releaseExclusive(owner);
      if (this.session?.id === id) {
        if (this.session.state === "preparing") this.session.state = transitionCaptureState(this.session.state, "failed");
        this.session.failures.push(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async start(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId, ["armed"]);
    const status = await session.helper!.request("start", {});
    session.state = transitionCaptureState(session.state, "capturing");
    return { sessionId, ...status };
  }

  async status(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId);
    if (session.helper && ["armed", "capturing"].includes(session.state)) {
      const status = await session.helper.request("status", {});
      if (typeof status.state === "string" && status.state !== session.state) session.state = transitionCaptureState(session.state, status.state as CaptureState);
      return { sessionId, ...status };
    }
    return { sessionId, state: session.state, terminationReason: session.terminationReason, binaryFile: session.binaryFile };
  }

  async stop(sessionId: string): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId, ["armed", "capturing"]);
    const status = await session.helper!.request("stop", {}, 30000);
    await this.finalizeSession(session, status);
    return { sessionId, ...status };
  }

  async control(sessionId: string, command: "start" | "stop"): Promise<Record<string, unknown>> {
    const session = this.requireSession(sessionId, command === "start" ? ["capturing"] : ["armed", "capturing"]);
    const status = await session.helper!.request("control", { command }, 30000);
    if (typeof status.state === "string" && status.state !== session.state) session.state = transitionCaptureState(session.state, status.state as CaptureState);
    if (["completed", "stopped", "failed"].includes(session.state)) await this.finalizeSession(session, status);
    return { sessionId, ...status };
  }

  async query(input: CaptureQueryInput): Promise<Record<string, unknown>> {
    const session = await this.findTerminalSession(input.sessionId);
    return { sessionId: input.sessionId, ...await queryCaptureFile(session.binaryFile, input) };
  }

  async export(sessionId: string): Promise<Record<string, unknown>> {
    const session = await this.findTerminalSession(sessionId);
    const header = await readCaptureHeader(session.binaryFile);
    const stem = session.binaryFile.slice(0, -extname(session.binaryFile).length);
    const csvFile = `${stem}.csv`;
    const jsonFile = `${stem}.json`;
    await access(session.binaryFile);
    let csvCreated = false;
    let jsonCreated = false;
    try {
      await writeCaptureCsv(session.binaryFile, csvFile);
      csvCreated = true;
      const metadata = await this.buildMetadata(session, header);
      await writeFile(jsonFile, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" });
      jsonCreated = true;
      return { sessionId, csvFile, jsonFile, frames: header.frameCount.toString() };
    } catch (error) {
      if (csvCreated) await rm(csvFile, { force: true });
      if (jsonCreated) await rm(jsonFile, { force: true });
      throw error;
    }
  }

  async list(outputDir?: string): Promise<Array<Record<string, unknown>>> {
    const directory = outputDir ? await requireExistingAbsoluteDirectory(outputDir) : await prepareOutputDirectory(undefined);
    this.knownOutputDirs.add(directory);
    const entries = await readdir(directory);
    const results: Array<Record<string, unknown>> = [];
    const listed = new Set<string>();
    for (const name of entries.filter((entry) => entry.endsWith(".metadata.json"))) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, name), "utf8")) as CaptureMetadata;
        if (!metadata.sessionId || !metadata.binaryFile) continue;
        if (!selectSessionArtifacts([name], metadata.sessionId).length) continue;
        const binaryFile = await realpath(metadata.binaryFile);
        if (dirname(binaryFile).toLowerCase() !== directory.toLowerCase()) continue;
        results.push({ sessionId: metadata.sessionId, state: metadata.state, binaryFile, terminationReason: metadata.terminationReason });
        listed.add(metadata.sessionId);
      } catch { /* externally removed or invalid capture is not listed */ }
    }
    for (const name of entries.filter((entry) => entry.endsWith(".native.json"))) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, name), "utf8")) as NativeMetadata;
        if (!validNativeMetadata(metadata) || listed.has(metadata.sessionId) || !selectSessionArtifacts([name], metadata.sessionId).length) continue;
        const binaryFile = await realpath(metadata.binaryFile);
        if (dirname(binaryFile).toLowerCase() !== directory.toLowerCase()) continue;
        await readCaptureHeader(binaryFile);
        results.push({ sessionId: metadata.sessionId, state: metadata.state, binaryFile, terminationReason: metadata.terminationReason, recoveredFromNativeSidecar: true });
      } catch { /* invalid/incomplete sidecar is not listed */ }
    }
    return results;
  }

  async delete(sessionId: string): Promise<Record<string, unknown>> {
    if (!isSessionId(sessionId)) throw new Error("capture_delete requires one exact session UUID");
    if (this.session?.id === sessionId && ["preparing", "armed", "capturing"].includes(this.session.state)) throw new Error("Active capture sessions cannot be deleted");
    for (const directory of this.knownOutputDirs) {
      let entries: string[];
      try { entries = await readdir(directory); } catch { continue; }
      const names = selectSessionArtifacts(entries, sessionId);
      if (names.length === 0) continue;
      for (const name of names) await rm(join(directory, name));
      if (this.session?.id === sessionId) this.session = null;
      return { sessionId, deleted: names.sort() };
    }
    throw new Error(`Capture session not found: ${sessionId}`);
  }

  async dispose(): Promise<void> {
    await this.session?.helper?.close(true);
    await new Promise<void>((resolveReady) => setImmediate(resolveReady));
    if (this.finalizing) await this.finalizing;
    this.processManager.kill(captureServerProcess);
    if (this.session) this.probe.releaseExclusive(`capture:${this.session.id}`);
  }

  private requireSession(id: string, states?: CaptureState[]): Session {
    if (!this.session || this.session.id !== id) throw new Error(`Unknown capture session: ${id}`);
    if (states && !states.includes(this.session.state)) throw new Error(`Operation is invalid in capture state ${this.session.state}`);
    return this.session;
  }

  private async startCaptureServer(config: CaptureProbeConfig, serial: string): Promise<{ output: string[] }> {
    const args = [
      "-device", config.device,
      "-if", config.interface,
      "-speed", String(config.speed),
      "-port", String(config.gdbPort),
      "-vd", "-nohalt", "-noir", "-LocalhostOnly", "1", "-singlerun", "-NoGui",
      "-select", `USB=${serial}`,
    ];
    const managed = this.processManager.spawn(captureServerProcess, config.gdbServerPath, args);
    const output: string[] = [];
    const collector = () => {
      let pending = "";
      return (data: Buffer) => {
        const lines = (pending + data.toString()).split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          output.push(line);
          log(`[Capture GDB Server] ${line}`);
        }
      };
    };
    managed.process.stdout?.on("data", collector());
    managed.process.stderr?.on("data", collector());
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`J-Link GDB Server startup timed out:\n${output.join("\n")}`)), 15000);
      const poll = setInterval(() => {
        if (output.some((line) => /^Connected to target$|Waiting for GDB connection|GDB Server.*ready/i.test(line))) {
          clearInterval(poll); clearTimeout(timeout); resolveReady();
        }
        if (output.some((line) => /cannot connect|failed|no J-Link|already in use/i.test(line))) {
          clearInterval(poll); clearTimeout(timeout); rejectReady(new Error(`J-Link GDB Server rejected capture:\n${output.join("\n")}`));
        }
      }, 50);
      managed.process.once("exit", (code) => { clearInterval(poll); clearTimeout(timeout); rejectReady(new Error(`J-Link GDB Server exited with code ${code}:\n${output.join("\n")}`)); });
    });
    return { output };
  }

  private async handleHelperEvent(type: string, payload: HelperResponse): Promise<void> {
    if (!this.session) return;
    if (type === "capture_complete") {
      await new Promise<void>((resolveReady) => setImmediate(resolveReady));
      try { await this.finalizeSession(this.session, payload); } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.session.failures.push(`Finalization failed: ${message}`);
        logError("Capture finalization failed", error);
      }
    }
    if (type === "parent_lost") this.session.failures.push("Native helper reported parent loss");
    if (type === "ipc_failure") this.session.failures.push(`Helper IPC failure: ${String(payload.reason ?? "unknown")}`);
    if (type === "helper_exit") await this.failSessionWithoutHelper(this.session, String(payload.reason ?? "unexpected helper exit"));
  }

  private async failSessionWithoutHelper(session: Session, reason: string): Promise<void> {
    session.failures.push(reason);
    session.terminationReason = "helper_exit";
    if (["preparing", "armed", "capturing"].includes(session.state)) session.state = transitionCaptureState(session.state, "failed");
    this.processManager.kill(captureServerProcess);
    this.probe.releaseExclusive(`capture:${session.id}`);
    session.helper = undefined;
  }

  private async finalizeSession(session: Session, status: HelperResponse): Promise<void> {
    if (this.finalizing) return this.finalizing;
    this.finalizing = this.finishSession(session, status);
    try { await this.finalizing; } finally { this.finalizing = null; }
  }

  private async finishSession(session: Session, status: HelperResponse): Promise<void> {
    if (typeof status.state === "string" && status.state !== session.state) session.state = transitionCaptureState(session.state, status.state as CaptureState);
    if (!["completed", "stopped", "failed"].includes(session.state)) return;
    session.terminationReason = String(status.terminationReason ?? session.terminationReason);
    try {
      const header = await readCaptureHeader(session.binaryFile);
      const metadata = await this.buildMetadata(session, header);
      try { await writeFile(session.metadataFile, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await rm(nativeMetadataFile(session.binaryFile), { force: true });
    } finally {
      this.processManager.kill(captureServerProcess);
      this.probe.releaseExclusive(`capture:${session.id}`);
      await session.helper?.close(false);
      session.helper = undefined;
    }
  }

  private async buildMetadata(session: Session, header: BinaryHeader): Promise<CaptureMetadata> {
    const events = await readEvents(session.binaryFile, header);
    const timing = await captureTiming(session.binaryFile, header);
    const eventMisses = events.filter((event) => event.type === "missed_deadline").reduce((sum, event) => sum + (Number.parseInt(event.detail, 10) || 0), 0);
    timing.missedDeadlines = eventMisses;
    timing.scheduledFrames = Math.max(timing.scheduledFrames, timing.collectedFrames + eventMisses);
    return {
      version: 1,
      sessionId: session.id,
      state: session.state as CaptureMetadata["state"],
      elfPath: session.elf.elfPath,
      elfSha256: session.elf.elfSha256,
      device: session.probe.device,
      probeModel: session.probeModel,
      probeSerial: session.probeSerial,
      swdRateKhz: session.probe.speed,
      gdbServerPath: session.probe.gdbServerPath,
      gdbServerVersion: session.serverVersion,
      rspCapabilities: session.capabilities,
      symbols: header.symbols,
      timing,
      events,
      failures: session.failures,
      resets: events.filter((event) => event.type === "reset"),
      terminationReason: session.terminationReason,
      binaryFile: session.binaryFile,
    };
  }

  private async findTerminalSession(sessionId: string): Promise<Session> {
    if (!isSessionId(sessionId)) throw new Error("An exact capture session UUID is required");
    if (this.session?.id === sessionId) {
      if (!["completed", "stopped", "failed"].includes(this.session.state)) throw new Error("Operation requires a terminal capture session");
      return this.session;
    }
    for (const directory of this.knownOutputDirs) {
      let names: string[];
      try { names = await readdir(directory); } catch { continue; }
      const artifacts = selectSessionArtifacts(names, sessionId);
      const metadataName = artifacts.find((name) => name.endsWith(".metadata.json"));
      const nativeName = artifacts.find((name) => name.endsWith(".native.json"));
      if (!metadataName && !nativeName) continue;
      const stored = JSON.parse(await readFile(join(directory, metadataName ?? nativeName!), "utf8")) as CaptureMetadata | NativeMetadata;
      if (stored.sessionId !== sessionId || !["completed", "stopped", "failed"].includes(stored.state) || typeof stored.binaryFile !== "string") throw new Error("Capture metadata is invalid");
      if (!metadataName && !validNativeMetadata(stored as NativeMetadata)) throw new Error("Native capture metadata is invalid");
      const binaryFile = await realpath(stored.binaryFile);
      if (dirname(binaryFile).toLowerCase() !== directory.toLowerCase()) throw new Error("Capture metadata path escapes its output directory");
      const formal = metadataName ? stored as CaptureMetadata : null;
      const native = nativeName && !metadataName ? stored as NativeMetadata : null;
      return {
        id: stored.sessionId,
        state: stored.state,
        outputDir: directory,
        binaryFile,
        metadataFile: join(directory, metadataName ?? `${basename(binaryFile, ".jlcp")}.metadata.json`),
        elf: { elfPath: stored.elfPath, elfSha256: stored.elfSha256, symbols: formal?.symbols ?? [], sections: [], ramRanges: [], flashSections: [] },
        configPath: native?.configPath ?? "",
        control: {} as ProjectControlConfig,
        probe: { gdbServerPath: stored.gdbServerPath, jlinkExePath: "", device: stored.device, interface: "SWD", speed: stored.swdRateKhz, gdbPort: 0 },
        probeSerial: stored.probeSerial ?? "",
        probeModel: stored.probeModel,
        serverVersion: stored.gdbServerVersion,
        capabilities: formal?.rspCapabilities ?? native?.capabilities.split(";").filter(Boolean) ?? [],
        failures: formal?.failures ?? [],
        terminationReason: stored.terminationReason,
      };
    }
    throw new Error(`Capture session not found: ${sessionId}`);
  }
}

function buildRequestedSymbols(capture: RequestedCaptureSymbol[], config: ProjectControlConfig): RequestedCaptureSymbol[] {
  const names = [
    ...capture,
    { name: config.commands.start.selector },
    { name: config.commands.start.verify.selector },
    { name: config.commands.stop.selector },
    { name: config.commands.stop.verify.selector },
  ];
  const unique = new Map<string, RequestedCaptureSymbol>();
  for (const symbol of names) if (!unique.has(symbol.name)) unique.set(symbol.name, symbol);
  return [...unique.values()];
}

function validateDeclaredTypes(config: ProjectControlConfig, symbols: Map<string, CaptureSymbol>): void {
  for (const [name, command] of Object.entries(config.commands)) {
    const target = symbols.get(command.selector);
    const verify = symbols.get(command.verify.selector);
    if (!target || !verify) throw new Error(`Control command ${name} did not resolve from ELF`);
    if (target.type !== command.type) throw new Error(`Control command ${name} declared type does not match ELF`);
    if (verify.type !== command.verify.type) throw new Error(`Control verification ${name} declared type does not match ELF`);
  }
}

function helperControlPayload(config: ProjectControlConfig, symbols: Map<string, CaptureSymbol>): Record<string, unknown> {
  const convert = (name: "start" | "stop") => {
    const command = config.commands[name];
    return {
      target: symbols.get(command.selector),
      value: command.value,
      timeoutMs: command.timeoutMs ?? (name === "start" ? 1000 : 500),
      verify: {
        symbol: symbols.get(command.verify.selector),
        operator: command.verify.operator,
        value: command.verify.value,
      },
    };
  };
  return { start: convert("start"), stop: convert("stop") };
}

async function prepareOutputDirectory(candidate?: string): Promise<string> {
  const requested = candidate ?? join(tmpdir(), "jlink-mcp-captures");
  if (!isAbsolute(requested)) throw new Error("outputDir must be absolute");
  await mkdir(requested, { recursive: true });
  const directory = await realpath(requested);
  const probe = join(directory, `.write-test-${randomUUID()}`);
  await writeFile(probe, "", { flag: "wx" });
  await rm(probe);
  return directory;
}

async function requireExistingAbsoluteDirectory(candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) throw new Error("outputDir must be absolute");
  const directory = await realpath(candidate);
  if (!(await stat(directory)).isDirectory()) throw new Error("outputDir must be a directory");
  return directory;
}

export function selectProbeSerial(configured: string | undefined, candidates: string[]): string {
  if (configured) return configured;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new Error(`Multiple J-Link probes found; set JLINK_SERIAL explicitly: ${candidates.join(", ")}`);
  throw new Error("No J-Link probe was discovered");
}

export function validateServerIdentity(output: string[], targetStatus: string, device: string, serial: string): { version: string; model: string; voltage: number } {
  const text = output.join("\n") + "\n" + targetStatus;
  const version = text.match(/J-Link GDB Server\s+V?([^\s]+)/i)?.[1] ?? text.match(/V(\d+\.\d+[a-z]?)/i)?.[1];
  const voltageText = text.match(/(?:VTref|VTarget|Target voltage)\s*[:=]\s*([0-9.]+)\s*V?/i)?.[1];
  const voltage = voltageText ? Number(voltageText) : NaN;
  if (!version) throw new Error("J-Link GDB Server version could not be verified");
  if (!Number.isFinite(voltage) || voltage <= 0) throw new Error("Positive target voltage could not be verified");
  if (!device || device === "Unspecified") throw new Error("Target device identity is not configured");
  const model = text.match(/(?:ProductName|Product name|J-Link model)\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim()
    ?? text.match(/Hardware version\s*[:=]\s*([^\r\n]+)/i)?.[1]?.trim()
    ?? "J-Link";
  if (!text.includes(serial)) log(`[Capture] Server output did not echo serial ${serial}; explicit -select remains authoritative`);
  return { version, model, voltage };
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

async function captureTiming(filePath: string, header: BinaryHeader): Promise<Record<string, number>> {
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

function nativeMetadataFile(binaryFile: string): string {
  return binaryFile.endsWith(".jlcp") ? `${binaryFile.slice(0, -5)}.native.json` : `${binaryFile}.native.json`;
}

function validNativeMetadata(value: NativeMetadata): boolean {
  return value?.version === 1 && isSessionId(value.sessionId) && ["completed", "stopped", "failed"].includes(value.state)
    && typeof value.binaryFile === "string" && typeof value.elfPath === "string" && /^[0-9a-f]{64}$/i.test(value.elfSha256)
    && typeof value.device === "string" && typeof value.gdbServerPath === "string" && Number.isFinite(value.swdRateKhz);
}
