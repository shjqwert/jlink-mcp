import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import sqlite3 from "sqlite3";
import {
  ANALYSIS_V0_MAX_POINTS,
  analyzeJcapV0,
  type AnalysisV0Event,
  type AnalysisV0Profile,
  type AnalysisV0Result,
  type AnalysisV0Role,
  type AnalysisV0Source,
} from "./analysis-v0";

export const JCAP_FORMAT_VERSION = 0 as const;
export const JCAP_STATUS = "experimental" as const;

export type JcapCaptureState = "planned" | "active" | "finalizing" | "completed" | "stopped" | "recoverable" | "failed";
export type JcapIndexStatus = "absent" | "building" | "ready" | "rebuild_required" | "failed";

export interface JcapV0Provenance {
  captureId: string;
  sessionName?: string;
  backend: string;
  runtime: Record<string, unknown>;
  target: Record<string, unknown>;
  script: { mode: "none" | "file"; path?: string; sha256?: string };
  reset?: Record<string, unknown>;
  artifact?: Record<string, unknown>;
  variables?: Record<string, unknown>[];
  artifactMatch?: Record<string, unknown>;
  warnings?: string[];
}

export interface JcapV0Sample {
  sampleIndex: number;
  tick: string;
  statusFlags: number;
  values: Record<string, number>;
}

export interface JcapV0Event extends Record<string, unknown> {
  eventId: string;
  eventSequence: number;
  type: "lifecycle" | "target_control" | "variable_write" | "quality" | "flag" | "fault" | "artifact_match";
  tick: string;
}

export interface JcapRawDiagnostic {
  file: string;
  offset: number;
  length: number;
  reason: "truncated_tail" | "corrupt_suffix";
}

export interface JcapV0Raw {
  provenance: JcapV0Provenance;
  samples: JcapV0Sample[];
  events: JcapV0Event[];
  diagnostics: JcapRawDiagnostic[];
  sources: Array<{ file: string; sha256: string; bytes: number; validBytes: number }>;
}

const LIMITS = {
  rawPayloadBytes: 16 * 1024 * 1024,
  eventPayloadBytes: 256 * 1024,
  listDefault: 50,
  listMax: 100,
  listBytes: 256 * 1024,
  listTailBytes: 512 * 1024,
  summaryBytes: 1024 * 1024,
  seriesVariables: 32,
  seriesBuckets: 4096,
  seriesPoints: 65536,
  seriesBytes: 8 * 1024 * 1024,
  eventVariables: 16,
  eventBuckets: 2048,
  eventMs: 60000,
  eventCount: 128,
  eventBytes: 4 * 1024 * 1024,
  analysisBytes: 4 * 1024 * 1024,
  exportRows: 1_000_000,
} as const;

const U64_MAX = 18_446_744_073_709_551_615n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const RAW_KINDS = ["provenance", "sample", "event"] as const;
type RawKind = typeof RAW_KINDS[number];

interface RawFrameHeader {
  formatVersion: 0;
  status: "experimental";
  kind: RawKind;
  payloadEncoding: "json";
  payloadBytes: number;
  payloadSha256: string;
}

interface ParsedRaw<T> {
  values: T[];
  validBytes: number;
  diagnostic?: JcapRawDiagnostic;
}

interface MetaRow { key: string; value: string }
interface CountRow { count: number }
interface IntegrityRow { integrity_check: string }
interface SourceRow { file: string; sha256: string; bytes: number; valid_bytes: number; diagnostic: string | null }
interface ValueRow { sample_index: number; tick: string; status_flags: number; variable: string; value: number }
interface SampleRow { sample_index: number; tick: string; status_flags: number }
interface EventRow { event_id: string; event_sequence: number; type: string; tick: string; json: string }

export interface AnalysisV0RunRequest {
  captureId: string;
  profile: AnalysisV0Profile;
  signalRoles: Record<string, AnalysisV0Role>;
  eventId?: string;
  beforeMs?: number;
  afterMs?: number;
  startTick?: string;
  endTick?: string;
}

const activeWriters = new Set<string>();
const utf8 = new TextDecoder("utf-8", { fatal: true });

export class JcapBoundsError extends Error {
  readonly code = "JCAP_BOUNDS";
}

export class JcapCaptureNotFoundError extends Error {
  readonly code = "JCAP_CAPTURE_NOT_FOUND";
}

export class JcapV0QueryService {
  private readonly capturesDir: string;

  constructor(capturesDir: string) {
    this.capturesDir = path.resolve(capturesDir);
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
    validateListBounds(input);
    if (!existsSync(this.capturesDir)) return { captures: [] };
    return jcapCaptureList(this.capturesDir, input);
  }

  async summary(input: { captureId: string }): Promise<Record<string, unknown>> {
    const summary = await jcapCaptureSummary(this.packageFor(input.captureId));
    return readinessResponse(summary) ?? summary;
  }

  async series(input: { captureId: string; variables: string[]; startTick: string; endTick: string; bucketCount: number }): Promise<Record<string, unknown>> {
    validateSeriesBounds(input.variables, input.startTick, input.endTick, input.bucketCount, LIMITS.seriesVariables, LIMITS.seriesBuckets);
    const packageDir = this.packageFor(input.captureId);
    const unavailable = readinessResponse(await verifyJcapV0Index(packageDir), true);
    return unavailable ?? jcapCaptureSeries({ packageDir, variables: input.variables, startTick: input.startTick, endTick: input.endTick, bucketCount: input.bucketCount });
  }

  async eventWindow(input: { captureId: string; eventId: string; variables: string[]; beforeMs: number; afterMs: number; bucketCount: number }): Promise<Record<string, unknown>> {
    if (!UUID.test(input.eventId)) throw new JcapBoundsError("eventId must be a UUID");
    if (!Number.isInteger(input.beforeMs) || input.beforeMs < 0 || input.beforeMs > LIMITS.eventMs || !Number.isInteger(input.afterMs) || input.afterMs < 0 || input.afterMs > LIMITS.eventMs) throw new JcapBoundsError("event window must be 0..60000 ms");
    validateEventWindowBounds(input.variables, input.bucketCount);
    const packageDir = this.packageFor(input.captureId);
    const unavailable = readinessResponse(await verifyJcapV0Index(packageDir), true);
    return unavailable ?? jcapCaptureEventWindow({ packageDir, eventId: input.eventId, variables: input.variables, beforeMs: input.beforeMs, afterMs: input.afterMs, bucketCount: input.bucketCount });
  }

