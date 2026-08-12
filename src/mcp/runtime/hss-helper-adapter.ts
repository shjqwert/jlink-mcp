import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { findPinnedHssHelperPath, matchesPinnedHssHelperVersion, PINNED_HSS_HELPER_RELEASE } from "../hss-helper-release";
import type { StoredTarget } from "./target-store";

export const HSS_HELPER_PROTOCOL_VERSION = PINNED_HSS_HELPER_RELEASE.protocolVersion;
export const HSS_EFFECTIVE_LIMITS = { maxVariables: 10, maxWriteVariables: 32, maxRateHz: 1_000, maxDurationSec: 60 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HssRuntimeFacts {
  backend: "jlink-hss" | "fake-hss";
  available: boolean;
  helperPath?: string;
  runtimePath?: string;
  helperSha256?: string;
  runtimeSha256?: string;
  helperVersion?: string;
  helperProtocolVersion?: number;
  architecture?: string;
  abi?: Record<string, unknown>;
  errorCode?: string;
  reason?: string;
}

export interface HssCapabilityFacts extends HssRuntimeFacts {
  hardware?: { maxBlocks: number; maxFreq: number; flags: number; raw?: number[] };
  effective: typeof HSS_EFFECTIVE_LIMITS;
  observed?: Record<string, unknown>;
}

export interface HssTimebase {
  qpcCounter: string;
  qpcFrequency: string;
}

export type HssTargetState = "running" | "halted" | "unknown";

export interface HssCaptureControlFiles {
  planPath: string;
  pidFile: string;
  readyFile: string;
  stdoutPath: string;
  stderrPath: string;
  stopFile: string;
  requestFile: string;
  claimFile: string;
  responseFile: string;
}

export interface HssCaptureLaunch {
  pid: number;
  launchedAt: string;
  captureId: string;
  helperNonce: string;
  initialTargetState: Exclude<HssTargetState, "unknown">;
  expectedTargetState: Exclude<HssTargetState, "unknown">;
  resumeBeforeStart: boolean;
}

export interface HssMemoryRequest {
  captureId: string;
  op: "read" | "write" | "resume";
  operationId?: string;
  eventContext?:
    | {
      kind?: "variable_write";
      logicalIdentity: string;
      requestedValue: number;
      phase: "write" | "restore";
      endian: "little" | "big";
    }
    | {
      kind: "target_control";
      requestedAction: "resume" | "continue";
      canonicalAction: "resume";
    };
  address?: string;
  length?: number;
  accessSize?: 1 | 2 | 4;
  bytesHex?: string;
}

export interface HssMemoryResponse extends Record<string, unknown> {
  requestId: string;
  status: "ok" | "error";
  op?: HssMemoryRequest["op"];
  errorCode?: string;
  reason?: string;
  bytesHex?: string;
  writeIssued?: boolean;
  stateUnknown?: boolean;
  resumeIssued?: boolean;
  beforeState?: HssTargetState;
  afterState?: HssTargetState;
  operationBeforeQpcCounter?: string;
  operationAfterQpcCounter?: string;
}

export interface HssMemoryTransaction {
  formatVersion: 1;
  request: HssMemoryRequest & { formatVersion: 1; requestId: string; createdAt: string };
  response: HssMemoryResponse;
  receivedAt: string;
}

export interface HssHelperAdapter {
  readonly backend: HssRuntimeFacts["backend"];
  inspectRuntime(target: StoredTarget): Promise<HssRuntimeFacts>;
  capability(target: StoredTarget, runtime: HssRuntimeFacts | undefined, expectedTargetState: Exclude<HssTargetState, "unknown">): Promise<HssCapabilityFacts>;
  observeTargetState(target: StoredTarget, runtime: HssRuntimeFacts): Promise<HssTargetState>;
  restoreHaltedState(target: StoredTarget, runtime: HssRuntimeFacts): Promise<HssTargetState>;
  qpcTimebase(runtime: HssRuntimeFacts): Promise<HssTimebase>;
  launchCapture(runtime: HssRuntimeFacts, control: HssCaptureControlFiles): Promise<HssCaptureLaunch>;
  waitUntilReady(control: HssCaptureControlFiles, launch: HssCaptureLaunch, timeoutMs?: number): Promise<void>;
  requestMemory(control: HssCaptureControlFiles, request: HssMemoryRequest, timeoutMs?: number): Promise<HssMemoryResponse>;
  listMemoryTransactions(control: HssCaptureControlFiles): HssMemoryTransaction[];
  acknowledgeMemoryTransactions(control: HssCaptureControlFiles, requestIds: readonly string[]): void;
  requestStop(control: HssCaptureControlFiles): Promise<void>;
  terminate(pid: number): void;
  isAlive(pid: number): boolean;
  isCaptureAlive(control: HssCaptureControlFiles, pid: number, captureId: string, helperNonce: string): boolean;
  confirmCaptureAlive(control: HssCaptureControlFiles, pid: number, captureId: string, helperNonce: string, timeoutMs?: number): Promise<boolean>;
  readRecords(control: HssCaptureControlFiles): Array<Record<string, unknown>>;
}

export class HssAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly stateUnknown = false,
    readonly currentRequestIssued = false,
  ) {
    super(message);
    this.name = "HssAdapterError";
  }
}

