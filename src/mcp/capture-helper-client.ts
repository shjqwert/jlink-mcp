import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ManagedProcess, ProcessManager } from "../utils/process-manager";
import { logError } from "../utils/logger";
import {
  CaptureIpcMessage,
  decodeCaptureIpc,
  encodeCaptureIpc,
} from "./capture-contract";

const captureHelperProcess = "jlink-capture-helper";

export interface HelperResponse {
  [key: string]: unknown;
}

export class CaptureHelperClient {
  private process: ManagedProcess | null = null;
  private pending = new Map<string, { resolve: (value: HelperResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void> | null = null;
  private eventHandler: (type: string, payload: HelperResponse) => void;
  private shuttingDown = false;

  constructor(private processManager: ProcessManager, eventHandler: (type: string, payload: HelperResponse) => void) {
    this.eventHandler = eventHandler;
  }

  async start(): Promise<void> {
    const executable = await findHelperExecutable();
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      let settled = false;
      try {
        this.process = this.processManager.spawn(captureHelperProcess, executable, ["--parent-pid", String(process.pid)]);
        const child = this.process.process;
        const lines = createInterface({ input: child.stdout! });
        lines.on("line", (line) => {
          try {
            const message = decodeCaptureIpc(line);
            if (message.type === "ready") {
              if (!settled) { settled = true; resolveReady(); }
              return;
            }
            if (message.id === "event") {
              this.eventHandler(message.type, message.payload as HelperResponse);
              return;
            }
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.type === "error") pending.reject(new Error(String((message.payload as { message?: unknown }).message ?? "Native helper error")));
            else pending.resolve(message.payload as HelperResponse);
          } catch (error) {
            logError("Capture helper emitted invalid IPC", error);
            this.initiateSafetyShutdown("invalid_helper_ipc");
          }
        });
        child.stderr?.on("data", (data: Buffer) => logError(`[Capture helper] ${data.toString().trim()}`));
        child.once("error", (error) => {
          if (!settled) { settled = true; rejectReady(error); }
          this.rejectAll(error);
          this.reportUnexpectedExit(error.message);
        });
        child.once("exit", (code) => {
          const error = new Error(`Capture helper exited with code ${code}`);
          if (!settled) { settled = true; rejectReady(error); }
          this.rejectAll(error);
          this.process = null;
          this.reportUnexpectedExit(error.message);
        });
      } catch (error) {
        settled = true;
        rejectReady(error);
      }
    });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Capture helper startup timed out")), 5000));
    await Promise.race([this.ready, timeout]);
  }

  request(type: string, payload: unknown, timeoutMs = 30000): Promise<HelperResponse> {
    if (!this.process?.process.stdin) return Promise.reject(new Error("Capture helper is not running"));
    const id = randomUUID();
    return new Promise<HelperResponse>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Capture helper ${type} timed out`));
        this.initiateSafetyShutdown(`request_timeout:${type}`);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      const message: CaptureIpcMessage = { version: 1, id, type, payload };
      this.process!.process.stdin!.write(encodeCaptureIpc(message), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error);
      });
    });
  }

  async close(safe = true): Promise<void> {
    if (!this.process) return;
    this.shuttingDown = true;
    if (safe) {
      try { await this.request("shutdown", {}, 5000); } catch { /* helper parent-loss path handles safety */ }
    }
    this.processManager.kill(captureHelperProcess);
    this.process = null;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private initiateSafetyShutdown(reason: string): void {
    if (this.shuttingDown || !this.process?.process.stdin) return;
    this.shuttingDown = true;
    this.eventHandler("ipc_failure", { reason });
    const message: CaptureIpcMessage = { version: 1, id: `safety-${Date.now()}`, type: "shutdown", payload: { reason } };
    this.process.process.stdin.write(encodeCaptureIpc(message));
    const timer = setTimeout(() => this.processManager.kill(captureHelperProcess), 5000);
    timer.unref();
  }

  private reportUnexpectedExit(reason: string): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.eventHandler("helper_exit", { reason });
  }
}

async function findHelperExecutable(): Promise<string> {
  if (process.env.JLINK_CAPTURE_HELPER) return realpath(process.env.JLINK_CAPTURE_HELPER);
  const executable = process.platform === "win32" ? "jlink-capture-helper.exe" : "jlink-capture-helper";
  const candidates = [
    join(__dirname, "..", "..", "native", "capture-helper", "bin", executable),
    join(__dirname, "..", "native", "capture-helper", "bin", executable),
    join(__dirname, "..", "..", "native", "capture-helper", "build", "Release", executable),
    join(__dirname, "..", "native", "capture-helper", "build", "Release", executable),
    join(process.cwd(), "native", "capture-helper", "build", "Release", executable),
    join(process.cwd(), "native", "capture-helper", "bin", executable),
  ];
  for (const candidate of candidates) {
    try { return await realpath(candidate); } catch { /* next */ }
  }
  throw new Error("Native capture helper is unavailable; run npm run build:capture or set JLINK_CAPTURE_HELPER");
}