  async analysisRun(input: AnalysisV0RunRequest): Promise<Record<string, unknown>> {
    validateAnalysisRunInput(input);
    const packageDir = this.packageFor(input.captureId);
    const status = await verifyJcapV0Index(packageDir);
    const unavailable = readinessResponse(status, true);
    if (unavailable) return unavailable;
    const database = await openDatabase(path.join(packageDir, "capture.db"));
    try {
      let startTick = input.startTick;
      let endTick = input.endTick;
      if (input.eventId) {
        const event = await get<EventRow>(database, "SELECT event_id,event_sequence,type,tick,json FROM events WHERE event_id=?", [input.eventId]);
        if (!event) throw new Error("JCAP event was not found");
        const center = BigInt(event.tick);
        const before = BigInt(input.beforeMs!) * 1_000_000n;
        const after = BigInt(input.afterMs!) * 1_000_000n;
        if (center + after > U64_MAX) throw new JcapBoundsError("analysis event window exceeds u64 ticks");
        startTick = (center > before ? center - before : 0n).toString();
        endTick = (center + after).toString();
      }
      const variables = Object.keys(input.signalRoles).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      const placeholders = variables.map(() => "?").join(",");
      const rows = variables.length ? await all<ValueRow>(database, `SELECT sample_index,tick,status_flags,variable,value FROM sample_values WHERE variable IN (${placeholders}) AND tick_key BETWEEN ? AND ? ORDER BY tick_key,sample_index,variable LIMIT ?`, [...variables, u64Key(startTick!), u64Key(endTick!), ANALYSIS_V0_MAX_POINTS + 1]) : [];
      if (rows.length > ANALYSIS_V0_MAX_POINTS) throw new JcapBoundsError(`analysis point limit exceeded: ${ANALYSIS_V0_MAX_POINTS}`);
      const eventRows = await all<EventRow>(database, "SELECT event_id,event_sequence,type,tick,json FROM events WHERE tick_key BETWEEN ? AND ? ORDER BY tick_key,event_sequence,event_id LIMIT ?", [u64Key(startTick!), u64Key(endTick!), ANALYSIS_V0_MAX_POINTS + 1]);
      if (eventRows.length > ANALYSIS_V0_MAX_POINTS) throw new JcapBoundsError(`analysis event limit exceeded: ${ANALYSIS_V0_MAX_POINTS}`);
      const events = eventRows.map((row) => JSON.parse(row.json) as AnalysisV0Event);
      const rawSources = (await all<SourceRow>(database, "SELECT file,sha256,bytes,valid_bytes,diagnostic FROM raw_sources ORDER BY file")).map<AnalysisV0Source>((source) => ({
        file: source.file,
        sha256: source.sha256,
        bytes: source.bytes,
        validBytes: source.valid_bytes,
      }));
      const result = analyzeJcapV0({
        captureId: input.captureId,
        profile: input.profile,
        signalRoles: input.signalRoles,
        window: { startTick: startTick!, endTick: endTick!, ...(input.eventId ? { eventId: input.eventId } : {}) },
        points: rows.map((row) => ({ sampleIndex: row.sample_index, tick: row.tick, statusFlags: row.status_flags, variable: row.variable, value: row.value })),
        events,
        rawSources,
      });
      bounded(result, LIMITS.analysisBytes);
      await persistAnalysisRun(database, result);
      return result;
    } finally {
      await closeDatabase(database);
    }
  }

  async rebuild(input: { captureId: string }): Promise<Record<string, unknown>> {
    const packageDir = this.packageFor(input.captureId);
    const status = await verifyJcapV0Index(packageDir);
    if (["planned", "active", "finalizing"].includes(status.captureState)) return { status: "not_ready", ...status };
    return rebuildJcapV0Index(packageDir);
  }

  async exportCsv(input: { captureId: string }): Promise<Record<string, unknown>> {
    const packageDir = this.packageFor(input.captureId);
    const status = await verifyJcapV0Index(packageDir);
    const unavailable = readinessResponse(status, true);
    return unavailable ?? { ...status, ...await jcapCaptureExportCsv(packageDir) };
  }

  private packageFor(captureId: string): string {
    if (!UUID.test(captureId)) throw new JcapBoundsError("captureId must be a UUID");
    const packageDir = path.join(this.capturesDir, `${captureId}.jcap`);
    if (!existsSync(packageDir)) throw new JcapCaptureNotFoundError(`JCAP capture was not found: ${captureId}`);
    return packageDir;
  }
}

