import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { atomicReplaceSync } from "../../utils/atomic-file";
import { canonicalProbeSerial, ProbeIdentityError } from "./probe-identity";

export type ProbeOwnerKind = "hss" | "gdb" | "memory";

export interface ProbeOwner {
  kind: ProbeOwnerKind;
  token: string;
  pid: number;
  processInstanceId: string;
  processStartedAt: string;
  heartbeatAt: string;
  projectRoot: string;
  targetGeneration: string;
  acquiredAt: string;
  /**
   * PID of the long-lived process that physically owns the Probe. Unlike the
   * controller PID above, this process may intentionally outlive the MCP
   * process (for example when disconnecting it could implicitly resume a
   * halted target). A live resource PID therefore keeps the owner fail-closed.
   */
  resourcePid?: number;
  details?: Record<string, unknown>;
}

export interface QueueMetadata {
  queueSequence: number;
  queuedAt: string;
  startedAt: string;
  leaseToken: string;
}

export interface QueueExecution<T> extends QueueMetadata {
  endedAt: string;
  value: T;
}

export interface QueueRunOptions {
  allowedOwnerKinds?: ProbeOwnerKind[];
  ownerTarget?: { projectRoot: string; targetGeneration: string };
  requiredOwner?: Pick<ProbeOwner, "kind" | "token" | "projectRoot" | "targetGeneration">;
  queueTimeoutMs?: number;
}

interface TicketRecord {
  sequence: number;
  pid: number;
  processInstanceId: string;
  processStartedAt: string;
  token: string;
  queuedAt: string;
  heartbeatAt: string;
}

interface LeaseRecord extends TicketRecord {
  startedAt: string;
}

const processInstanceId = randomUUID();
const processStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
const inProcessTails = new Map<string, Promise<void>>();

export class ProbeQueueError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly owner?: ProbeOwner,
  ) {
    super(message);
    this.name = "ProbeQueueError";
  }
}

export class ProbeQueue {
  readonly root: string;
  private readonly ownerHeartbeats = new Map<string, NodeJS.Timeout>();

  constructor(root = defaultQueueRoot()) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  async runExclusive<T>(
    probeSerial: string,
    operation: (metadata: QueueMetadata) => Promise<T>,
    options: QueueRunOptions = {},
  ): Promise<QueueExecution<T>> {
    const serial = requireSerial(probeSerial);
    const queueKey = `${this.root}:${probeKey(serial)}`;
    return enqueueInProcess(queueKey, () => this.runCrossProcess(serial, operation, options));
  }

  getOwner(probeSerial: string): ProbeOwner | undefined {
    const probeDir = this.probeDirectory(requireSerial(probeSerial));
    mkdirSync(probeDir, { recursive: true });
    return readVisibleOwner(probeDir);
  }

  claimOwner(
    probeSerial: string,
    input: Omit<ProbeOwner, "token" | "pid" | "processInstanceId" | "processStartedAt" | "heartbeatAt" | "acquiredAt">,
    leaseToken: string,
  ): ProbeOwner {
    const probeDir = this.probeDirectory(requireSerial(probeSerial));
    mkdirSync(probeDir, { recursive: true });
    const lease = readLease(join(probeDir, "lease.lock"));
    if (!lease || lease.token !== leaseToken || lease.pid !== process.pid || lease.processInstanceId !== processInstanceId) {
      throw new ProbeQueueError("LEASE_TOKEN_MISMATCH", "a live Probe queue lease is required before claiming a long-lived owner");
    }
    const ownerLock = join(probeDir, "owner-update.lock");
    const lockToken = acquireDirectoryLock(ownerLock, 5_000);
    try {
      const existing = readLiveOwnerLocked(probeDir);
      if (existing) throw ownerError(existing);
      const owner: ProbeOwner = {
        ...input,
        token: randomUUID(),
        pid: process.pid,
        processInstanceId,
        processStartedAt,
        heartbeatAt: new Date().toISOString(),
        acquiredAt: new Date().toISOString(),
      };
      atomicJsonWrite(join(probeDir, "owner.json"), owner);
      this.startOwnerHeartbeat(probeDir, owner.token);
      return owner;
    } finally {
      releaseDirectoryLock(ownerLock, lockToken);
    }
  }

