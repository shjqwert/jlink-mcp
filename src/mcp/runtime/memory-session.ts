import { randomUUID, createHash } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import {
  ProbeBackend,
  ProbeErrorCode,
  type CommandResult,
  type GDBServerInfo,
  type TargetStateObservation,
} from "../../probe/backend";
import type { QueueMetadata, ProbeOwner } from "./probe-queue";
import { ProbeQueue } from "./probe-queue";
import type { StoredTarget } from "./target-store";

const SESSION_TIMEOUT_MS = 10_000;
const SESSION_IDLE_TIMEOUT_MS = 30_000;
const MAX_SESSION_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface PersistentMemorySession {
  readonly probe: ProbeBackend;
  readonly pid: number;
  readonly runtime: MemorySessionRuntimeFacts;
  isAlive(): boolean;
  isReusable(): boolean;
  close(): Promise<void>;
  onExit(listener: () => void): () => void;
}

export interface MemorySessionRuntimeFacts {
  helperPath: string;
  runtimePath: string;
  helperSha256: string;
  runtimeSha256: string;
}

export interface MemorySessionCloseResult {
  targetStateBeforeClose: "running" | "halted" | "unknown";
}

export interface MemorySessionLauncher {
  /**
   * `onStarted` must be called immediately after a native child has a PID.
   * If startup then fails, the implementation must either prove child exit or
   * reject with MemorySessionError.retainOwner=true for that PID.
   */
  open(target: StoredTarget, onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession | undefined>;
}

interface ActiveSession {
  target: Pick<StoredTarget, "projectRoot" | "probeSerial" | "generation">;
  owner: ProbeOwner;
  session: PersistentMemorySession;
}

/**
 * Holds one native J-Link connection for sequential memory operations. The
 * ProbeQueue owner remains live for the lifetime of the helper process, so
 * another GDB/HSS/direct connection cannot interleave with it.
 */
export class MemorySessionManager {
  private active?: ActiveSession;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private readonly queue: ProbeQueue,
    private readonly launcher: MemorySessionLauncher = new NativeMemorySessionLauncher(),
    private readonly idleTimeoutMs = SESSION_IDLE_TIMEOUT_MS,
  ) {}

  async probeFor(target: StoredTarget, metadata: QueueMetadata): Promise<ProbeBackend | undefined> {
    const current = this.active;
    if (current && sameTarget(current.target, target) && current.session.isAlive() && current.session.isReusable()) {
      this.localOwnerForTarget(target);
      this.scheduleIdle(current);
      return current.session.probe;
    }
    if (current && !sameTarget(current.target, target)) {
      throw new MemorySessionError("MEMORY_SESSION_ACTIVE", "another Target generation owns a local persistent memory session", true, false);
    }
    if (current) await this.closeActive(current);

    // Claim before spawning the helper: the native process will connect to the
    // physical Probe as part of startup, and must never race a second owner.
    let owner = this.queue.claimOwner(target.probeSerial, {
      kind: "memory",
      projectRoot: target.projectRoot,
      targetGeneration: target.generation,
      details: { backend: "native_memory_session" },
    }, metadata.leaseToken);
    let startupPid: number | undefined;
    try {
      const session = await this.launcher.open(target, (pid, runtime) => {
        startupPid = pid;
        owner = this.queue.updateOwnerResource(target.probeSerial, owner.token, pid, {
          ...owner.details,
          startup: "native_memory_session_starting",
          runtime: { helperSha256: runtime.helperSha256, runtimeSha256: runtime.runtimeSha256 },
        });
      });
      if (!session) {
        if (startupPid) {
          throw new MemorySessionError("MEMORY_SESSION_STARTUP_EXIT_UNCONFIRMED", "native memory helper started without a confirmed session result; Probe ownership remains fail-closed", true, true, true, startupPid);
        }
        this.queue.releaseOwner(target.probeSerial, owner.token);
        return undefined;
      }
      const active: ActiveSession = {
        target: { projectRoot: target.projectRoot, probeSerial: target.probeSerial, generation: target.generation },
        owner,
        session,
      };
      this.active = active;
      const unsubscribe = session.onExit(() => {
        unsubscribe();
        this.finalizeExited(active);
      });
      this.scheduleIdle(active);
      return session.probe;
    } catch (error) {
      if (error instanceof MemorySessionError && error.retainOwner && error.resourcePid) {
        try {
          this.queue.updateOwnerResource(target.probeSerial, owner.token, error.resourcePid, {
            ...owner.details,
            cleanup: "native_memory_session_exit_unconfirmed",
          });
        } catch { /* preserve the original fail-closed startup error */ }
        throw error;
      }
      if (error instanceof MemorySessionError && startupPid && error.resourcePid === startupPid) {
        try { this.queue.releaseOwner(target.probeSerial, owner.token); } catch { /* process exit was already confirmed by the launcher */ }
        throw error;
      }
      if (startupPid) {
        try {
          this.queue.updateOwnerResource(target.probeSerial, owner.token, startupPid, {
            ...owner.details,
            cleanup: "native_memory_session_exit_unconfirmed",
          });
        } catch { /* an already-persisted owner remains a fail-closed gate */ }
        throw new MemorySessionError("MEMORY_SESSION_STARTUP_EXIT_UNCONFIRMED", "native memory helper startup did not prove process exit; Probe ownership remains fail-closed", true, true, true, startupPid);
      }
      try { this.queue.releaseOwner(target.probeSerial, owner.token); } catch { /* preserve startup error */ }
      throw error;
    }
  }