async function persistAnalysisRun(database: sqlite3.Database, result: AnalysisV0Result): Promise<void> {
  await run(database, "BEGIN IMMEDIATE");
  try {
    await exec(database, `
      CREATE TABLE IF NOT EXISTS analysis_schema_version (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_runs (analysis_run_id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, result_json TEXT NOT NULL, raw_source_tuple_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_findings (analysis_run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(analysis_run_id, ordinal), FOREIGN KEY(analysis_run_id) REFERENCES analysis_runs(analysis_run_id) ON DELETE CASCADE);
    `);
    await run(database, "INSERT OR IGNORE INTO analysis_schema_version(singleton,version) VALUES(1,1)");
    const schema = await get<{ version: number }>(database, "SELECT version FROM analysis_schema_version WHERE singleton=1");
    if (schema?.version !== 1) throw new Error("unsupported analysis schema version");
    await run(database, "INSERT OR REPLACE INTO analysis_runs(analysis_run_id,input_digest,result_json,raw_source_tuple_json) VALUES(?,?,?,?)", [result.analysisRunId, result.analysisRunId, JSON.stringify(result), JSON.stringify(result.rawSources)]);
    await run(database, "DELETE FROM analysis_findings WHERE analysis_run_id=?", [result.analysisRunId]);
    for (const [ordinal, finding] of result.findings.entries()) await run(database, "INSERT INTO analysis_findings(analysis_run_id,ordinal,type,json) VALUES(?,?,?,?)", [result.analysisRunId, ordinal, String(finding.type), JSON.stringify(finding)]);
    await run(database, "COMMIT");
  } catch (error) {
    await run(database, "ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function validateAnalysisRunInput(input: AnalysisV0RunRequest): void {
  const allowed = new Set(["captureId", "profile", "signalRoles", "eventId", "beforeMs", "afterMs", "startTick", "endTick"]);
  if (!isRecord(input) || Object.keys(input).some((key) => !allowed.has(key))) throw new JcapBoundsError("analysis_run accepts only captureId, profile, signalRoles and one window selector");
  if (!UUID.test(input.captureId)) throw new JcapBoundsError("captureId must be a UUID");
  if (input.profile !== "generic_control" && input.profile !== "generic_state_machine") throw new JcapBoundsError("analysis profile must be generic_control or generic_state_machine");
  if (!isRecord(input.signalRoles)) throw new JcapBoundsError("signalRoles must be an object");
  const variables = Object.keys(input.signalRoles);
  if (variables.length > 16) throw new JcapBoundsError("analysis accepts at most 16 signalRoles");
  validateVariableNames(variables);
  if (Object.values(input.signalRoles).some((role) => !["command", "feedback", "state"].includes(role))) throw new JcapBoundsError("analysis v0 roles are command, feedback, or state");
  const eventWindow = input.eventId !== undefined || input.beforeMs !== undefined || input.afterMs !== undefined;
  const tickWindow = input.startTick !== undefined || input.endTick !== undefined;
  if (eventWindow === tickWindow) throw new JcapBoundsError("select exactly one event or tick analysis window");
  if (eventWindow) {
    if (typeof input.eventId !== "string" || !UUID.test(input.eventId)) throw new JcapBoundsError("eventId must be a UUID");
    if (!Number.isInteger(input.beforeMs) || input.beforeMs! < 0 || input.beforeMs! > LIMITS.eventMs || !Number.isInteger(input.afterMs) || input.afterMs! < 0 || input.afterMs! > LIMITS.eventMs) throw new JcapBoundsError("analysis event window must be 0..60000 ms");
  } else if (!isU64(input.startTick) || !isU64(input.endTick) || BigInt(input.startTick!) > BigInt(input.endTick!)) {
    throw new JcapBoundsError("analysis tick window must be ordered decimal u64 startTick/endTick");
  }
}

export class JcapV0Writer {
  readonly packageDir: string;
  readonly samplesFile: string;
  readonly eventsFile: string;
  private samplesHandle: number | undefined;
  private eventsHandle: number | undefined;
  private samplesBytes = 0;
  private samplesStopped = false;
  private previousSampleIndex = -1;
  private previousSampleTick = -1n;
  private previousEventSequence = -1;
  private previousEventTick = -1n;
  private lifecycleState: JcapCaptureState | undefined;
  private readonly externalSamples: boolean;

  constructor(input: { packageDir: string; provenance: JcapV0Provenance; maxSamplesBytes?: number; externalSamples?: boolean }) {
    this.packageDir = checkedPackageDir(input.packageDir);
    validateProvenance(input.provenance);
    const maxSamplesBytes = input.maxSamplesBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxSamplesBytes) || maxSamplesBytes < 1) throw new JcapBoundsError("maxSamplesBytes must be a positive safe integer");
    this.maxSamplesBytes = maxSamplesBytes;
    this.externalSamples = input.externalSamples === true;
    if (activeWriters.has(this.packageDir)) throw new Error("JCAP package already has an active writer");
    const rawDir = path.join(this.packageDir, "raw");
    mkdirSync(rawDir, { recursive: true });
    if (readdirSync(rawDir).some((name) => name.endsWith(".bin"))) throw new Error("JCAP raw directory already contains a binary journal");
    this.samplesFile = path.join(rawDir, "samples.bin");
    this.eventsFile = path.join(rawDir, "events.bin");
    try {
      if (!this.externalSamples) this.samplesHandle = openSync(this.samplesFile, "ax");
      this.eventsHandle = openSync(this.eventsFile, "ax");
      writeSync(this.eventsHandle, encodeFrame("provenance", input.provenance));
      activeWriters.add(this.packageDir);
    } catch (error) {
      if (this.samplesHandle !== undefined) closeSync(this.samplesHandle);
      if (this.eventsHandle !== undefined) closeSync(this.eventsHandle);
      rmSync(this.samplesFile, { force: true });
      rmSync(this.eventsFile, { force: true });
      throw error;
    }
  }

  private readonly maxSamplesBytes: number;

  appendSample(sample: JcapV0Sample): boolean {
    if (this.externalSamples) throw new Error("JCAP samples journal is owned by an external producer");
    if (this.samplesHandle === undefined) throw new Error("JCAP samples journal is closed");
    if (this.samplesStopped) return false;
    validateSample(sample, this.previousSampleIndex, this.previousSampleTick);
    const frame = encodeFrame("sample", sample);
    if (this.samplesBytes + frame.length > this.maxSamplesBytes) {
      this.samplesStopped = true;
      return false;
    }
    writeSync(this.samplesHandle, frame);
    this.samplesBytes += frame.length;
    this.previousSampleIndex = sample.sampleIndex;
    this.previousSampleTick = BigInt(sample.tick);
    return true;
  }

  appendEvent(event: JcapV0Event): void {
    if (this.eventsHandle === undefined) throw new Error("JCAP events journal is closed");
    validateEvent(event, this.previousEventSequence, this.previousEventTick, this.lifecycleState);
    writeSync(this.eventsHandle, encodeFrame("event", event));
    this.previousEventSequence = event.eventSequence;
    this.previousEventTick = BigInt(event.tick);
    if (event.type === "lifecycle") this.lifecycleState = event.state as JcapCaptureState;
  }

  syncSamples(): void {
    if (this.externalSamples) throw new Error("JCAP samples journal is owned by an external producer");
    if (this.samplesHandle === undefined) throw new Error("JCAP samples journal is closed");
    fsyncSync(this.samplesHandle);
  }

  syncEvents(): void {
    if (this.eventsHandle === undefined) throw new Error("JCAP events journal is closed");
    fsyncSync(this.eventsHandle);
  }

  closeSamples(): void {
    if (this.samplesHandle === undefined) return;
    fsyncSync(this.samplesHandle);
    closeSync(this.samplesHandle);
    this.samplesHandle = undefined;
  }

  closeEvents(): void {
    if (this.samplesHandle !== undefined) throw new Error("close samples before closing the JCAP events journal");
    if (this.eventsHandle === undefined) return;
    fsyncSync(this.eventsHandle);
    closeSync(this.eventsHandle);
    this.eventsHandle = undefined;
    activeWriters.delete(this.packageDir);
  }

  close(): void {
    this.closeSamples();
    this.closeEvents();
  }
}

export function writeJcapV0Raw(input: {
  packageDir: string;
  provenance: JcapV0Provenance;
  samples: JcapV0Sample[];
  events: JcapV0Event[];
}): { samplesFile: string; eventsFile: string } {
  const writer = new JcapV0Writer({ packageDir: input.packageDir, provenance: input.provenance });
  try {
    for (const sample of input.samples) if (!writer.appendSample(sample)) throw new JcapBoundsError("JCAP samples budget exhausted");
    writer.closeSamples();
    for (const event of input.events) writer.appendEvent(event);
    writer.closeEvents();
    return { samplesFile: writer.samplesFile, eventsFile: writer.eventsFile };
  } catch (error) {
    writer.close();
    throw error;
  }
}

export async function finalizeJcapV0Capture(input: {
  writer: JcapV0Writer;
  finalizingEvent: JcapV0Event;
  terminalEvent: JcapV0Event;
  recoverableEvent: JcapV0Event;
}): ReturnType<typeof rebuildJcapV0Index> {
  if (input.finalizingEvent.type !== "lifecycle" || input.finalizingEvent.state !== "finalizing") throw new Error("finalizingEvent must enter finalizing");
  if (input.terminalEvent.type !== "lifecycle" || !["completed", "stopped", "failed"].includes(input.terminalEvent.state as string)) throw new Error("terminalEvent must enter completed, stopped, or failed");
  if (input.recoverableEvent.type !== "lifecycle" || input.recoverableEvent.state !== "recoverable") throw new Error("recoverableEvent must enter recoverable");
  input.writer.closeSamples();
  input.writer.appendEvent(input.finalizingEvent);
  input.writer.syncEvents();
  try {
    const raw = readJcapV0Raw(input.writer.packageDir);
    if (!raw.diagnostics.length) input.writer.appendEvent(input.terminalEvent);
    else if (raw.diagnostics.every((diagnostic) => diagnostic.file === "raw/samples.bin")) input.writer.appendEvent(input.recoverableEvent);
    input.writer.closeEvents();
  } catch (error) {
    input.writer.closeEvents();
    throw error;
  }
  return rebuildJcapV0Index(input.writer.packageDir);
}

