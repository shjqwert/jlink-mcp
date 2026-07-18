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

  spawn(
    name: string,
    command: string,
    args: string[],
    options?: SpawnOptions
  ): ManagedProcess {
    // Kill existing process with same name
    this.kill(name);

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
        this.processes.delete(name);
        this.emit("processExit", name, null, err);
      }
    });

    proc.on("exit", (code, signal) => {
      log(`Process "${name}" exited (code=${code}, signal=${signal})`);
      if (this.processes.get(name)?.process === proc) {
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