  /** Returns a matching owner only when this MCP can close the session safely. */
  localOwnerForTarget(target: Pick<StoredTarget, "projectRoot" | "probeSerial" | "generation">): ProbeOwner | undefined {
    const active = this.active;
    if (!active || !sameTarget(active.target, target)) return undefined;
    const owner = this.queue.getOwner(target.probeSerial);
    if (!owner
      || owner.kind !== "memory"
      || owner.token !== active.owner.token
      || owner.pid !== active.owner.pid
      || owner.processInstanceId !== active.owner.processInstanceId
      || owner.projectRoot !== target.projectRoot
      || owner.targetGeneration !== target.generation) {
      throw new MemorySessionError("MEMORY_SESSION_ACTIVE", "local persistent memory session ownership cannot be verified; Probe access remains blocked", true, true);
    }
    return owner;
  }

  async closeForTarget(target: Pick<StoredTarget, "projectRoot" | "probeSerial" | "generation">): Promise<MemorySessionCloseResult | undefined> {
    const active = this.active;
    if (!active || !sameTarget(active.target, target)) return undefined;
    this.localOwnerForTarget(target);
    let targetStateBeforeClose: MemorySessionCloseResult["targetStateBeforeClose"] = "unknown";
    try { targetStateBeforeClose = (await active.session.probe.observeTargetState()).state; }
    catch { /* close remains fail-closed if its state cannot be proven */ }
    await this.closeActive(active);
    return { targetStateBeforeClose };
  }

  async dispose(): Promise<void> {
    if (this.active) await this.closeActive(this.active);
  }

  private async closeActive(active: ActiveSession): Promise<void> {
    if (this.active !== active) return;
    this.clearIdle();
    await active.session.close();
    this.finalizeExited(active);
  }

  private finalizeExited(active: ActiveSession): void {
    if (this.active !== active) return;
    this.clearIdle();
    this.active = undefined;
    try { this.queue.releaseOwner(active.target.probeSerial, active.owner.token); } catch { /* owner may already be replaced */ }
  }