export function readJcapV0Raw(packageDir: string): JcapV0Raw {
  const rawDir = path.join(checkedPackageDir(packageDir), "raw");
  const samplesFile = path.join(rawDir, "samples.bin");
  const eventsFile = path.join(rawDir, "events.bin");
  let previousSampleIndex = -1;
  let previousSampleTick = -1n;
  const sampleRaw = parseFrames<JcapV0Sample>(samplesFile, () => "sample", (sample) => {
    validateSample(sample, previousSampleIndex, previousSampleTick);
    previousSampleIndex = sample.sampleIndex;
    previousSampleTick = BigInt(sample.tick);
  });
  let previousEventSequence = -1;
  let previousEventTick = -1n;
  let lifecycleState: JcapCaptureState | undefined;
  const eventRaw = parseFrames<JcapV0Event | JcapV0Provenance>(eventsFile, (index) => index === 0 ? "provenance" : "event", (value, index) => {
    if (index === 0) {
      validateProvenance(value as JcapV0Provenance);
      return;
    }
    const event = value as JcapV0Event;
    validateEvent(event, previousEventSequence, previousEventTick, lifecycleState);
    previousEventSequence = event.eventSequence;
    previousEventTick = BigInt(event.tick);
    if (event.type === "lifecycle") lifecycleState = event.state as JcapCaptureState;
  });
  const provenance = eventRaw.values[0] as JcapV0Provenance | undefined;
  if (!provenance) throw new Error("JCAP v0 raw is missing provenance");
  const events = eventRaw.values.slice(1) as JcapV0Event[];
  if (!events.length) throw new Error("JCAP v0 raw is missing lifecycle events");
  return {
    provenance,
    samples: sampleRaw.values,
    events,
    diagnostics: [sampleRaw.diagnostic, eventRaw.diagnostic].filter((value): value is JcapRawDiagnostic => Boolean(value)),
    sources: [sourceIdentity(samplesFile, sampleRaw.validBytes), sourceIdentity(eventsFile, eventRaw.validBytes)],
  };
}