export function hssTargetStateFromConnectPreflight(observed: Record<string, unknown>): HssTargetState {
  if (observed.targetWasHaltedRaw === 1) return "halted";
  if (observed.targetWasHaltedRaw === 0) return "running";
  throw new HssAdapterError("HSS_TARGET_STATE_UNKNOWN", "HSS target-state preflight returned no usable execution state", true, true);
}

export function assertNonIntrusiveConnectPreflight(observed: Record<string, unknown>): void {
  // The policy avoids the device script, while reset continuity remains a
  // target-specific hardware fact and is intentionally not inferred here.
  if (observed.nonIntrusiveAttach !== true || observed.targetWritten !== false || observed.flashIssued !== false || observed.resetIssued !== false || observed.haltIssued !== false) {
    throw new HssAdapterError("HSS_CONNECT_PREFLIGHT_SIDE_EFFECT", "HSS target-state preflight reported an unsafe attach policy or target side effect", false, true);
  }
}

export function selectHssAttachDevice(target: Pick<StoredTarget, "device" | "gdbDevice">): string {
  return target.gdbDevice === "Cortex-M4" ? target.gdbDevice : target.device;
}

export class NativeHssHelperAdapter implements HssHelperAdapter {
  readonly backend = "jlink-hss" as const;

  constructor(private readonly helperOverride?: string) {}

  async inspectRuntime(target: StoredTarget): Promise<HssRuntimeFacts> {
    const helperPath = this.findHelper();
    const runtimePath = findRuntime(target);
    if (process.platform !== "win32") return unavailable("HSS_PLATFORM_UNSUPPORTED", "the native J-Link HSS helper requires Windows", helperPath, runtimePath);
    if (!helperPath) return unavailable("HSS_HELPER_MISSING", "the bundled native HSS helper was not found", helperPath, runtimePath);
    if (!runtimePath) return unavailable("HSS_RUNTIME_NOT_CONFIGURED", "no J-Link DLL was found beside an explicitly configured J-Link tool", helperPath, runtimePath);
    try {
      const [helperSha256, runtimeSha256] = [sha256File(helperPath), sha256File(runtimePath)];
      if (helperSha256 !== PINNED_HSS_HELPER_RELEASE.sha256) {
        return unavailable(
          "HSS_HELPER_IDENTITY_MISMATCH",
          "the selected HSS helper does not match the pinned release identity",
          helperPath,
          runtimePath,
        );
      }
      const version = await runJson(helperPath, ["version"], 10_000);
      if (!matchesPinnedHssHelperVersion(version)) {
        return unavailable("HSS_HELPER_ABI_INCOMPATIBLE", "the helper protocol is incompatible", helperPath, runtimePath, version);
      }
      if (sha256File(helperPath) !== helperSha256 || sha256File(runtimePath) !== runtimeSha256) throw new HssAdapterError("HSS_RUNTIME_IDENTITY_CHANGED", "the helper or J-Link runtime changed during ABI inspection", true);
      const preflight = await runJson(helperPath, ["preflight", "--dll", runtimePath], 20_000);
      const exportsFound = preflight.exportsFound === true;
      if (preflight.status !== "ok" || !exportsFound) {
        return unavailable(String(preflight.errorCode ?? "HSS_RUNTIME_ABI_INCOMPATIBLE"), String(preflight.reason ?? "required J-Link HSS exports are unavailable"), helperPath, runtimePath, preflight);
      }
      if (sha256File(helperPath) !== helperSha256 || sha256File(runtimePath) !== runtimeSha256) throw new HssAdapterError("HSS_RUNTIME_IDENTITY_CHANGED", "the helper or J-Link runtime changed during ABI inspection", true);
      return {
        backend: this.backend,
        available: true,
        helperPath,
        runtimePath,
        helperSha256,
        runtimeSha256,
        helperVersion: String(version.helperVersion ?? ""),
        helperProtocolVersion: Number(version.helperProtocolVersion),
        architecture: String(version.architecture ?? "unknown"),
        abi: sanitizeObserved(preflight),
      };
    } catch (error) {
      return unavailable(
        error instanceof HssAdapterError ? error.code : "HSS_RUNTIME_INSPECTION_FAILED",
        error instanceof Error ? error.message : String(error),
        helperPath,
        runtimePath,
      );
    }
  }