  private scheduleIdle(active: ActiveSession): void {
    this.clearIdle();
    if (this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      void this.queue.runExclusive(active.target.probeSerial, async () => {
        if (this.active === active) await this.closeActive(active);
      }, {
        allowedOwnerKinds: ["memory"],
        ownerTarget: { projectRoot: active.target.projectRoot, targetGeneration: active.target.generation },
      }).catch(() => undefined);
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

export function persistentMemorySessionEvidence(probe: ProbeBackend): Record<string, unknown> | undefined {
  return probe instanceof NativeMemorySessionProbe ? probe.evidence : undefined;
}

class NativeMemorySessionLauncher implements MemorySessionLauncher {
  async open(target: StoredTarget, onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<PersistentMemorySession | undefined> {
    if (process.platform !== "win32") return undefined;
    const helperPath = findHelper();
    const runtimePath = findRuntime(target);
    if (!helperPath || !runtimePath) return undefined;
    let helperSha256: string;
    let runtimeSha256: string;
    try {
      helperSha256 = memorySessionHash(helperPath);
      runtimeSha256 = memorySessionHash(runtimePath);
    } catch {
      throw new MemorySessionError("MEMORY_SESSION_RUNTIME_UNAVAILABLE", "native memory-session runtime identity could not be established", true, true);
    }
    const runtime: MemorySessionRuntimeFacts = { helperPath, runtimePath, helperSha256, runtimeSha256 };
    return NativePersistentMemorySession.open(target, runtime, onStarted);
  }
}

class NativePersistentMemorySession implements PersistentMemorySession {
  readonly probe: ProbeBackend;
  readonly pid: number;
  private readonly pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; dispatched: boolean }>();
  private readonly exitListeners = new Set<() => void>();
  private stdout = "";
  private stderr = "";
  private ready?: { resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };
  private startupReady = false;
  private startupError?: Error;
  private closed = false;
  private poisoned = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly target: StoredTarget,
    readonly runtime: MemorySessionRuntimeFacts,
  ) {
    if (!child.pid) throw new MemorySessionError("MEMORY_SESSION_PID_MISSING", "native memory helper did not provide a process ID");
    this.pid = child.pid;
    this.probe = new NativeMemorySessionProbe(this);
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => { this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES); });
    child.once("error", () => this.failAll(new MemorySessionError("MEMORY_SESSION_EXEC_FAILED", "native memory helper could not be started", true, true)));
    child.once("close", (code) => {
      this.closed = true;
      this.failAll(new MemorySessionError("MEMORY_SESSION_EXITED", "native memory helper exited before the operation completed", true, true));
      for (const listener of this.exitListeners) listener();
      this.exitListeners.clear();
    });
  }