export async function rebuildJcapV0Index(packageDir: string): Promise<{ captureState: JcapCaptureState; indexStatus: JcapIndexStatus; databaseFile: string; diagnostics: JcapRawDiagnostic[] }> {
  const root = checkedPackageDir(packageDir);
  if (activeWriters.has(root)) throw new Error("close the JCAP raw writer before rebuilding the index");
  const raw = readJcapV0Raw(root);
  const captureState = effectiveCaptureState(raw);
  if (!isTerminal(captureState)) throw new Error(`JCAP raw is not terminal: ${captureState}`);
  const indexStatus: JcapIndexStatus = raw.diagnostics.length ? "failed" : "ready";
  const databaseFile = path.join(root, "capture.db");
  const temporary = path.join(root, "capture.db.tmp");
  rmSync(temporary, { force: true });
  let database: sqlite3.Database | undefined;
  try {
    database = await openDatabase(temporary);
    await exec(database, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    await run(database, "BEGIN IMMEDIATE");
    try {
      await exec(database, `
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE provenance (capture_id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE raw_sources (file TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, valid_bytes INTEGER NOT NULL, diagnostic TEXT);
        CREATE TABLE samples (sample_index INTEGER PRIMARY KEY, tick TEXT NOT NULL, tick_key TEXT NOT NULL, status_flags INTEGER NOT NULL);
        CREATE TABLE sample_values (sample_index INTEGER NOT NULL, tick TEXT NOT NULL, tick_key TEXT NOT NULL, status_flags INTEGER NOT NULL, variable TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(sample_index, variable));
        CREATE INDEX sample_values_window ON sample_values(variable, tick_key, sample_index);
        CREATE TABLE events (event_id TEXT PRIMARY KEY, event_sequence INTEGER UNIQUE NOT NULL, type TEXT NOT NULL, tick TEXT NOT NULL, tick_key TEXT NOT NULL, json TEXT NOT NULL);
        CREATE INDEX events_window ON events(tick_key, event_sequence);
      `);
      const metadata: Record<string, string> = {
        schema_version: "1",
        format_version: String(JCAP_FORMAT_VERSION),
        format_status: JCAP_STATUS,
        capture_state: captureState,
        index_status: indexStatus,
      };
      for (const [key, value] of Object.entries(metadata)) await run(database, "INSERT INTO meta(key,value) VALUES(?,?)", [key, value]);
      await run(database, "INSERT INTO provenance(capture_id,json) VALUES(?,?)", [raw.provenance.captureId, JSON.stringify(raw.provenance)]);
      for (const source of raw.sources) {
        const diagnostic = raw.diagnostics.find((item) => item.file === source.file);
        await run(database, "INSERT INTO raw_sources(file,sha256,bytes,valid_bytes,diagnostic) VALUES(?,?,?,?,?)", [source.file, source.sha256, source.bytes, source.validBytes, diagnostic ? JSON.stringify(diagnostic) : null]);
      }
      for (const sample of raw.samples) {
        const tickKey = u64Key(sample.tick);
        await run(database, "INSERT INTO samples(sample_index,tick,tick_key,status_flags) VALUES(?,?,?,?)", [sample.sampleIndex, sample.tick, tickKey, sample.statusFlags]);
        for (const [variable, value] of Object.entries(sample.values)) await run(database, "INSERT INTO sample_values(sample_index,tick,tick_key,status_flags,variable,value) VALUES(?,?,?,?,?,?)", [sample.sampleIndex, sample.tick, tickKey, sample.statusFlags, variable, value]);
      }
      for (const event of raw.events) await run(database, "INSERT INTO events(event_id,event_sequence,type,tick,tick_key,json) VALUES(?,?,?,?,?,?)", [event.eventId, event.eventSequence, event.type, event.tick, u64Key(event.tick), JSON.stringify(event)]);
      await run(database, "COMMIT");
    } catch (error) {
      await run(database, "ROLLBACK").catch(() => undefined);
      throw error;
    }
    const integrity = await get<IntegrityRow>(database, "PRAGMA integrity_check");
    if (integrity?.integrity_check !== "ok") throw new Error("capture.db.tmp failed integrity_check");
    await closeDatabase(database);
    database = undefined;
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    for (const source of raw.sources) {
      const current = sourceIdentity(path.join(root, source.file), source.validBytes);
      if (current.sha256 !== source.sha256 || current.bytes !== source.bytes || current.validBytes !== source.validBytes) throw new Error("JCAP raw changed while capture.db.tmp was being built");
    }
    renameSync(temporary, databaseFile);
    return { captureState, indexStatus, databaseFile, diagnostics: raw.diagnostics };
  } finally {
    if (database) await closeDatabase(database).catch(() => undefined);
    rmSync(temporary, { force: true });
  }
}

export async function verifyJcapV0Index(packageDir: string): Promise<{ captureState: JcapCaptureState; indexStatus: JcapIndexStatus }> {
  const root = checkedPackageDir(packageDir);
  if (activeWriters.has(root)) {
    return { captureState: captureStateFromEvents(readJcapV0Raw(root).events), indexStatus: "absent" };
  }
  const databaseFile = path.join(root, "capture.db");
  if (!existsSync(databaseFile)) {
    const captureState = effectiveCaptureState(readJcapV0Raw(root));
    return { captureState, indexStatus: isTerminal(captureState) ? "rebuild_required" : "absent" };
  }
  let database: sqlite3.Database | undefined;
  try {
    database = await openDatabase(databaseFile, sqlite3.OPEN_READONLY);
    const integrity = await get<IntegrityRow>(database, "PRAGMA integrity_check");
    const meta = Object.fromEntries((await all<MetaRow>(database, "SELECT key,value FROM meta")).map((row) => [row.key, row.value]));
    const captureState = meta.capture_state as JcapCaptureState;
    if (integrity?.integrity_check !== "ok" || meta.schema_version !== "1" || meta.format_version !== "0" || meta.format_status !== JCAP_STATUS || !isCaptureState(captureState)) return { captureState: isCaptureState(captureState) ? captureState : "recoverable", indexStatus: "rebuild_required" };
    const sources = await all<SourceRow>(database, "SELECT file,sha256,bytes,valid_bytes,diagnostic FROM raw_sources");
    const expectedSources = new Set(["raw/samples.bin", "raw/events.bin"]);
    if (sources.length !== expectedSources.size || sources.some((source) => !expectedSources.delete(source.file))) return { captureState, indexStatus: "rebuild_required" };
    for (const source of sources) {
      const file = path.join(root, source.file);
      if (!existsSync(file) || statSync(file).size !== source.bytes || sha256File(file) !== source.sha256) return { captureState, indexStatus: "rebuild_required" };
    }
    return { captureState, indexStatus: isIndexStatus(meta.index_status) ? meta.index_status : "rebuild_required" };
  } catch {
    return { captureState: effectiveCaptureState(readJcapV0Raw(root)), indexStatus: "rebuild_required" };
  } finally {
    if (database) await closeDatabase(database).catch(() => undefined);
  }
}

export async function jcapCaptureSummary(packageDir: string): Promise<Record<string, unknown>> {
  const root = checkedPackageDir(packageDir);
  const status = await verifyJcapV0Index(root);
  const databaseFile = path.join(root, "capture.db");
  if (!existsSync(databaseFile) || status.indexStatus === "rebuild_required" || status.indexStatus === "absent") return status;
  const database = await openDatabase(databaseFile, sqlite3.OPEN_READONLY);
  try {
    const provenance = JSON.parse((await get<{ json: string }>(database, "SELECT json FROM provenance"))!.json) as JcapV0Provenance;
    const artifactMatchRow = await get<{ json: string }>(database, "SELECT json FROM events WHERE type='artifact_match' ORDER BY event_sequence DESC LIMIT 1");
    if (artifactMatchRow) {
      const artifactMatch = JSON.parse(artifactMatchRow.json) as Record<string, unknown>;
      provenance.artifactMatch = artifactMatch;
      provenance.warnings = artifactMatch.targetArtifactMatch === "unverified" && artifactMatch.captureAllowed !== false ? ["target Artifact match is unverified; read-only capture continued"] : [];
    }
    const sampleCount = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM samples"))!.count;
    const eventCount = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM events"))!.count;
    const variables = (await all<{ variable: string }>(database, "SELECT DISTINCT variable FROM sample_values ORDER BY variable")).map((row) => row.variable);
    const sources = await all<SourceRow>(database, "SELECT file,sha256,bytes,valid_bytes,diagnostic FROM raw_sources ORDER BY file");
    return bounded({ ...status, provenance, sampleCount, eventCount, variables, sources }, LIMITS.summaryBytes);
  } finally {
    await closeDatabase(database);
  }
}

export async function jcapCaptureSeries(input: { packageDir: string; variables: string[]; startTick: string; endTick: string; bucketCount: number }): Promise<Record<string, unknown>> {
  validateSeriesBounds(input.variables, input.startTick, input.endTick, input.bucketCount, LIMITS.seriesVariables, LIMITS.seriesBuckets);
  const status = await verifyJcapV0Index(input.packageDir);
  if (status.indexStatus !== "ready" || !["completed", "stopped"].includes(status.captureState)) throw new Error(`JCAP capture is not queryable: ${status.captureState}/${status.indexStatus}`);
  const database = await openDatabase(path.join(checkedPackageDir(input.packageDir), "capture.db"), sqlite3.OPEN_READONLY);
  try {
    const placeholders = input.variables.map(() => "?").join(",");
    const start = BigInt(input.startTick);
    const end = BigInt(input.endTick);
    const span = end - start + 1n;
    const buckets = new Map<string, { bucket: number; variable: string; count: number; min: number; max: number; sum: number; last: number; statusFlags: number }>();
    await each<ValueRow>(database, `SELECT sample_index,tick,status_flags,variable,value FROM sample_values WHERE variable IN (${placeholders}) AND tick_key BETWEEN ? AND ? ORDER BY tick_key,sample_index,variable`, [...input.variables, u64Key(input.startTick), u64Key(input.endTick)], (row) => {
      const bucket = Number((BigInt(row.tick) - start) * BigInt(input.bucketCount) / span);
      const key = `${bucket}\0${row.variable}`;
      const current = buckets.get(key) ?? { bucket, variable: row.variable, count: 0, min: Infinity, max: -Infinity, sum: 0, last: row.value, statusFlags: 0 };
      current.count += 1;
      current.min = Math.min(current.min, row.value);
      current.max = Math.max(current.max, row.value);
      current.sum += row.value;
      current.last = row.value;
      current.statusFlags |= row.status_flags;
      buckets.set(key, current);
    });
    const series = [...buckets.values()].sort((left, right) => left.bucket - right.bucket || left.variable.localeCompare(right.variable)).map((bucket) => {
      const bucketStartTick = start + divideCeiling(span * BigInt(bucket.bucket), BigInt(input.bucketCount));
      const bucketEndTick = start + divideCeiling(span * BigInt(bucket.bucket + 1), BigInt(input.bucketCount)) - 1n;
      return { bucket: bucket.bucket, bucketStartTick: bucketStartTick.toString(), bucketEndTick: bucketEndTick.toString(), variable: bucket.variable, count: bucket.count, min: bucket.min, max: bucket.max, average: bucket.sum / bucket.count, last: bucket.last, statusFlags: bucket.statusFlags };
    });
    return bounded({ captureState: status.captureState, indexStatus: status.indexStatus, timebase: "capture-relative-nanoseconds", unit: "ns", startTick: input.startTick, endTick: input.endTick, bucketCount: input.bucketCount, series }, LIMITS.seriesBytes);
  } finally {
    await closeDatabase(database);
  }
}

export async function jcapCaptureEventWindow(input: { packageDir: string; eventId: string; variables: string[]; beforeMs: number; afterMs: number; bucketCount: number }): Promise<Record<string, unknown>> {
  if (!UUID.test(input.eventId)) throw new JcapBoundsError("eventId must be a UUID");
  if (!Number.isInteger(input.beforeMs) || input.beforeMs < 0 || input.beforeMs > LIMITS.eventMs || !Number.isInteger(input.afterMs) || input.afterMs < 0 || input.afterMs > LIMITS.eventMs) throw new JcapBoundsError("event window must be 0..60000 ms");
  validateEventWindowBounds(input.variables, input.bucketCount);
  const root = checkedPackageDir(input.packageDir);
  const status = await verifyJcapV0Index(root);
  if (status.indexStatus !== "ready" || !["completed", "stopped"].includes(status.captureState)) throw new Error(`JCAP capture is not queryable: ${status.captureState}/${status.indexStatus}`);
  const database = await openDatabase(path.join(root, "capture.db"), sqlite3.OPEN_READONLY);
  try {
    const event = await get<EventRow>(database, "SELECT event_id,event_sequence,type,tick,json FROM events WHERE event_id=?", [input.eventId]);
    if (!event) throw new Error("JCAP event was not found");
    const center = BigInt(event.tick);
    const before = BigInt(input.beforeMs) * 1_000_000n;
    const after = BigInt(input.afterMs) * 1_000_000n;
    if (center + after > U64_MAX) throw new JcapBoundsError("event window exceeds u64 ticks");
    const start = center > before ? center - before : 0n;
    const end = center + after;
    const related = await all<EventRow>(database, "SELECT event_id,event_sequence,type,tick,json FROM events WHERE tick_key BETWEEN ? AND ? ORDER BY event_sequence LIMIT ?", [u64Key(start.toString()), u64Key(end.toString()), LIMITS.eventCount + 1]);
    if (related.length > LIMITS.eventCount) throw new JcapBoundsError("event count limit exceeded");
    const nearest = await nearestSample(database, center);
    const series = input.variables.length ? await jcapCaptureSeries({ packageDir: root, variables: input.variables, startTick: start.toString(), endTick: end.toString(), bucketCount: input.bucketCount }) : { series: [], bucketCount: input.bucketCount, startTick: start.toString(), endTick: end.toString() };
    return bounded({ captureState: status.captureState, indexStatus: status.indexStatus, event: JSON.parse(event.json), relatedEvents: related.map((row) => JSON.parse(row.json)), nearestSample: nearest, series }, LIMITS.eventBytes);
  } finally {
    await closeDatabase(database);
  }
}

export async function jcapCaptureList(rootDir: string, options: { limit?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
  const limit = validateListBounds(options);
  const root = path.resolve(rootDir);
  const names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.endsWith(".jcap")).map((entry) => entry.name).sort();
  const page = names.filter((name) => !options.cursor || name > options.cursor).slice(0, limit + 1);
  const selected = page.slice(0, limit);
  const captures = await Promise.all(selected.map(async (name) => ({ name, ...await listCaptureStatus(path.join(root, name)) })));
  return bounded({ captures, nextCursor: page.length > limit ? selected.at(-1) : undefined }, LIMITS.listBytes);
}

function validateListBounds(options: { limit?: number; cursor?: string }): number {
  const limit = options.limit ?? LIMITS.listDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax) throw new JcapBoundsError("capture list limit must be 1..100");
  if (Buffer.byteLength(options.cursor ?? "", "utf8") > 1024) throw new JcapBoundsError("capture list cursor exceeds 1024 bytes");
  return limit;
}