  async capability(target: StoredTarget, supplied: HssRuntimeFacts | undefined, expectedTargetState: Exclude<HssTargetState, "unknown">): Promise<HssCapabilityFacts> {
    const runtime = supplied ?? await this.inspectRuntime(target);
    if (!runtime.available || !runtime.helperPath || !runtime.runtimePath) return { ...runtime, effective: HSS_EFFECTIVE_LIMITS };
    try {
      assertRuntimeIdentity(runtime);
      const observed = await runJson(runtime.helperPath, [
        "getcaps",
        "--dll", runtime.runtimePath,
        "--device", selectHssAttachDevice(target),
        "--interface", target.interface,
        "--serial", target.probeSerial,
        "--speed", String(target.speed),
        "--jlink-script-mode", "none",
        "--expected-target-state", expectedTargetState,
      ], 30_000);
      if (observed.status !== "ok") {
        const code = String(observed.errorCode ?? "HSS_CAPABILITY_FAILED");
        if (code === "HSS_TARGET_STATE_CHANGED" || code === "HSS_TARGET_STATE_RESTORE_FAILED" || code === "HSS_TARGET_STATE_OBSERVE_FAILED") {
          return {
            ...runtime,
            available: false,
            effective: HSS_EFFECTIVE_LIMITS,
            errorCode: code,
            reason: String(observed.reason ?? "HSS capability changed or obscured target state"),
            observed: sanitizeObserved(observed),
          };
        }
        return {
          ...runtime,
          available: false,
          effective: HSS_EFFECTIVE_LIMITS,
          errorCode: code,
          reason: String(observed.reason ?? "JLINK_HSS_GetCaps failed"),
          observed: sanitizeObserved(observed),
        };
      }
      const caps = asRecord(observed.caps);
      const maxBlocks = Number(caps.maxBlocks);
      const maxFreq = Number(caps.maxFreq);
      const flags = Number(caps.caps);
      if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || !Number.isFinite(maxFreq) || maxFreq <= 0 || !Number.isSafeInteger(flags)) {
        throw new HssAdapterError("HSS_CAPABILITY_INVALID", "JLINK_HSS_GetCaps returned invalid bounds");
      }
      return {
        ...runtime,
        available: true,
        hardware: { maxBlocks, maxFreq, flags, raw: Array.isArray(caps.raw) ? caps.raw.map(Number) : undefined },
        effective: HSS_EFFECTIVE_LIMITS,
        observed: sanitizeObserved(observed),
      };
    } catch (error) {
      return {
        ...runtime,
        available: false,
        effective: HSS_EFFECTIVE_LIMITS,
        errorCode: error instanceof HssAdapterError ? error.code : "HSS_CAPABILITY_FAILED",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async observeTargetState(target: StoredTarget, runtime: HssRuntimeFacts): Promise<HssTargetState> {
    assertRuntimeIdentity(runtime);
    const observed = await runJson(runtime.helperPath, [
      "connect-preflight",
      "--dll", runtime.runtimePath,
      "--device", selectHssAttachDevice(target),
      "--interface", target.interface,
      "--serial", target.probeSerial,
      "--speed", String(target.speed),
      "--jlink-script-mode", "none",
    ], 30_000);
    if (observed.status !== "ok") {
      throw new HssAdapterError(String(observed.errorCode ?? "HSS_CONNECT_PREFLIGHT_FAILED"), String(observed.reason ?? "target state could not be observed through the HSS helper"), true, true);
    }
    assertNonIntrusiveConnectPreflight(observed);
    return hssTargetStateFromConnectPreflight(observed);
  }

  async restoreHaltedState(target: StoredTarget, runtime: HssRuntimeFacts): Promise<HssTargetState> {
    assertRuntimeIdentity(runtime);
    const observed = await runJson(runtime.helperPath, [
      "cpu-control",
      "--dll", runtime.runtimePath,
      "--dll-sha256", runtime.runtimeSha256,
      "--device", selectHssAttachDevice(target),
      "--interface", target.interface,
      "--serial", target.probeSerial,
      "--speed", String(target.speed),
      "--operation", "halt",
      "--jlink-script-mode", "none",
    ], 30_000);
    if (observed.status !== "ok" || observed.afterState !== "halted" || observed.haltIssued !== true) {
      throw new HssAdapterError(
        String(observed.errorCode ?? "HSS_TARGET_STATE_RESTORE_FAILED"),
        String(observed.reason ?? "HSS target state could not be restored to halted"),
        false,
        true,
      );
    }
    return "halted";
  }

  async qpcTimebase(runtime: HssRuntimeFacts): Promise<HssTimebase> {
    assertRuntimeIdentity(runtime);
    const value = await runJson(runtime.helperPath, ["qpc-timebase"], 10_000);
    if (value.status !== "ok" || !decimal(value.qpcCounter) || !decimal(value.qpcFrequency) || BigInt(String(value.qpcFrequency)) <= 0n) {
      throw new HssAdapterError("HSS_QPC_TIMEBASE_INVALID", "the helper returned an invalid QPC timebase");
    }
    return { qpcCounter: String(value.qpcCounter), qpcFrequency: String(value.qpcFrequency) };
  }

  async launchCapture(runtime: HssRuntimeFacts, control: HssCaptureControlFiles): Promise<HssCaptureLaunch> {
    assertRuntimeIdentity(runtime);
    const plan = readBoundedJson(control.planPath, 1024 * 1024, "HSS_PLAN_INVALID");
    const captureId = typeof plan.captureId === "string" ? plan.captureId : "";
    const helperNonce = typeof plan.helperInstanceNonce === "string" ? plan.helperInstanceNonce : "";
    const initialTargetState = plan.initialTargetState;
    const expectedTargetState = plan.expectedTargetState;
    const resumeBeforeStart = plan.resumeBeforeStart;
    if (plan.planFormatVersion !== 3
      || !UUID.test(captureId) || !UUID.test(helperNonce)
      || initialTargetState !== "halted" && initialTargetState !== "running"
      || expectedTargetState !== "running"
      || typeof resumeBeforeStart !== "boolean"
      || resumeBeforeStart !== (initialTargetState === "halted")) {
      throw new HssAdapterError("HSS_PLAN_INVALID", "the capture plan is missing its immutable identity or authorized initial/capture target-state transition");
    }
    mkdirSync(dirname(control.stdoutPath), { recursive: true });
    const stdout = openSync(control.stdoutPath, "ax");
    const stderr = openSync(control.stderrPath, "ax");
    try {
      const child = spawn(runtime.helperPath, ["hss-capture", "--plan", control.planPath, "--jlink-script-mode", "none"], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdout, stderr],
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        const onSpawn = () => { child.off("error", onError); resolveSpawn(); };
        const onError = (error: Error) => { child.off("spawn", onSpawn); rejectSpawn(error); };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      if (!child.pid) throw new HssAdapterError("HSS_HELPER_START_FAILED", "the native helper did not provide a process ID", true);
      child.on("error", () => undefined);
      child.unref();
      return { pid: child.pid, launchedAt: new Date().toISOString(), captureId, helperNonce, initialTargetState, expectedTargetState, resumeBeforeStart };
    } catch (error) {
      if (error instanceof HssAdapterError) throw error;
      throw new HssAdapterError("HSS_HELPER_START_FAILED", error instanceof Error ? error.message : String(error), true);
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
  }

  async waitUntilReady(control: HssCaptureControlFiles, launch: HssCaptureLaunch, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(control.readyFile)) {
        const ready = readBoundedJson(control.readyFile, 16 * 1024, "HSS_READY_INVALID");
        if (ready.status !== "ready" || ready.pid !== launch.pid || ready.captureId !== launch.captureId || ready.helperNonce !== launch.helperNonce
          || typeof ready.qpcCounter !== "string" || !/^\d+$/.test(ready.qpcCounter)
          || !Number.isSafeInteger(ready.heartbeatSequence) || Number(ready.heartbeatSequence) < 0
          || ready.initialTargetState !== launch.initialTargetState
          || ready.expectedTargetState !== launch.expectedTargetState
          || ready.resumeIssued !== launch.resumeBeforeStart
          || ready.targetState !== launch.expectedTargetState) {
          throw new HssAdapterError("HSS_READY_INVALID", "the Helper ready journal does not match the launched process", false, true);
        }
        return;
      }
      if (!this.isAlive(launch.pid)) throw new HssAdapterError("HSS_HELPER_EXITED_BEFORE_READY", "the HSS Helper exited before publishing readiness", false, true);
      await delay(10);
    }
    throw new HssAdapterError("HSS_HELPER_READY_TIMEOUT", "the HSS Helper did not publish readiness before the startup timeout", true, true);
  }

  async requestMemory(control: HssCaptureControlFiles, request: HssMemoryRequest, timeoutMs = 10_000): Promise<HssMemoryResponse> {
    if (!UUID.test(request.captureId)) throw new HssAdapterError("HSS_MEMORY_REQUEST_INVALID", "capture-owner memory request requires a valid captureId");
    validateMemoryRequestContext(request);
    const reconciled = reconcileMemoryTransaction(control);
    if (reconciled) {
      throw new HssAdapterError(
        "HSS_MEMORY_LATE_RESPONSE_RECONCILED",
        `the previous timed-out ${reconciled.request.op} request completed late; its durable transaction must be recorded before another memory operation`,
        true,
        targetEffectIssued(reconciled),
        false,
      );
    }
    const unrelated = readMemoryTransactions(control).find((transaction) => transaction.request.operationId !== request.operationId);
    if (unrelated) throw new HssAdapterError("HSS_MEMORY_RECOVERY_REQUIRED", "a durable capture-owner transaction must be recorded before another operation", true, true, false);
    if (existsSync(control.requestFile) || existsSync(control.claimFile) || existsSync(control.responseFile)) throw new HssAdapterError("HSS_MEMORY_REQUEST_BUSY", "another capture-owner memory request is pending", true, request.op === "write");
    const requestId = randomUUID();
    const temporary = `${control.requestFile}.${process.pid}.${requestId}.tmp`;
    const body = { formatVersion: 1, requestId, createdAt: new Date().toISOString(), ...request };
    try {
      writeFileSync(temporary, JSON.stringify(body), { encoding: "utf8", flag: "wx" });
      renameSync(temporary, control.requestFile);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new HssAdapterError("HSS_MEMORY_REQUEST_FAILED", error instanceof Error ? error.message : String(error), true);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(control.responseFile)) {
        let parsed: HssMemoryResponse;
        try {
          parsed = readBoundedJson(control.responseFile, 1024 * 1024, "HSS_MEMORY_RESPONSE_INVALID") as unknown as HssMemoryResponse;
        } catch (error) {
          throw new HssAdapterError("HSS_MEMORY_RESPONSE_INVALID", error instanceof Error ? error.message : String(error), false, true, true);
        }
        if (parsed.requestId !== requestId || !["ok", "error"].includes(parsed.status)) throw new HssAdapterError("HSS_MEMORY_RESPONSE_INVALID", "capture-owner response does not match the request", false, true, true);
        const claimed = readBoundedJson(control.claimFile, 1024 * 1024, "HSS_MEMORY_CLAIM_INVALID");
        const journal = memoryRequestJournal(claimed);
        if (!journal || journal.requestId !== requestId || journal.captureId !== request.captureId || journal.op !== request.op) throw new HssAdapterError("HSS_MEMORY_CLAIM_INVALID", "the Helper response is not bound to the claimed request", false, true, true);
        if (journal.op === "write" || journal.op === "resume") persistMemoryTransaction(control, journal, parsed);
        try {
          rmSync(control.responseFile);
          rmSync(control.claimFile);
          rmSync(control.requestFile, { force: true });
        } catch (error) {
          throw new HssAdapterError("HSS_MEMORY_ACK_CLEANUP_FAILED", error instanceof Error ? error.message : String(error), true, request.op === "write" || request.op === "resume", true);
        }
        return parsed;
      }
      await delay(10);
    }
    throw new HssAdapterError("HSS_MEMORY_REQUEST_TIMEOUT", "capture-owner request timed out", true, true, request.op === "write" || request.op === "resume");
  }

