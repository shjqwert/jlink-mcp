import { dirname } from "node:path";
import { GDBClient, type GDBTargetExecutionState } from "../../gdb/gdb-client";
import { createProbeBackend } from "../../probe/factory";
import type { ProbeBackend } from "../../probe/backend";
import { RTTClient } from "../../rtt/rtt-client";
import { ProcessManager } from "../../utils/process-manager";
import type { StoredTarget } from "./target-store";

export interface TargetRuntime {
  projectRoot: string;
  probeSerial: string;
  targetGeneration: string;
  processManager: ProcessManager;
  probe: ProbeBackend;
  gdb: GDBClient;
  rtt: RTTClient;
  gdbOwnerToken?: string;
  gdbOwnerExitSubscription?: () => void;
  gdbServerStopping?: boolean;
  gdbServerTargetExecutionState?: GDBTargetExecutionState;
  gdbClientExitSubscription?: () => void;
  onGdbServerExit(listener: () => void): () => void;
}

export class TargetRuntimeRegistry {
  private readonly runtimes = new Map<string, TargetRuntime>();
  private readonly keyTails = new Map<string, Promise<void>>();

  async get(target: StoredTarget): Promise<TargetRuntime> {
    const key = targetKey(target.projectRoot);
    return this.withKey(key, async () => {
      const existing = this.runtimes.get(key);
      if (existing?.targetGeneration === target.generation) return existing;
      if (existing) {
        if (!(await this.disposeRuntime(existing))) {
          throw new Error("GDB_SERVER_UNSAFE_TO_DISPOSE: target state must be explicitly running before replacing this runtime");
        }
        if (this.runtimes.get(key) === existing) this.runtimes.delete(key);
      }
      const processManager = new ProcessManager();
      const installDir = target.jlinkPath ? dirname(target.jlinkPath.path)
        : target.gdbServerPath ? dirname(target.gdbServerPath.path)
        : "";
      const probe = createProbeBackend({
        type: "jlink",
        jlink: {
          installDir,
          jlinkExePath: target.jlinkPath?.path,
          gdbServerExePath: target.gdbServerPath?.path,
          device: target.device,
          gdbDevice: target.gdbDevice,
          serialNumber: target.probeSerial,
          interface: target.interface,
          speed: target.speed,
          gdbPort: target.ports.gdb,
          rttTelnetPort: target.ports.rtt,
          swoTelnetPort: target.ports.swo,
        },
      }, processManager);
      const runtime: TargetRuntime = {
        projectRoot: target.projectRoot,
        probeSerial: target.probeSerial,
        targetGeneration: target.generation,
        processManager,
        probe,
        gdb: new GDBClient(target.gdbPath?.path ?? "arm-none-eabi-gdb"),
        rtt: new RTTClient("localhost", target.ports.rtt),
        onGdbServerExit: (listener) => {
          const handler = (name: string) => { if (name === "jlink-gdb-server") listener(); };
          processManager.on("processExit", handler);
          return () => processManager.off("processExit", handler);
        },
      };
      this.runtimes.set(key, runtime);
      return runtime;
    });
  }

  entries(): TargetRuntime[] {
    return [...this.runtimes.values()];
  }

  async invalidate(projectRoot: string, expectedGeneration?: string): Promise<boolean> {
    const key = targetKey(projectRoot);
    return this.withKey(key, async () => {
      const runtime = this.runtimes.get(key);
      if (!runtime || (expectedGeneration !== undefined && runtime.targetGeneration !== expectedGeneration)) return false;
      if (!(await this.disposeRuntime(runtime))) return false;
      if (this.runtimes.get(key) === runtime) this.runtimes.delete(key);
      return true;
    });
  }

  async dispose(): Promise<void> {
    for (const runtime of [...this.runtimes.values()]) await this.invalidate(runtime.projectRoot);
  }

  canSafelyDispose(runtime: TargetRuntime): boolean {
    if (!runtime.probe.isGDBServerRunning()) return true;
    const state = runtime.gdb.isConnected()
      ? runtime.gdb.getTargetExecutionState()
      : runtime.gdbServerTargetExecutionState ?? "unknown";
    return state === "running";
  }

  private async disposeRuntime(runtime: TargetRuntime): Promise<boolean> {
    if (!this.canSafelyDispose(runtime)) return false;
    runtime.rtt.disconnect();
    await runtime.gdb.disconnect();
    await runtime.processManager.killAndWait("jlink-gdb-server");
    runtime.gdbOwnerExitSubscription?.();
    runtime.gdbOwnerExitSubscription = undefined;
    runtime.gdbClientExitSubscription?.();
    runtime.gdbClientExitSubscription = undefined;
    runtime.probe.dispose();
    runtime.processManager.killAll();
    return true;
  }

  private async withKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.keyTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.keyTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.keyTails.get(key) === tail) this.keyTails.delete(key);
    }
  }
}

function targetKey(projectRoot: string): string {
  return process.platform === "win32" ? projectRoot.toLocaleLowerCase("en-US") : projectRoot;
}