  static async open(target: StoredTarget, runtime: MemorySessionRuntimeFacts, onStarted?: (pid: number, runtime: MemorySessionRuntimeFacts) => void): Promise<NativePersistentMemorySession> {
    const child = spawn(runtime.helperPath, [
      "memory-session",
      "--dll", runtime.runtimePath,
      "--device", target.device,
      "--interface", target.interface,
      "--serial", target.probeSerial,
      "--speed", String(target.speed),
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const session = new NativePersistentMemorySession(child, target, runtime);
    try {
      onStarted?.(session.pid, runtime);
      await session.activate();
      await session.waitUntilReady();
    } catch (error) {
      await session.abortStartup(error);
      if (error instanceof MemorySessionError) {
        throw new MemorySessionError(error.code, error.message, error.retryable, error.stateUnknown, false, session.pid);
      }
      throw new MemorySessionError("MEMORY_SESSION_START_FAILED", "native memory helper startup failed after process exit was confirmed", true, true, false, session.pid);
    }
    return session;
  }

  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && this.child.signalCode === null;
  }

  isReusable(): boolean {
    return this.isAlive() && !this.poisoned;
  }

  private async activate(): Promise<void> {
    if (!this.isAlive()) throw new MemorySessionError("MEMORY_SESSION_START_FAILED", "native memory helper exited before activation", true, true);
    await new Promise<void>((resolveActivation, rejectActivation) => {
      this.child.stdin.write("{\"op\":\"activate\"}\n", "utf8", (error) => {
        if (error) {
          rejectActivation(new MemorySessionError("MEMORY_SESSION_ACTIVATION_FAILED", "native memory helper could not receive its activation gate", true, true));
          return;
        }
        resolveActivation();
      });
    });
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async request(body: Record<string, unknown>, timeoutMs = SESSION_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (!this.isReusable()) throw new MemorySessionError("MEMORY_SESSION_UNAVAILABLE", "native memory session is not available for another request", true, true);
    try { assertRuntimeIdentity(this.runtime); }
    catch (error) {
      this.poison(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    const id = randomUUID();
    const payload = `${JSON.stringify({ id, ...body })}\n`;
    if (Buffer.byteLength(payload, "utf8") > MAX_SESSION_LINE_BYTES) throw new MemorySessionError("MEMORY_SESSION_REQUEST_LIMIT", "memory-session request exceeds its 1 MiB bound");
    return new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = new MemorySessionError("MEMORY_SESSION_TIMEOUT", "native memory session did not respond before its timeout", true, true, false, undefined, pending.dispatched);
        this.poison(error);
        rejectRequest(error);
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout, dispatched: false });
      try {
        const pending = this.pending.get(id)!;
        // Handing bytes to the child pipe makes the hardware outcome uncertain,
        // even if the local stream later reports an error or timeout.
        this.child.stdin.write(payload, "utf8", (error) => {
          if (!error) return;
          const current = this.pending.get(id);
          if (!current) return;
          clearTimeout(current.timeout);
          this.pending.delete(id);
          const sessionError = new MemorySessionError("MEMORY_SESSION_WRITE_FAILED", "native memory helper could not accept the request", true, true, false, undefined, current.dispatched);
          this.poison(sessionError);
          current.reject(sessionError);
        });
        pending.dispatched = true;
      } catch {
        const current = this.pending.get(id);
        if (!current) return;
        clearTimeout(current.timeout);
        this.pending.delete(id);
        const sessionError = new MemorySessionError("MEMORY_SESSION_WRITE_FAILED", "native memory helper could not accept the request", true, true, false, undefined, current.dispatched);
        this.poison(sessionError);
        current.reject(sessionError);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    let requestError: unknown;
    if (!this.poisoned) {
      try { await this.request({ op: "close" }, 3_000); }
      catch (error) { requestError = error; }
    }
    this.poison(requestError instanceof Error ? requestError : undefined);
    const exited = await this.terminateAndWait();
    if (!exited) throw new MemorySessionError("MEMORY_SESSION_CLOSE_UNCONFIRMED", "native memory helper did not exit after close; Probe ownership remains fail-closed", true, true, true, this.pid);
    if (requestError) throw requestError;
  }

  private async waitUntilReady(): Promise<void> {
    if (this.startupReady) return;
    if (this.startupError) throw this.startupError;
    if (this.closed) throw new MemorySessionError("MEMORY_SESSION_START_FAILED", "native memory helper exited before readiness", true, true);
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        this.ready = undefined;
        const error = new MemorySessionError("MEMORY_SESSION_READY_TIMEOUT", "native memory helper did not report readiness", true, true);
        this.poison(error);
        rejectReady(error);
      }, SESSION_TIMEOUT_MS);
      timeout.unref();
      this.ready = { resolve: resolveReady, reject: rejectReady, timeout };
    });
  }

  private consumeStdout(chunk: Buffer): void {
    this.stdout = `${this.stdout}${chunk.toString("utf8")}`;
    if (Buffer.byteLength(this.stdout, "utf8") > MAX_SESSION_LINE_BYTES * 2) {
      this.poison(new MemorySessionError("MEMORY_SESSION_OUTPUT_LIMIT", "native memory helper output exceeded its bound", false, true));
      return;
    }
    for (;;) {
      const newline = this.stdout.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_SESSION_LINE_BYTES) {
        this.poison(new MemorySessionError("MEMORY_SESSION_OUTPUT_LIMIT", "native memory helper response exceeds its 1 MiB bound", false, true));
        return;
      }
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("response is not an object");
        value = parsed as Record<string, unknown>;
      } catch (error) {
        this.poison(new MemorySessionError("MEMORY_SESSION_OUTPUT_INVALID", "native memory helper returned malformed protocol output", false, true));
        return;
      }
      if (value.status === "ready") {
        if (value.command !== "memory-session" || !Number.isSafeInteger(value.probeSerial) || String(value.probeSerial) !== this.target.probeSerial
          || value.device !== this.target.device || value.interface !== this.target.interface || value.speedKhz !== this.target.speed
          || !["running", "halted"].includes(String(value.targetState)) || value.memoryCacheDisabled !== true) {
          this.poison(new MemorySessionError("MEMORY_SESSION_READY_INVALID", "native memory helper readiness does not match the configured target", false, true));
          return;
        }
        this.startupReady = true;
        if (!this.ready) continue;
        clearTimeout(this.ready.timeout);
        const ready = this.ready;
        this.ready = undefined;
        ready.resolve();
        continue;
      }
      if (this.ready && value.status === "error") {
        clearTimeout(this.ready.timeout);
        const ready = this.ready;
        this.ready = undefined;
        const error = new MemorySessionError(String(value.errorCode ?? "MEMORY_SESSION_START_FAILED"), String(value.reason ?? "native memory helper startup failed"), true, value.stateUnknown === true);
        this.startupError = error;
        ready.reject(error);
        continue;
      }
      if (!this.ready && value.status === "error") {
        this.startupError = new MemorySessionError(String(value.errorCode ?? "MEMORY_SESSION_START_FAILED"), String(value.reason ?? "native memory helper startup failed"), true, value.stateUnknown === true);
        continue;
      }
      const id = typeof value.id === "string" ? value.id : "";
      const pending = this.pending.get(id);
      if (!pending) {
        this.poison(new MemorySessionError("MEMORY_SESSION_RESPONSE_UNBOUND", "native memory helper returned an unbound response", false, true));
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.resolve(value);
    }
  }

  private failAll(error: Error): void {
    if (!this.startupReady) this.startupError = error;
    if (this.ready) {
      clearTimeout(this.ready.timeout);
      this.ready.reject(error);
      this.ready = undefined;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(withDispatchFact(error, pending.dispatched));
    }
    this.pending.clear();
  }

  private poison(error?: Error): void {
    if (this.poisoned) return;
    this.poisoned = true;
    if (error) this.failAll(error);
    try { this.child.stdin.end(); } catch { /* process may already be closing */ }
    try { this.child.kill(); } catch { /* close confirmation remains fail-closed */ }
  }

  private async abortStartup(error: unknown): Promise<void> {
    this.poison(error instanceof Error ? error : new Error(String(error)));
    if (await this.terminateAndWait()) return;
    throw new MemorySessionError("MEMORY_SESSION_STARTUP_EXIT_UNCONFIRMED", "native memory helper startup could not be terminated; Probe ownership remains fail-closed", true, true, true, this.pid);
  }

  private async terminateAndWait(): Promise<boolean> {
    try { this.child.stdin.end(); } catch { /* process may already be closing */ }
    try { if (this.isAlive()) this.child.kill(); } catch { /* confirmation below decides release */ }
    if (await waitForExit(this.child, 3_000)) return true;
    try { if (this.isAlive()) this.child.kill(); } catch { /* confirmation below decides release */ }
    return waitForExit(this.child, 3_000);
  }
}

