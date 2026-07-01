import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProbeBackend } from "../../probe/backend";
import { discoverHssDll, resolveHssHelperPath, type HssDllPreflightInput } from "../hss-dll/hss-dll-adapter";
import { appendHssAudit } from "./audit-log";
import { exportHssCapture, finalizeMetadata, hssCaptureStatusFromMetadata, hssCaptureStopFromMetadata, queryHssCapture, writeInitialMetadata } from "./hss-artifact";
import { hssCapabilityProbe } from "./hss-capability";
import type { HssCapturePlan, HssCapturePlanInput } from "./hss-plan";
import { buildHssCapturePlan } from "./hss-plan";
import { HSS_SAFETY_FALSE } from "./hss-contract";
import { appendHssWriteEvent, materializeHssCaptureEvents } from "./hss-events";
import { appendHssWriteFlagIntervals, materializeHssFlagIntervals } from "./hss-flag-overlay";
import { hssFail, hssOk, type HssEnvelope } from "./hss-envelope";
import { HSS_ERROR, HssError } from "./hss-errors";
import { ProbeHssVariableMemoryIo, type HssVariableMemoryIo } from "./hss-memory-io";
import { loadHssPolicy } from "./hss-policy";
import { createHssVariableWritePlan, HssWritePlanStore, type HssVariableWritePlan, type HssVariableWritePlanInput } from "./hss-write-plan";
import { executeHssVariableWritePlan, type HssVariableWriteExecuteInput, type HssVariableWriteExecuteResult } from "./hss-write-execute";
import { HssCaptureWriteQueue } from "./hss-write-queue";
import { assertNoMvpAWriteFlags, HSS_STATUS_FLAGS } from "./hss-status-flags";
import { assertInsideProject, ensureHssProjectDirs, hssProjectPaths } from "./project-paths";

export interface HssCaptureStartInput extends HssDllPreflightInput, HssCapturePlanInput {
  planId?: string;
}

export interface HssCaptureServiceOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  helperPath?: string;
  helperArgsPrefix?: string[];
  memoryIo?: HssVariableMemoryIo;
  targetEndian?: "little" | "big";
}

interface ActiveCapture {
  captureId: string;
  generation: number;
  owner: string;
  plan: HssCapturePlan;
  metadataFile: string;
  segmentFile: string;
  stopFile: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  writeQueue: HssCaptureWriteQueue;
  done: Promise<void>;
}