export async function jcapCaptureExportCsv(packageDir: string): Promise<{ exportFile: string; rows: number }> {
  const root = checkedPackageDir(packageDir);
  const status = await verifyJcapV0Index(root);
  if (status.indexStatus !== "ready" || !["completed", "stopped"].includes(status.captureState)) throw new Error(`JCAP capture is not exportable: ${status.captureState}/${status.indexStatus}`);
  const database = await openDatabase(path.join(root, "capture.db"), sqlite3.OPEN_READONLY);
  const exportDir = path.join(root, "export");
  const exportFile = path.join(exportDir, "samples.csv");
  let handle: number | undefined;
  let created = false;
  try {
    const rows = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM sample_values"))!.count;
    if (!Number.isSafeInteger(rows) || rows > LIMITS.exportRows) throw new JcapBoundsError(`CSV export exceeds ${LIMITS.exportRows} rows`);
    mkdirSync(exportDir, { recursive: true });
    handle = openSync(exportFile, "wx");
    created = true;
    writeSync(handle, "sampleIndex,tick,statusFlags,variable,value\r\n");
    await each<ValueRow>(database, "SELECT sample_index,tick,status_flags,variable,value FROM sample_values ORDER BY sample_index,variable", [], (row) => {
      writeSync(handle!, `${row.sample_index},${row.tick},${row.status_flags},${csv(row.variable)},${row.value}\r\n`);
    });
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    return { exportFile, rows };
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    if (created) rmSync(exportFile, { force: true });
    throw error;
  } finally {
    await closeDatabase(database);
  }
}

function readinessResponse(status: Record<string, unknown>, requireCompleted = false): Record<string, unknown> | undefined {
  const captureState = status.captureState as JcapCaptureState | undefined;
  const indexStatus = status.indexStatus as JcapIndexStatus | undefined;
  if (indexStatus === "rebuild_required") return { status: "rebuild_required", captureState, indexStatus };
  if (indexStatus !== "ready" || (requireCompleted && captureState !== "completed" && captureState !== "stopped")) {
    return { status: "not_ready", captureState, indexStatus };
  }
  return undefined;
}

function encodeFrame(kind: RawKind, payload: unknown): Buffer {
  validateJsonNumbers(payload);
  const json = JSON.stringify(payload);
  if (json === undefined) throw new Error("JCAP payload is not JSON encodable");
  const payloadBytes = Buffer.from(json, "utf8");
  const payloadLimit = kind === "event" ? LIMITS.eventPayloadBytes : LIMITS.rawPayloadBytes;
  if (payloadBytes.length > payloadLimit) throw new JcapBoundsError(`JCAP payload exceeds ${payloadLimit} bytes`);
  const header: RawFrameHeader = { formatVersion: 0, status: JCAP_STATUS, kind, payloadEncoding: "json", payloadBytes: payloadBytes.length, payloadSha256: sha256(payloadBytes) };
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), payloadBytes, Buffer.from("\n")]);
}