class NativeMemorySessionProbe extends ProbeBackend {
  readonly type = "jlink" as const;
  readonly displayName = "native-persistent-memory-session";

  constructor(private readonly session: NativePersistentMemorySession) { super(); }

  get evidence(): Record<string, unknown> {
    return {
      backend: "native_memory_session",
      connection: "persistent_native",
      helperPid: this.session.pid,
      runtime: {
        helperSha256: this.session.runtime.helperSha256,
        runtimeSha256: this.session.runtime.runtimeSha256,
      },
    };
  }

  async observeTargetState(): Promise<TargetStateObservation> {
    try {
      const response = await this.session.request({ op: "state" });
      const result = sessionCommand(response, false);
      const state = responseState(response, "targetStateAfter");
      return { state, source: state === "unknown" ? "unavailable" : "dhcsr", result };
    } catch (error) {
      return { state: "unknown", source: "unavailable", result: sessionException(error, false) };
    }
  }

  async readMemory(address: number, length: number, accessSize: 1 | 2 | 4 = 1): Promise<CommandResult> {
    try {
      const response = await this.session.request({ op: "read", address: hex32(address), size: length, accessSize });
      return sessionCommand(response, false, address, length);
    } catch (error) {
      return sessionException(error, false);
    }
  }

  async writeMemory(_address: number, _value: number): Promise<CommandResult> {
    return unsupported("writeMemory requires explicit byte width");
  }