  adoptOwner(probeSerial: string, expected: { kind: ProbeOwnerKind; projectRoot: string; targetGeneration: string; resourcePid: number; captureId: string }): ProbeOwner {
    const probeDir = this.probeDirectory(requireSerial(probeSerial));
    mkdirSync(probeDir, { recursive: true });
    const ownerLock = join(probeDir, "owner-update.lock");
    const lockToken = acquireDirectoryLock(ownerLock, 5_000);
    try {
      const existing = readLiveOwnerLocked(probeDir);
      if (!existing) throw new ProbeQueueError("OWNER_MISSING", "the long-lived Probe owner disappeared before adoption");
      if (identityRecordLive(existing)) throw new ProbeQueueError("OWNER_ADOPTION_DENIED", "a live controller process still owns the Probe", existing);
      if (existing.kind !== expected.kind || existing.projectRoot !== expected.projectRoot || existing.targetGeneration !== expected.targetGeneration
        || existing.resourcePid !== expected.resourcePid || existing.details?.captureId !== expected.captureId) throw new ProbeQueueError("OWNER_CHANGED", "the durable Probe owner does not match the capture recovery journal", existing);
      const now = new Date().toISOString();
      const adopted: ProbeOwner = {
        ...existing,
        token: randomUUID(),
        pid: process.pid,
        processInstanceId,
        processStartedAt,
        heartbeatAt: now,
        acquiredAt: now,
      };
      atomicJsonWrite(join(probeDir, "owner.json"), adopted);
      this.startOwnerHeartbeat(probeDir, adopted.token);
      return adopted;
    } finally {
      releaseDirectoryLock(ownerLock, lockToken);
    }
  }

  releaseOwner(probeSerial: string, token: string): boolean {
    const probeDir = this.probeDirectory(requireSerial(probeSerial));
    const ownerLock = join(probeDir, "owner-update.lock");
    const lockToken = acquireDirectoryLock(ownerLock, 5_000);
    try {
      const owner = readLiveOwnerLocked(probeDir);
      if (!owner) {
        this.stopOwnerHeartbeat(token);
        return false;
      }
      if (owner.token !== token || owner.pid !== process.pid || owner.processInstanceId !== processInstanceId) {
        throw new ProbeQueueError("OWNER_TOKEN_MISMATCH", "only the process that acquired the Probe owner may release it", owner);
      }
      removeJsonFileIfTokenMatches(join(probeDir, "owner.json"), token);
      this.stopOwnerHeartbeat(token);
      return true;
    } finally {
      releaseDirectoryLock(ownerLock, lockToken);
    }
  }

  updateOwnerResource(
    probeSerial: string,
    token: string,
    resourcePid: number,
    details?: Record<string, unknown>,
  ): ProbeOwner {
    if (!validOptionalPid(resourcePid) || resourcePid === undefined) throw new ProbeQueueError("OWNER_RESOURCE_PID_INVALID", "owner resource PID must be a live positive integer");
    const probeDir = this.probeDirectory(requireSerial(probeSerial));
    const ownerLock = join(probeDir, "owner-update.lock");
    const lockToken = acquireDirectoryLock(ownerLock, 5_000);
    try {
      const owner = readLiveOwnerLocked(probeDir);
      if (!owner || owner.token !== token || owner.pid !== process.pid || owner.processInstanceId !== processInstanceId) {
        throw new ProbeQueueError("OWNER_TOKEN_MISMATCH", "only the process that acquired the Probe owner may update its resource identity", owner);
      }
      const updated: ProbeOwner = { ...owner, resourcePid, ...(details ? { details } : {}) };
      atomicJsonWrite(join(probeDir, "owner.json"), updated);
      return updated;
    } finally {
      releaseDirectoryLock(ownerLock, lockToken);
    }
  }

