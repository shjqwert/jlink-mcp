import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import sqlite3 from "sqlite3";

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
}

export interface JcapV0Sample {
  sampleIndex: number;
  tick: string;
  statusFlags: number;
  values: Record<string, number>;
}

export interface JcapV0Event extends Record<string, unknown> {
  eventId: string;
  type: string;
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
  listDefault: 50,
  listMax: 100,
  listBytes: 256 * 1024,
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
} as const;

interface RawEnvelope {
  formatVersion: 0;
  status: "experimental";
  kind: "provenance" | "sample" | "event";
  payloadEncoding: "json";
  payloadBytes: number;
  payloadSha256: string;
  payload: unknown;
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
interface EventRow { event_id: string; type: string; tick: string; json: string }

export class JcapBoundsError extends Error {
  readonly code = "JCAP_BOUNDS";
}

export function writeJcapV0Raw(input: {
  packageDir: string;
  provenance: JcapV0Provenance;
  samples: JcapV0Sample[];
  events: JcapV0Event[];
}): { samplesFile: string; eventsFile: string } {
  const packageDir = checkedPackageDir(input.packageDir);
  validateProvenance(input.provenance);
  validateSamples(input.samples);
  validateLifecycle(input.events);
  const rawDir = path.join(packageDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const samplesFile = path.join(rawDir, "samples.bin");
  const eventsFile = path.join(rawDir, "events.bin");
  writeFrames(samplesFile, input.samples.map((sample) => envelope("sample", sample)));
  writeFrames(eventsFile, [
    envelope("provenance", input.provenance),
    ...input.events.map((event) => envelope("event", event)),
  ]);
  return { samplesFile, eventsFile };
}

export function readJcapV0Raw(packageDir: string): JcapV0Raw {
  const rawDir = path.join(checkedPackageDir(packageDir), "raw");
  const samplesFile = path.join(rawDir, "samples.bin");
  const eventsFile = path.join(rawDir, "events.bin");
  const sampleRaw = parseFrames<JcapV0Sample>(samplesFile, "sample");
  const eventRaw = parseFrames<JcapV0Event | JcapV0Provenance>(eventsFile, ["provenance", "event"]);
  const provenance = eventRaw.values[0] as JcapV0Provenance | undefined;
  if (!provenance || !("captureId" in provenance)) throw new Error("JCAP v0 raw is missing provenance");
  const events = eventRaw.values.slice(1) as JcapV0Event[];
  validateProvenance(provenance);
  validateSamples(sampleRaw.values);
  validateLifecycle(events);
  return {
    provenance,
    samples: sampleRaw.values,
    events,
    diagnostics: [sampleRaw.diagnostic, eventRaw.diagnostic].filter((value): value is JcapRawDiagnostic => Boolean(value)),
    sources: [
      sourceIdentity(samplesFile, sampleRaw.validBytes),
      sourceIdentity(eventsFile, eventRaw.validBytes),
    ],
  };
}

export async function rebuildJcapV0Index(packageDir: string): Promise<{ captureState: JcapCaptureState; indexStatus: JcapIndexStatus; databaseFile: string; diagnostics: JcapRawDiagnostic[] }> {
  const root = checkedPackageDir(packageDir);
  const raw = readJcapV0Raw(root);
  const captureState = captureStateFromEvents(raw.events);
  const indexStatus: JcapIndexStatus = raw.diagnostics.length ? "failed" : "ready";
  const databaseFile = path.join(root, "capture.db");
  const temporary = path.join(root, "capture.db.tmp");
  rmSync(temporary, { force: true });
  let database: sqlite3.Database | undefined;
  try {
    database = await openDatabase(temporary);
    await exec(database, `
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE provenance (capture_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE raw_sources (file TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, valid_bytes INTEGER NOT NULL, diagnostic TEXT);
      CREATE TABLE samples (sample_index INTEGER PRIMARY KEY, tick TEXT NOT NULL, status_flags INTEGER NOT NULL);
      CREATE TABLE sample_values (sample_index INTEGER NOT NULL, tick TEXT NOT NULL, status_flags INTEGER NOT NULL, variable TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(sample_index, variable));
      CREATE INDEX sample_values_window ON sample_values(variable, CAST(tick AS INTEGER), sample_index);
      CREATE TABLE events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, tick TEXT NOT NULL, json TEXT NOT NULL);
    `);
    await run(database, "BEGIN IMMEDIATE");
    try {
      const metadata: Record<string, string> = {
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
        await run(database, "INSERT INTO samples(sample_index,tick,status_flags) VALUES(?,?,?)", [sample.sampleIndex, sample.tick, sample.statusFlags]);
        for (const [variable, value] of Object.entries(sample.values)) {
          await run(database, "INSERT INTO sample_values(sample_index,tick,status_flags,variable,value) VALUES(?,?,?,?,?)", [sample.sampleIndex, sample.tick, sample.statusFlags, variable, value]);
        }
      }
      for (const event of raw.events) await run(database, "INSERT INTO events(event_id,type,tick,json) VALUES(?,?,?,?)", [event.eventId, event.type, event.tick, JSON.stringify(event)]);
      await run(database, "COMMIT");
    } catch (error) {
      await run(database, "ROLLBACK").catch(() => undefined);
      throw error;
    }
    const integrity = await get<IntegrityRow>(database, "PRAGMA integrity_check");
    if (integrity?.integrity_check !== "ok") throw new Error("capture.db.tmp failed integrity_check");
    await closeDatabase(database);
    database = undefined;
    for (const source of raw.sources) {
      const current = sourceIdentity(path.join(root, source.file), source.validBytes);
      if (current.sha256 !== source.sha256 || current.bytes !== source.bytes) throw new Error("JCAP raw changed while capture.db.tmp was being built");
    }
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, databaseFile);
    return { captureState, indexStatus, databaseFile, diagnostics: raw.diagnostics };
  } finally {
    if (database) await closeDatabase(database).catch(() => undefined);
    rmSync(temporary, { force: true });
  }
}

export async function verifyJcapV0Index(packageDir: string): Promise<{ captureState: JcapCaptureState; indexStatus: JcapIndexStatus }> {
  const root = checkedPackageDir(packageDir);
  const databaseFile = path.join(root, "capture.db");
  if (!existsSync(databaseFile)) {
    const raw = readJcapV0Raw(root);
    const captureState = captureStateFromEvents(raw.events);
    return { captureState, indexStatus: isTerminal(captureState) ? "rebuild_required" : "absent" };
  }
  const database = await openDatabase(databaseFile, sqlite3.OPEN_READONLY);
  try {
    const integrity = await get<IntegrityRow>(database, "PRAGMA integrity_check");
    const meta = Object.fromEntries((await all<MetaRow>(database, "SELECT key,value FROM meta")).map((row) => [row.key, row.value]));
    if (integrity?.integrity_check !== "ok" || meta.format_version !== "0" || meta.format_status !== JCAP_STATUS) return { captureState: meta.capture_state as JcapCaptureState, indexStatus: "rebuild_required" };
    for (const source of await all<SourceRow>(database, "SELECT file,sha256,bytes,valid_bytes,diagnostic FROM raw_sources")) {
      const file = path.join(root, source.file);
      if (!existsSync(file) || sha256File(file) !== source.sha256 || readFileSync(file).length !== source.bytes) return { captureState: meta.capture_state as JcapCaptureState, indexStatus: "rebuild_required" };
    }
    return { captureState: meta.capture_state as JcapCaptureState, indexStatus: meta.index_status as JcapIndexStatus };
  } finally {
    await closeDatabase(database);
  }
}

export async function jcapCaptureSummary(packageDir: string): Promise<Record<string, unknown>> {
  const root = checkedPackageDir(packageDir);
  const status = await verifyJcapV0Index(root);
  const databaseFile = path.join(root, "capture.db");
  if (!existsSync(databaseFile)) return status;
  const database = await openDatabase(databaseFile, sqlite3.OPEN_READONLY);
  try {
    const provenance = JSON.parse((await get<{ json: string }>(database, "SELECT json FROM provenance"))!.json) as JcapV0Provenance;
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
  if (status.indexStatus !== "ready") throw new Error(`JCAP index is not ready: ${status.indexStatus}`);
  const database = await openDatabase(path.join(checkedPackageDir(input.packageDir), "capture.db"), sqlite3.OPEN_READONLY);
  try {
    const placeholders = input.variables.map(() => "?").join(",");
    const rows = await all<ValueRow>(database, `SELECT sample_index,tick,status_flags,variable,value FROM sample_values WHERE variable IN (${placeholders}) AND CAST(tick AS INTEGER) BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER) ORDER BY sample_index,variable LIMIT ?`, [...input.variables, input.startTick, input.endTick, LIMITS.seriesPoints + 1]);
    if (rows.length > LIMITS.seriesPoints) throw new JcapBoundsError("series raw point limit exceeded");
    const start = BigInt(input.startTick);
    const end = BigInt(input.endTick);
    const span = end - start + 1n;
    const buckets = new Map<string, { bucket: number; variable: string; count: number; min: number; max: number; sum: number; last: number; statusFlags: number }>();
    for (const row of rows) {
      const bucket = Math.min(input.bucketCount - 1, Number((BigInt(row.tick) - start) * BigInt(input.bucketCount) / span));
      const key = `${bucket}\0${row.variable}`;
      const current = buckets.get(key) ?? { bucket, variable: row.variable, count: 0, min: Infinity, max: -Infinity, sum: 0, last: row.value, statusFlags: 0 };
      current.count += 1;
      current.min = Math.min(current.min, row.value);
      current.max = Math.max(current.max, row.value);
      current.sum += row.value;
      current.last = row.value;
      current.statusFlags |= row.status_flags;
      buckets.set(key, current);
    }
    const result = {
      captureState: status.captureState,
      indexStatus: status.indexStatus,
      timebase: "capture-relative-nanoseconds",
      startTick: input.startTick,
      endTick: input.endTick,
      bucketCount: input.bucketCount,
      series: [...buckets.values()].map((bucket) => ({ ...bucket, average: bucket.sum / bucket.count, sum: undefined })),
    };
    return bounded(result, LIMITS.seriesBytes);
  } finally {
    await closeDatabase(database);
  }
}

export async function jcapCaptureEventWindow(input: { packageDir: string; eventId: string; variables: string[]; beforeMs: number; afterMs: number; bucketCount: number }): Promise<Record<string, unknown>> {
  if (!Number.isInteger(input.beforeMs) || input.beforeMs < 0 || input.beforeMs > LIMITS.eventMs || !Number.isInteger(input.afterMs) || input.afterMs < 0 || input.afterMs > LIMITS.eventMs) throw new JcapBoundsError("event window must be 0..60000 ms");
  validateSeriesBounds(input.variables, "0", "0", input.bucketCount, LIMITS.eventVariables, LIMITS.eventBuckets, false);
  const root = checkedPackageDir(input.packageDir);
  const status = await verifyJcapV0Index(root);
  if (status.indexStatus !== "ready") throw new Error(`JCAP index is not ready: ${status.indexStatus}`);
  const database = await openDatabase(path.join(root, "capture.db"), sqlite3.OPEN_READONLY);
  try {
    const event = await get<EventRow>(database, "SELECT event_id,type,tick,json FROM events WHERE event_id=?", [input.eventId]);
    if (!event) throw new Error("JCAP event was not found");
    const center = BigInt(event.tick);
    const start = center > BigInt(input.beforeMs) * 1_000_000n ? center - BigInt(input.beforeMs) * 1_000_000n : 0n;
    const end = center + BigInt(input.afterMs) * 1_000_000n;
    const related = await all<EventRow>(database, "SELECT event_id,type,tick,json FROM events WHERE CAST(tick AS INTEGER) BETWEEN CAST(? AS INTEGER) AND CAST(? AS INTEGER) ORDER BY CAST(tick AS INTEGER) LIMIT ?", [start.toString(), end.toString(), LIMITS.eventCount + 1]);
    if (related.length > LIMITS.eventCount) throw new JcapBoundsError("event count limit exceeded");
    const series = await jcapCaptureSeries({ packageDir: root, variables: input.variables, startTick: start.toString(), endTick: end.toString(), bucketCount: input.bucketCount });
    return bounded({ event: JSON.parse(event.json), relatedEvents: related.map((row) => JSON.parse(row.json)), series }, LIMITS.eventBytes);
  } finally {
    await closeDatabase(database);
  }
}

export async function jcapCaptureList(rootDir: string, options: { limit?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
  const limit = options.limit ?? LIMITS.listDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax) throw new JcapBoundsError("capture list limit must be 1..100");
  if ((options.cursor?.length ?? 0) > 1024) throw new JcapBoundsError("capture list cursor exceeds 1024 bytes");
  const names = readdirSync(path.resolve(rootDir), { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.endsWith(".jcap")).map((entry) => entry.name).sort();
  const selected = names.filter((name) => !options.cursor || name > options.cursor).slice(0, limit);
  const captures = await Promise.all(selected.map(async (name) => ({ name, ...await verifyJcapV0Index(path.join(rootDir, name)) })));
  return bounded({ captures, nextCursor: selected.length === limit ? selected.at(-1) : undefined }, LIMITS.listBytes);
}

function envelope(kind: RawEnvelope["kind"], payload: unknown): RawEnvelope {
  const bytes = Buffer.from(JSON.stringify(payload));
  return { formatVersion: 0, status: JCAP_STATUS, kind, payloadEncoding: "json", payloadBytes: bytes.length, payloadSha256: sha256(bytes), payload };
}

function writeFrames(file: string, frames: RawEnvelope[]): void {
  const handle = openSync(file, "wx");
  try {
    for (const frame of frames) writeSync(handle, Buffer.from(`${JSON.stringify(frame)}\n`));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function parseFrames<T>(file: string, expectedKinds: RawEnvelope["kind"] | RawEnvelope["kind"][]): ParsedRaw<T> {
  const bytes = readFileSync(file);
  const kinds = Array.isArray(expectedKinds) ? expectedKinds : [expectedKinds];
  const values: T[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) return { values, validBytes: offset, diagnostic: { file: relativeRawFile(file), offset, length: bytes.length - offset, reason: "truncated_tail" } };
    const next = newline + 1;
    try {
      const frame = JSON.parse(bytes.subarray(offset, newline).toString("utf8")) as RawEnvelope;
      const payload = Buffer.from(JSON.stringify(frame.payload));
      if (frame.formatVersion !== 0 || frame.status !== JCAP_STATUS || frame.payloadEncoding !== "json" || !kinds.includes(frame.kind) || frame.payloadBytes !== payload.length || frame.payloadSha256 !== sha256(payload)) throw new Error("invalid envelope");
      values.push(frame.payload as T);
    } catch {
      return { values, validBytes: offset, diagnostic: { file: relativeRawFile(file), offset, length: bytes.length - offset, reason: "corrupt_suffix" } };
    }
    offset = next;
  }
  return { values, validBytes: offset };
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
  if (!value.captureId || !value.backend || !value.runtime || !value.target || !value.script || !["none", "file"].includes(value.script.mode)) throw new Error("invalid JCAP v0 provenance");
}

function validateSamples(samples: JcapV0Sample[]): void {
  let previousIndex = -1;
  let previousTick = -1n;
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.sampleIndex) || sample.sampleIndex <= previousIndex || !/^\d+$/.test(sample.tick) || BigInt(sample.tick) < previousTick || !Number.isInteger(sample.statusFlags) || !Object.values(sample.values).every(Number.isFinite)) throw new Error("invalid JCAP v0 sample sequence");
    previousIndex = sample.sampleIndex;
    previousTick = BigInt(sample.tick);
  }
}

function validateLifecycle(events: JcapV0Event[]): void {
  const states = events.filter((event) => event.type === "lifecycle").map((event) => event.state as JcapCaptureState);
  if (!states.length || states[0] !== "planned") throw new Error("JCAP lifecycle must begin with planned");
  const allowed: Record<JcapCaptureState, JcapCaptureState[]> = {
    planned: ["active", "failed"], active: ["finalizing", "recoverable", "failed"], finalizing: ["completed", "stopped", "recoverable", "failed"], recoverable: ["finalizing", "failed"], completed: [], stopped: [], failed: [],
  };
  for (let index = 1; index < states.length; index += 1) if (!allowed[states[index - 1]]?.includes(states[index])) throw new Error(`invalid JCAP lifecycle transition ${states[index - 1]} -> ${states[index]}`);
}

function captureStateFromEvents(events: JcapV0Event[]): JcapCaptureState {
  return events.filter((event) => event.type === "lifecycle").at(-1)!.state as JcapCaptureState;
}

function isTerminal(state: JcapCaptureState): boolean {
  return ["completed", "stopped", "failed", "recoverable"].includes(state);
}

function validateSeriesBounds(variables: string[], startTick: string, endTick: string, bucketCount: number, variableLimit: number, bucketLimit: number, validateWindow = true): void {
  if (variables.length < 1 || variables.length > variableLimit || new Set(variables).size !== variables.length) throw new JcapBoundsError(`variable count must be 1..${variableLimit}`);
  if (!Number.isInteger(bucketCount) || bucketCount < 1 || bucketCount > bucketLimit || bucketCount * variables.length > LIMITS.seriesPoints) throw new JcapBoundsError("bucket/variable point limit exceeded");
  if (validateWindow && (!/^\d+$/.test(startTick) || !/^\d+$/.test(endTick) || BigInt(endTick) < BigInt(startTick))) throw new JcapBoundsError("invalid capture-relative tick window");
}

function bounded<T>(value: T, limit: number): T {
  if (Buffer.byteLength(JSON.stringify(value)) > limit) throw new JcapBoundsError(`encoded response exceeds ${limit} bytes`);
  return value;
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

function closeDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
}