  override async writeMemoryBytes(address: number, bytes: Buffer, accessSize: 1 | 2 | 4): Promise<CommandResult> {
    try {
      const response = await this.session.request({ op: "write", address: hex32(address), size: bytes.length, accessSize, bytesHex: bytes.toString("hex") });
      return sessionCommand(response, true);
    } catch (error) {
      return sessionException(error, true);
    }
  }

  async getDeviceInfo(): Promise<CommandResult> { return unsupported("memory session does not expose device info"); }
  async halt(): Promise<CommandResult> { return unsupported("memory session must not halt the target"); }
  async resume(): Promise<CommandResult> { return unsupported("memory session must not resume the target"); }
  async reset(): Promise<CommandResult> { return unsupported("memory session must not reset the target"); }
  async step(): Promise<CommandResult> { return unsupported("memory session does not step the target"); }
  async readAllRegisters(): Promise<CommandResult> { return unsupported("memory session does not read core registers"); }
  async readRegister(): Promise<CommandResult> { return unsupported("memory session does not read core registers"); }
  async flash(): Promise<CommandResult> { return unsupported("memory session does not flash the target"); }
  async erase(): Promise<CommandResult> { return unsupported("memory session does not erase the target"); }
  async setBreakpoint(): Promise<CommandResult> { return unsupported("memory session does not set breakpoints"); }
  async clearBreakpoints(): Promise<CommandResult> { return unsupported("memory session does not clear breakpoints"); }
  async startGDBServer(): Promise<{ success: boolean; message: string }> { return { success: false, message: "memory session owns the Probe" }; }
  async stopGDBServer(): Promise<{ success: boolean; message: string }> { return { success: false, message: "memory session owns the Probe" }; }
  isGDBServerRunning(): boolean { return false; }
  getGDBServerStatus(): GDBServerInfo { return { running: false, gdbPort: 0, rttTelnetPort: 0 }; }
  getGDBServerOutput(): string[] { return []; }
  async executeRaw(): Promise<CommandResult> { return unsupported("memory session does not execute raw commands"); }
  isDeviceConfigured(): boolean { return true; }
  getDeviceName(): string { return "persistent-memory-session"; }
  setDevice(): void { /* target binding is immutable for this session */ }
  async listDevices(): Promise<CommandResult> { return unsupported("memory session does not enumerate devices"); }
  dispose(): void { void this.session.close().catch(() => undefined); }
}

export class MemorySessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly stateUnknown = false,
    readonly retainOwner = false,
    readonly resourcePid?: number,
    readonly dispatched = false,
  ) {
    super(message);
    this.name = "MemorySessionError";
  }
}

function sessionCommand(response: Record<string, unknown>, write: boolean, address?: number, length?: number): CommandResult {
  const success = response.status === "ok";
  const stateUnknown = response.stateUnknown === true || responseState(response, "targetStateAfter") === "unknown";
  const rawOutput = success && address !== undefined && length !== undefined && typeof response.bytesHex === "string"
    ? memoryDump(address, response.bytesHex, length)
    : JSON.stringify(response);
  return {
    success,
    rawOutput,
    output: rawOutput,
    error: success ? undefined : String(response.reason ?? "native memory session command failed"),
    errorCode: success ? undefined : probeErrorCode(String(response.errorCode ?? "")),
    writeIssued: write ? response.writeIssued === true : undefined,
    stateUnknown,
  };
}

