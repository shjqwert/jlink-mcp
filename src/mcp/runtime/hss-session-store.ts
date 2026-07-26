import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { atomicReplaceSync } from "../../utils/atomic-file";
import { withDirectoryLease } from "../../utils/directory-lease";
import type { JcapV1VariableDescriptor } from "../jcap/jcap-v1";
import type { HssCapabilityFacts, HssCaptureControlFiles, HssRuntimeFacts, HssTargetState } from "./hss-helper-adapter";
import type { PreparedQualityOracle } from "./hss-quality-evidence";
import type { StoredTarget } from "./target-store";

export type HssSessionState = "starting" | "capturing" | "stopping" | "completed" | "stopped" | "interrupted" | "failed";

export interface HssSessionRecord {
  formatVersion: 1;
  captureId: string;
  projectRoot: string;
  targetGeneration: string;
  artifactGeneration: string;
  probeSerial: string;
  state: HssSessionState;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  stopRequestedAt?: string;
  endedAt?: string;
  runId?: string;
  packageDir: string;
  sessionDir: string;
  control: HssCaptureControlFiles;
  helperPid: number;
  helperNonce: string;
  ownerToken: string;
  qpcEpochCounter: string;
  qpcFrequency: string;
  configuredInterface?: StoredTarget["interface"];
  configuredSpeedKHz?: number;
  expectedTargetState?: Exclude<HssTargetState, "unknown">;
  statePreservationPending?: boolean;
  rateHz: number;
  durationSec: number;
  descriptors: JcapV1VariableDescriptor[];
  writeDescriptors?: JcapV1VariableDescriptor[];
  qualityOracle?: PreparedQualityOracle;
  runtime: HssRuntimeFacts;
  capability: HssCapabilityFacts;
  result?: Record<string, unknown>;
  lastError?: { code: string; message: string };
}

const ACTIVE_SESSION_STATES = new Set<HssSessionState>(["starting", "capturing", "stopping"]);
const TERMINAL_SESSION_STATES = new Set<HssSessionState>(["completed", "stopped", "interrupted", "failed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isActiveHssSessionState(state: HssSessionState): boolean {
  return ACTIVE_SESSION_STATES.has(state);
}

export function isTerminalHssSessionState(state: HssSessionState): boolean {
  return TERMINAL_SESSION_STATES.has(state);
}

export class HssSessionStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HssSessionStoreError";
  }
}

export class HssSessionStore {
  private readonly sessionsRoot: string;
  private readonly captureTails = new Map<string, Promise<void>>();

  constructor(stateRoot: string) {
    this.sessionsRoot = resolve(stateRoot, "hss-sessions");
    mkdirSync(this.sessionsRoot, { recursive: true });
  }

  list(): HssSessionRecord[] {
    const entries = readdirSync(this.sessionsRoot, { withFileTypes: true });
    if (entries.length > 10_000) throw new HssSessionStoreError("HSS_SESSION_LIMIT", "HSS session store exceeds 10,000 records");
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.read(entry.name.slice(0, -5)));
  }

  active(projectRoot: string): HssSessionRecord | undefined {
    const matches = this.list().filter((session) => session.projectRoot === projectRoot && isActiveHssSessionState(session.state));
    if (matches.length > 1) throw new HssSessionStoreError("HSS_SESSION_STATE_INVALID", "multiple active captures exist for one projectRoot");
    return matches[0];
  }

  select(projectRoot: string, captureId?: string, activePreferred = false): HssSessionRecord {
    const matches = this.list()
      .filter((session) => session.projectRoot === projectRoot && (!captureId || session.captureId === captureId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const selected = activePreferred
      ? matches.find((session) => isActiveHssSessionState(session.state)) ?? matches[0]
      : matches[0];
    if (!selected) {
      throw new HssSessionStoreError(
        "CAPTURE_NOT_FOUND",
        captureId ? `capture not found: ${captureId}` : "no HSS capture exists for this projectRoot",
      );
    }
    return selected;
  }

  read(captureId: string): HssSessionRecord {
    const file = this.sessionFile(captureId);
    const bytes = readFileSync(file, "utf8");
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) {
      throw new HssSessionStoreError("HSS_SESSION_INVALID", "HSS session record exceeds 4 MiB");
    }
    const value = JSON.parse(bytes) as HssSessionRecord;
    validateSession(value, captureId);
    return value;
  }

  write(session: HssSessionRecord): void {
    validateSession(session, session.captureId);
    const file = this.sessionFile(session.captureId);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      atomicReplaceSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  update(captureId: string, update: (current: HssSessionRecord) => HssSessionRecord): HssSessionRecord {
    const next = update(this.read(captureId));
    this.write(next);
    return this.read(captureId);
  }

  async withExclusiveCapture<T>(captureId: string, operation: () => Promise<T>): Promise<T> {
    this.assertCaptureId(captureId);
    const previous = this.captureTails.get(captureId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveNext) => { release = resolveNext; });
    const tail = previous.then(() => next, () => next);
    this.captureTails.set(captureId, tail);
    await previous.catch(() => undefined);
    try {
      return await withDirectoryLease(join(this.sessionsRoot, ".locks", `${captureId}.lock`), operation, {
        timeoutMs: 30_000,
        errorCode: "CAPTURE_METADATA_BUSY",
      });
    } finally {
      release();
      if (this.captureTails.get(captureId) === tail) this.captureTails.delete(captureId);
    }
  }

  private sessionFile(captureId: string): string {
    this.assertCaptureId(captureId);
    return join(this.sessionsRoot, `${captureId}.json`);
  }

  private assertCaptureId(captureId: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(captureId)) {
      throw new HssSessionStoreError("CAPTURE_ID_INVALID", "captureId must be a UUID");
    }
  }
}

function validateSession(value: HssSessionRecord, captureId: string): void {
  const provisional = value?.state === "starting" || value?.state === "failed";
  if (!value || value.formatVersion !== 1 || value.captureId !== captureId || !value.projectRoot || !value.targetGeneration || !value.probeSerial || !isActiveHssSessionState(value.state) && !isTerminalHssSessionState(value.state) || !value.packageDir || !value.sessionDir
    || !value.control || !value.control.planPath || !value.control.pidFile || !value.control.readyFile || !value.control.stdoutPath || !value.control.stderrPath || !value.control.stopFile || !value.control.requestFile || !value.control.claimFile || !value.control.responseFile
    || !Number.isSafeInteger(value.helperPid) || value.helperPid < 0 || !provisional && value.helperPid < 1 || !value.ownerToken || !provisional && value.ownerToken === "pending"
    || !UUID.test(value.helperNonce) || !/^\d+$/.test(value.qpcEpochCounter) || !/^\d+$/.test(value.qpcFrequency) || BigInt(value.qpcFrequency) < 1n || !Array.isArray(value.descriptors)
    || value.writeDescriptors !== undefined && !Array.isArray(value.writeDescriptors)
    || value.qualityOracle !== undefined && (!value.qualityOracle.logicalIdentity || !Number.isSafeInteger(value.qualityOracle.expectedIncrement) || value.qualityOracle.expectedIncrement < 1
      || !Number.isSafeInteger(value.qualityOracle.tolerance) || value.qualityOracle.tolerance < 0 || !Number.isSafeInteger(value.qualityOracle.modulus) || value.qualityOracle.modulus < 2
      || value.qualityOracle.expectedIncrement + value.qualityOracle.tolerance >= value.qualityOracle.modulus)) {
    throw new HssSessionStoreError("HSS_SESSION_INVALID", `invalid HSS session record: ${basename(captureId)}`);
  }
}
