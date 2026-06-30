import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProbeBackend } from "../../probe/backend";
import { discoverHssDll, resolveHssHelperPath, type HssDllPreflightInput } from "../hss-dll/hss-dll-adapter";
import { appendHssAudit } from "./audit-log";
import { exportHssCapture, finalizeMetadata, hssCaptureStatusFromMetadata, queryHssCapture, writeInitialMetadata } from "./hss-artifact";
import { hssCapabilityProbe } from "./hss-capability";
import type { HssCapturePlan, HssCapturePlanInput } from "./hss-plan";
import { buildHssCapturePlan } from "./hss-plan";
import { HSS_SAFETY_FALSE } from "./hss-contract";
import { hssFail, hssOk, type HssEnvelope } from "./hss-envelope";
import { HSS_ERROR, HssError } from "./hss-errors";
import { ensureHssProjectDirs, hssProjectPaths } from "./project-paths";

export interface HssCaptureStartInput extends HssDllPreflightInput, HssCapturePlanInput {
  planId?: string;
}

export interface HssCaptureServiceOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  helperPath?: string;
  helperArgsPrefix?: string[];
}

interface ActiveCapture {
  captureId: string;
  owner: string;
  plan: HssCapturePlan;
  metadataFile: string;
  segmentFile: string;
  stopFile: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  done: Promise<void>;
}

export class HssCaptureService {
  private readonly sessionId = randomUUID();
  private readonly plans = new Map<string, HssCapturePlan>();
  private active: ActiveCapture | null = null;

  constructor(private readonly probe: ProbeBackend, private readonly options: HssCaptureServiceOptions = {}) {}