function sessionException(error: unknown, write: boolean): CommandResult {
  const sessionError = error instanceof MemorySessionError ? error : undefined;
  const writeIssued = write && sessionError?.dispatched === true;
  return {
    success: false,
    rawOutput: "",
    output: "",
    error: sessionError?.message ?? "native memory session command failed",
    errorCode: probeErrorCode(sessionError?.code ?? ""),
    writeIssued,
    stateUnknown: sessionError?.stateUnknown ?? writeIssued,
  };
}

function withDispatchFact(error: Error, dispatched: boolean): Error {
  if (!dispatched || !(error instanceof MemorySessionError) || error.dispatched) return error;
  return new MemorySessionError(error.code, error.message, error.retryable, error.stateUnknown, error.retainOwner, error.resourcePid, true);
}

function responseState(response: Record<string, unknown>, key: "targetStateBefore" | "targetStateAfter"): "running" | "halted" | "unknown" {
  const state = response[key];
  return state === "running" || state === "halted" ? state : "unknown";
}

function probeErrorCode(code: string): ProbeErrorCode {
  if (/IDENTITY|SERIAL/.test(code)) return ProbeErrorCode.PROBE_IDENTITY_MISMATCH;
  if (/BUSY|SESSION/.test(code)) return ProbeErrorCode.PROBE_BUSY;
  if (/STATE|CONNECT|OPEN|READ|WRITE/.test(code)) return ProbeErrorCode.TARGET_UNREACHABLE;
  return ProbeErrorCode.INVALID_ARGUMENT;
}

function unsupported(message: string): CommandResult {
  return { success: false, rawOutput: "", output: "", error: message, errorCode: ProbeErrorCode.INVALID_ARGUMENT };
}

function memoryDump(address: number, bytesHex: string, length: number): string {
  if (!/^[0-9a-f]*$/i.test(bytesHex) || bytesHex.length !== length * 2) return "";
  const bytes = bytesHex.match(/../g)?.join(" ") ?? "";
  return `${address.toString(16).padStart(8, "0")} = ${bytes}`;
}

function sameTarget(left: Pick<StoredTarget, "projectRoot" | "probeSerial" | "generation">, right: Pick<StoredTarget, "projectRoot" | "probeSerial" | "generation">): boolean {
  return left.projectRoot === right.projectRoot && left.probeSerial === right.probeSerial && left.generation === right.generation;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolveExit(false);
    }, timeoutMs);
    timeout.unref();
    const onClose = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("close", onClose);
  });
}

function findHelper(): string | undefined {
  const candidates = [
    resolve(process.cwd(), "native", "hss-helper", "bin", "hss_helper.exe"),
    resolve(__dirname, "..", "..", "native", "hss-helper", "bin", "hss_helper.exe"),
    resolve(__dirname, "..", "..", "..", "native", "hss-helper", "bin", "hss_helper.exe"),
  ];
  return candidates.find(regularFile);
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

function assertRuntimeIdentity(runtime: MemorySessionRuntimeFacts): void {
  if (memorySessionHash(runtime.helperPath) !== runtime.helperSha256 || memorySessionHash(runtime.runtimePath) !== runtime.runtimeSha256) {
    throw new MemorySessionError("MEMORY_SESSION_RUNTIME_IDENTITY_CHANGED", "the native helper or J-Link runtime changed while the memory session was active", true, true);
  }
}

function memorySessionHash(path: string): string {
  try { return sha256File(path); }
  catch (error) {
    if (error instanceof MemorySessionError) throw error;
    throw new MemorySessionError("MEMORY_SESSION_RUNTIME_UNAVAILABLE", "native memory-session runtime identity could not be verified", true, true);
  }
}

function sha256File(path: string): string {
  const info = statSync(path);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new MemorySessionError("MEMORY_SESSION_RUNTIME_HASH_LIMIT", "native memory-session runtime identity file exceeds its hash bound");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function regularFile(path: string): boolean {
  try { return existsSync(path) && statSync(path).isFile(); }
  catch { return false; }
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}