  private async runCrossProcess<T>(
    probeSerial: string,
    operation: (metadata: QueueMetadata) => Promise<T>,
    options: QueueRunOptions,
  ): Promise<QueueExecution<T>> {
    const probeDir = this.probeDirectory(probeSerial);
    const ticketsDir = join(probeDir, "tickets");
    mkdirSync(ticketsDir, { recursive: true });
    const ticket = await this.allocateTicket(probeDir, ticketsDir);
    const ticketPath = join(ticketsDir, ticketFileName(ticket));
    const leaseDir = join(probeDir, "lease.lock");
    const deadline = Date.now() + (options.queueTimeoutMs ?? 120_000);
    const ticketHeartbeat = startRecordHeartbeat(ticketPath, ticket.token);
    let leaseHeld = false;
    let leaseHeartbeat: NodeJS.Timeout | undefined;
    try {
      for (;;) {
        cleanStaleTickets(ticketsDir);
        const first = readTickets(ticketsDir)[0];
        if (first?.token === ticket.token) {
          recoverStaleLease(leaseDir);
          const startedAt = new Date().toISOString();
          const lease: LeaseRecord = { ...ticket, startedAt, heartbeatAt: startedAt };
          if (tryCreateLease(leaseDir, lease)) {
            leaseHeld = true;
            leaseHeartbeat = startRecordHeartbeat(join(leaseDir, "owner.json"), lease.token);
            break;
          }
        }
        if (Date.now() >= deadline) throw new ProbeQueueError("QUEUE_TIMEOUT", "timed out waiting for the Probe FIFO lease");
        await delay(10);
      }

      const lease = readLease(leaseDir);
      if (!lease || lease.token !== ticket.token) throw new ProbeQueueError("LEASE_TOKEN_MISMATCH", "Probe queue lease changed before execution");
      const startedAt = lease.startedAt;
      const owner = readLiveOwnerForExecution(probeDir);
      if (options.requiredOwner && !sameOwner(owner, options.requiredOwner)) {
        throw new ProbeQueueError("OWNER_CHANGED", "required Probe owner changed while the request waited in the queue", owner);
      }
      if (owner && !(options.allowedOwnerKinds ?? []).includes(owner.kind)) throw ownerError(owner);
      if (owner && options.ownerTarget && (
        owner.projectRoot !== options.ownerTarget.projectRoot
        || owner.targetGeneration !== options.ownerTarget.targetGeneration
      )) throw ownerError(owner);
      const metadata: QueueMetadata = {
        queueSequence: ticket.sequence,
        queuedAt: ticket.queuedAt,
        startedAt,
        leaseToken: ticket.token,
      };
      const value = await operation(metadata);
      return { ...metadata, endedAt: new Date().toISOString(), value };
    } finally {
      clearInterval(ticketHeartbeat);
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      if (leaseHeld) removeDirectoryIfTokenMatches(leaseDir, ticket.token);
      removeJsonFileIfTokenMatches(ticketPath, ticket.token);
    }
  }

  private async allocateTicket(probeDir: string, ticketsDir: string): Promise<TicketRecord> {
    const metadataLock = join(probeDir, "metadata.lock");
    const lockToken = await acquireDirectoryLockAsync(metadataLock, 10_000);
    try {
      const sequencePath = join(probeDir, "sequence.json");
      let previous = 0;
      if (existsSync(sequencePath)) {
        try {
          previous = Number((JSON.parse(readFileSync(sequencePath, "utf8")) as { value?: unknown }).value);
        } catch {
          throw new ProbeQueueError("QUEUE_STATE_INVALID", "Probe queue sequence state is not valid JSON");
        }
        if (!Number.isSafeInteger(previous) || previous < 0) throw new ProbeQueueError("QUEUE_STATE_INVALID", "Probe queue sequence is not a non-negative safe integer");
      }
      const sequence = previous + 1;
      const ticket: TicketRecord = {
        sequence,
        pid: process.pid,
        processInstanceId,
        processStartedAt,
        token: randomUUID(),
        queuedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      };
      atomicJsonWrite(sequencePath, { value: sequence });
      atomicJsonWrite(join(ticketsDir, ticketFileName(ticket)), ticket);
      return ticket;
    } finally {
      releaseDirectoryLock(metadataLock, lockToken);
    }
  }

