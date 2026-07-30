import { ChildProcess, spawn, SpawnOptions } from "child_process";
import { log, logError } from "./logger";
import { EventEmitter } from "events";

export interface ManagedProcess {
  process: ChildProcess;
  name: string;
  kill(): void;
}

export interface TerminateChildProcessOptions {
  gracefulRequest?: () => void;
  gracefulWaitMs?: number;
  terminateWaitMs?: number;
  forceRetryMs?: number;
}

export interface ProcessExitObservation {
  found: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

/**
 * Terminate a child without treating its generic `error` event as proof of
 * exit. In particular, a failed kill can emit `error` while the process is
 * still alive. Once escalation reaches SIGKILL this deliberately waits (and
 * retries) until exit/close or OS liveness confirms that the PID is gone.
 */
export async function terminateChildProcess(
  proc: ChildProcess,
  options: TerminateChildProcessOptions = {},
): Promise<void> {
  if (!childProcessAlive(proc)) return;
  let exitObserved = false;
  const onExit = () => { exitObserved = true; };
  proc.once("exit", onExit);
  proc.once("close", onExit);
  const waitForExit = async (milliseconds: number): Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, milliseconds);
    do {
      if (exitObserved || !childProcessAlive(proc)) return true;
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return exitObserved || !childProcessAlive(proc);
  };
  const signal = (value: NodeJS.Signals): void => {
    try { proc.kill(value); } catch { /* liveness is checked below */ }
  };
  try {
    if (options.gracefulRequest) {
      try { options.gracefulRequest(); } catch { /* continue with signals */ }
      if (await waitForExit(options.gracefulWaitMs ?? 1_000)) return;
    }
    signal("SIGTERM");
    if (await waitForExit(options.terminateWaitMs ?? 1_000)) return;
    for (;;) {
      signal("SIGKILL");
      if (await waitForExit(options.forceRetryMs ?? 1_000)) return;
    }
  } finally {
    proc.off("exit", onExit);
    proc.off("close", onExit);
  }
}

export function childProcessAlive(proc: ChildProcess): boolean {
  if (proc.exitCode !== null || proc.signalCode !== null) return false;
  if (!Number.isSafeInteger(proc.pid) || Number(proc.pid) <= 0) return false;
  try {
    process.kill(proc.pid!, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Manages spawned child processes with lifecycle tracking.
 */
export class ProcessManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();
  private lastExits = new Map<string, Omit<ProcessExitObservation, "found" | "exited">>();

  spawn(
    name: string,
    command: string,
    args: string[],
    options?: SpawnOptions
  ): ManagedProcess {
    // Kill existing process with same name
    this.kill(name);
    this.lastExits.delete(name);

    log(`Spawning process "${name}": ${command} ${args.join(" ")}`);

    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });

    const managed: ManagedProcess = {
      process: proc,
      name,
      kill: () => this.kill(name),
    };

    proc.on("error", (err) => {
      logError(`Process "${name}" error`, err);
      if (!childProcessAlive(proc) && this.processes.get(name)?.process === proc) {
        this.lastExits.set(name, {
          exitCode: proc.exitCode,
          signal: proc.signalCode,
          error: err.message,
        });
        this.processes.delete(name);
        this.emit("processExit", name, null, err);
      }
    });

    proc.on("exit", (code, signal) => {
      log(`Process "${name}" exited (code=${code}, signal=${signal})`);
      if (this.processes.get(name)?.process === proc) {
        this.lastExits.set(name, { exitCode: code, signal });
        this.processes.delete(name);
        this.emit("processExit", name, code, signal);
      }
    });

    this.processes.set(name, managed);
    return managed;
  }

  kill(name: string): boolean {
    const existing = this.processes.get(name);
    if (existing) {
      log(`Killing process "${name}" (pid=${existing.process.pid})`);
      existing.process.kill("SIGTERM");
      // Force kill after 3 seconds
      const forceTermination = setTimeout(() => {
        try {
          existing.process.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 3000);
      forceTermination.unref();
      this.processes.delete(name);
      return true;
    }
    return false;
  }

  async killAndWait(name: string, timeoutMs = 3000): Promise<{ found: boolean; exited: boolean }> {
    const existing = this.processes.get(name);
    if (!existing) return { found: false, exited: true };
    await terminateChildProcess(existing.process, { terminateWaitMs: timeoutMs });
    if (this.processes.get(name)?.process === existing.process) this.processes.delete(name);
    return { found: true, exited: true };
  }

  async waitForExit(name: string, timeoutMs = 3000): Promise<ProcessExitObservation> {
    const existing = this.processes.get(name);
    if (!existing) {
      const previous = this.lastExits.get(name);
      return previous
        ? { found: true, exited: true, ...previous }
        : { found: false, exited: true, exitCode: null, signal: null };
    }
    const proc = existing.process;
    const previous = this.lastExits.get(name);
    if (
      !childProcessAlive(proc)
      && (previous !== undefined || proc.exitCode !== null || proc.signalCode !== null)
    ) {
      return {
        found: true,
        exited: true,
        exitCode: previous?.exitCode ?? proc.exitCode,
        signal: previous?.signal ?? proc.signalCode,
        ...(previous?.error ? { error: previous.error } : {}),
      };
    }
    return new Promise((resolve) => {
      let lastError: string | undefined;
      const finish = (observation: ProcessExitObservation) => {
        clearTimeout(timer);
        proc.off("exit", onExit);
        proc.off("close", onExit);
        proc.off("error", onError);
        resolve(observation);
      };
      const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        finish({ found: true, exited: true, exitCode, signal, ...(lastError ? { error: lastError } : {}) });
      };
      const onError = (error: Error) => {
        lastError = error.message;
        if (!childProcessAlive(proc)) {
          finish({ found: true, exited: true, exitCode: proc.exitCode, signal: proc.signalCode, error: lastError });
        }
      };
      const timer = setTimeout(() => {
        finish({ found: true, exited: false, exitCode: null, signal: null, ...(lastError ? { error: lastError } : {}) });
      }, Math.max(0, timeoutMs));
      proc.once("exit", onExit);
      proc.once("close", onExit);
      proc.on("error", onError);
    });
  }

  get(name: string): ManagedProcess | undefined {
    return this.processes.get(name);
  }

  killAll(): void {
    for (const [name] of this.processes) {
      this.kill(name);
    }
  }

  listRunning(): string[] {
    return Array.from(this.processes.keys());
  }
}