  listMemoryTransactions(control: HssCaptureControlFiles): HssMemoryTransaction[] {
    reconcileMemoryTransaction(control);
    return readMemoryTransactions(control);
  }

  acknowledgeMemoryTransactions(control: HssCaptureControlFiles, requestIds: readonly string[]): void {
    for (const requestId of requestIds) {
      if (!UUID.test(requestId)) throw new HssAdapterError("HSS_MEMORY_ACK_INVALID", "memory transaction acknowledgement requires UUID requestIds");
      try { rmSync(memoryReceiptPath(control, requestId), { force: true }); }
      catch (error) { throw new HssAdapterError("HSS_MEMORY_ACK_CLEANUP_FAILED", error instanceof Error ? error.message : String(error), true, true, false); }
    }
  }

  async requestStop(control: HssCaptureControlFiles): Promise<void> {
    if (existsSync(control.stopFile)) return;
    try { writeFileSync(control.stopFile, "stop\n", { encoding: "utf8", flag: "wx" }); }
    catch (error) { throw new HssAdapterError("HSS_STOP_REQUEST_FAILED", error instanceof Error ? error.message : String(error), true); }
  }

  terminate(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid < 1) return;
    try { process.kill(pid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new HssAdapterError("HSS_HELPER_TERMINATE_FAILED", error instanceof Error ? error.message : String(error), true, true);
    }
  }

  isAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  }

  isCaptureAlive(control: HssCaptureControlFiles, pid: number, captureId: string, helperNonce: string): boolean {
    if (!this.isAlive(pid)) return false;
    try {
      return Boolean(readCaptureHeartbeat(control, pid, captureId, helperNonce));
    } catch {
      return false;
    }
  }

  async confirmCaptureAlive(control: HssCaptureControlFiles, pid: number, captureId: string, helperNonce: string, timeoutMs = 2_500): Promise<boolean> {
    if (!this.isAlive(pid)) return false;
    let first: HssCaptureHeartbeat | undefined;
    try { first = readCaptureHeartbeat(control, pid, captureId, helperNonce); }
    catch { return false; }
    if (!first) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      if (!this.isAlive(pid)) return false;
      try {
        const current = readCaptureHeartbeat(control, pid, captureId, helperNonce);
        if (current && current.sequence > first.sequence && current.qpcCounter > first.qpcCounter) return true;
      } catch { return false; }
    }
    return false;
  }

  readRecords(control: HssCaptureControlFiles): Array<Record<string, unknown>> {
    if (!existsSync(control.stdoutPath)) return [];
    const bytes = readFileSync(control.stdoutPath, "utf8");
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new HssAdapterError("HSS_HELPER_LOG_LIMIT", "helper stdout exceeded 16 MiB");
    const records: Array<Record<string, unknown>> = [];
    for (const line of bytes.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value)) records.push(value as Record<string, unknown>);
      } catch {
        records.push({ record: "diagnostic", status: "error", errorCode: "HSS_HELPER_OUTPUT_INVALID", reason: line.slice(0, 512) });
      }
    }
    return records;
  }

  private findHelper(): string | undefined {
    return findPinnedHssHelperPath(this.helperOverride);
  }
}

