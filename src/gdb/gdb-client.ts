import { ChildProcess, spawn, type SpawnOptions } from "child_process";
import { log, logError } from "../utils/logger";
import { childProcessAlive, terminateChildProcess } from "../utils/process-manager";

export interface GDBResponse {
  success: boolean;
  output: string;
  /** Exact GDB/MI exchange retained for Agent diagnosis. */
  rawOutput?: string;
  /** If the target stopped, why (breakpoint, signal, exit, etc.) */
  stopReason?: string;
  error?: string;
  code?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  exitError?: string;
  /** Target state explicitly reported by this GDB/MI exchange. */
  observedTargetExecutionState?: GDBTargetExecutionState;
}

export type GDBTargetExecutionState = "running" | "halted" | "unknown";

export interface GDBUnexpectedExit {
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exitError?: string;
}

interface GDBCommandExchange {
  output: string;
  timedOut: boolean;
  processExited: boolean;
}

export type GdbSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/**
 * Persistent GDB client that connects to a running GDB server.
 * Maintains a long-lived arm-none-eabi-gdb process and sends commands
 * via stdin, reading responses from stdout.
 *
 * This bridges the gap between GDB's interactive model and MCP's
 * request/response model. Each command blocks until GDB produces
 * a complete response or times out.
 */
export class GDBClient {
  private proc: ChildProcess | null = null;
  private gdbPath: string;
  private connected = false;
  private outputBuffer = "";
  private pendingResolve: ((response: string, processExited: boolean) => void) | null = null;
  private pendingRequiresPrompt = false;
  private stopEvent: string | null = null;
  private history: string[] = [];
  private maxHistory = 200;
  /** Minimum delay between commands to avoid overwhelming slow adapters */
  private lastCommandTime = 0;
  private commandThrottleMs = 50;
  private hardwareGuard?: () => string | null;
  private connectionGeneration = 0;
  private loadedSymbolFile: string | null = null;
  private connectedEndpoint: string | null = null;
  private targetExecutionState: GDBTargetExecutionState = "unknown";
  private lastExit: { code: number | null; signal: NodeJS.Signals | null; error?: string } | undefined;
  private readonly spawnProcess: GdbSpawn;
  private readonly unexpectedExitListeners = new Set<(event: GDBUnexpectedExit) => void>();
  private readonly unexpectedExitNotified = new WeakSet<ChildProcess>();

  constructor(gdbPath: string = "arm-none-eabi-gdb", hardwareGuard?: () => string | null, spawnProcess: GdbSpawn = spawn) {
    this.gdbPath = gdbPath;
    this.hardwareGuard = hardwareGuard;
    this.spawnProcess = spawnProcess;
  }