  private startOwnerHeartbeat(probeDir: string, token: string): void {
    this.stopOwnerHeartbeat(token);
    const ownerPath = join(probeDir, "owner.json");
    const ownerLock = join(probeDir, "owner-update.lock");
    const timer = setInterval(() => {
      let lockToken: string | undefined;
      try {
        lockToken = acquireDirectoryLock(ownerLock, 250);
        refreshJsonHeartbeat(ownerPath, token);
      } catch { /* a concurrent owner operation will refresh or remove it */ }
      finally { if (lockToken) releaseDirectoryLock(ownerLock, lockToken); }
    }, 1_000);
    timer.unref();
    this.ownerHeartbeats.set(token, timer);
  }

  private stopOwnerHeartbeat(token: string): void {
    const timer = this.ownerHeartbeats.get(token);
    if (timer) clearInterval(timer);
    this.ownerHeartbeats.delete(token);
  }

  private probeDirectory(probeSerial: string): string {
    return join(this.root, probeKey(probeSerial));
  }
}

async function enqueueInProcess<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = inProcessTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolveNext) => { release = resolveNext; });
  const tail = previous.then(() => next, () => next);
  inProcessTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (inProcessTails.get(key) === tail) inProcessTails.delete(key);
  }
}

function readLiveOwnerLocked(probeDir: string): ProbeOwner | undefined {
  const ownerPath = join(probeDir, "owner.json");
  if (!existsSync(ownerPath)) return undefined;
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as ProbeOwner;
    if (!validIdentityRecord(owner) || !owner.kind || !owner.token || !validOptionalPid(owner.resourcePid)) throw new Error("invalid owner");
    if (!ownerRecordLive(owner)) {
      removeJsonFileIfTokenMatches(ownerPath, owner.token);
      return undefined;
    }
    return owner;
  } catch {
    throw new ProbeQueueError("QUEUE_STATE_INVALID", "Probe owner state is malformed and was not removed automatically");
  }
}

function readLiveOwnerForExecution(probeDir: string): ProbeOwner | undefined {
  const ownerLock = join(probeDir, "owner-update.lock");
  const lockToken = acquireDirectoryLock(ownerLock, 5_000);
  try {
    return readLiveOwnerLocked(probeDir);
  } finally {
    releaseDirectoryLock(ownerLock, lockToken);
  }
}

/**
 * Status reads deliberately do not take or clean up the owner-update lock.
 * Writer paths replace owner.json atomically and retain the lock while they
 * validate or remove stale state, so an observer must never race that cleanup.
 */
function readVisibleOwner(probeDir: string): ProbeOwner | undefined {
  const ownerPath = join(probeDir, "owner.json");
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as ProbeOwner;
    if (!validIdentityRecord(owner) || !owner.kind || !owner.token || !validOptionalPid(owner.resourcePid)) throw new Error("invalid owner");
    return ownerRecordLive(owner) ? owner : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProbeQueueError("QUEUE_STATE_INVALID", "Probe owner state is malformed and was not removed automatically");
  }
}

function ownerRecordLive(owner: ProbeOwner): boolean {
  if (identityRecordLive(owner)) return true;
  // A GDB Server or capture helper can survive an MCP crash/forced exit. Its
  // PID is deliberately authoritative even with a stale heartbeat so another
  // MCP process cannot concurrently reclaim the same physical Probe.
  return owner.resourcePid !== undefined && processAlive(owner.resourcePid);
}

function validOptionalPid(pid: number | undefined): boolean {
  return pid === undefined || (Number.isSafeInteger(pid) && pid > 0);
}