function reconcileMemoryTransaction(control: HssCaptureControlFiles): HssMemoryTransaction | undefined {
  const response = existsSync(control.responseFile)
    ? readBoundedJson(control.responseFile, 1024 * 1024, "HSS_MEMORY_RESPONSE_INVALID") as HssMemoryResponse
    : undefined;
  const claimed = existsSync(control.claimFile)
    ? readBoundedJson(control.claimFile, 1024 * 1024, "HSS_MEMORY_CLAIM_INVALID")
    : undefined;
  if (!response) {
    if (claimed) {
      const journal = memoryRequestJournal(claimed);
      if (!journal) {
        throw new HssAdapterError("HSS_MEMORY_CLAIM_INVALID", "the claimed request journal is malformed", false, true);
      }
      throw new HssAdapterError("HSS_MEMORY_REQUEST_INDETERMINATE", "the Helper claimed the prior request but no durable response exists", true, memoryOperationMayAffectTarget(journal.op), false);
    }
    if (existsSync(control.requestFile)) {
      const pending = readBoundedJson(control.requestFile, 1024 * 1024, "HSS_MEMORY_REQUEST_INVALID");
      const journal = memoryRequestJournal(pending);
      if (!journal) {
        throw new HssAdapterError("HSS_MEMORY_REQUEST_INVALID", "the pending request journal is malformed", false, true);
      }
      throw new HssAdapterError("HSS_MEMORY_REQUEST_PENDING", "the previous request is published but not yet claimed", true, journal.op === "write", false);
    }
    return undefined;
  }
  const journal = claimed ? memoryRequestJournal(claimed) : undefined;
  if (!journal || typeof response.requestId !== "string" || !UUID.test(response.requestId) || !["ok", "error"].includes(response.status)
    || journal.requestId !== response.requestId) {
    throw new HssAdapterError("HSS_MEMORY_RESPONSE_INVALID", "the late response is not bound to its claimed request", false, true);
  }
  const transaction = memoryOperationMayAffectTarget(journal.op) ? persistMemoryTransaction(control, journal, response) : {
    formatVersion: 1 as const,
    request: journal,
    response,
    receivedAt: new Date().toISOString(),
  };
  try {
    rmSync(control.responseFile);
    rmSync(control.claimFile);
    rmSync(control.requestFile, { force: true });
  } catch (error) {
    throw new HssAdapterError("HSS_MEMORY_ACK_CLEANUP_FAILED", error instanceof Error ? error.message : String(error), true, memoryOperationMayAffectTarget(journal.op), false);
  }
  return transaction;
}

function validateMemoryRequestContext(request: HssMemoryRequest): void {
  if (request.operationId !== undefined && !UUID.test(request.operationId)) throw new HssAdapterError("HSS_MEMORY_REQUEST_INVALID", "capture-owner operationId must be a UUID");
  const context = request.eventContext;
  if (request.op === "resume") {
    if (!request.operationId || !context || context.kind !== "target_control"
      || !["resume", "continue"].includes(context.requestedAction) || context.canonicalAction !== "resume") {
      throw new HssAdapterError("HSS_MEMORY_REQUEST_INVALID", "capture-owner resume requires durable target-control context");
    }
    return;
  }
  if (request.op !== "write") return;
  if (!request.operationId || !context || context.kind === "target_control" || !context.logicalIdentity || context.logicalIdentity.length > 512
    || typeof context.requestedValue !== "number" || !Number.isFinite(context.requestedValue)
    || !["write", "restore"].includes(context.phase) || !["little", "big"].includes(context.endian)
    || typeof request.address !== "string" || !/^0x[0-9a-f]{1,8}$/i.test(request.address)
    || ![1, 2, 4].includes(Number(request.length)) || request.accessSize !== request.length
    || typeof request.bytesHex !== "string" || !new RegExp(`^[0-9a-fA-F]{${Number(request.length) * 2}}$`).test(request.bytesHex)) {
    throw new HssAdapterError("HSS_MEMORY_REQUEST_INVALID", "capture-owner writes require durable event context");
  }
}