  /**
   * Start GDB and connect to a remote target (GDB server).
   */
  async connect(host: string = "localhost", port: number = 2331, elfFile?: string): Promise<GDBResponse> {
    const blocked = this.hardwareGuard?.();
    if (blocked) return { success: false, output: "", error: blocked };
    const endpoint = `${host}:${port}`;
    if (this.connected && this.proc) {
      if (this.connectedEndpoint !== endpoint) {
        return { success: false, output: "", error: `GDB is already connected to ${this.connectedEndpoint ?? "an unknown endpoint"}; disconnect before connecting to ${endpoint}`, code: "GDB_ALREADY_CONNECTED_DIFFERENT_TARGET" };
      }
      if (elfFile && this.loadedSymbolFile !== elfFile) {
        const loaded = await this.loadSymbols(elfFile);
        return loaded.success
          ? { ...loaded, output: `GDB already connected to ${endpoint}; symbols loaded from ${elfFile}\n${loaded.output}`.trim() }
          : loaded;
      }
      return { success: true, output: `GDB already connected to ${endpoint}${elfFile ? ` with symbols from ${elfFile}` : ""}` };
    }

    const args = ["--interpreter=mi2", "--quiet", "--nx", "-iex", "set auto-load off"];
    if (elfFile) args.push(elfFile);

    log(`[GDB] Starting: ${this.gdbPath} ${args.join(" ")}`);

    return new Promise((resolve) => {
      let settled = false;
      let terminating = false;
      let checkInterval: NodeJS.Timeout | undefined;
      let startupTimeout: NodeJS.Timeout | undefined;
      const finish = (response: GDBResponse) => {
        if (settled) return;
        settled = true;
        if (checkInterval) clearInterval(checkInterval);
        if (startupTimeout) clearTimeout(startupTimeout);
        resolve(response);
      };
      const proc = this.spawnProcess(this.gdbPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;

      this.outputBuffer = "";
      this.stopEvent = null;
      this.lastExit = undefined;

      proc.stdout?.on("data", (data: Buffer) => {
        this.handleOutput(data.toString());
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        log(`[GDB stderr] ${text.trim()}`);
      });

      proc.on("error", (err) => {
        logError("GDB process error", err);
        const wasConnected = this.connected;
        if (!childProcessAlive(proc)) {
          this.connected = false;
          this.targetExecutionState = "unknown";
          this.connectedEndpoint = null;
          this.loadedSymbolFile = null;
          this.lastExit = { code: proc.exitCode, signal: proc.signalCode, error: err.message };
          if (wasConnected) this.notifyUnexpectedExit(proc);
          if (this.proc === proc) this.proc = null;
          const pending = this.pendingResolve;
          this.pendingResolve = null;
          this.pendingRequiresPrompt = false;
          pending?.(this.outputBuffer, true);
          if (pending) return;
          if (!terminating) finish({ success: false, output: "", error: `Failed to start GDB: ${err.message}. Is ${this.gdbPath} installed?`, ...this.exitFacts() });
          return;
        }
        if (!terminating) {
          terminating = true;
          const pending = this.pendingResolve;
          const pendingOutput = this.outputBuffer;
          this.pendingResolve = null;
          this.pendingRequiresPrompt = false;
          this.lastExit = { code: proc.exitCode, signal: proc.signalCode, error: err.message };
          if (wasConnected) this.notifyUnexpectedExit(proc);
          void this.terminateGdbProcess().then(() => {
            pending?.(pendingOutput, true);
            if (pending) return;
            finish({ success: false, output: "", error: `GDB process error: ${err.message}`, ...this.exitFacts() });
          });
        }
      });

      proc.on("exit", (code, signal) => {
        log(`[GDB] Process exited with code ${code}`);
        const wasConnected = this.connected;
        this.connected = false;
        this.targetExecutionState = "unknown";
        this.connectedEndpoint = null;
        this.loadedSymbolFile = null;
        this.lastExit = { code, signal, error: this.lastExit?.error };
        if (wasConnected) this.notifyUnexpectedExit(proc);
        if (this.proc === proc) this.proc = null;
        const pending = this.pendingResolve;
        this.pendingResolve = null;
        this.pendingRequiresPrompt = false;
        pending?.(this.outputBuffer, true);
        if (pending) return;
        if (!terminating && !settled) finish({ success: false, output: this.cleanMI(this.outputBuffer), rawOutput: this.outputBuffer, error: `GDB exited before connection completed (code ${code})`, ...this.exitFacts() });
      });

      checkInterval = setInterval(() => {
        if (!hasMiPrompt(this.outputBuffer)) return;
        if (checkInterval) clearInterval(checkInterval);
        checkInterval = undefined;
        if (startupTimeout) clearTimeout(startupTimeout);
        startupTimeout = undefined;
        this.outputBuffer = "";
        this.connectionGeneration += 1;
        void (async () => {
          const asyncExchange = await this.sendCommand("-gdb-set mi-async on", 15_000, true);
          const asyncOutput = asyncExchange.output;
          const asyncCleanOutput = this.cleanMI(asyncOutput);
          if (asyncExchange.processExited) {
            finish({ success: false, output: asyncCleanOutput, rawOutput: asyncOutput, error: "GDB exited while enabling MI asynchronous command processing", code: "GDB_PROCESS_EXITED", ...this.exitFacts() });
            return;
          }
          if (asyncExchange.timedOut) {
            terminating = true;
            await this.terminateGdbProcess();
            finish({ success: false, output: asyncCleanOutput, rawOutput: asyncOutput, error: "GDB timed out while enabling MI asynchronous command processing", code: "GDB_COMMAND_TIMEOUT", ...this.exitFacts() });
            return;
          }
          if (!hasMiResult(asyncOutput, "done") || findMiResult(asyncOutput, "error")) {
            terminating = true;
            await this.terminateGdbProcess();
            finish({ success: false, output: asyncCleanOutput, rawOutput: asyncOutput, error: "GDB does not support the MI asynchronous mode required for commands while the target is running", code: "GDB_MI_ASYNC_UNAVAILABLE", ...this.exitFacts() });
            return;
          }

          const exchange = await this.sendCommand(`target remote ${host}:${port}`, 15_000);
          const connectResult = exchange.output;
          const cleanOutput = this.cleanMI(connectResult);
          const miError = /(?:^|\n)\^error(?:,|\r?$)/m.test(connectResult);
          const miConnected = !miError && (hasMiResult(connectResult, "done") || hasMiResult(connectResult, "connected") || hasMiAsyncRecord(connectResult, "stopped"));
          if (exchange.processExited) {
            finish({ success: false, output: cleanOutput, rawOutput: connectResult, error: "GDB exited while connecting to the remote target", code: "GDB_PROCESS_EXITED", ...this.exitFacts() });
          } else if (exchange.timedOut) {
            terminating = true;
            await this.terminateGdbProcess();
            finish({ success: false, output: cleanOutput, rawOutput: connectResult, error: "GDB remote connection timed out", code: "GDB_COMMAND_TIMEOUT", ...this.exitFacts() });
          } else if (miConnected) {
            this.connected = true;
            this.connectedEndpoint = endpoint;
            this.loadedSymbolFile = elfFile ?? null;
            this.updateTargetExecutionState(connectResult);
            finish({ success: true, output: `Connected to GDB server at ${host}:${port}\n${cleanOutput}`, rawOutput: connectResult });
          } else {
            terminating = true;
            await this.terminateGdbProcess();
            finish({ success: false, output: cleanOutput, rawOutput: connectResult, error: "Failed to connect to GDB server", ...this.exitFacts() });
          }
        })().catch(async (error) => {
          terminating = true;
          await this.terminateGdbProcess();
          finish({ success: false, output: "", error: error instanceof Error ? error.message : String(error), ...this.exitFacts() });
        });
      }, 100);

      startupTimeout = setTimeout(() => {
        terminating = true;
        const output = this.outputBuffer;
        void this.terminateGdbProcess().then(() => finish({ success: false, output, rawOutput: output, error: `GDB did not start within timeout. Output: ${output.slice(0, 200)}`, code: "GDB_START_TIMEOUT", ...this.exitFacts() }));
      }, 8_000);
    });
  }

  /**
   * Send a GDB command and wait for the response.
   *
   * For commands that cause the target to run (continue, step, next, until, finish),
   * this will wait up to `timeout` ms for the target to stop.
   * If the target doesn't stop in time, returns with a "target running" message.
   */
  async command(cmd: string, timeout: number = 15000): Promise<GDBResponse> {
    if (!this.proc || !this.connected) {
      return { success: false, output: "", error: "GDB is not connected", code: "GDB_NOT_CONNECTED" };
    }
    const result = await this.commandInternal(cmd, timeout);
    if (!result.observedTargetExecutionState) this.targetExecutionState = "unknown";
    return result;
  }

  private async commandInternal(cmd: string, timeout: number): Promise<GDBResponse> {
    const blocked = this.hardwareGuard?.();
    if (blocked) return { success: false, output: "", error: blocked };
    if (!this.proc || !this.connected) {
      return { success: false, output: "", error: "GDB not connected. Use gdb_connect first." };
    }

    // Throttle rapid commands to avoid overwhelming slow adapters (e.g., ST-Link V2.1)
    const now = Date.now();
    const elapsed = now - this.lastCommandTime;
    if (elapsed < this.commandThrottleMs) {
      await new Promise((r) => setTimeout(r, this.commandThrottleMs - elapsed));
    }
    this.lastCommandTime = Date.now();

    // Detect if this is a "run" command that will make the target execute
    const isRunCommand = /^(continue|c|step|s|stepi|si|next|n|nexti|ni|finish|until|advance|run|r)\b/i.test(cmd.trim());

    this.stopEvent = null;
    let exchange: GDBCommandExchange;
    try {
      exchange = await this.sendCommand(cmd, timeout);
    } catch (error) {
      await this.terminateGdbProcess();
      return { success: false, output: "", rawOutput: this.outputBuffer, error: error instanceof Error ? error.message : String(error), code: "GDB_IO_FAILED", ...this.exitFacts() };
    }
    const rawOutput = exchange.output;
    const observedTargetExecutionState = this.updateTargetExecutionState(rawOutput);
    const output = this.cleanMI(rawOutput);
    if (exchange.processExited) {
      return { success: false, output, rawOutput, error: "GDB exited while the command was in flight", code: "GDB_PROCESS_EXITED", ...this.exitFacts() };
    }
    if (exchange.timedOut) {
      await this.terminateGdbProcess();
      return { success: false, output, rawOutput, error: `GDB command timed out after ${timeout}ms; the GDB client was terminated before releasing the Probe queue`, code: "GDB_COMMAND_TIMEOUT", ...this.exitFacts() };
    }

    // For run commands, check if we got a stop event
    if (isRunCommand) {
      if (this.stopEvent) {
        return {
          success: true,
          output,
          rawOutput,
          stopReason: this.stopEvent,
          observedTargetExecutionState,
        };
      }
      // Check if target is still running (we timed out waiting)
      if (observedTargetExecutionState === "running") {
        return {
          success: true,
          output: `Target is running. Use gdb_wait to poll for stop events.\nLast output: ${output}`,
          rawOutput,
          stopReason: "running",
          observedTargetExecutionState,
        };
      }
    }

    const errorRecord = findMiResult(rawOutput, "error");
    const errorMessage = errorRecord?.match(/(?:^|,)msg="((?:\\.|[^"])*)"/)?.[1];
    const success = !errorRecord;