function ownerError(owner: ProbeOwner): ProbeQueueError {
  if (owner.kind === "hss") return new ProbeQueueError("CAPTURE_ACTIVE", "HSS capture owns this Probe", owner);
  if (owner.kind === "gdb") return new ProbeQueueError("GDB_SESSION_ACTIVE", "J-Link GDB Server owns this Probe", owner);
  return new ProbeQueueError("MEMORY_SESSION_ACTIVE", "persistent native memory session owns this Probe", owner);
}

function readTickets(ticketsDir: string): TicketRecord[] {
  return readdirSync(ticketsDir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try { return [JSON.parse(readFileSync(join(ticketsDir, name), "utf8")) as TicketRecord]; } catch { return []; }
    })
    .sort((left, right) => left.sequence - right.sequence);
}

function cleanStaleTickets(ticketsDir: string): void {
  for (const name of readdirSync(ticketsDir).filter((entry) => entry.endsWith(".json"))) {
    const ticketPath = join(ticketsDir, name);
    try {
      const ticket = JSON.parse(readFileSync(ticketPath, "utf8")) as TicketRecord;
      if (!validIdentityRecord(ticket) || !identityRecordLive(ticket)) removeJsonFileIfTokenMatches(ticketPath, ticket.token);
    } catch {
      /* Malformed tickets are ignored but never deleted without an identity token. */
    }
  }
}

function recoverStaleLease(leaseDir: string): void {
  if (!existsSync(leaseDir)) return;
  try {
    const lease = JSON.parse(readFileSync(join(leaseDir, "owner.json"), "utf8")) as LeaseRecord;
    if (!validIdentityRecord(lease) || !identityRecordLive(lease)) removeDirectoryIfTokenMatches(leaseDir, lease.token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(leaseDir)) return;
    throw new ProbeQueueError("QUEUE_STATE_INVALID", "Probe lease state is malformed and was not removed automatically");
  }
}

function readLease(leaseDir: string): LeaseRecord | undefined {
  if (!existsSync(leaseDir)) return undefined;
  try {
    const lease = JSON.parse(readFileSync(join(leaseDir, "owner.json"), "utf8")) as LeaseRecord;
    return validIdentityRecord(lease) && identityRecordLive(lease) ? lease : undefined;
  } catch {
    return undefined;
  }
}

function acquireDirectoryLock(lockPath: string, timeoutMs: number): string {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = randomUUID();
    try {
      if (!tryCreateLease(lockPath, identityRecord(token))) throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      recoverStaleLease(lockPath);
      if (!existsSync(lockPath)) continue;
      if (Date.now() >= deadline) throw new ProbeQueueError("QUEUE_METADATA_BUSY", "timed out acquiring Probe queue metadata lock");
      synchronousDelay(10);
    }
  }
}

async function acquireDirectoryLockAsync(lockPath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = randomUUID();
    try {
      if (!tryCreateLease(lockPath, identityRecord(token))) throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      recoverStaleLease(lockPath);
      if (!existsSync(lockPath)) continue;
      if (Date.now() >= deadline) throw new ProbeQueueError("QUEUE_METADATA_BUSY", "timed out acquiring Probe queue metadata lock");
      await delay(10);
    }
  }
}

function atomicJsonWrite(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  atomicReplaceSync(temporary, filePath);
}

function identityRecord(token: string): TicketRecord {
  const now = new Date().toISOString();
  return { sequence: 0, pid: process.pid, processInstanceId, processStartedAt, token, queuedAt: now, heartbeatAt: now };
}

function validIdentityRecord(record: Partial<TicketRecord>): record is TicketRecord {
  return Number.isSafeInteger(record.pid) && Number(record.pid) > 0
    && typeof record.processInstanceId === "string"
    && typeof record.processStartedAt === "string"
    && typeof record.heartbeatAt === "string"
    && typeof record.token === "string";
}

function identityRecordLive(record: Pick<TicketRecord, "pid" | "processInstanceId" | "processStartedAt" | "heartbeatAt">): boolean {
  if (record.pid === process.pid) return record.processInstanceId === processInstanceId && record.processStartedAt === processStartedAt;
  // Heartbeats are diagnostic only. A live process may pause long enough to miss
  // them, so reclaiming its lease would allow two processes to use one Probe.
  return processAlive(record.pid);
}