function parseFrames<T>(file: string, expectedKind: (index: number) => RawKind, accept: (value: T, index: number) => void): ParsedRaw<T> {
  const bytes = readFileSync(file);
  const values: T[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const headerEnd = bytes.indexOf(0x0a, offset);
    if (headerEnd < 0) return damaged(values, file, offset, bytes.length, "truncated_tail");
    let header: RawFrameHeader;
    try {
      header = JSON.parse(utf8.decode(bytes.subarray(offset, headerEnd))) as RawFrameHeader;
      validateHeader(header, expectedKind(values.length));
    } catch {
      return damaged(values, file, offset, bytes.length, "corrupt_suffix");
    }
    const payloadStart = headerEnd + 1;
    const payloadEnd = payloadStart + header.payloadBytes;
    if (payloadEnd >= bytes.length) return damaged(values, file, offset, bytes.length, "truncated_tail");
    if (bytes[payloadEnd] !== 0x0a) return damaged(values, file, offset, bytes.length, "corrupt_suffix");
    const payloadBytes = bytes.subarray(payloadStart, payloadEnd);
    try {
      if (sha256(payloadBytes) !== header.payloadSha256) throw new Error("payload hash mismatch");
      const value = JSON.parse(utf8.decode(payloadBytes)) as T;
      validateJsonNumbers(value);
      accept(value, values.length);
      values.push(value);
    } catch {
      return damaged(values, file, offset, bytes.length, "corrupt_suffix");
    }
    offset = payloadEnd + 1;
  }
  return { values, validBytes: offset };
}

function damaged<T>(values: T[], file: string, offset: number, total: number, reason: JcapRawDiagnostic["reason"]): ParsedRaw<T> {
  return { values, validBytes: offset, diagnostic: { file: relativeRawFile(file), offset, length: total - offset, reason } };
}

function validateHeader(header: RawFrameHeader, expectedKind: RawKind): void {
  const payloadLimit = expectedKind === "event" ? LIMITS.eventPayloadBytes : LIMITS.rawPayloadBytes;
  if (!header || header.formatVersion !== 0 || header.status !== JCAP_STATUS || header.kind !== expectedKind || !RAW_KINDS.includes(header.kind) || header.payloadEncoding !== "json" || !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 0 || header.payloadBytes > payloadLimit || !SHA256.test(header.payloadSha256)) throw new Error("invalid JCAP v0 frame header");
}

function sourceIdentity(file: string, validBytes: number): { file: string; sha256: string; bytes: number; validBytes: number } {
  const bytes = readFileSync(file);
  return { file: relativeRawFile(file), sha256: sha256(bytes), bytes: bytes.length, validBytes };
}

function relativeRawFile(file: string): string {
  return path.join("raw", path.basename(file)).replaceAll("\\", "/");
}

function checkedPackageDir(value: string): string {
  const resolved = path.resolve(value);
  if (!resolved.endsWith(".jcap")) throw new Error("JCAP package directory must end with .jcap");
  return resolved;
}

function validateProvenance(value: JcapV0Provenance): void {
  if (!isRecord(value) || !UUID.test(value.captureId) || typeof value.backend !== "string" || !value.backend || !isRecord(value.runtime) || !isRecord(value.target) || !isRecord(value.script) || !["none", "file"].includes(value.script.mode)) throw new Error("invalid JCAP v0 provenance");
  if (value.script.mode === "file" && (typeof value.script.path !== "string" || !value.script.path || typeof value.script.sha256 !== "string" || !SHA256.test(value.script.sha256))) throw new Error("file script provenance requires path and sha256");
  if (value.script.mode === "none" && (value.script.path !== undefined || value.script.sha256 !== undefined)) throw new Error("none script provenance cannot carry a script identity");
  validateJsonNumbers(value);
}

function validateSample(sample: JcapV0Sample, previousIndex: number, previousTick: bigint): void {
  if (!isRecord(sample) || !Number.isSafeInteger(sample.sampleIndex) || sample.sampleIndex < 0 || sample.sampleIndex <= previousIndex || !isU64(sample.tick) || BigInt(sample.tick) < previousTick || !Number.isSafeInteger(sample.statusFlags) || sample.statusFlags < 0 || sample.statusFlags > 0xffff_ffff || !isRecord(sample.values) || !Object.keys(sample.values).length || !Object.entries(sample.values).every(([name, value]) => name.length > 0 && typeof value === "number" && Number.isFinite(value))) throw new Error("invalid JCAP v0 sample sequence");
  validateJsonNumbers(sample);
}

function validateEvent(event: JcapV0Event, previousSequence: number, previousTick: bigint, lifecycleState: JcapCaptureState | undefined): void {
  if (!isRecord(event) || !UUID.test(event.eventId) || !Number.isSafeInteger(event.eventSequence) || event.eventSequence < 0 || event.eventSequence <= previousSequence || !["lifecycle", "target_control", "variable_write", "quality", "flag", "fault", "artifact_match"].includes(event.type) || !isU64(event.tick) || BigInt(event.tick) < previousTick) throw new Error("invalid JCAP v0 event sequence");
  if (previousSequence < 0 && (event.type !== "lifecycle" || event.state !== "planned")) throw new Error("JCAP lifecycle must begin with planned");
  if (lifecycleState && ["completed", "stopped", "failed"].includes(lifecycleState)) throw new Error("JCAP terminal event must be last");
  if (event.type === "lifecycle") {
    if (!isCaptureState(event.state)) throw new Error("invalid JCAP lifecycle state");
    const next = event.state;
    const allowed: Record<JcapCaptureState, JcapCaptureState[]> = {
      planned: ["active", "failed"], active: ["finalizing", "recoverable", "failed"], finalizing: ["completed", "stopped", "recoverable", "failed"], recoverable: ["finalizing", "failed"], completed: [], stopped: [], failed: [],
    };
    if (lifecycleState ? !allowed[lifecycleState].includes(next) : next !== "planned") throw new Error(`invalid JCAP lifecycle transition ${lifecycleState ?? "none"} -> ${next}`);
  }
  validateJsonNumbers(event);
}

function validateJsonNumbers(value: unknown, seen = new Set<object>()): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("JCAP payload contains an invalid number");
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value !== "object") throw new Error("JCAP payload contains a non-JSON value");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("JCAP payload contains a non-plain object");
  if (seen.has(value)) throw new Error("JCAP payload contains a cycle");
  seen.add(value);
  for (const child of Object.values(value)) validateJsonNumbers(child, seen);
  seen.delete(value);
}