export class HssCaptureService {
  private readonly sessionId = randomUUID();
  private readonly plans = new Map<string, HssCapturePlan>();
  private readonly metadataFiles = new Map<string, string>();
  private readonly writePlans = new HssWritePlanStore();
  private readonly writeCounters = new Map<string, { ops: number; elements: number }>();
  private captureGeneration = 0;
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
      const probe = this.probe.getCaptureConfig();
      const capability = await hssCapabilityProbe({
        dllPath: input.dllPath,
        device: input.device ?? probe?.device,
        interface: input.interface ?? (probe?.interface as "SWD" | "JTAG" | undefined),
        speedKhz: input.speedKhz ?? probe?.speed,
        serial: input.serial ?? probe?.serialNumber,
      }, { env: this.env(), helperPath: this.options.helperPath, helperArgsPrefix: this.options.helperArgsPrefix, cwd: this.cwd() });
      enforceCapabilityRate(capability, input.requestedRateHz ?? 1000);
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
      enforceCapabilityRate(capability, plan.sampling.requestedRateHz);
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
        readMode: input.readMode ?? plan.readMode,
        resumeBeforeStart: input.resumeBeforeStart ?? plan.resumeBeforeStart,
        targetWasHaltedBeforeCapture,
        warnings,
      });
      this.metadataFiles.set(plan.output.captureId, plan.output.metadataFile);
      await writeHelperPlan(plan.output.planFile, {
        captureId: plan.output.captureId,
        dllPath: discovery.selectedDllPath,
        getCapsValidated: Boolean(hss.getCapsOk),
        startReadStopValidated: false,
        targetWasHaltedBeforeCapture,
        device: target.device,
        interface: target.interface,
        speedKhz: target.speedKhz,
        serial,
        readMode: input.readMode ?? plan.readMode,
        resumeBeforeStart: input.resumeBeforeStart ?? plan.resumeBeforeStart,
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
        generation: ++this.captureGeneration,
        owner,
        plan,
        metadataFile: plan.output.metadataFile,
        segmentFile: plan.output.firstSegmentFile,
        stopFile,
        child,
        stdout: "",
        stderr: "",
        writeQueue: new HssCaptureWriteQueue(),
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
        const quality = existsSync(active.segmentFile) ? activeQuality(await readFile(active.segmentFile), recordSize) : emptyLiveQuality();
        return {
          captureId: input.captureId,
          state: "capturing",
          ...quality,
          elapsedSec: quality.elapsedSec,
          requestedRateHz: active.plan.sampling.requestedRateHz,
          actualRateHz: quality.actualRateHz,
          sampling: {
            requestedRateHz: active.plan.sampling.requestedRateHz,
            hssIndexRateHz: quality.actualRateHz,
            hostObservedRateHz: quality.actualRateHz,
            helperReportedRateHz: 0,
            helperActualRateHz: 0,
            readMode: active.plan.readMode,
          },
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
      if (!active) return hssCaptureStopFromMetadata(this.metadataFor(input.captureId));
      active.writeQueue.beginStopping();
      await active.writeQueue.waitForIdle();
      await writeFile(active.stopFile, "stop", "utf8");
      await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, 30000))]);
      return hssCaptureStopFromMetadata(active.metadataFile);
    });
  }

  async captureQuery(input: Parameters<typeof queryHssCapture>[0]): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_query", input, () => queryHssCapture({ ...input, metadataFile: input.metadataFile ?? this.metadataFor(input.captureId) }, this.cwd()));
  }

  async captureExport(input: Parameters<typeof exportHssCapture>[0]): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_export", input, () => exportHssCapture({ ...input, metadataFile: input.metadataFile ?? this.metadataFor(input.captureId) }, this.cwd()));
  }

  async variableWritePlan(input: HssVariableWritePlanInput): Promise<HssEnvelope<HssVariableWritePlan>> {
    return this.wrap("variable_write_plan", input, async () => {
      const active = this.active?.captureId === input.captureId ? this.active : null;
      if (!active) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "active HSS capture was not found", { captureId: input.captureId });
      if (!active.plan.artifact.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "active HSS capture has no map file");
      const policy = await loadHssPolicy(this.cwd());
      return this.writePlans.put(createHssVariableWritePlan(input, {
        captureId: active.captureId,
        captureGeneration: active.generation,
        backend: "jlink-hss",
        mapFile: active.plan.artifact.mapFile,
        policy,
        ...this.writeCounts(active.captureId, input.targetRef?.path ?? input.target ?? ""),
      }));
    });
  }

  async variableWriteExecute(input: HssVariableWriteExecuteInput): Promise<HssEnvelope<HssVariableWriteExecuteResult>> {
    return this.wrap("variable_write_execute", input, async () => {
      const active = this.active;
      if (!active) throw new HssError(HSS_ERROR.CAPTURE_NOT_ACTIVE, "no active HSS capture");
      if (!active.plan.artifact.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "active HSS capture has no map file");
      const policy = await loadHssPolicy(this.cwd());
      const plan = this.writePlans.get(input.writePlanId, {
        captureId: active.captureId,
        captureGeneration: active.generation,
        policy,
        mapFile: active.plan.artifact.mapFile,
      });
      if (!plan.executable) throw new HssError(HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE, "write plan risk is not executable", { writePlanId: input.writePlanId, operationPlanRequired: true });
      return active.writeQueue.run(async () => {
        const io = this.options.memoryIo ?? new ProbeHssVariableMemoryIo(this.probe, active.owner);
        try {
          const result = await executeHssVariableWritePlan(plan, io, this.options.targetEndian ?? "little", Boolean(input.dryRun));
          if (!input.dryRun) {
            await appendHssWriteEvent(active.metadataFile, plan, result, true);
            await appendHssWriteFlagIntervals(active.metadataFile, { eventId: result.eventId, writeStartUs: result.writeStartUs, writeEndUs: result.writeEndUs, requestedRateHz: active.plan.sampling.requestedRateHz });
            await materializeHssCaptureEvents(active.metadataFile);
            await materializeHssFlagIntervals(active.metadataFile);
            this.consumeWrite(plan);
            this.writePlans.markExecuted(input.writePlanId);
          }
          return result;
        } catch (error) {
          if (error instanceof HssError && error.details.writeIssued === true) {
            const maybeResult = "writeId" in error.details ? error.details as unknown as HssVariableWriteExecuteResult : undefined;
            await appendHssWriteEvent(active.metadataFile, plan, maybeResult, false, error.code);
            if (maybeResult) await appendHssWriteFlagIntervals(active.metadataFile, { eventId: maybeResult.eventId, writeStartUs: maybeResult.writeStartUs, writeEndUs: maybeResult.writeEndUs, requestedRateHz: active.plan.sampling.requestedRateHz, backendBusy: error.code === HSS_ERROR.UNKNOWN_WRITE_STATE });
            await materializeHssCaptureEvents(active.metadataFile);
            await materializeHssFlagIntervals(active.metadataFile);
            this.consumeWrite(plan);
            this.writePlans.markExecuted(input.writePlanId);
          }
          throw error;
        }
      });
    });
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
      this.writePlans.invalidateCapture(active.captureId, active.generation);
      active.writeQueue.close();
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
    const known = this.metadataFiles.get(captureId);
    if (known) return known;
    const paths = hssProjectPaths(this.cwd());
    const metadataFile = join(paths.capturesDir, captureId, "capture.json");
    assertInsideProject(metadataFile, paths.capturesDir);
    return metadataFile;
  }

  private cwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  private env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  private writeCounts(captureId: string, path: string): { writeOpsUsed: number; elementsUsed: number } {
    const counter = this.writeCounters.get(`${captureId}:${path}`) ?? { ops: 0, elements: 0 };
    return { writeOpsUsed: counter.ops, elementsUsed: counter.elements };
  }

  private consumeWrite(plan: HssVariableWritePlan): void {
    const key = `${plan.captureId}:${plan.targetRef.path}`;
    const counter = this.writeCounters.get(key) ?? { ops: 0, elements: 0 };
    counter.ops += 1;
    counter.elements += plan.writeElementCount;
    this.writeCounters.set(key, counter);
  }

  private async wrap<T>(operation: Parameters<typeof hssOk<T>>[0], input: unknown, fn: () => Promise<T> | T): Promise<HssEnvelope<T>> {
    try {
      const data = await fn();
      const artifacts = artifactList(data);
      const envelope = hssOk(operation, data, artifacts, warningList(data));
      await this.safeAudit(operation, input, envelope);
      return envelope;
    } catch (error) {
      const envelope = hssFail<T>(operation, error);
      await this.safeAudit(operation, input, envelope);
      return envelope;
    }
  }

  private async safeAudit(operation: Parameters<typeof hssOk<unknown>>[0], input: unknown, envelope: HssEnvelope<unknown>): Promise<void> {
    try {
      await appendHssAudit(this.sessionId, operation, input, envelope, this.cwd());
    } catch (error) {
      envelope.warnings.push(`audit append failed: ${error instanceof Error ? error.message : String(error)}`);
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

function enforceCapabilityRate(capability: Record<string, unknown>, requestedRateHz: number): void {
  void capability;
  void requestedRateHz;
}

interface LiveQuality {
  sampleCount: number;
  validSamples: number;
  readErrors: number;
  timeouts: number;
  overflows: number;
  droppedSamples: number;
  elapsedSec: number;
  actualRateHz: number;
}

function emptyLiveQuality(): LiveQuality {
  return { sampleCount: 0, validSamples: 0, readErrors: 0, timeouts: 0, overflows: 0, droppedSamples: 0, elapsedSec: 0, actualRateHz: 0 };
}

function activeQuality(data: Buffer, recordSize: number): LiveQuality {
  const quality = emptyLiveQuality();
  quality.sampleCount = Math.floor(data.length / recordSize);
  if (quality.sampleCount >= 2) {
    const firstIndex = data.readBigUInt64LE(0);
    const firstTicks = data.readBigInt64LE(8);
    const lastOffset = (quality.sampleCount - 1) * recordSize;
    const lastIndex = data.readBigUInt64LE(lastOffset);
    const lastTicks = data.readBigInt64LE(lastOffset + 8);
    quality.elapsedSec = Math.max(0, Number(lastTicks - firstTicks) / 1_000_000_000);
    quality.actualRateHz = quality.elapsedSec > 0 ? Number(lastIndex - firstIndex) / quality.elapsedSec : 0;
  }
  for (let offset = 0; offset < quality.sampleCount * recordSize; offset += recordSize) {
    const flags = data.readUInt32LE(offset + 16);
    assertNoMvpAWriteFlags(flags);
    if ((flags & HSS_STATUS_FLAGS.valid) !== 0) quality.validSamples += 1;
    if ((flags & HSS_STATUS_FLAGS.read_error) !== 0) quality.readErrors += 1;
    if ((flags & HSS_STATUS_FLAGS.timeout) !== 0) quality.timeouts += 1;
    if ((flags & HSS_STATUS_FLAGS.overflow) !== 0) quality.overflows += 1;
    if ((flags & HSS_STATUS_FLAGS.dropped_before_this_sample) !== 0) quality.droppedSamples += 1;
  }
  return quality;
}