    return {
      success,
      output,
      rawOutput,
      error: errorRecord ? decodeMiString(errorMessage ?? "GDB command failed") : undefined,
      stopReason: this.stopEvent || undefined,
      observedTargetExecutionState,
    };
  }

  /**
   * Wait for the target to stop (after a continue/step that timed out).
   * Call this to poll after gdb_command returned "target running".
   */
  async wait(timeout: number = 30000): Promise<GDBResponse> {
    const blocked = this.hardwareGuard?.();
    if (blocked) return { success: false, output: "", error: blocked };
    if (!this.proc || !this.connected) {
      return { success: false, output: "", error: "GDB not connected" };
    }

    // Check if we already have a pending stop
    if (this.stopEvent) {
      const reason = this.stopEvent;
      this.stopEvent = null;
      this.targetExecutionState = "halted";
      return { success: true, output: `Target stopped: ${reason}`, stopReason: reason, observedTargetExecutionState: "halted" };
    }

    if (this.targetExecutionState === "unknown") {
      return { success: false, output: "", error: "target execution state is unknown; gdb_wait cannot infer that it is running", code: "TARGET_STATE_UNKNOWN" };
    }
    if (this.targetExecutionState === "halted") {
      return { success: true, output: "Target is already halted", stopReason: "already-halted", observedTargetExecutionState: "halted" };
    }

    // Wait for a stop event
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        if (!this.proc || !this.connected) {
          const exitFacts = this.lastExit ? ` (exitCode=${String(this.lastExit.code)}, signal=${String(this.lastExit.signal)}${this.lastExit.error ? `, error=${this.lastExit.error}` : ""})` : "";
          resolve({ success: false, output: `GDB disconnected while waiting for a stop event${exitFacts}`, rawOutput: this.outputBuffer, error: "GDB disconnected", code: "GDB_NOT_CONNECTED", ...this.exitFacts() });
          return;
        }
        if (this.stopEvent) {
          const reason = this.stopEvent;
          this.stopEvent = null;
          this.targetExecutionState = "halted";
          resolve({ success: true, output: `Target stopped: ${reason}`, stopReason: reason, observedTargetExecutionState: "halted" });
          return;
        }
        if (this.targetExecutionState === "unknown") {
          resolve({ success: false, output: "Target state became unknown while waiting", error: "target execution state became unknown", code: "TARGET_STATE_UNKNOWN", observedTargetExecutionState: "unknown" });
          return;
        }
        if (this.targetExecutionState === "halted") {
          resolve({ success: true, output: "Target stopped (reason unavailable)", stopReason: "stopped", observedTargetExecutionState: "halted" });
          return;
        }
        if (Date.now() - startTime > timeout) {
          this.targetExecutionState = "running";
          resolve({ success: true, output: "Target still running (timeout)", stopReason: "running", observedTargetExecutionState: "running" });
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });
  }

  /** Load an ELF file for symbol-aware debugging */
  async loadSymbols(elfPath: string): Promise<GDBResponse> {
    if (!elfPath || /[\r\n\0]/.test(elfPath)) return { success: false, output: "", error: "symbol path contains forbidden control characters", code: "INVALID_ARGUMENT" };
    const quoted = `"${elfPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    this.loadedSymbolFile = null;
    const result = await this.commandInternal(`file ${quoted}`, 15_000);
    if (result.success) this.loadedSymbolFile = elfPath;
    return result;
  }

  /** Get a backtrace */
  async backtrace(full: boolean = false): Promise<GDBResponse> {
    return this.commandInternal(full ? "bt full" : "bt", 15_000);
  }

  /** List threads (useful for RTOS debugging) */
  async listThreads(): Promise<GDBResponse> {
    return this.commandInternal("info threads", 15_000);
  }

  /** Read a C variable by name (requires debug symbols) */
  async readVariable(name: string): Promise<GDBResponse> {
    if (!/^[A-Za-z_]\w*(?:(?:\.[A-Za-z_]\w*)|(?:\[\d+\]))*$/.test(name)) {
      return { success: false, output: "", error: "variable selector is not supported", code: "INVALID_ARGUMENT" };
    }
    return this.commandInternal(`print ${name}`, 15_000);
  }

  getConnectionGeneration(): number { return this.connectionGeneration; }

  getTargetExecutionState(): GDBTargetExecutionState { return this.targetExecutionState; }

  onUnexpectedExit(listener: (event: GDBUnexpectedExit) => void): () => void {
    this.unexpectedExitListeners.add(listener);
    return () => this.unexpectedExitListeners.delete(listener);
  }

  /** Get recent command history */
  getHistory(count: number = 20): string[] {
    return this.history.slice(-count);
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.connected && !!this.proc;
  }

  /** Disconnect and kill GDB process */
  async disconnect(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.connected = false;
    this.targetExecutionState = "unknown";
    const pending = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingRequiresPrompt = false;
    if (pending) pending(this.outputBuffer, true);
    if (proc) {
      await terminateChildProcess(proc, {
        gracefulRequest: () => { proc.stdin?.write("quit\n"); },
        gracefulWaitMs: 1_000,
        terminateWaitMs: 1_000,
      });
    }
    this.outputBuffer = "";
    this.stopEvent = null;
    this.loadedSymbolFile = null;
    this.connectedEndpoint = null;
  }

  // ── Internal ─────────────────────────────────────────────────────

  private handleOutput(text: string): void {
    this.outputBuffer += text;
    this.updateTargetExecutionState(this.outputBuffer);

    // If someone is waiting for a response, check if we have a prompt
    if (this.pendingResolve && (this.pendingRequiresPrompt ? hasMiPrompt(this.outputBuffer) : this.isResponseComplete())) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingRequiresPrompt = false;
      const response = this.outputBuffer;
      this.outputBuffer = "";
      resolve(response, false);
    }
  }

  private isResponseComplete(): boolean {
    // GDB/MI: response is complete when we see (gdb) prompt
    // or a result record (^done, ^error, ^running, ^exit)
    return hasMiPrompt(this.outputBuffer) || hasAnyMiResult(this.outputBuffer);
  }

  private formatStopReason(miOutput: string): string {
    const reason = miOutput.match(/reason="([^"]*)"/)?.[1] || "unknown";
    const parts: string[] = [reason];

    // Extract useful fields
    const func = miOutput.match(/func="([^"]*)"/)?.[1];
    const file = miOutput.match(/file="([^"]*)"/)?.[1];
    const line = miOutput.match(/line="([^"]*)"/)?.[1];
    const addr = miOutput.match(/addr="([^"]*)"/)?.[1];
    const bkptno = miOutput.match(/bkptno="([^"]*)"/)?.[1];
    const signalName = miOutput.match(/signal-name="([^"]*)"/)?.[1];

    if (bkptno) parts.push(`breakpoint #${bkptno}`);
    if (signalName) parts.push(`signal ${signalName}`);
    if (func) parts.push(`at ${func}()`);
    if (file && line) parts.push(`${file}:${line}`);
    else if (addr) parts.push(`at ${addr}`);

    return parts.join(" ");
  }

  private sendCommand(cmd: string, timeout: number, requirePrompt = true): Promise<GDBCommandExchange> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject("GDB process not available");
        return;
      }

      this.outputBuffer = "";
      let settled = false;
      let timeoutHandle: NodeJS.Timeout;
      const finish = (output: string, timedOut: boolean, processExited = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (this.pendingResolve === onResponse) {
          this.pendingResolve = null;
          this.pendingRequiresPrompt = false;
        }
        resolve({ output, timedOut, processExited });
      };
      const onResponse = (output: string, processExited: boolean) => finish(output, false, processExited);
      this.pendingResolve = onResponse;
      this.pendingRequiresPrompt = requirePrompt;

      // Record in history
      this.history.push(`> ${cmd}`);
      if (this.history.length > this.maxHistory) this.history.shift();

      log(`[GDB] > ${cmd}`);
      timeoutHandle = setTimeout(() => {
        if (this.pendingResolve === onResponse) {
          const partial = this.outputBuffer;
          this.outputBuffer = "";
          // Record partial output in history
          if (partial.trim()) {
            this.history.push(this.cleanMI(partial));
          }
          finish(partial, true);
        }
      }, timeout);
      try {
        this.proc.stdin.write(cmd + "\n");
      } catch (error) {
        clearTimeout(timeoutHandle);
        if (this.pendingResolve === onResponse) {
          this.pendingResolve = null;
          this.pendingRequiresPrompt = false;
        }
        reject(error);
      }
    });
  }

  private updateTargetExecutionState(raw: string): GDBTargetExecutionState | undefined {
    let observed: GDBTargetExecutionState | undefined;
    let stopReason: string | undefined;
    for (const line of raw.split(/\r?\n/)) {
      if (/^\*stopped(?=,|$)/.test(line)) {
        observed = "halted";
        stopReason = /(?:^|,)reason="/.test(line) ? this.formatStopReason(line) : "stopped";
      } else if (/^(?:\*running|\^running)(?=,|$)/.test(line)) {
        observed = "running";
        stopReason = undefined;
      } else if (/^=thread-group-exited(?=,|$)/.test(line)) {
        observed = "unknown";
        stopReason = undefined;
      }
    }
    if (!observed) return undefined;
    this.targetExecutionState = observed;
    this.stopEvent = observed === "halted" ? stopReason ?? "unknown" : null;
    if (observed === "halted") log(`[GDB] Stop event: ${this.stopEvent}`);
    return observed;
  }

  private async waitForPrompt(timeout: number): Promise<string> {
    return (await this.sendCommand("", timeout)).output;
  }

  private async terminateGdbProcess(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.connected = false;
    this.targetExecutionState = "unknown";
    this.connectedEndpoint = null;
    this.loadedSymbolFile = null;
    this.pendingResolve = null;
    this.pendingRequiresPrompt = false;
    if (!proc) return;
    await terminateChildProcess(proc, { terminateWaitMs: 1_000 });
    this.lastExit ??= { code: proc.exitCode, signal: proc.signalCode };
  }

  private exitFacts(): Pick<GDBResponse, "exitCode" | "exitSignal" | "exitError"> {
    return this.lastExit ? { exitCode: this.lastExit.code, exitSignal: this.lastExit.signal, exitError: this.lastExit.error } : {};
  }

  private notifyUnexpectedExit(proc: ChildProcess): void {
    if (this.unexpectedExitNotified.has(proc)) return;
    this.unexpectedExitNotified.add(proc);
    const event: GDBUnexpectedExit = {
      exitCode: this.lastExit?.code ?? proc.exitCode,
      exitSignal: this.lastExit?.signal ?? proc.signalCode,
      exitError: this.lastExit?.error,
    };
    for (const listener of this.unexpectedExitListeners) {
      try { listener(event); } catch { /* lifecycle evidence must not be lost because one observer failed */ }
    }
  }

  /** Clean GDB/MI output into human-readable text */
  private cleanMI(raw: string): string {
    const lines: string[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "(gdb)") continue;

      // Strip MI prefix markers
      // ~"text\n" → text  (console output)
      const consoleMatch = trimmed.match(/^~"(.*)"$/);
      if (consoleMatch) {
        lines.push(consoleMatch[1].replace(/\\n$/, "").replace(/\\t/g, "\t").replace(/\\"/g, '"'));
        continue;
      }

      // &"text\n" → skip (log/debug output)
      if (trimmed.startsWith('&"')) continue;

      // ^done → skip
      if (trimmed.startsWith("^done") && trimmed.length < 10) continue;
      // ^running → note it
      if (trimmed === "^running") { lines.push("(target running)"); continue; }

      // ^error,msg="..." → extract error
      const errorMatch = trimmed.match(/\^error,msg="(.*)"/);
      if (errorMatch) { lines.push(`Error: ${errorMatch[1].replace(/\\"/g, '"')}`); continue; }

      // *stopped,reason="..." → format nicely
      if (trimmed.startsWith("*stopped")) {
        lines.push(`Stopped: ${this.formatStopReason(trimmed)}`);
        continue;
      }

      // =thread-group-* → skip
      if (trimmed.startsWith("=")) continue;

      // ^done,value="..." → extract value
      const valueMatch = trimmed.match(/\^done,value="(.*)"/);
      if (valueMatch) { lines.push(valueMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")); continue; }

      // Anything else — pass through
      if (!trimmed.startsWith("^done")) {
        lines.push(trimmed);
      }
    }

    const result = lines.join("\n").trim();
    // Record in history
    if (result) {
      this.history.push(result);
      if (this.history.length > this.maxHistory) this.history.shift();
    }
    return result;
  }
}

function hasMiPrompt(raw: string): boolean {
  return /(?:^|\r?\n)\(gdb\)[\t ]*(?=\r?\n|$)/m.test(raw);
}

function findMiResult(raw: string, kind: "done" | "error" | "running" | "connected" | "exit"): string | undefined {
  return raw.match(new RegExp(`(?:^|\\r?\\n)(\\^${kind}(?:,[^\\r\\n]*)?)(?=\\r?\\n|$)`, "m"))?.[1];
}

function hasMiResult(raw: string, kind: "done" | "error" | "running" | "connected" | "exit"): boolean {
  return findMiResult(raw, kind) !== undefined;
}

function hasAnyMiResult(raw: string): boolean {
  return /(?:^|\r?\n)\^(?:done|error|running|connected|exit)(?=,|\r?(?:\n|$))/m.test(raw);
}

function hasMiAsyncRecord(raw: string, kind: "stopped" | "running"): boolean {
  return new RegExp(`(?:^|\\r?\\n)\\*${kind}(?=,|\\r?(?:\\n|$))`, "m").test(raw);
}

function decodeMiString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
}