function captureStateFromEvents(events: JcapV0Event[]): JcapCaptureState {
  const state = events.filter((event) => event.type === "lifecycle").at(-1)?.state;
  if (!isCaptureState(state)) throw new Error("JCAP raw has no valid lifecycle state");
  return state;
}

function effectiveCaptureState(raw: JcapV0Raw): JcapCaptureState {
  const state = captureStateFromEvents(raw.events);
  return raw.diagnostics.length && ["active", "finalizing"].includes(state) ? "recoverable" : state;
}

function isCaptureState(value: unknown): value is JcapCaptureState {
  return typeof value === "string" && ["planned", "active", "finalizing", "completed", "stopped", "recoverable", "failed"].includes(value);
}

function isIndexStatus(value: unknown): value is JcapIndexStatus {
  return typeof value === "string" && ["absent", "building", "ready", "rebuild_required", "failed"].includes(value);
}

function isTerminal(state: JcapCaptureState): boolean {
  return ["completed", "stopped", "failed", "recoverable"].includes(state);
}

function isU64(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= U64_MAX;
}

function u64Key(value: string): string {
  if (!isU64(value)) throw new JcapBoundsError("tick must be a decimal u64 string");
  return value.padStart(20, "0");
}

function validateVariableNames(variables: string[]): void {
  if (variables.some((name) => typeof name !== "string" || !name || Buffer.byteLength(name, "utf8") > 256) || new Set(variables).size !== variables.length) throw new JcapBoundsError("variable names must be unique non-empty UTF-8 strings of at most 256 bytes");
}

function validateSeriesBounds(variables: string[], startTick: string, endTick: string, bucketCount: number, variableLimit: number, bucketLimit: number): void {
  if (variables.length < 1 || variables.length > variableLimit) throw new JcapBoundsError(`variable count must be 1..${variableLimit}`);
  validateVariableNames(variables);
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > bucketLimit || bucketCount * variables.length > LIMITS.seriesPoints) throw new JcapBoundsError("bucket/variable point limit exceeded");
  if (!isU64(startTick) || !isU64(endTick) || BigInt(endTick) < BigInt(startTick)) throw new JcapBoundsError("invalid capture-relative tick window");
}

function validateEventWindowBounds(variables: string[], bucketCount: number): void {
  if (variables.length > LIMITS.eventVariables) throw new JcapBoundsError(`variable count must be 0..${LIMITS.eventVariables}`);
  validateVariableNames(variables);
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > LIMITS.eventBuckets || bucketCount * variables.length > LIMITS.seriesPoints) throw new JcapBoundsError("bucket/variable point limit exceeded");
}

function bounded<T>(value: T, limit: number): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > limit) throw new JcapBoundsError(`encoded response exceeds ${limit} bytes`);
  return value;
}

function divideCeiling(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

async function listCaptureStatus(packageDir: string): Promise<{ captureState: JcapCaptureState; indexStatus: JcapIndexStatus }> {
  const databaseFile = path.join(packageDir, "capture.db");
  if (existsSync(databaseFile)) {
    let database: sqlite3.Database | undefined;
    try {
      database = await openDatabase(databaseFile, sqlite3.OPEN_READONLY);
      const meta = Object.fromEntries((await all<MetaRow>(database, "SELECT key,value FROM meta WHERE key IN ('capture_state','index_status')")).map((row) => [row.key, row.value]));
      if (isCaptureState(meta.capture_state) && isIndexStatus(meta.index_status)) return { captureState: meta.capture_state, indexStatus: meta.index_status };
    } catch { /* malformed indexes are rebuildable */ } finally {
      if (database) await closeDatabase(database).catch(() => undefined);
    }
  }
  const state = readTailCaptureState(path.join(packageDir, "raw", "events.bin"));
  return { captureState: state, indexStatus: isTerminal(state) ? "rebuild_required" : "absent" };
}

function readTailCaptureState(file: string): JcapCaptureState {
  if (!existsSync(file)) return "recoverable";
  const size = statSync(file).size;
  const length = Math.min(size, LIMITS.listTailBytes);
  const bytes = Buffer.alloc(length);
  const handle = openSync(file, "r");
  try { readSync(handle, bytes, 0, length, size - length); } finally { closeSync(handle); }
  let end = bytes.length;
  if (end && bytes[end - 1] === 0x0a) end -= 1;
  for (let headerEnd = bytes.lastIndexOf(0x0a, end - 1); headerEnd >= 0;) {
    const previousLine = bytes.lastIndexOf(0x0a, headerEnd - 1);
    try {
      const header = JSON.parse(utf8.decode(bytes.subarray(previousLine + 1, headerEnd))) as RawFrameHeader;
      validateHeader(header, "event");
      const payload = bytes.subarray(headerEnd + 1, end);
      if (payload.length === header.payloadBytes && sha256(payload) === header.payloadSha256) {
        const event = JSON.parse(utf8.decode(payload)) as JcapV0Event;
        return event.type === "lifecycle" && UUID.test(event.eventId) && Number.isSafeInteger(event.eventSequence) && isU64(event.tick) && isCaptureState(event.state) ? event.state : "recoverable";
      }
    } catch { /* keep scanning within the fixed tail for the terminal frame header */ }
    headerEnd = previousLine;
  }
  return "recoverable";
}

async function nearestSample(database: sqlite3.Database, tick: bigint): Promise<SampleRow | undefined> {
  const key = u64Key(tick.toString());
  const before = await get<SampleRow>(database, "SELECT sample_index,tick,status_flags FROM samples WHERE tick_key<=? ORDER BY tick_key DESC,sample_index DESC LIMIT 1", [key]);
  const after = await get<SampleRow>(database, "SELECT sample_index,tick,status_flags FROM samples WHERE tick_key>=? ORDER BY tick_key,sample_index LIMIT 1", [key]);
  if (!before) return after;
  if (!after) return before;
  return tick - BigInt(before.tick) <= BigInt(after.tick) - tick ? before : after;
}

function csv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file: string): string {
  return sha256(readFileSync(file));
}

function openDatabase(file: string, mode?: number): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, mode ?? (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE), (error) => error ? reject(error) : resolve(database));
  });
}

function exec(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => database.exec(sql, (error) => error ? reject(error) : resolve()));
}

function run(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => database.run(sql, params, (error) => error ? reject(error) : resolve()));
}

function get<T>(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => database.get<T>(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function all<T>(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => database.all<T>(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function each<T>(database: sqlite3.Database, sql: string, params: unknown[], onRow: (row: T) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    let callbackError: unknown;
    database.each<T>(sql, params, (error, row) => {
      if (error || callbackError) {
        callbackError ??= error;
        return;
      }
      try { onRow(row); } catch (caught) { callbackError = caught; }
    }, (error, count) => callbackError ? reject(callbackError) : error ? reject(error) : resolve(count));
  });
}

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}