function memoryRequestJournal(value: Record<string, unknown>): HssMemoryTransaction["request"] | undefined {
  const op = memoryOperation(value.op);
  if (value.formatVersion !== 1 || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.captureId !== "string" || !UUID.test(value.captureId) || !op) return undefined;
  const journal = value as unknown as HssMemoryTransaction["request"];
  try { validateMemoryRequestContext(journal); }
  catch { return undefined; }
  return journal;
}

function memoryReceiptDirectory(control: HssCaptureControlFiles): string {
  return join(dirname(control.responseFile), "memory-receipts");
}

function memoryReceiptPath(control: HssCaptureControlFiles, requestId: string): string {
  return join(memoryReceiptDirectory(control), `${requestId}.json`);
}

function persistMemoryTransaction(control: HssCaptureControlFiles, request: HssMemoryTransaction["request"], response: HssMemoryResponse): HssMemoryTransaction {
  const transaction: HssMemoryTransaction = { formatVersion: 1, request, response, receivedAt: new Date().toISOString() };
  const encoded = Buffer.from(JSON.stringify(transaction), "utf8");
  if (encoded.length < 2 || encoded.length > 1024 * 1024) throw new HssAdapterError("HSS_MEMORY_RECEIPT_LIMIT", "durable memory transaction receipt exceeds 1 MiB", false, true);
  const directory = memoryReceiptDirectory(control);
  mkdirSync(directory, { recursive: true });
  const destination = memoryReceiptPath(control, request.requestId);
  if (existsSync(destination)) {
    const existing = readBoundedJson(destination, 1024 * 1024, "HSS_MEMORY_RECEIPT_INVALID") as unknown as HssMemoryTransaction;
    if (JSON.stringify(existing.request) !== JSON.stringify(request) || JSON.stringify(existing.response) !== JSON.stringify(response)) {
      throw new HssAdapterError("HSS_MEMORY_RECEIPT_CONFLICT", "durable memory transaction conflicts with an existing receipt", false, true);
    }
    return existing;
  }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = openSync(temporary, "wx");
    try {
      writeFileSync(handle, encoded);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, destination);
    const persisted = openSync(destination, "r+");
    try { fsyncSync(persisted); }
    finally { closeSync(persisted); }
  }
  catch (error) {
    rmSync(temporary, { force: true });
    throw new HssAdapterError("HSS_MEMORY_RECEIPT_PERSIST_FAILED", error instanceof Error ? error.message : String(error), true, true);
  }
  return transaction;
}

function memoryOperationMayAffectTarget(operation: HssMemoryRequest["op"]): boolean {
  return operation === "write" || operation === "resume";
}

function targetEffectIssued(transaction: HssMemoryTransaction): boolean {
  return transaction.response.writeIssued === true || transaction.response.resumeIssued === true;
}

function readMemoryTransactions(control: HssCaptureControlFiles): HssMemoryTransaction[] {
  const directory = memoryReceiptDirectory(control);
  if (!existsSync(directory)) return [];
  const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (entries.length > 32) throw new HssAdapterError("HSS_MEMORY_RECEIPT_LIMIT", "durable capture-owner transaction count exceeds 32", false, true);
  return entries.map((entry) => {
    const value = readBoundedJson(join(directory, entry.name), 1024 * 1024, "HSS_MEMORY_RECEIPT_INVALID") as unknown as HssMemoryTransaction;
    const request = value && value.formatVersion === 1 && value.request && typeof value.request === "object" && !Array.isArray(value.request)
      ? memoryRequestJournal(value.request as unknown as Record<string, unknown>)
      : undefined;
    if (!request || !memoryOperationMayAffectTarget(request.op) || !value.response || value.response.requestId !== request.requestId
      || !["ok", "error"].includes(value.response.status) || typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt))
      || entry.name !== `${request.requestId}.json`) throw new HssAdapterError("HSS_MEMORY_RECEIPT_INVALID", "durable capture-owner transaction receipt is malformed", false, true);
    return { ...value, request };
  }).sort((left, right) => left.request.createdAt.localeCompare(right.request.createdAt) || left.request.requestId.localeCompare(right.request.requestId));
}

interface HssCaptureHeartbeat {
  sequence: number;
  qpcCounter: bigint;
}

