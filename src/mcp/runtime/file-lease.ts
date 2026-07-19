import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const PROCESS_INSTANCE_ID = randomUUID();
const PUBLISH_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64] as const;

interface LeaseRecord {
  token: string;
  pid: number;
  processInstanceId: string;
  acquiredAt: string;
}

export class FileLeaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FileLeaseError";
  }
}

export async function withDirectoryLease<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number; errorCode?: string } = {},
): Promise<T> {
  const resolved = resolve(lockPath);
  if (!basename(resolved).endsWith(".lock")) throw new FileLeaseError("FILE_LEASE_PATH_INVALID", "directory lease path must end with .lock");
  mkdirSync(dirname(resolved), { recursive: true });
  const token = await acquire(resolved, options.timeoutMs ?? 30_000, options.errorCode ?? "FILE_LEASE_BUSY");
  try {
    return await operation();
  } finally {
    release(resolved, token);
  }
}

async function acquire(lockPath: string, timeoutMs: number, errorCode: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record: LeaseRecord = {
      token: randomUUID(),
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      acquiredAt: new Date().toISOString(),
    };
    if (tryCreate(lockPath, record)) return record.token;
    recoverStale(lockPath);
    if (Date.now() >= deadline) throw new FileLeaseError(errorCode, `timed out acquiring directory lease: ${basename(lockPath)}`);
    await delay(10);
  }
}

function tryCreate(lockPath: string, record: LeaseRecord): boolean {
  const prepared = `${lockPath}.${process.pid}.${record.token}.tmp`;
  mkdirSync(prepared);
  try {
    writeFileSync(resolve(prepared, "owner.json"), JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(prepared, lockPath);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTEMPTY" || (code === "EPERM" && existsSync(lockPath))) return false;
        if (code === "EPERM" && attempt < PUBLISH_RETRY_DELAYS_MS.length) {
          waitSync(PUBLISH_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw error;
      }
    }
  } finally {
    if (existsSync(prepared)) rmSync(prepared, { recursive: true, force: true });
  }
}

function recoverStale(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  const record = readRecord(lockPath);
  if (record && recordLive(record)) return;
  if (!record) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < 5_000) return;
    } catch { return; }
  }
  moveAndRemove(lockPath, `stale-${randomUUID()}`);
}

function release(lockPath: string, token: string): void {
  const record = readRecord(lockPath);
  if (!record || record.token !== token || record.pid !== process.pid || record.processInstanceId !== PROCESS_INSTANCE_ID) return;
  moveAndRemove(lockPath, `released-${token}`);
}

function moveAndRemove(lockPath: string, suffix: string): void {
  const tombstone = `${lockPath}.${suffix}.tmp`;
  try {
    renameSync(lockPath, tombstone);
    rmSync(tombstone, { recursive: true, force: true });
  } catch {
    if (existsSync(tombstone)) rmSync(tombstone, { recursive: true, force: true });
  }
}

function readRecord(lockPath: string): LeaseRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(resolve(lockPath, "owner.json"), "utf8")) as Partial<LeaseRecord>;
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.processInstanceId !== "string" || !Number.isFinite(Date.parse(String(value.acquiredAt)))) return undefined;
    return value as LeaseRecord;
  } catch {
    return undefined;
  }
}

function recordLive(record: LeaseRecord): boolean {
  if (record.pid === process.pid) return record.processInstanceId === PROCESS_INSTANCE_ID;
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
