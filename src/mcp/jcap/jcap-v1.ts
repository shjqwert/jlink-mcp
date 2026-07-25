import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import sqlite3 from "sqlite3";
import { atomicReplaceSync } from "../../utils/atomic-file";
import {
  ANALYSIS_V0_MAX_POINTS,
  analyzeJcapV0,
  type AnalysisV0Event,
  type AnalysisV0Profile,
  type AnalysisV0Result,
  type AnalysisV0Role,
  type AnalysisV0Source,
} from "./analysis-v0";
import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";
import { withDirectoryLease } from "../runtime/file-lease";

export const JCAP_FORMAT_VERSION = 1 as const;
export const JCAP_STATUS = "stable" as const;

export type JcapV1CaptureState = "active" | "finalizing" | "completed" | "stopped" | "interrupted" | "failed";
export type JcapV1IndexStatus = "absent" | "building" | "ready" | "rebuild_required" | "failed";
export type JcapV1QualitySource = "none" | "jlink" | "target_counter";
export type JcapRunMutationGuard = <T>(runId: string, operation: () => Promise<T>) => Promise<T>;

export interface JcapV1Provenance {
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

export interface JcapV1VariableDescriptor {
  logicalIdentity: string;
  type: string;
  address: string;
  size: number;
  artifactGeneration: string;
  layoutHash: string;
  alias?: string;
  unit?: string;
}

export interface JcapV1RawIdentity {
  file: "raw/samples.bin" | "raw/events.bin";
  bytes: number;
  validBytes: number;
  sha256: string | null;
}

export interface JcapV1Metadata {
  formatVersion: 1;
  captureId: string;
  createdAt: string;
  updatedAt: string;
  state: JcapV1CaptureState;
  indexStatus: JcapV1IndexStatus;
  backend: "jlink-hss" | "fake-jlink-hss";
  requestedRateHz: number;
  durationSec: number;
  recordSize: number;
  timebase: { kind: "capture-relative"; unit: "ns"; tickFrequencyHz: 1_000_000_000 };
  variables: JcapV1VariableDescriptor[];
  provenance: JcapV1Provenance;
  sampleCount: number;
  eventCount: number;
  qualityStatus: "unknown" | "partial" | "reported";
  qualitySource: JcapV1QualitySource;
  quality: { missingSamples: number | null; droppedSamples: number | null; overflows: number | null; readErrors: number | null; timeouts: number | null };
  raw: { samples: JcapV1RawIdentity; events: JcapV1RawIdentity };
  diagnostics: JcapRawDiagnostic[];
}

export interface JcapV1Sample {
  sampleIndex: number;
  tick: string;
  statusFlags: number;
  values: Record<string, number>;
}

export interface JcapV1Event extends Record<string, unknown> {
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

export interface JcapV1Raw {
  metadata: JcapV1Metadata;
  provenance: JcapV1Provenance;
  samples: JcapV1Sample[];
  events: JcapV1Event[];
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
const SCALAR_BYTES: Readonly<Record<string, number>> = Object.freeze({ int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4 });
const RAW_KINDS = ["sample", "event"] as const;
type RawKind = typeof RAW_KINDS[number];

interface RawFrameHeader {
  formatVersion: 1;
  status: "stable";
  kind: RawKind;
  payloadEncoding: "json";
  payloadBytes: number;
  payloadSha256: string;
  payloadCrc32: string;
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
interface IndexValueRow extends ValueRow { tick_key: string }
interface IndexSampleRow extends SampleRow { tick_key: string }
interface IndexEventRow extends EventRow { tick_key: string }

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

export class JcapVersionUnsupportedError extends Error {
  readonly code = "JCAP_VERSION_UNSUPPORTED";
}

export class JcapIntegrityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JcapIntegrityError";
  }
}

export class JcapCaptureAmbiguousError extends Error {
  readonly code = "JCAP_CAPTURE_AMBIGUOUS";
}

export function createJcapV1Metadata(input: {
  captureId: string;
  backend: JcapV1Metadata["backend"];
  requestedRateHz: number;
  durationSec: number;
  variables: JcapV1VariableDescriptor[];
  provenance: JcapV1Provenance;
  createdAt?: string;
}): JcapV1Metadata {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const metadata: JcapV1Metadata = {
    formatVersion: 1,
    captureId: input.captureId,
    createdAt,
    updatedAt: createdAt,
    state: "active",
    indexStatus: "absent",
    backend: input.backend,
    requestedRateHz: input.requestedRateHz,
    durationSec: input.durationSec,
    recordSize: 4 + input.variables.reduce((sum, variable) => sum + variable.size, 0),
    timebase: { kind: "capture-relative", unit: "ns", tickFrequencyHz: 1_000_000_000 },
    variables: structuredClone(input.variables),
    provenance: structuredClone(input.provenance),
    sampleCount: 0,
    eventCount: 0,
    qualityStatus: "unknown",
    qualitySource: "none",
    quality: { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
    raw: {
      samples: { file: "raw/samples.bin", bytes: 0, validBytes: 0, sha256: null },
      events: { file: "raw/events.bin", bytes: 0, validBytes: 0, sha256: null },
    },
    diagnostics: [],
  };
  validateMetadata(metadata);
  return metadata;
}

export function readJcapV1Metadata(packageDir: string): JcapV1Metadata {
  const root = checkedPackageDir(packageDir);
  const file = path.join(root, "capture.json");
  let value: unknown;
  try {
    const bytes = readFileSync(file);
    if (bytes.length > 4 * 1024 * 1024) throw new Error("capture.json exceeds 4 MiB");
    value = JSON.parse(utf8.decode(bytes));
  } catch (error) {
    if (error instanceof JcapVersionUnsupportedError) throw error;
    throw new JcapVersionUnsupportedError(`JCAP v1 capture.json is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || value.formatVersion !== 1) throw new JcapVersionUnsupportedError("JCAP package is not formatVersion 1");
  validateMetadata(value as JcapV1Metadata, root);
  return value as JcapV1Metadata;
}

export function updateJcapV1Metadata(packageDir: string, update: (current: JcapV1Metadata) => JcapV1Metadata): JcapV1Metadata {
  const root = checkedPackageDir(packageDir);
  const next = update(readJcapV1Metadata(root));
  validateMetadata(next, root);
  atomicWriteMetadata(path.join(root, "capture.json"), next);
  return structuredClone(next);
}

export function refreshActiveJcapV1Metadata(packageDir: string): JcapV1Metadata {
  const root = checkedPackageDir(packageDir);
  const raw = readJcapV1Raw(root);
  if (!['active', 'finalizing'].includes(raw.metadata.state)) return raw.metadata;
  const identities = rawIdentities(raw.sources);
  const next: JcapV1Metadata = {
    ...raw.metadata,
    updatedAt: new Date().toISOString(),
    sampleCount: raw.samples.length,
    eventCount: raw.events.length,
    raw: {
      samples: { ...identities.samples, sha256: null },
      events: { ...identities.events, sha256: null },
    },
    diagnostics: raw.diagnostics,
  };
  atomicWriteMetadata(path.join(root, "capture.json"), next);
  return structuredClone(next);
}

export function finalizeJcapV1Metadata(
  packageDir: string,
  state: Exclude<JcapV1CaptureState, "active" | "finalizing">,
  quality: Partial<JcapV1Metadata["quality"]> = {},
  qualityStatus: JcapV1Metadata["qualityStatus"] = "unknown",
  qualitySource: JcapV1QualitySource = qualityStatus === "reported" ? "jlink" : "none",
): JcapV1Metadata {
  const root = checkedPackageDir(packageDir);
  const raw = readJcapV1Raw(root);
  if (!terminalStateMatchesRaw(raw, state)) throw new Error("terminal lifecycle event does not match requested capture state");
  const current = raw.metadata;
  const next: JcapV1Metadata = {
    ...current,
    updatedAt: new Date().toISOString(),
    state,
    indexStatus: state === "failed" ? "failed" : "rebuild_required",
    sampleCount: raw.samples.length,
    eventCount: raw.events.length,
    qualityStatus,
    qualitySource,
    quality: { ...current.quality, ...quality },
    raw: rawIdentities(raw.sources),
    diagnostics: raw.diagnostics,
  };
  validateMetadata(next, root);
  atomicWriteMetadata(path.join(root, "capture.json"), next);
  return structuredClone(next);
}

export class JcapV1QueryService {
  private readonly rootDir: string;

  constructor(rootDir: string, private readonly guardRunMutation?: JcapRunMutationGuard) {
    this.rootDir = path.resolve(rootDir);
  }

  async list(input: { limit?: number; cursor?: string } = {}): Promise<Record<string, unknown>> {
    validateListBounds(input);
    if (!existsSync(this.rootDir)) return { captures: [] };
    return jcapCaptureList(this.rootDir, input);
  }

  async summary(input: { captureId: string }): Promise<Record<string, unknown>> {
    const location = this.locationFor(input.captureId);
    return this.mutate(location, async () => {
      const ready = await this.ensureQueryableIndex(location);
      if (ready.unavailable) return ready.unavailable;
      return { ...await jcapCaptureSummary(location.packageDir), ...(ready.indexRebuilt ? { indexRebuilt: true } : {}) };
    });
  }

  async series(input: { captureId: string; variables: string[]; startTick: string; endTick: string; bucketCount: number }): Promise<Record<string, unknown>> {
    validateSeriesBounds(input.variables, input.startTick, input.endTick, input.bucketCount, LIMITS.seriesVariables, LIMITS.seriesBuckets);
    const location = this.locationFor(input.captureId);
    return this.mutate(location, async () => {
      const ready = await this.ensureQueryableIndex(location);
      if (ready.unavailable) return ready.unavailable;
      return { ...await jcapCaptureSeries({ packageDir: location.packageDir, variables: input.variables, startTick: input.startTick, endTick: input.endTick, bucketCount: input.bucketCount }), ...(ready.indexRebuilt ? { indexRebuilt: true } : {}) };
    });
  }

  async eventWindow(input: { captureId: string; eventId: string; variables: string[]; beforeMs: number; afterMs: number; bucketCount: number }): Promise<Record<string, unknown>> {
    if (!UUID.test(input.eventId)) throw new JcapBoundsError("eventId must be a UUID");
    if (!Number.isInteger(input.beforeMs) || input.beforeMs < 0 || input.beforeMs > LIMITS.eventMs || !Number.isInteger(input.afterMs) || input.afterMs < 0 || input.afterMs > LIMITS.eventMs) throw new JcapBoundsError("event window must be 0..60000 ms");
    validateEventWindowBounds(input.variables, input.bucketCount);
    const location = this.locationFor(input.captureId);
    return this.mutate(location, async () => {
      const ready = await this.ensureQueryableIndex(location);
      if (ready.unavailable) return ready.unavailable;
      return { ...await jcapCaptureEventWindow({ packageDir: location.packageDir, eventId: input.eventId, variables: input.variables, beforeMs: input.beforeMs, afterMs: input.afterMs, bucketCount: input.bucketCount }), ...(ready.indexRebuilt ? { indexRebuilt: true } : {}) };
    });
  }

  async analysisRun(input: AnalysisV0RunRequest): Promise<Record<string, unknown>> {
    validateAnalysisRunInput(input);
    const location = this.locationFor(input.captureId);
    return this.mutate(location, () => this.analysisRunPackage(input, location.packageDir));
  }

  private async analysisRunPackage(input: AnalysisV0RunRequest, packageDir: string): Promise<Record<string, unknown>> {
    const ready = await this.ensureQueryableIndex({ packageDir, captureId: input.captureId, cursor: input.captureId });
    const unavailable = ready.unavailable;
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
      return { ...result, ...(ready.indexRebuilt ? { indexRebuilt: true } : {}) };
    } finally {
      await closeDatabase(database);
    }
  }

  async rebuild(input: { captureId: string }): Promise<Record<string, unknown>> {
    const location = this.locationFor(input.captureId);
    return this.mutate(location, async () => {
      const status = await verifyJcapV1Index(location.packageDir);
      if (["active", "finalizing"].includes(status.captureState)) return { status: "not_ready", ...status };
      return rebuildJcapV1Index(location.packageDir);
    });
  }

  async exportCsv(input: { captureId: string }): Promise<Record<string, unknown>> {
    const location = this.locationFor(input.captureId);
    return this.mutate(location, async () => {
      const ready = await this.ensureQueryableIndex(location);
      const unavailable = ready.unavailable;
      const owningRoot = path.dirname(path.dirname(location.packageDir));
      return unavailable ?? { ...ready.status, ...await jcapCaptureExportCsv(location.packageDir, path.join(owningRoot, "exports")), ...(ready.indexRebuilt ? { indexRebuilt: true } : {}) };
    });
  }

  private async ensureQueryableIndex(location: Pick<CaptureLocation, "packageDir" | "captureId" | "cursor">): Promise<{ status: Awaited<ReturnType<typeof verifyJcapV1Index>>; indexRebuilt: boolean; unavailable?: Record<string, unknown> }> {
    let status = await verifyJcapV1Index(location.packageDir);
    let indexRebuilt = false;
    if (status.indexStatus === "rebuild_required" && !["active", "finalizing"].includes(status.captureState)) {
      await rebuildJcapV1Index(location.packageDir);
      status = await verifyJcapV1Index(location.packageDir);
      indexRebuilt = true;
    }
    return { status, indexRebuilt, unavailable: readinessResponse(status, true) };
  }

  private packageFor(captureId: string): string {
    return this.locationFor(captureId).packageDir;
  }

  private locationFor(captureId: string): CaptureLocation {
    if (!UUID.test(captureId)) throw new JcapBoundsError("captureId must be a UUID");
    return resolveCaptureLocation(this.rootDir, captureId);
  }

  private mutate<T>(location: CaptureLocation, operation: () => Promise<T>): Promise<T> {
    return location.runId && this.guardRunMutation ? this.guardRunMutation(location.runId, operation) : operation();
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

export class JcapV1Writer {
  readonly packageDir: string;
  readonly captureJson: string;
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
  private lifecycleState: JcapV1CaptureState | undefined;
  private readonly externalSamples: boolean;
  private metadata: JcapV1Metadata;

  constructor(input: { packageDir: string; metadata: JcapV1Metadata; maxSamplesBytes?: number; externalSamples?: boolean }) {
    this.packageDir = checkedPackageDir(input.packageDir);
    validateMetadata(input.metadata, this.packageDir);
    this.metadata = structuredClone(input.metadata);
    const maxSamplesBytes = input.maxSamplesBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxSamplesBytes) || maxSamplesBytes < 1) throw new JcapBoundsError("maxSamplesBytes must be a positive safe integer");
    this.maxSamplesBytes = maxSamplesBytes;
    this.externalSamples = input.externalSamples === true;
    if (activeWriters.has(this.packageDir)) throw new Error("JCAP package already has an active writer");
    const rawDir = path.join(this.packageDir, "raw");
    if (existsSync(this.packageDir) && readdirSync(this.packageDir).length) throw new Error("JCAP v1 package must be new and empty");
    mkdirSync(rawDir, { recursive: true });
    this.captureJson = path.join(this.packageDir, "capture.json");
    this.samplesFile = path.join(rawDir, "samples.bin");
    this.eventsFile = path.join(rawDir, "events.bin");
    try {
      if (!this.externalSamples) this.samplesHandle = openSync(this.samplesFile, "ax");
      this.eventsHandle = openSync(this.eventsFile, "ax");
      atomicWriteMetadata(this.captureJson, this.metadata);
      activeWriters.add(this.packageDir);
    } catch (error) {
      if (this.samplesHandle !== undefined) closeSync(this.samplesHandle);
      if (this.eventsHandle !== undefined) closeSync(this.eventsHandle);
      rmSync(this.samplesFile, { force: true });
      rmSync(this.eventsFile, { force: true });
      rmSync(this.captureJson, { force: true });
      throw error;
    }
  }

  private readonly maxSamplesBytes: number;

  appendSample(sample: JcapV1Sample): boolean {
    if (this.externalSamples) throw new Error("JCAP samples journal is owned by an external producer");
    if (this.samplesHandle === undefined) throw new Error("JCAP samples journal is closed");
    if (this.samplesStopped) return false;
    validateSample(sample, this.previousSampleIndex, this.previousSampleTick, this.metadata.variables.map((variable) => variable.logicalIdentity));
    const frame = encodeFrame("sample", sample);
    if (this.samplesBytes + frame.length > this.maxSamplesBytes) {
      this.samplesStopped = true;
      return false;
    }
    writeAll(this.samplesHandle, frame);
    this.samplesBytes += frame.length;
    this.previousSampleIndex = sample.sampleIndex;
    this.previousSampleTick = BigInt(sample.tick);
    this.metadata.sampleCount += 1;
    return true;
  }

  appendEvent(event: JcapV1Event): void {
    if (this.eventsHandle === undefined) throw new Error("JCAP events journal is closed");
    validateEvent(event, this.previousEventSequence, this.previousEventTick, this.lifecycleState, this.metadata.variables);
    writeAll(this.eventsHandle, encodeFrame("event", event));
    this.previousEventSequence = event.eventSequence;
    this.previousEventTick = BigInt(event.tick);
    this.metadata.eventCount += 1;
    if (event.type === "lifecycle") this.lifecycleState = event.state as JcapV1CaptureState;
  }

  syncSamples(): void {
    if (this.externalSamples) throw new Error("JCAP samples journal is owned by an external producer");
    if (this.samplesHandle === undefined) throw new Error("JCAP samples journal is closed");
    fsyncSync(this.samplesHandle);
    this.publishProgress();
  }

  syncEvents(): void {
    if (this.eventsHandle === undefined) throw new Error("JCAP events journal is closed");
    fsyncSync(this.eventsHandle);
    if (this.externalSamples && !existsSync(this.samplesFile)) return;
    this.publishProgress();
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

  publishProgress(): JcapV1Metadata {
    this.metadata = currentMetadata(this.packageDir, this.metadata, false);
    atomicWriteMetadata(this.captureJson, this.metadata);
    return structuredClone(this.metadata);
  }

  finalize(
    state: Exclude<JcapV1CaptureState, "active" | "finalizing">,
    quality: Partial<JcapV1Metadata["quality"]> = {},
    qualityStatus: JcapV1Metadata["qualityStatus"] = "unknown",
    qualitySource: JcapV1QualitySource = qualityStatus === "reported" ? "jlink" : "none",
  ): JcapV1Metadata {
    if (this.samplesHandle !== undefined || this.eventsHandle !== undefined) throw new Error("close both Raw writers before finalizing capture metadata");
    return finalizeJcapV1Metadata(this.packageDir, state, quality, qualityStatus, qualitySource);
  }
}

export function writeJcapV1Raw(input: {
  packageDir: string;
  metadata: JcapV1Metadata;
  samples: JcapV1Sample[];
  events: JcapV1Event[];
}): { samplesFile: string; eventsFile: string } {
  const writer = new JcapV1Writer({ packageDir: input.packageDir, metadata: input.metadata });
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

export async function finalizeJcapV1Capture(input: {
  writer: JcapV1Writer;
  finalizingEvent: JcapV1Event;
  terminalEvent: JcapV1Event;
  interruptedEvent: JcapV1Event;
  quality?: Partial<JcapV1Metadata["quality"]>;
  qualityStatus?: JcapV1Metadata["qualityStatus"];
  qualitySource?: JcapV1QualitySource;
}): ReturnType<typeof rebuildJcapV1Index> {
  if (input.finalizingEvent.type !== "lifecycle" || input.finalizingEvent.state !== "finalizing") throw new Error("finalizingEvent must enter finalizing");
  if (input.terminalEvent.type !== "lifecycle" || !["completed", "stopped", "failed"].includes(input.terminalEvent.state as string)) throw new Error("terminalEvent must enter completed, stopped, or failed");
  if (input.interruptedEvent.type !== "lifecycle" || input.interruptedEvent.state !== "interrupted") throw new Error("interruptedEvent must enter interrupted");
  input.writer.closeSamples();
  input.writer.appendEvent(input.finalizingEvent);
  input.writer.syncEvents();
  let state = input.terminalEvent.state as Exclude<JcapV1CaptureState, "active" | "finalizing">;
  try {
    const raw = readJcapV1Raw(input.writer.packageDir);
    if (!raw.diagnostics.length) input.writer.appendEvent(input.terminalEvent);
    else if (raw.diagnostics.every((diagnostic) => diagnostic.reason === "truncated_tail")) {
      input.writer.appendEvent(input.interruptedEvent);
      state = "interrupted";
    } else {
      input.writer.appendEvent({ ...input.interruptedEvent, eventId: randomUUID(), state: "failed", reason: "raw_corrupt" });
      state = "failed";
    }
    input.writer.closeEvents();
  } catch (error) {
    input.writer.closeEvents();
    throw error;
  }
  input.writer.finalize(state, input.quality ?? {}, input.qualityStatus ?? "unknown", input.qualitySource ?? (input.qualityStatus === "reported" ? "jlink" : "none"));
  return rebuildJcapV1Index(input.writer.packageDir);
}

export function readJcapV1Raw(packageDir: string): JcapV1Raw {
  const root = checkedPackageDir(packageDir);
  const metadata = readJcapV1Metadata(root);
  const rawDir = path.join(root, "raw");
  const samplesFile = path.join(rawDir, "samples.bin");
  const eventsFile = path.join(rawDir, "events.bin");
  let previousSampleIndex = -1;
  let previousSampleTick = -1n;
  const sampleRaw = parseFrames<JcapV1Sample>(samplesFile, () => "sample", (sample) => {
    validateSample(sample, previousSampleIndex, previousSampleTick, metadata.variables.map((variable) => variable.logicalIdentity));
    previousSampleIndex = sample.sampleIndex;
    previousSampleTick = BigInt(sample.tick);
  });
  let previousEventSequence = -1;
  let previousEventTick = -1n;
  let lifecycleState: JcapV1CaptureState | undefined;
  const eventRaw = parseFrames<JcapV1Event>(eventsFile, () => "event", (event) => {
    validateEvent(event, previousEventSequence, previousEventTick, lifecycleState, metadata.variables);
    previousEventSequence = event.eventSequence;
    previousEventTick = BigInt(event.tick);
    if (event.type === "lifecycle") lifecycleState = event.state as JcapV1CaptureState;
  });
  const events = eventRaw.values;
  if (!events.length) throw new Error("JCAP v1 raw is missing lifecycle events");
  assertQualityFacts(metadata, events);
  return {
    metadata,
    provenance: metadata.provenance,
    samples: sampleRaw.values,
    events,
    diagnostics: [sampleRaw.diagnostic, eventRaw.diagnostic].filter((value): value is JcapRawDiagnostic => Boolean(value)),
    sources: [sourceIdentity(samplesFile, sampleRaw.validBytes), sourceIdentity(eventsFile, eventRaw.validBytes)],
  };
}

export async function rebuildJcapV1Index(packageDir: string): Promise<{ captureState: JcapV1CaptureState; indexStatus: JcapV1IndexStatus; databaseFile: string; diagnostics: JcapRawDiagnostic[] }> {
  const root = checkedPackageDir(packageDir);
  return withDirectoryLease(path.join(path.dirname(root), ".locks", `${path.basename(root)}.lock`), () => rebuildJcapV1IndexUnlocked(root), {
    timeoutMs: 30_000,
    errorCode: "JCAP_REBUILD_BUSY",
  });
}

async function rebuildJcapV1IndexUnlocked(root: string): Promise<{ captureState: JcapV1CaptureState; indexStatus: JcapV1IndexStatus; databaseFile: string; diagnostics: JcapRawDiagnostic[] }> {
  if (activeWriters.has(root)) throw new Error("close the JCAP raw writer before rebuilding the index");
  const originalMetadata = readJcapV1Metadata(root);
  const recoveryMetadata: JcapV1Metadata = originalMetadata.indexStatus === "building"
    ? { ...originalMetadata, indexStatus: "rebuild_required", updatedAt: new Date().toISOString() }
    : originalMetadata;
  const raw = readJcapV1Raw(root);
  const captureState = raw.metadata.state;
  if (!isTerminal(captureState)) throw new Error(`JCAP raw is not terminal: ${captureState}`);
  if (effectiveCaptureState(raw) !== captureState) throw new Error("capture.json lifecycle does not match the effective Raw lifecycle");
  if (raw.diagnostics.some((diagnostic) => diagnostic.reason === "corrupt_suffix") || captureState === "failed") {
    throw new JcapIntegrityError("JCAP_RAW_CORRUPT", "Raw corruption or failed lifecycle forbids a ready index");
  }
  assertFinalRawIdentities(raw.metadata, raw.sources, originalMetadata.indexStatus === "building");
  assertSampleLossFacts(raw);
  const indexStatus: JcapV1IndexStatus = "ready";
  const databaseFile = path.join(root, "capture.db");
  const temporary = path.join(root, "capture.db.tmp");
  rmSync(temporary, { force: true });
  let database: sqlite3.Database | undefined;
  try {
    atomicWriteMetadata(path.join(root, "capture.json"), { ...recoveryMetadata, indexStatus: "building", updatedAt: new Date().toISOString() });
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
        capture_id: raw.metadata.captureId,
        capture_state: captureState,
        index_status: indexStatus,
        sample_count: String(raw.samples.length),
        event_count: String(raw.events.length),
        sample_value_count: String(raw.samples.length * raw.metadata.variables.length),
        quality_status: raw.metadata.qualityStatus,
        quality_source: raw.metadata.qualitySource,
      };
      for (const source of raw.sources) {
        const prefix = source.file === "raw/samples.bin" ? "samples" : "events";
        metadata[`${prefix}_sha256`] = source.sha256;
        metadata[`${prefix}_bytes`] = String(source.bytes);
        metadata[`${prefix}_valid_bytes`] = String(source.validBytes);
      }
      for (const [key, value] of Object.entries(metadata)) await run(database, "INSERT INTO meta(key,value) VALUES(?,?)", [key, value]);
      await run(database, "INSERT INTO provenance(capture_id,json) VALUES(?,?)", [raw.provenance.captureId, JSON.stringify(raw.provenance)]);
      for (const source of raw.sources) {
        const diagnostic = raw.diagnostics.find((item) => item.file === source.file);
        await run(database, "INSERT INTO raw_sources(file,sha256,bytes,valid_bytes,diagnostic) VALUES(?,?,?,?,?)", [source.file, source.sha256, source.bytes, source.validBytes, diagnostic ? JSON.stringify(diagnostic) : null]);
      }
      const inferredDroppedBefore = inferredDroppedBeforeSampleIndexes(raw.events);
      for (const sample of raw.samples) {
        const tickKey = u64Key(sample.tick);
        const statusFlags = sample.statusFlags | (inferredDroppedBefore.has(sample.sampleIndex) ? HSS_STATUS_FLAGS.dropped_before_this_sample : 0);
        await run(database, "INSERT INTO samples(sample_index,tick,tick_key,status_flags) VALUES(?,?,?,?)", [sample.sampleIndex, sample.tick, tickKey, statusFlags]);
        for (const [variable, value] of Object.entries(sample.values)) await run(database, "INSERT INTO sample_values(sample_index,tick,tick_key,status_flags,variable,value) VALUES(?,?,?,?,?,?)", [sample.sampleIndex, sample.tick, tickKey, statusFlags, variable, value]);
      }
      for (const event of raw.events) {
        const indexedEvent = resolveEventForIndex(event, raw.samples);
        await run(database, "INSERT INTO events(event_id,event_sequence,type,tick,tick_key,json) VALUES(?,?,?,?,?,?)", [event.eventId, event.eventSequence, event.type, event.tick, u64Key(event.tick), JSON.stringify(indexedEvent)]);
      }
      await run(database, "INSERT INTO meta(key,value) VALUES(?,?)", ["index_content_sha256", await indexContentSha256(database)]);
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
    assertFinalRawIdentities(readJcapV1Metadata(root), raw.sources, true);
    atomicReplaceSync(temporary, databaseFile);
    atomicWriteMetadata(path.join(root, "capture.json"), {
      ...recoveryMetadata,
      indexStatus,
      updatedAt: new Date().toISOString(),
      raw: rawIdentities(raw.sources),
      diagnostics: raw.diagnostics,
      sampleCount: raw.samples.length,
      eventCount: raw.events.length,
    });
    return { captureState, indexStatus, databaseFile, diagnostics: raw.diagnostics };
  } catch (error) {
    atomicWriteMetadata(path.join(root, "capture.json"), recoveryMetadata);
    throw error;
  } finally {
    if (database) await closeDatabase(database).catch(() => undefined);
    rmSync(temporary, { force: true });
  }
}

export async function verifyJcapV1Index(packageDir: string): Promise<{ captureState: JcapV1CaptureState; indexStatus: JcapV1IndexStatus }> {
  const root = checkedPackageDir(packageDir);
  const metadata = readJcapV1Metadata(root);
  if (metadata.indexStatus === "building") return { captureState: metadata.state, indexStatus: "rebuild_required" };
  if (activeWriters.has(root)) {
    return { captureState: metadata.state, indexStatus: "absent" };
  }
  const databaseFile = path.join(root, "capture.db");
  if (!existsSync(databaseFile)) {
    return { captureState: metadata.state, indexStatus: isTerminal(metadata.state) && metadata.state !== "failed" ? "rebuild_required" : metadata.state === "failed" ? "failed" : "absent" };
  }
  let database: sqlite3.Database | undefined;
  try {
    database = await openDatabase(databaseFile, sqlite3.OPEN_READONLY);
    const integrity = await get<IntegrityRow>(database, "PRAGMA integrity_check");
    const meta = Object.fromEntries((await all<MetaRow>(database, "SELECT key,value FROM meta")).map((row) => [row.key, row.value]));
    const captureState = meta.capture_state as JcapV1CaptureState;
    if (integrity?.integrity_check !== "ok" || meta.schema_version !== "1" || meta.format_version !== "1" || meta.format_status !== JCAP_STATUS || meta.capture_id !== metadata.captureId || meta.index_status !== "ready" || meta.quality_status !== metadata.qualityStatus || meta.quality_source !== metadata.qualitySource || !isCaptureState(captureState) || captureState !== metadata.state) return { captureState: metadata.state, indexStatus: "rebuild_required" };
    const sources = await all<SourceRow>(database, "SELECT file,sha256,bytes,valid_bytes,diagnostic FROM raw_sources");
    const expectedSources = new Set(["raw/samples.bin", "raw/events.bin"]);
    if (sources.length !== expectedSources.size || sources.some((source) => !expectedSources.delete(source.file))) return { captureState, indexStatus: "rebuild_required" };
    for (const source of sources) {
      const file = path.join(root, source.file);
      if (!existsSync(file) || statSync(file).size !== source.bytes || sha256File(file) !== source.sha256) return { captureState, indexStatus: "rebuild_required" };
      const prefix = source.file === "raw/samples.bin" ? "samples" : "events";
      if (meta[`${prefix}_sha256`] !== source.sha256 || meta[`${prefix}_bytes`] !== String(source.bytes) || meta[`${prefix}_valid_bytes`] !== String(source.valid_bytes)) return { captureState, indexStatus: "rebuild_required" };
    }
    const provenance = await get<{ capture_id: string; json: string }>(database, "SELECT capture_id,json FROM provenance LIMIT 1");
    const sampleCount = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM samples"))?.count;
    const eventCount = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM events"))?.count;
    const sampleValueCount = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM sample_values"))?.count;
    let provenanceCaptureId: unknown;
    try { provenanceCaptureId = provenance ? (JSON.parse(provenance.json) as JcapV1Provenance).captureId : undefined; }
    catch { return { captureState, indexStatus: "rebuild_required" }; }
    const expectedValueCount = metadata.sampleCount * metadata.variables.length;
    if (provenance?.capture_id !== metadata.captureId || provenanceCaptureId !== metadata.captureId
      || sampleCount !== metadata.sampleCount || eventCount !== metadata.eventCount || sampleValueCount !== expectedValueCount
      || meta.sample_count !== String(sampleCount) || meta.event_count !== String(eventCount) || meta.sample_value_count !== String(sampleValueCount)) {
      return { captureState, indexStatus: "rebuild_required" };
    }
    if (!await validIndexSchema(database) || !SHA256.test(meta.index_content_sha256 ?? "") || await indexContentSha256(database) !== meta.index_content_sha256) return { captureState, indexStatus: "rebuild_required" };
    try { assertFinalRawIdentities(metadata, sources.map((source) => ({ file: source.file, sha256: source.sha256, bytes: source.bytes, validBytes: source.valid_bytes }))); }
    catch { return { captureState, indexStatus: "rebuild_required" }; }
    return { captureState, indexStatus: isIndexStatus(meta.index_status) ? meta.index_status : "rebuild_required" };
  } catch {
    return { captureState: metadata.state, indexStatus: metadata.state === "failed" ? "failed" : "rebuild_required" };
  } finally {
    if (database) await closeDatabase(database).catch(() => undefined);
  }
}

export async function jcapCaptureSummary(packageDir: string): Promise<Record<string, unknown>> {
  const root = checkedPackageDir(packageDir);
  const status = await verifyJcapV1Index(root);
  const metadata = readJcapV1Metadata(root);
  const base = {
    ...status,
    readiness: status.indexStatus === "ready" ? "ready" : status.indexStatus,
    metadata,
    provenance: metadata.provenance,
    sampleCount: metadata.sampleCount,
    eventCount: metadata.eventCount,
    variables: metadata.variables.map((variable) => variable.logicalIdentity),
    qualityStatus: metadata.qualityStatus,
    qualitySource: metadata.qualitySource,
    quality: metadata.quality,
    sources: Object.values(metadata.raw).map((source) => ({ file: source.file, sha256: source.sha256, bytes: source.bytes, valid_bytes: source.validBytes })),
  };
  const databaseFile = path.join(root, "capture.db");
  if (!existsSync(databaseFile) || status.indexStatus !== "ready") return bounded(base, LIMITS.summaryBytes);
  const database = await openDatabase(databaseFile, sqlite3.OPEN_READONLY);
  try {
    const provenance = JSON.parse((await get<{ json: string }>(database, "SELECT json FROM provenance"))!.json) as JcapV1Provenance;
    const artifactMatchRow = await get<{ json: string }>(database, "SELECT json FROM events WHERE type='artifact_match' ORDER BY event_sequence DESC LIMIT 1");
    if (artifactMatchRow) {
      const artifactMatch = JSON.parse(artifactMatchRow.json) as Record<string, unknown>;
      provenance.artifactMatch = artifactMatch;
      provenance.warnings = artifactMatch.targetArtifactMatch === "unverified" && artifactMatch.captureAllowed !== false ? ["target Artifact match is unverified; read-only capture continued"] : [];
    }
    const sampleCount = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM samples"))!.count;
    const eventCount = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM events"))!.count;
    const tickRange = await get<{ start_tick: string | null; end_tick: string | null }>(database, "SELECT (SELECT tick FROM samples ORDER BY tick_key,sample_index LIMIT 1) AS start_tick, (SELECT tick FROM samples ORDER BY tick_key DESC,sample_index DESC LIMIT 1) AS end_tick");
    const variables = (await all<{ variable: string }>(database, "SELECT DISTINCT variable FROM sample_values ORDER BY variable")).map((row) => row.variable);
    const sources = await all<SourceRow>(database, "SELECT file,sha256,bytes,valid_bytes,diagnostic FROM raw_sources ORDER BY file");
    return bounded({
      ...status,
      metadata,
      provenance,
      sampleCount,
      eventCount,
      qualityStatus: metadata.qualityStatus,
      qualitySource: metadata.qualitySource,
      ...(typeof tickRange?.start_tick === "string" && typeof tickRange.end_tick === "string" ? { startTick: tickRange.start_tick, endTick: tickRange.end_tick } : {}),
      variables: variables.length ? variables : base.variables,
      sources,
    }, LIMITS.summaryBytes);
  } finally {
    await closeDatabase(database);
  }
}

export async function jcapCaptureSeries(input: { packageDir: string; variables: string[]; startTick: string; endTick: string; bucketCount: number }): Promise<Record<string, unknown>> {
  validateSeriesBounds(input.variables, input.startTick, input.endTick, input.bucketCount, LIMITS.seriesVariables, LIMITS.seriesBuckets);
  const status = await verifyJcapV1Index(input.packageDir);
  if (status.indexStatus !== "ready" || !["completed", "stopped", "interrupted"].includes(status.captureState)) throw new Error(`JCAP capture is not queryable: ${status.captureState}/${status.indexStatus}`);
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
  const status = await verifyJcapV1Index(root);
  if (status.indexStatus !== "ready" || !["completed", "stopped", "interrupted"].includes(status.captureState)) throw new Error(`JCAP capture is not queryable: ${status.captureState}/${status.indexStatus}`);
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
  const found = findCapturePackages(root);
  assertNoDuplicateCaptureIds(found);
  const page = found.filter((entry) => !options.cursor || entry.cursor > options.cursor).slice(0, limit + 1);
  const selected = page.slice(0, limit);
  const captures = await Promise.all(selected.map((entry) => captureListItem(entry)));
  return bounded({ captures, nextCursor: page.length > limit ? selected.at(-1)?.cursor : undefined }, LIMITS.listBytes);
}

function validateListBounds(options: { limit?: number; cursor?: string }): number {
  const limit = options.limit ?? LIMITS.listDefault;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.listMax) throw new JcapBoundsError("capture list limit must be 1..100");
  if (Buffer.byteLength(options.cursor ?? "", "utf8") > 1024) throw new JcapBoundsError("capture list cursor exceeds 1024 bytes");
  return limit;
}

export async function jcapCaptureExportCsv(packageDir: string, exportsDir = path.join(path.dirname(checkedPackageDir(packageDir)), "exports")): Promise<{ exportFile: string; rows: number }> {
  const root = checkedPackageDir(packageDir);
  const status = await verifyJcapV1Index(root);
  if (status.indexStatus !== "ready" || !["completed", "stopped", "interrupted"].includes(status.captureState)) throw new Error(`JCAP capture is not exportable: ${status.captureState}/${status.indexStatus}`);
  const database = await openDatabase(path.join(root, "capture.db"), sqlite3.OPEN_READONLY);
  const exportDir = path.resolve(exportsDir);
  const exportFile = path.join(exportDir, `${readJcapV1Metadata(root).captureId}.csv`);
  let handle: number | undefined;
  let created = false;
  try {
    const rows = (await get<CountRow>(database, "SELECT COUNT(*) AS count FROM sample_values"))!.count;
    if (!Number.isSafeInteger(rows) || rows > LIMITS.exportRows) throw new JcapBoundsError(`CSV export exceeds ${LIMITS.exportRows} rows`);
    mkdirSync(exportDir, { recursive: true });
    handle = openSync(exportFile, "wx");
    created = true;
    writeAll(handle, "sampleIndex,tick,statusFlags,variable,value\r\n");
    await each<ValueRow>(database, "SELECT sample_index,tick,status_flags,variable,value FROM sample_values ORDER BY sample_index,variable", [], (row) => {
      writeAll(handle!, `${row.sample_index},${row.tick},${row.status_flags},${csv(row.variable)},${row.value}\r\n`);
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
  const captureState = status.captureState as JcapV1CaptureState | undefined;
  const indexStatus = status.indexStatus as JcapV1IndexStatus | undefined;
  if (indexStatus === "rebuild_required") return { status: "rebuild_required", captureState, indexStatus };
  if (indexStatus !== "ready" || (requireCompleted && captureState !== "completed" && captureState !== "stopped" && captureState !== "interrupted")) {
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
  const header: RawFrameHeader = { formatVersion: 1, status: JCAP_STATUS, kind, payloadEncoding: "json", payloadBytes: payloadBytes.length, payloadSha256: sha256(payloadBytes), payloadCrc32: crc32Hex(payloadBytes) };
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
      if (sha256(payloadBytes) !== header.payloadSha256 || crc32Hex(payloadBytes) !== header.payloadCrc32) throw new Error("payload integrity mismatch");
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
  if (!header || header.formatVersion !== 1 || header.status !== JCAP_STATUS || header.kind !== expectedKind || !RAW_KINDS.includes(header.kind) || header.payloadEncoding !== "json" || !Number.isSafeInteger(header.payloadBytes) || header.payloadBytes < 0 || header.payloadBytes > payloadLimit || !SHA256.test(header.payloadSha256) || !/^[0-9a-f]{8}$/.test(header.payloadCrc32)) throw new Error("invalid JCAP v1 frame header");
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

export function appendJcapV1Event(packageDir: string, event: JcapV1Event): void {
  const root = checkedPackageDir(packageDir);
  const metadata = readJcapV1Metadata(root);
  if (!['active', 'finalizing'].includes(metadata.state)) throw new JcapIntegrityError("JCAP_CAPTURE_TERMINAL", "cannot append an event to a terminal JCAP capture");
  const eventsFile = path.join(root, "raw", "events.bin");
  if (!existsSync(eventsFile)) throw new JcapIntegrityError("JCAP_EVENTS_MISSING", "JCAP v1 events journal is missing");
  let previousEventSequence = -1;
  let previousEventTick = -1n;
  let lifecycleState: JcapV1CaptureState | undefined;
  const raw = parseFrames<JcapV1Event>(eventsFile, () => "event", (current) => {
    validateEvent(current, previousEventSequence, previousEventTick, lifecycleState, metadata.variables);
    previousEventSequence = current.eventSequence;
    previousEventTick = BigInt(current.tick);
    if (current.type === "lifecycle") lifecycleState = current.state as JcapV1CaptureState;
  });
  if (raw.diagnostic) throw new JcapIntegrityError("JCAP_EVENTS_TAIL_INVALID", "cannot append after an incomplete or corrupt events journal tail");
  validateEvent(event, previousEventSequence, previousEventTick, lifecycleState, metadata.variables);
  const handle = openSync(eventsFile, "a");
  try {
    writeAll(handle, encodeFrame("event", event));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export function appendJcapV1Sample(packageDir: string, sample: JcapV1Sample): void {
  const root = checkedPackageDir(packageDir);
  const metadata = readJcapV1Metadata(root);
  if (metadata.state !== "active") throw new JcapIntegrityError("JCAP_CAPTURE_NOT_ACTIVE", "cannot append a sample unless the JCAP capture is active");
  const samplesFile = path.join(root, "raw", "samples.bin");
  let previousSampleIndex = -1;
  let previousSampleTick = -1n;
  if (existsSync(samplesFile)) {
    const raw = parseFrames<JcapV1Sample>(samplesFile, () => "sample", (current) => {
      validateSample(current, previousSampleIndex, previousSampleTick, metadata.variables.map((variable) => variable.logicalIdentity));
      previousSampleIndex = current.sampleIndex;
      previousSampleTick = BigInt(current.tick);
    });
    if (raw.diagnostic) throw new JcapIntegrityError("JCAP_SAMPLES_TAIL_INVALID", "cannot append after an incomplete or corrupt samples journal tail");
  }
  validateSample(sample, previousSampleIndex, previousSampleTick, metadata.variables.map((variable) => variable.logicalIdentity));
  const handle = openSync(samplesFile, "a");
  try {
    writeAll(handle, encodeFrame("sample", sample));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function validateMetadata(value: JcapV1Metadata, packageDir?: string): void {
  if (!isRecord(value) || value.formatVersion !== 1 || !UUID.test(value.captureId) || !isCaptureState(value.state) || !isIndexStatus(value.indexStatus)) {
    throw new JcapVersionUnsupportedError("invalid JCAP v1 capture.json identity or lifecycle");
  }
  if (packageDir && path.basename(packageDir).toLowerCase() !== `${value.captureId}.jcap`.toLowerCase()) throw new Error("capture.json captureId does not match its package directory");
  if (!Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) throw new Error("capture.json timestamps are invalid");
  if (!["jlink-hss", "fake-jlink-hss"].includes(value.backend) || !Number.isInteger(value.requestedRateHz) || value.requestedRateHz < 1 || value.requestedRateHz > 1_000 || !Number.isSafeInteger(value.durationSec) || value.durationSec < 1 || value.durationSec > 60) throw new Error("capture.json HSS bounds are invalid");
  if (!Array.isArray(value.variables) || value.variables.length < 1 || value.variables.length > 10) throw new Error("capture.json must declare 1..10 variables");
  const logical = new Set<string>();
  for (const variable of value.variables) {
    if (!isRecord(variable) || typeof variable.logicalIdentity !== "string" || !variable.logicalIdentity || logical.has(variable.logicalIdentity) || typeof variable.type !== "string" || SCALAR_BYTES[variable.type] !== variable.size || !/^0x[0-9a-f]{1,8}$/i.test(variable.address) || Number.parseInt(variable.address, 16) + variable.size > 0x1_0000_0000 || !SHA256.test(variable.artifactGeneration) || !SHA256.test(variable.layoutHash)) throw new Error("capture.json contains an invalid variable descriptor");
    logical.add(variable.logicalIdentity);
  }
  const expectedRecordSize = 4 + value.variables.reduce((sum, variable) => sum + variable.size, 0);
  if (value.recordSize !== expectedRecordSize || !isRecord(value.timebase) || value.timebase.kind !== "capture-relative" || value.timebase.unit !== "ns" || value.timebase.tickFrequencyHz !== 1_000_000_000) throw new Error("capture.json record layout or timebase is invalid");
  validateProvenance(value.provenance);
  if (value.provenance.captureId !== value.captureId || value.provenance.backend !== value.backend) throw new Error("capture.json provenance identity does not match capture metadata");
  const targetIdentity = value.provenance.target;
  const artifactIdentity = value.provenance.artifact;
  if (typeof targetIdentity.projectRoot !== "string" || !targetIdentity.projectRoot || typeof targetIdentity.generation !== "string" || !UUID.test(targetIdentity.generation)
    || typeof targetIdentity.device !== "string" || !targetIdentity.device || typeof targetIdentity.probeSerial !== "string" || !/^\d+$/.test(targetIdentity.probeSerial)
    || !["SWD", "JTAG"].includes(String(targetIdentity.interface)) || typeof targetIdentity.speed !== "number" || !Number.isSafeInteger(targetIdentity.speed) || targetIdentity.speed < 1
    || !isRecord(artifactIdentity) || typeof artifactIdentity.path !== "string" || !artifactIdentity.path
    || typeof artifactIdentity.generation !== "string" || !SHA256.test(artifactIdentity.generation)
    || typeof artifactIdentity.sha256 !== "string" || !SHA256.test(artifactIdentity.sha256)) throw new Error("capture.json provenance is missing Target, Probe, or Artifact identity");
  if (value.variables.some((variable) => variable.artifactGeneration !== artifactIdentity.generation)) throw new Error("capture.json variable descriptors do not match the provenance Artifact generation");
  if (value.backend === "jlink-hss") {
    const helperSha256 = value.provenance.runtime.helperSha256;
    const runtimeSha256 = value.provenance.runtime.runtimeSha256;
    if (typeof helperSha256 !== "string" || !SHA256.test(helperSha256) || typeof runtimeSha256 !== "string" || !SHA256.test(runtimeSha256)) throw new Error("native JCAP provenance is missing helper/runtime hashes");
  }
  if (!["unknown", "partial", "reported"].includes(value.qualityStatus)) throw new Error("capture.json quality status is invalid");
  if (!["none", "jlink", "target_counter"].includes(value.qualitySource)) throw new Error("capture.json quality source is invalid");
  const qualityKeys = ["missingSamples", "droppedSamples", "overflows", "readErrors", "timeouts"] as const;
  if (!isRecord(value.quality) || Object.keys(value.quality).length !== qualityKeys.length || qualityKeys.some((key) => !Object.hasOwn(value.quality, key))) throw new Error("capture.json quality counters are invalid");
  for (const count of [value.sampleCount, value.eventCount]) if (!Number.isSafeInteger(count) || count < 0) throw new Error("capture.json contains an invalid count");
  if (qualityKeys.some((key) => value.quality[key] !== null && (!Number.isSafeInteger(value.quality[key]) || Number(value.quality[key]) < 0))
    || !qualityEvidenceIsConsistent(value.qualityStatus, value.qualitySource, value.quality)) throw new Error("capture.json quality evidence is inconsistent");
  if (!isRecord(value.raw) || !validRawIdentity(value.raw.samples, "raw/samples.bin") || !validRawIdentity(value.raw.events, "raw/events.bin") || !Array.isArray(value.diagnostics)
    || value.diagnostics.some((diagnostic) => !isRecord(diagnostic) || !["raw/samples.bin", "raw/events.bin"].includes(String(diagnostic.file))
      || !Number.isSafeInteger(diagnostic.offset) || diagnostic.offset < 0 || !Number.isSafeInteger(diagnostic.length) || diagnostic.length < 0
      || !["truncated_tail", "corrupt_suffix"].includes(String(diagnostic.reason)))) throw new Error("capture.json Raw identities are invalid");
  validateJsonNumbers(value);
}

function validRawIdentity(value: unknown, file: JcapV1RawIdentity["file"]): value is JcapV1RawIdentity {
  if (!isRecord(value) || value.file !== file || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || !Number.isSafeInteger(value.validBytes) || value.validBytes < 0 || value.validBytes > value.bytes) return false;
  return value.sha256 === null || typeof value.sha256 === "string" && SHA256.test(value.sha256);
}

function atomicWriteMetadata(file: string, metadata: JcapV1Metadata): void {
  validateMetadata(metadata, path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = openSync(temporary, "wx");
    writeAll(handle, Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8"));
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    atomicReplaceSync(temporary, file);
  } finally {
    if (handle !== undefined) closeSync(handle);
    rmSync(temporary, { force: true });
  }
}

function currentMetadata(packageDir: string, current: JcapV1Metadata, final: boolean): JcapV1Metadata {
  const identity = (file: JcapV1RawIdentity["file"]): JcapV1RawIdentity => {
    const absolute = path.join(packageDir, file);
    const bytes = existsSync(absolute) ? statSync(absolute).size : 0;
    return { file, bytes, validBytes: bytes, sha256: final && existsSync(absolute) ? sha256File(absolute) : null };
  };
  return { ...current, updatedAt: new Date().toISOString(), raw: { samples: identity("raw/samples.bin"), events: identity("raw/events.bin") } };
}

function rawIdentities(sources: Array<{ file: string; sha256: string; bytes: number; validBytes: number }>): JcapV1Metadata["raw"] {
  const find = (file: JcapV1RawIdentity["file"]): JcapV1RawIdentity => {
    const source = sources.find((entry) => entry.file === file);
    if (!source) throw new Error(`Raw source is missing: ${file}`);
    return { file, sha256: source.sha256, bytes: source.bytes, validBytes: source.validBytes };
  };
  return { samples: find("raw/samples.bin"), events: find("raw/events.bin") };
}

function assertFinalRawIdentities(metadata: JcapV1Metadata, sources: Array<{ file: string; sha256: string; bytes: number; validBytes: number }>, allowBuilding = false): void {
  if (!isTerminal(metadata.state) || metadata.state === "failed" || (!allowBuilding && metadata.indexStatus === "building")) throw new Error("capture.json is not a rebuildable terminal identity");
  const expected = rawIdentities(sources);
  for (const key of ["samples", "events"] as const) {
    const left = metadata.raw[key];
    const right = expected[key];
    if (!left.sha256 || left.sha256 !== right.sha256 || left.bytes !== right.bytes || left.validBytes !== right.validBytes) throw new JcapIntegrityError("JCAP_RAW_IDENTITY_MISMATCH", `${right.file} does not match capture.json`);
  }
}

function validateProvenance(value: JcapV1Provenance): void {
  if (!isRecord(value) || !UUID.test(value.captureId) || typeof value.backend !== "string" || !value.backend || !isRecord(value.runtime) || !isRecord(value.target) || !isRecord(value.script) || !["none", "file"].includes(value.script.mode)) throw new Error("invalid JCAP v1 provenance");
  if (value.script.mode === "file" && (typeof value.script.path !== "string" || !value.script.path || typeof value.script.sha256 !== "string" || !SHA256.test(value.script.sha256))) throw new Error("file script provenance requires path and sha256");
  if (value.script.mode === "none" && (value.script.path !== undefined || value.script.sha256 !== undefined)) throw new Error("none script provenance cannot carry a script identity");
  validateJsonNumbers(value);
}

function validateSample(sample: JcapV1Sample, previousIndex: number, previousTick: bigint, expectedVariables: string[]): void {
  if (!isRecord(sample) || !Number.isSafeInteger(sample.sampleIndex) || sample.sampleIndex < 0 || sample.sampleIndex <= previousIndex || !isU64(sample.tick) || BigInt(sample.tick) < previousTick || !Number.isSafeInteger(sample.statusFlags) || sample.statusFlags < 0 || sample.statusFlags > 0xffff_ffff || !isRecord(sample.values) || !Object.keys(sample.values).length || !Object.entries(sample.values).every(([name, value]) => name.length > 0 && typeof value === "number" && Number.isFinite(value))) throw new Error("invalid JCAP v1 sample sequence");
  if (previousIndex >= 0 && sample.sampleIndex > previousIndex + 1 && (sample.statusFlags & (1 << 4)) === 0) throw new Error("JCAP v1 sample gap is missing its explicit loss status flag");
  if (Object.keys(sample.values).length !== expectedVariables.length || Object.keys(sample.values).some((name, index) => name !== expectedVariables[index])) throw new Error("JCAP v1 sample variables do not match the immutable descriptor order");
  validateJsonNumbers(sample);
}

function validateEvent(event: JcapV1Event, previousSequence: number, previousTick: bigint, lifecycleState: JcapV1CaptureState | undefined, variables: readonly JcapV1VariableDescriptor[]): void {
  if (!isRecord(event) || !UUID.test(event.eventId)) throw new Error("invalid JCAP v1 event identity");
  if (!Number.isSafeInteger(event.eventSequence) || event.eventSequence < 0 || event.eventSequence <= previousSequence) throw new Error(`invalid JCAP v1 event sequence: current=${String(event.eventSequence)}, previous=${previousSequence}`);
  if (!["lifecycle", "target_control", "variable_write", "quality", "flag", "fault", "artifact_match"].includes(event.type)) throw new Error("invalid JCAP v1 event type");
  if (!isU64(event.tick) || BigInt(event.tick) < previousTick) throw new Error("invalid JCAP v1 event tick");
  if (previousSequence < 0 && (event.type !== "lifecycle" || event.state !== "active")) throw new Error("JCAP lifecycle must begin with active");
  if (lifecycleState && ["completed", "stopped", "interrupted", "failed"].includes(lifecycleState)) throw new Error("JCAP terminal event must be last");
  if (event.type === "lifecycle") {
    if (!isCaptureState(event.state)) throw new Error("invalid JCAP lifecycle state");
    const next = event.state;
    const allowed: Record<JcapV1CaptureState, JcapV1CaptureState[]> = {
      active: ["finalizing", "interrupted", "failed"], finalizing: ["completed", "stopped", "interrupted", "failed"], completed: [], stopped: [], interrupted: [], failed: [],
    };
    if (lifecycleState ? !allowed[lifecycleState].includes(next) : next !== "active") throw new Error(`invalid JCAP lifecycle transition ${lifecycleState ?? "none"} -> ${next}`);
  }
  if (event.type === "variable_write") validateVariableWriteEvent(event, variables);
  if (event.type === "quality") validateQualityEvent(event);
  validateJsonNumbers(event);
}

function validateQualityEvent(event: JcapV1Event): void {
  const keys = ["missingSamples", "droppedSamples", "overflows", "readErrors", "timeouts"] as const;
  if (!["unknown", "partial", "reported"].includes(String(event.qualityStatus))) throw new Error("JCAP quality event status is invalid");
  if (!["none", "jlink", "target_counter"].includes(String(event.qualitySource))) throw new Error("JCAP quality event source is invalid");
  if (keys.some((key) => event[key] !== null && (!Number.isSafeInteger(event[key]) || Number(event[key]) < 0))
    || !qualityEvidenceIsConsistent(event.qualityStatus as JcapV1Metadata["qualityStatus"], event.qualitySource as JcapV1QualitySource, Object.fromEntries(keys.map((key) => [key, event[key]])) as JcapV1Metadata["quality"])) throw new Error("JCAP quality event counters are invalid");
  if (event.durationValidated !== null && typeof event.durationValidated !== "boolean") throw new Error("JCAP quality duration evidence is invalid");
  if (event.qualityEvidence !== undefined && !isRecord(event.qualityEvidence)) throw new Error("JCAP quality provenance is invalid");
  if (event.inferredDroppedBeforeSampleIndexes !== undefined && (!Array.isArray(event.inferredDroppedBeforeSampleIndexes)
    || event.inferredDroppedBeforeSampleIndexes.some((value) => !Number.isSafeInteger(value) || Number(value) < 0)
    || event.inferredDroppedBeforeSampleIndexes.some((value, index, values) => index > 0 && Number(value) <= Number(values[index - 1])))) {
    throw new Error("JCAP quality inferred-loss indexes are invalid");
  }
}

function qualityEvidenceIsConsistent(
  status: JcapV1Metadata["qualityStatus"],
  source: JcapV1QualitySource,
  quality: JcapV1Metadata["quality"],
): boolean {
  const keys = ["missingSamples", "droppedSamples", "overflows", "readErrors", "timeouts"] as const;
  const observed = keys.filter((key) => quality[key] !== null);
  if (status === "unknown") return source === "none" && observed.length === 0;
  if (source === "none") return status === "partial" && quality.droppedSamples === null && quality.overflows === null;
  if (source === "jlink") return status === "reported" && observed.length === keys.length;
  return quality.droppedSamples === null && quality.overflows === null
    && (status === "partial" || status === "reported" && quality.missingSamples !== null);
}

function inferredDroppedBeforeSampleIndexes(events: readonly JcapV1Event[]): Set<number> {
  const quality = [...events].reverse().find((event) => event.type === "quality");
  if (!quality || quality.qualitySource !== "target_counter" || !Array.isArray(quality.inferredDroppedBeforeSampleIndexes)) return new Set();
  return new Set(quality.inferredDroppedBeforeSampleIndexes as number[]);
}

function assertQualityFacts(metadata: JcapV1Metadata, events: readonly JcapV1Event[]): void {
  if (!isTerminal(metadata.state)) return;
  const quality = [...events].reverse().find((event) => event.type === "quality");
  if (!quality) {
    if (metadata.qualityStatus !== "unknown") throw new Error("observed capture quality lacks a Raw quality event");
    return;
  }
  if (quality.qualityStatus !== metadata.qualityStatus) throw new Error("Raw quality status does not match capture.json");
  if (quality.qualitySource !== metadata.qualitySource) throw new Error("Raw quality source does not match capture.json");
  for (const key of ["missingSamples", "droppedSamples", "overflows", "readErrors", "timeouts"] as const) {
    if (quality[key] !== metadata.quality[key]) throw new Error("Raw quality counters do not match capture.json");
  }
  if (metadata.state === "completed" && quality.durationValidated !== true) throw new Error("completed capture lacks validated duration evidence");
}

function validateVariableWriteEvent(event: JcapV1Event, variables: readonly JcapV1VariableDescriptor[]): void {
  const selector = event.selector;
  const descriptor = event.descriptor;
  const expected = typeof selector === "string"
    ? variables.find((variable) => variable.logicalIdentity === selector) ?? standaloneWriteDescriptor(descriptor, selector, variables)
    : undefined;
  if (!expected || event.logicalIdentity !== selector || !isRecord(descriptor) || !sameDescriptor(descriptor, expected)) throw new Error("JCAP variable_write selector does not match a declared or embedded variable descriptor");
  if (!isU64(event.operationStartTick) || !isU64(event.operationEndTick)
    || BigInt(event.operationEndTick) < BigInt(event.operationStartTick) || event.tick !== event.operationEndTick
    || !["helper_qpc", "controller_fallback"].includes(String(event.timingSource))) throw new Error("JCAP variable_write timing evidence is invalid");
  if (!validTimestamp(event.startedAt) || !validTimestamp(event.endedAt) || Date.parse(event.endedAt) < Date.parse(event.startedAt)) throw new Error("JCAP variable_write wall-clock evidence is invalid");
  if (typeof event.writeAttempted !== "boolean" || typeof event.writeIssued !== "boolean" || typeof event.stateUnknown !== "boolean"
    || event.writeIssued && !event.writeAttempted) throw new Error("JCAP variable_write write-state evidence is invalid");
  if (event.operationId !== undefined && (typeof event.operationId !== "string" || !UUID.test(event.operationId))) throw new Error("JCAP variable_write operation identity is invalid");
  if (event.ipcRequestIds !== undefined && (!Array.isArray(event.ipcRequestIds) || event.ipcRequestIds.length > 2
    || event.ipcRequestIds.some((requestId) => typeof requestId !== "string" || !UUID.test(requestId))
    || new Set(event.ipcRequestIds).size !== event.ipcRequestIds.length)) throw new Error("JCAP variable_write IPC identities are invalid");
  const requested = event.requested;
  if (!isRecord(requested) || !Object.hasOwn(requested, "value") || !validScalarHex(requested.bytesHex, expected.size)) throw new Error("JCAP variable_write requested value is invalid");
  validateValueEvidence(event.old, ["captured", "failed", "not_requested"], "captured", expected.size, "old");
  validateValueEvidence(event.readback, ["observed", "failed", "not_requested"], "observed", expected.size, "readback");
  const verification = event.verification;
  if (!isRecord(verification) || !["verified", "failed", "state_unknown", "executed_unverified", "not_executed"].includes(String(verification.state))) throw new Error("JCAP variable_write verification evidence is invalid");
  const restore = event.restore;
  if (!isRecord(restore) || !["not_requested", "not_needed", "failed", "restored"].includes(String(restore.state))
    || typeof restore.attempted !== "boolean" || typeof restore.writeIssued !== "boolean" || typeof restore.stateUnknown !== "boolean"
    || restore.writeIssued && !restore.attempted
    || !(restore.readback === null || Object.hasOwn(restore, "readback"))
    || !(restore.readbackHex === null || validScalarHex(restore.readbackHex, expected.size))) throw new Error("JCAP variable_write restore evidence is invalid");
  if (restore.state === "restored" && (!restore.attempted || !restore.writeIssued || !validScalarHex(restore.readbackHex, expected.size))) throw new Error("JCAP variable_write restored state lacks readback evidence");
  const alignment = event.sampleAlignment;
  if (!isRecord(alignment) || alignment.method !== "terminal_raw_nearest" || alignment.status !== "derive_on_rebuild"
    || Object.hasOwn(event, "neighbors") || Object.hasOwn(event, "previousSample") || Object.hasOwn(event, "nextSample")) {
    throw new Error("JCAP variable_write Raw alignment contract is invalid");
  }
  if (!["completed", "failed", "restore_failed"].includes(String(event.outcome))) throw new Error("JCAP variable_write outcome is invalid");
  if (event.error !== null && (!isRecord(event.error) || typeof event.error.code !== "string" || !event.error.code || typeof event.error.message !== "string"
    || typeof event.error.writeIssued !== "boolean" || typeof event.error.stateUnknown !== "boolean")) throw new Error("JCAP variable_write error evidence is invalid");
  if (event.outcome === "completed" && event.error !== null || event.outcome !== "completed" && event.error === null) throw new Error("JCAP variable_write outcome and error evidence disagree");
}

function standaloneWriteDescriptor(
  value: unknown,
  selector: string,
  variables: readonly JcapV1VariableDescriptor[],
): JcapV1VariableDescriptor | undefined {
  if (!isRecord(value)
    || value.logicalIdentity !== selector
    || typeof value.type !== "string"
    || SCALAR_BYTES[value.type] !== value.size
    || !/^0x[0-9a-f]{1,8}$/i.test(String(value.address))
    || Number.parseInt(String(value.address), 16) + Number(value.size) > 0x1_0000_0000
    || !SHA256.test(String(value.artifactGeneration))
    || value.artifactGeneration !== variables[0]?.artifactGeneration
    || !SHA256.test(String(value.layoutHash))
    || value.alias !== undefined && (typeof value.alias !== "string" || !value.alias || Buffer.byteLength(value.alias, "utf8") > 128)
    || value.unit !== undefined && (typeof value.unit !== "string" || !value.unit || Buffer.byteLength(value.unit, "utf8") > 64)) return undefined;
  return value as unknown as JcapV1VariableDescriptor;
}

function sameDescriptor(value: Record<string, unknown>, expected: JcapV1VariableDescriptor): boolean {
  return value.logicalIdentity === expected.logicalIdentity && value.type === expected.type && value.address === expected.address
    && value.size === expected.size && value.artifactGeneration === expected.artifactGeneration && value.layoutHash === expected.layoutHash
    && (value.alias ?? undefined) === expected.alias && (value.unit ?? undefined) === expected.unit;
}

function validateValueEvidence(value: unknown, states: readonly string[], presentState: string, size: number, label: string): void {
  if (!isRecord(value) || !states.includes(String(value.state)) || !Object.hasOwn(value, "value") || !Object.hasOwn(value, "bytesHex")) throw new Error(`JCAP variable_write ${label} evidence is invalid`);
  if (value.state === presentState ? !validScalarHex(value.bytesHex, size) : value.bytesHex !== null || value.state !== presentState && value.value !== null) throw new Error(`JCAP variable_write ${label} evidence is inconsistent`);
}

function validScalarHex(value: unknown, size: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${size * 2}}$`, "i").test(value);
}

function resolveEventForIndex(event: JcapV1Event, samples: readonly JcapV1Sample[]): JcapV1Event {
  if (event.type !== "variable_write") return event;
  const start = BigInt(event.operationStartTick as string);
  const end = BigInt(event.operationEndTick as string);
  const before = [...samples].reverse().find((sample) => BigInt(sample.tick) <= start);
  const after = samples.find((sample) => BigInt(sample.tick) >= end);
  const beforeReference = before ? { sampleIndex: before.sampleIndex, tick: before.tick } : null;
  const afterReference = after ? { sampleIndex: after.sampleIndex, tick: after.tick } : null;
  return {
    ...event,
    sampleAlignment: { method: "terminal_raw_nearest", status: "resolved" },
    neighbors: { before: beforeReference, after: afterReference },
    previousSample: beforeReference,
    nextSample: afterReference,
  };
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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

function captureStateFromEvents(events: JcapV1Event[]): JcapV1CaptureState {
  const state = events.filter((event) => event.type === "lifecycle").at(-1)?.state;
  if (!isCaptureState(state)) throw new Error("JCAP raw has no valid lifecycle state");
  return state;
}

function effectiveCaptureState(raw: JcapV1Raw): JcapV1CaptureState {
  const state = captureStateFromEvents(raw.events);
  return raw.diagnostics.length && ["active", "finalizing"].includes(state) ? "interrupted" : state;
}

function terminalStateMatchesRaw(raw: JcapV1Raw, requested: Exclude<JcapV1CaptureState, "active" | "finalizing">): boolean {
  const state = captureStateFromEvents(raw.events);
  if (state === requested) return true;
  if (!["active", "finalizing"].includes(state)) return false;
  if (requested === "interrupted") return raw.diagnostics.some((diagnostic) => diagnostic.reason === "truncated_tail");
  if (requested === "failed") return raw.diagnostics.some((diagnostic) => diagnostic.reason === "corrupt_suffix");
  return false;
}

function assertSampleLossFacts(raw: JcapV1Raw): void {
  let gaps = 0;
  for (let index = 1; index < raw.samples.length; index += 1) gaps += raw.samples[index].sampleIndex - raw.samples[index - 1].sampleIndex - 1;
  const missing = raw.metadata.quality.missingSamples ?? 0;
  const dropped = raw.metadata.quality.droppedSamples ?? 0;
  const reported = Math.max(missing, dropped) + (raw.metadata.quality.overflows ?? 0);
  if (gaps > reported) throw new JcapIntegrityError("JCAP_SAMPLE_LOSS_UNREPORTED", `Raw sample-index gaps (${gaps}) exceed explicit loss/overflow counters (${reported})`);
  if (raw.metadata.state === "completed") {
    const expected = raw.metadata.requestedRateHz * raw.metadata.durationSec;
    if (raw.samples.length * 100 < expected * 95) throw new JcapIntegrityError("JCAP_SAMPLE_BUDGET_SHORT", `completed capture has ${raw.samples.length} of ${expected} planned samples; at least 95% are required`);
    const plannedDeficit = Math.max(0, expected - raw.samples.length);
    if (plannedDeficit > 0 && (raw.metadata.quality.missingSamples === null || raw.metadata.quality.missingSamples < plannedDeficit)) {
      throw new JcapIntegrityError("JCAP_SAMPLE_BUDGET_UNREPORTED", "completed capture does not explicitly account for its planned sample deficit");
    }
  }
}

function isCaptureState(value: unknown): value is JcapV1CaptureState {
  return typeof value === "string" && ["active", "finalizing", "completed", "stopped", "interrupted", "failed"].includes(value);
}

function isIndexStatus(value: unknown): value is JcapV1IndexStatus {
  return typeof value === "string" && ["absent", "building", "ready", "rebuild_required", "failed"].includes(value);
}

function isTerminal(state: JcapV1CaptureState): boolean {
  return ["completed", "stopped", "interrupted", "failed"].includes(state);
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

interface CaptureLocation {
  captureId: string;
  packageDir: string;
  runId?: string;
  cursor: string;
}

function findCapturePackages(root: string): CaptureLocation[] {
  if (!existsSync(root)) return [];
  const directories: Array<{ capturesDir: string; runId?: string }> = [];
  const add = (capturesDir: string, runId?: string) => {
    if (existsSync(capturesDir) && statSync(capturesDir).isDirectory()) directories.push({ capturesDir, ...(runId ? { runId } : {}) });
  };
  if (path.basename(root).toLowerCase() === "captures") add(root);
  else {
    add(root);
    add(path.join(root, "captures"));
    const children = readdirSync(root, { withFileTypes: true });
    if (children.length > 10_000) throw new JcapBoundsError("capture root contains too many entries");
    for (const child of children) {
      if (!child.isDirectory() || child.name.endsWith(".jcap") || ["captures", "exports"].includes(child.name.toLowerCase())) continue;
      add(path.join(root, child.name, "captures"), child.name);
    }
  }
  const found: CaptureLocation[] = [];
  for (const directory of directories) {
    const entries = readdirSync(directory.capturesDir, { withFileTypes: true });
    if (entries.length > 10_000) throw new JcapBoundsError("capture directory contains too many entries");
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".jcap")) continue;
      const captureId = entry.name.slice(0, -5);
      if (!UUID.test(captureId)) continue;
      found.push({ captureId, packageDir: path.join(directory.capturesDir, entry.name), runId: directory.runId, cursor: `${captureId}\0${directory.runId ?? ""}` });
    }
  }
  return found.sort((left, right) => left.cursor.localeCompare(right.cursor));
}

function assertNoDuplicateCaptureIds(found: CaptureLocation[]): void {
  const seen = new Set<string>();
  for (const entry of found) {
    if (seen.has(entry.captureId)) throw new JcapCaptureAmbiguousError(`duplicate JCAP captureId: ${entry.captureId}`);
    seen.add(entry.captureId);
  }
}

function resolveCapturePackage(root: string, captureId: string): string {
  return resolveCaptureLocation(root, captureId).packageDir;
}

function resolveCaptureLocation(root: string, captureId: string): CaptureLocation {
  if (!UUID.test(captureId)) throw new JcapBoundsError("captureId must be a UUID");
  const matches = findCapturePackages(root).filter((entry) => entry.captureId.toLowerCase() === captureId.toLowerCase());
  if (!matches.length) throw new JcapCaptureNotFoundError(`JCAP capture was not found: ${captureId}`);
  if (matches.length > 1) throw new JcapCaptureAmbiguousError(`duplicate JCAP captureId: ${captureId}`);
  return matches[0];
}

async function captureListItem(entry: CaptureLocation): Promise<Record<string, unknown>> {
  const metadata = readJcapV1Metadata(entry.packageDir);
  const status = await verifyJcapV1Index(entry.packageDir);
  let timeRange: { startTick: string; endTick: string } | undefined;
  if (status.indexStatus === "ready") {
    const database = await openDatabase(path.join(entry.packageDir, "capture.db"), sqlite3.OPEN_READONLY);
    try {
      const range = await get<{ start_tick: string | null; end_tick: string | null }>(database, "SELECT (SELECT tick FROM samples ORDER BY tick_key,sample_index LIMIT 1) AS start_tick, (SELECT tick FROM samples ORDER BY tick_key DESC,sample_index DESC LIMIT 1) AS end_tick");
      if (range?.start_tick && range.end_tick) timeRange = { startTick: range.start_tick, endTick: range.end_tick };
    } finally {
      await closeDatabase(database);
    }
  }
  return {
    captureId: entry.captureId,
    ...(entry.runId ? { runId: entry.runId } : {}),
    captureState: status.captureState,
    indexStatus: status.indexStatus,
    variables: metadata.variables.map((variable) => ({ logicalIdentity: variable.logicalIdentity, type: variable.type, alias: variable.alias, unit: variable.unit })),
    quality: metadata.quality,
    sampleCount: metadata.sampleCount,
    eventCount: metadata.eventCount,
    ...(timeRange ?? {}),
    provenance: { backend: metadata.backend, artifact: metadata.provenance.artifact ?? null },
  };
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

function writeAll(handle: number, value: Buffer | string): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(handle, bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error("regular-file write made no forward progress");
    offset += written;
  }
}

function crc32Hex(value: Buffer): string {
  let crc = 0xffff_ffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return ((crc ^ 0xffff_ffff) >>> 0).toString(16).padStart(8, "0");
}

function sha256File(file: string): string {
  return sha256(readFileSync(file));
}

async function indexContentSha256(database: sqlite3.Database): Promise<string> {
  const hash = createHash("sha256");
  const add = (row: readonly unknown[]): void => {
    const encoded = Buffer.from(JSON.stringify(row), "utf8");
    hash.update(String(encoded.length));
    hash.update(":");
    hash.update(encoded);
  };
  add(["jcap-v1-index-content", 1]);
  await each<{ capture_id: string; json: string }>(database, "SELECT capture_id,json FROM provenance ORDER BY capture_id", [], (row) => add(["provenance", row.capture_id, row.json]));
  await each<SourceRow>(database, "SELECT file,sha256,bytes,valid_bytes,diagnostic FROM raw_sources ORDER BY file", [], (row) => add(["raw_source", row.file, row.sha256, row.bytes, row.valid_bytes, row.diagnostic]));
  await each<IndexSampleRow>(database, "SELECT sample_index,tick,tick_key,status_flags FROM samples ORDER BY sample_index", [], (row) => add(["sample", row.sample_index, row.tick, row.tick_key, row.status_flags]));
  await each<IndexValueRow>(database, "SELECT sample_index,tick,tick_key,status_flags,variable,value FROM sample_values ORDER BY sample_index,variable", [], (row) => add(["sample_value", row.sample_index, row.tick, row.tick_key, row.status_flags, row.variable, row.value]));
  await each<IndexEventRow>(database, "SELECT event_id,event_sequence,type,tick,tick_key,json FROM events ORDER BY event_sequence", [], (row) => add(["event", row.event_id, row.event_sequence, row.type, row.tick, row.tick_key, row.json]));
  return hash.digest("hex");
}

async function validIndexSchema(database: sqlite3.Database): Promise<boolean> {
  const required: Readonly<Record<string, readonly string[]>> = {
    meta: ["key", "value"],
    provenance: ["capture_id", "json"],
    raw_sources: ["file", "sha256", "bytes", "valid_bytes", "diagnostic"],
    samples: ["sample_index", "tick", "tick_key", "status_flags"],
    sample_values: ["sample_index", "tick", "tick_key", "status_flags", "variable", "value"],
    events: ["event_id", "event_sequence", "type", "tick", "tick_key", "json"],
  };
  for (const [table, expected] of Object.entries(required)) {
    const columns = (await all<{ name: string }>(database, `PRAGMA table_info(${table})`)).map((row) => row.name);
    if (expected.some((name) => !columns.includes(name))) return false;
  }
  const expectedIndexes: Readonly<Record<string, readonly string[]>> = {
    sample_values_window: ["variable", "tick_key", "sample_index"],
    events_window: ["tick_key", "event_sequence"],
  };
  for (const [index, expected] of Object.entries(expectedIndexes)) {
    const columns = (await all<{ name: string }>(database, `PRAGMA index_info(${index})`)).map((row) => row.name);
    if (columns.length !== expected.length || columns.some((name, position) => name !== expected[position])) return false;
  }
  return true;
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