function readCaptureHeartbeat(control: HssCaptureControlFiles, pid: number, captureId: string, helperNonce: string): HssCaptureHeartbeat | undefined {
  if (!UUID.test(captureId) || !UUID.test(helperNonce) || !existsSync(control.readyFile)) return undefined;
  const ready = readBoundedJson(control.readyFile, 16 * 1024, "HSS_READY_INVALID");
  const sequence = Number(ready.heartbeatSequence);
  const ageMs = Date.now() - statSync(control.readyFile).mtimeMs;
  if (ready.status !== "ready" || ready.pid !== pid || ready.captureId !== captureId || ready.helperNonce !== helperNonce
    || typeof ready.qpcCounter !== "string" || !/^\d+$/.test(ready.qpcCounter)
    || !Number.isSafeInteger(sequence) || sequence < 0 || ageMs < -1_000 || ageMs > 10_000) return undefined;
  return { sequence, qpcCounter: BigInt(ready.qpcCounter) };
}

function memoryOperation(value: unknown): HssMemoryRequest["op"] | undefined {
  return value === "read" || value === "write" || value === "resume" ? value : undefined;
}

function readBoundedJson(file: string, maxBytes: number, code: string): Record<string, unknown> {
  try {
    const size = statSync(file).size;
    if (size < 2 || size > maxBytes) throw new Error(`JSON file size ${size} is outside 2..${maxBytes}`);
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON root must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new HssAdapterError(code, error instanceof Error ? error.message : String(error), false, true);
  }
}

function assertRuntimeIdentity(runtime: HssRuntimeFacts): asserts runtime is HssRuntimeFacts & Required<Pick<HssRuntimeFacts, "helperPath" | "runtimePath" | "helperSha256" | "runtimeSha256">> {
  if (!runtime.available || !runtime.helperPath || !runtime.runtimePath || !runtime.helperSha256 || !runtime.runtimeSha256) throw new HssAdapterError(runtime.errorCode ?? "HSS_UNAVAILABLE", runtime.reason ?? "HSS runtime identity is unavailable");
  if (runtime.helperSha256 !== PINNED_HSS_HELPER_RELEASE.sha256) throw new HssAdapterError("HSS_HELPER_IDENTITY_MISMATCH", "the HSS helper does not match the pinned release identity");
  if (sha256File(runtime.helperPath) !== runtime.helperSha256 || sha256File(runtime.runtimePath) !== runtime.runtimeSha256) throw new HssAdapterError("HSS_RUNTIME_IDENTITY_CHANGED", "the helper or J-Link runtime changed after ABI inspection", true);
}

function findRuntime(target: StoredTarget): string | undefined {
  const bindings = [target.jlinkPath?.path, target.gdbServerPath?.path, target.gdbPath?.path].filter((value): value is string => Boolean(value));
  const candidates: string[] = [];
  for (const binding of bindings) {
    if (extname(binding).toLowerCase() === ".dll") candidates.push(binding);
    const root = dirname(binding);
    candidates.push(join(root, "JLink_x64.dll"), join(root, "JLinkARM.dll"));
  }
  return [...new Set(candidates.map((candidate) => resolve(candidate)))].find(regularFile);
}

function unavailable(
  errorCode: string,
  reason: string,
  helperPath?: string,
  runtimePath?: string,
  observed?: Record<string, unknown>,
): HssRuntimeFacts {
  return {
    backend: "jlink-hss",
    available: false,
    helperPath,
    runtimePath,
    architecture: process.arch,
    errorCode,
    reason,
    abi: observed ? sanitizeObserved(observed) : undefined,
  };
}

async function runJson(command: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectResult(error);
      else resolveResult(value!);
    };
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) {
        child.kill();
        finish(new HssAdapterError("HSS_HELPER_OUTPUT_LIMIT", "helper output exceeded 4 MiB"));
      }
    });
    child.stderr?.on("data", (data: Buffer) => { stderr = `${stderr}${data.toString("utf8")}`.slice(-64 * 1024); });
    child.once("error", (error) => finish(new HssAdapterError("HSS_HELPER_EXEC_FAILED", error.message, true)));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new HssAdapterError("HSS_HELPER_EXEC_FAILED", `helper exited ${String(code)}: ${stderr}`, true));
      try {
        const value = JSON.parse(stdout.trim());
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response is not an object");
        finish(undefined, value as Record<string, unknown>);
      } catch (error) {
        finish(new HssAdapterError("HSS_HELPER_OUTPUT_INVALID", error instanceof Error ? error.message : String(error)));
      }
    });
    const timeout = setTimeout(() => {
      child.kill();
      finish(new HssAdapterError("HSS_HELPER_TIMEOUT", "helper command timed out", true));
    }, timeoutMs);
    timeout.unref();
  });
}

function regularFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); }
  catch { return false; }
}

function sha256File(path: string): string {
  const info = statSync(path);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new HssAdapterError("HSS_RUNTIME_HASH_LIMIT", "HSS runtime identity file exceeds its hash bound");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function decimal(value: unknown): boolean {
  return typeof value === "string" && /^\d+$/.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sanitizeObserved(value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value);
  delete copy.dll;
  delete copy.execOutput;
  delete copy.jlinkScriptExecOutput;
  return copy;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