function tryCreateLease(lockPath: string, record: TicketRecord | LeaseRecord): boolean {
  const prepared = `${lockPath}.${process.pid}.${record.token}.tmp`;
  try {
    mkdirSync(prepared);
    writeFileSync(join(prepared, "owner.json"), JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    writeFileSync(directoryGuardPath(prepared, record.token), record.token, { encoding: "utf8", flag: "wx" });
    renameSync(prepared, lockPath);
    return true;
  } catch (error) {
    rmSync(prepared, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") return false;
    throw error;
  }
}

function startRecordHeartbeat(filePath: string, token: string): NodeJS.Timeout {
  const timer = setInterval(() => refreshJsonHeartbeat(filePath, token), 1_000);
  timer.unref();
  return timer;
}

function refreshJsonHeartbeat(filePath: string, token: string): void {
  try {
    const current = JSON.parse(readFileSync(filePath, "utf8")) as TicketRecord;
    if (current.token !== token) return;
    atomicJsonWrite(filePath, { ...current, heartbeatAt: new Date().toISOString() });
  } catch { /* the record was released or replaced */ }
}

function removeJsonFileIfTokenMatches(filePath: string, token: string): boolean {
  try {
    const current = JSON.parse(readFileSync(filePath, "utf8")) as { token?: string };
    if (current.token !== token) return false;
    rmSync(filePath, { force: true });
    return true;
  } catch { return false; }
}

function removeDirectoryIfTokenMatches(directory: string, token: string): boolean {
  const guardPath = directoryGuardPath(directory, token);
  const claimedGuardPath = `${guardPath}.retiring-${process.pid}-${randomUUID()}`;
  try {
    renameSync(guardPath, claimedGuardPath);
  } catch {
    return false;
  }
  const retiredDirectory = `${directory}.retired-${process.pid}-${randomUUID()}`;
  try {
    renameSync(directory, retiredDirectory);
  } catch {
    try { renameSync(claimedGuardPath, guardPath); } catch { /* leave the lock fail-closed */ }
    return false;
  }
  try {
    rmSync(retiredDirectory, { recursive: true, force: true });
  } catch { /* the live lock name was already retired atomically */ }
  return true;
}

function directoryGuardPath(directory: string, token: string): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return join(directory, `.owner-${tokenHash}.guard`);
}

function releaseDirectoryLock(lockPath: string, token: string): void {
  removeDirectoryIfTokenMatches(lockPath, token);
}

function sameOwner(owner: ProbeOwner | undefined, expected: QueueRunOptions["requiredOwner"]): boolean {
  return Boolean(owner && expected
    && owner.kind === expected.kind
    && owner.token === expected.token
    && owner.projectRoot === expected.projectRoot
    && owner.targetGeneration === expected.targetGeneration);
}

function requireSerial(probeSerial: string): string {
  try { return canonicalProbeSerial(probeSerial); }
  catch (error) {
    throw new ProbeQueueError("PROBE_SELECTION_REQUIRED", error instanceof ProbeIdentityError ? error.message : "an unambiguous Probe serial is required");
  }
}

function probeKey(probeSerial: string): string {
  return createHash("sha256").update(probeSerial).digest("hex");
}

function ticketFileName(ticket: TicketRecord): string {
  return `${String(ticket.sequence).padStart(20, "0")}-${ticket.token}.json`;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function defaultQueueRoot(): string {
  if (process.platform !== "win32") return join(tmpdir(), "jlink-mcp-probe-queue");
  const commonData = process.env.ProgramData;
  if (!commonData) throw new ProbeQueueError("QUEUE_ROOT_UNAVAILABLE", "ProgramData is required for the machine-wide Probe queue on Windows");
  return join(commonData, "JlinkMCP", "probe-queue");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function synchronousDelay(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}