  async capabilityProbe(input: HssDllPreflightInput = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capability_probe", input, async () => {
      await ensureHssProjectDirs(this.cwd());
      return hssCapabilityProbe(input, { env: this.env(), helperPath: this.options.helperPath, helperArgsPrefix: this.options.helperArgsPrefix, cwd: this.cwd() });
    });
  }

  async capturePlan(input: HssCapturePlanInput = {}): Promise<HssEnvelope<HssCapturePlan>> {
    return this.wrap("hss_capture_plan", input, async () => {
      await ensureHssProjectDirs(this.cwd());
      const capability = await hssCapabilityProbe({}, { env: this.env(), helperPath: this.options.helperPath, helperArgsPrefix: this.options.helperArgsPrefix, cwd: this.cwd() });
      const startReady = Boolean((capability.hss as { startReadStopReady?: boolean }).startReadStopReady);
      const plan = await buildHssCapturePlan(input, this.cwd(), startReady);
      this.plans.set(plan.planId, plan);
      return plan;
    });
  }

  async captureStart(input: HssCaptureStartInput = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_start", input, async () => {
      const env = this.env();
      if (this.active) throw new HssError(HSS_ERROR.HSS_CAPTURE_ACTIVE, "an HSS capture is already active", { captureId: this.active.captureId });
      const discovery = discoverHssDll(input, env);
      if (!discovery.selectedDllPath) throw new HssError(HSS_ERROR.HSS_DLL_MISSING, "JLink_x64.dll was not found");
      if (!discovery.exportsFound) throw new HssError(HSS_ERROR.HSS_DLL_EXPORTS_MISSING, "required JLINK_HSS_* exports were not found");
      const helperPath = resolveHssHelperPath(env, this.options.helperPath);
      if (!existsSync(helperPath)) throw new HssError(HSS_ERROR.HSS_HELPER_MISSING, "native HSS helper was not found", { helperPath });
      const probe = this.probe.getCaptureConfig();
      const target = {
        device: input.device ?? probe?.device ?? "Z20K146MC",
        interface: input.interface ?? probe?.interface ?? "SWD",
        speedKhz: input.speedKhz ?? probe?.speed ?? 4000,
      } as const;
      const serial = input.serial ?? probe?.serialNumber;
      const capabilityInput = { ...input, device: target.device, interface: target.interface, speedKhz: target.speedKhz, serial };
      const capability = await hssCapabilityProbe(capabilityInput, { env, helperPath, helperArgsPrefix: this.options.helperArgsPrefix, cwd: this.cwd() });
      const hss = capability.hss as {
        getCapsOk?: boolean;
        targetWasHalted?: boolean;
      };
      const targetWasHaltedBeforeCapture = Boolean(hss.targetWasHalted);
      const warnings = targetWasHaltedBeforeCapture ? ["target reported halted during connect preflight; proceeding with read-only HSS capture per operator instruction"] : [];

      const plan = input.planId ? this.requirePlan(input.planId) : await buildHssCapturePlan(input, this.cwd(), true);
      this.plans.set(plan.planId, plan);
      const owner = `hss:${plan.output.captureId}`;
      if (!this.probe.acquireExclusive(owner)) throw new HssError(HSS_ERROR.HSS_CAPTURE_ACTIVE, `probe is already owned by ${this.probe.getExclusiveOwner() ?? "another operation"}`);
      const stopFile = join(plan.output.outputDir, "stop.request");
      await writeInitialMetadata({
        metadataFile: plan.output.metadataFile,
        captureId: plan.output.captureId,
        sessionName: input.sessionName ?? "hm_c095_hss",
        projectRoot: plan.projectRoot,
        artifact: plan.artifact,
        target,
        probe: { serial: input.serial ?? probe?.serialNumber, dllVersion: undefined, model: undefined },
        symbols: plan.symbols,
        requestedRateHz: plan.sampling.requestedRateHz,
        warnings,
      });
      await writeHelperPlan(plan.output.planFile, {
        captureId: plan.output.captureId,
        dllPath: discovery.selectedDllPath,
        startReadStopValidated: Boolean(hss.getCapsOk),
        targetWasHaltedBeforeCapture,
        device: target.device,
        interface: target.interface,
        speedKhz: target.speedKhz,
        serial,
        outputFile: plan.output.firstSegmentFile,
        stopFile,
        requestedRateHz: plan.sampling.requestedRateHz,
        durationSec: plan.sampling.durationSec,
        symbols: plan.symbols,
      });
      const child = spawn(helperPath, [...(this.options.helperArgsPrefix ?? []), "hss-capture", "--plan", plan.output.planFile], {
        windowsHide: true,
        env: { ...process.env, ...this.env() },
      });
      const active: ActiveCapture = {
        captureId: plan.output.captureId,
        owner,
        plan,
        metadataFile: plan.output.metadataFile,
        segmentFile: plan.output.firstSegmentFile,
        stopFile,
        child,
        stdout: "",
        stderr: "",
        done: Promise.resolve(),
      };
      active.done = new Promise((resolveDone) => {
        child.stdout.on("data", (data: Buffer) => { active.stdout += data.toString(); });
        child.stderr.on("data", (data: Buffer) => { active.stderr += data.toString(); });
        child.once("exit", (code) => {
          void this.finishActive(active, code).finally(resolveDone);
        });
        child.once("error", (error) => {
          active.stderr += error.message;
          void this.finishActive(active, -1).finally(resolveDone);
        });
      });
      this.active = active;
      return {
        captureId: plan.output.captureId,
        state: "capturing",
        backend: "jlink-hss",
        requestedRateHz: plan.sampling.requestedRateHz,
        durationSec: plan.sampling.durationSec,
        symbols: plan.symbols,
        outputDir: plan.output.outputDir,
        metadataFile: plan.output.metadataFile,
        segments: [plan.output.firstSegmentFile],
        safety: HSS_SAFETY_FALSE,
        targetWasHaltedBeforeCapture,
        warnings,
      };
    });
  }

  async captureStatus(input: { captureId: string }): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_status", input, async () => {
      const active = this.active?.captureId === input.captureId ? this.active : null;
      if (active) {
        const recordSize = 24 + active.plan.symbols.length * 4;
        const sampleCount = existsSync(active.segmentFile) ? Math.floor((await readFile(active.segmentFile)).length / recordSize) : 0;
        return {
          captureId: input.captureId,
          state: "capturing",
          elapsedSec: sampleCount / active.plan.sampling.requestedRateHz,
          requestedRateHz: active.plan.sampling.requestedRateHz,
          actualRateHz: 0,
          sampleCount,
          validSamples: sampleCount,
          readErrors: 0,
          timeouts: 0,
          overflows: 0,
          droppedSamples: 0,
          currentSegment: "capture_0001.bin",
          warnings: [],
        };
      }
      return hssCaptureStatusFromMetadata(this.metadataFor(input.captureId));
    });
  }

  async captureStop(input: { captureId: string }): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_stop", input, async () => {
      const active = this.active?.captureId === input.captureId ? this.active : null;
      if (!active) return hssCaptureStatusFromMetadata(this.metadataFor(input.captureId));
      await writeFile(active.stopFile, "stop", "utf8");
      await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, 30000))]);
      return hssCaptureStatusFromMetadata(active.metadataFile);
    });
  }

  async captureQuery(input: Parameters<typeof queryHssCapture>[0]): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_query", input, () => queryHssCapture(input, this.cwd()));
  }

  async captureExport(input: Parameters<typeof exportHssCapture>[0]): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_export", input, () => exportHssCapture(input, this.cwd()));
  }

  async dispose(): Promise<void> {
    if (!this.active) return;
    try {
      await writeFile(this.active.stopFile, "stop", "utf8");
      this.active.child.kill();
      await this.active.done;
    } finally {
      this.probe.releaseExclusive(this.active.owner);
      this.active = null;
    }
  }

  private async finishActive(active: ActiveCapture, code: number | null): Promise<void> {
    if (this.active?.captureId !== active.captureId) return;
    let state: "completed" | "stopped" | "failed" = "failed";
    let helperResult: Record<string, unknown> | undefined;
    let failure: string | undefined;
    try {
      helperResult = JSON.parse(active.stdout.trim() || "{}") as Record<string, unknown>;
      state = helperResult.status === "ok" ? "completed" : helperResult.status === "stopped" ? "stopped" : "failed";
      if (state === "failed") failure = String(helperResult.reason ?? helperResult.errorCode ?? `helper exited ${code}`);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      helperResult = { status: "error", errorCode: HSS_ERROR.HSS_HELPER_BAD_JSON, exitCode: code, stdout: active.stdout, stderr: active.stderr, reason: failure };
    }
    try {
      await finalizeMetadata({ metadataFile: active.metadataFile, state, segmentFile: active.segmentFile, helperResult, failure });
    } catch (error) {
      const text = await readFile(active.metadataFile, "utf8").catch(() => "{}");
      const metadata = JSON.parse(text) as Record<string, unknown>;
      metadata.state = "failed";
      metadata.failures = [...(Array.isArray(metadata.failures) ? metadata.failures : []), error instanceof Error ? error.message : String(error)];
      await writeFile(active.metadataFile, JSON.stringify(metadata, null, 2), "utf8");
    } finally {
      await appendHssAudit(this.sessionId, "hss_capture_status", { event: "capture_terminal", captureId: active.captureId }, {
        captureId: active.captureId,
        state,
        metadataFile: active.metadataFile,
        segmentFile: active.segmentFile,
        helperResult,
        failure,
      }, this.cwd()).catch(() => undefined);
      await rm(active.stopFile, { force: true });
      this.probe.releaseExclusive(active.owner);
      this.active = null;
    }
  }

  private requirePlan(planId: string): HssCapturePlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, `unknown HSS planId: ${planId}`);
    return plan;
  }

  private metadataFor(captureId: string): string {
    return join(hssProjectPaths(this.cwd()).capturesDir, captureId, "capture.json");
  }

  private cwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  private env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  private async wrap<T>(operation: Parameters<typeof hssOk<T>>[0], input: unknown, fn: () => Promise<T> | T): Promise<HssEnvelope<T>> {
    try {
      const data = await fn();
      const artifacts = artifactList(data);
      const envelope = hssOk(operation, data, artifacts, warningList(data));
      await appendHssAudit(this.sessionId, operation, input, envelope, this.cwd());
      return envelope;
    } catch (error) {
      const envelope = hssFail<T>(operation, error);
      await appendHssAudit(this.sessionId, operation, input, envelope, this.cwd());
      return envelope;
    }
  }
}

async function writeHelperPlan(file: string, plan: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(plan, null, 2), "utf8");
}

function artifactList(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const values = Object.values(data as Record<string, unknown>);
  const direct = values.filter((value): value is string => typeof value === "string" && /(?:capture\.json|capture_0001\.bin|\.csv)$/i.test(value));
  const nested = values.flatMap((value) => value && typeof value === "object" ? artifactList(value) : []);
  return [...new Set([...direct, ...nested])];
}

function warningList(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const warnings = (data as Record<string, unknown>).warnings;
  return Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === "string") : [];
}
