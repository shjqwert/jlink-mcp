import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProbeBackend } from "../../probe/backend";
import {
  discoverHssDll,
  hssRuntimeIdentityMatches,
  refreshHssRuntimeIdentity,
  resolveHssScriptIdentity,
  resolveHssHelperPath,
  runHssHelperCommand,
  type HssDllPreflightInput,
  type HssRuntimeIdentity,
  type HssScriptIdentity,
} from "../hss-dll/hss-dll-adapter";
import { resolveHssDebugArtifact } from "./debug-artifact";
import { appendHssAudit } from "./audit-log";
import { exportHssCapture, finalizeMetadata, hssCaptureStatusFromMetadata, hssCaptureStopFromMetadata, queryHssCapture, readHssMetadata, writeInitialMetadata } from "./hss-artifact";
import { hssCapabilityProbe } from "./hss-capability";
import type { HssCapturePlan, HssCapturePlanInput } from "./hss-plan";
import { buildHssCapturePlan } from "./hss-plan";
import { HSS_SAFETY_FALSE, type HssCaptureMetadata } from "./hss-contract";
import { appendHssTargetControlEvent, appendHssWriteEvent, materializeHssCaptureEvents } from "./hss-events";
import { appendHssWriteFlagIntervals, materializeHssFlagIntervals } from "./hss-flag-overlay";
import { hssFail, hssOk, type HssEnvelope } from "./hss-envelope";
import { HSS_ERROR, HssError } from "./hss-errors";
import { HelperHssVariableMemoryIo, ProbeDirectHssVariableMemoryIo, type HssVariableMemoryIo } from "./hss-memory-io";
import { loadHssPolicy } from "./hss-policy";
import { createHssVariableWritePlan, HssWritePlanStore, type HssVariableWritePlan, type HssVariableWritePlanInput } from "./hss-write-plan";
import { executeHssVariableWritePlan, type HssVariableWriteExecuteInput, type HssVariableWriteExecuteResult } from "./hss-write-execute";
import { HssCaptureWriteQueue } from "./hss-write-queue";
import { assertNoMvpAWriteFlags, HSS_STATUS_FLAGS } from "./hss-status-flags";
import { assertInsideProject, ensureHssProjectDirs, hssProjectPaths } from "./project-paths";
import { resolveHssTargetIdentity, type HssTargetIdentityInput } from "./target-identity";

const OUTSIDE_CAPTURE_ID = "outside-capture";

export interface HssCaptureStartInput extends HssDllPreflightInput, HssCapturePlanInput {
  planId?: string;
}

export interface HssCaptureServiceOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  helperPath?: string;
  helperArgsPrefix?: string[];
  validatedDllSha256?: readonly string[];
  validatedRuntimeIdentitySha256?: readonly string[];
  validatedJlinkScriptSha256?: readonly string[];
  adapterPath?: string;
  memoryIo?: HssVariableMemoryIo;
  targetEndian?: "little" | "big";
  stopTimeoutMs?: number;
  cpuControlExecutor?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  targetStateReader?: (input: Record<string, unknown>) => Promise<{ halted: boolean; raw?: number }>;
}

interface ActiveCapture {
  captureId: string;
  generation: number;
  owner: string;
  plan: HssCapturePlan;
  metadataFile: string;
  segmentFile: string;
  stopFile: string;
  diagnosticFile: string;
  writeRequestFile: string;
  writeResponseFile: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  writeQueue: HssCaptureWriteQueue;
  startTimeUs: number;
  done: Promise<void>;
  stopTimedOut?: boolean;
  helperExited?: boolean;
  runtimeIdentity: HssRuntimeIdentity;
}

interface SampleAnchor {
  sampleIndex: number;
  captureTimeUs: number;
}

export class HssCaptureService {
  private readonly sessionId = randomUUID();
  private readonly plans = new Map<string, HssCapturePlan>();
  private readonly metadataFiles = new Map<string, string>();
  private readonly writePlans = new HssWritePlanStore();
  private readonly outsideWritePlanMapFiles = new Map<string, string>();
  private readonly writeCounters = new Map<string, { ops: number; elements: number }>();
  private captureGeneration = 0;
  private active: ActiveCapture | null = null;

  constructor(private readonly probe: ProbeBackend, private readonly options: HssCaptureServiceOptions = {}) {}

  async capabilityProbe(input: HssDllPreflightInput & HssTargetIdentityInput = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capability_probe", input, async () => {
      const targetIdentity = await resolveHssTargetIdentity(input, { cwd: this.cwd() });
      await ensureHssProjectDirs(this.cwd());
      return hssCapabilityProbe(input, {
        env: this.env(),
        helperPath: this.options.helperPath,
        helperArgsPrefix: this.options.helperArgsPrefix,
        validatedDllSha256: this.options.validatedDllSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        adapterPath: this.options.adapterPath,
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
        cwd: this.cwd(),
        targetIdentity,
      });
    });
  }

  async capturePlan(input: HssCapturePlanInput = {}): Promise<HssEnvelope<HssCapturePlan>> {
    return this.wrap("hss_capture_plan", input, async () => {
      const targetIdentity = await resolveHssTargetIdentity(input, { cwd: this.cwd() });
      await ensureHssProjectDirs(this.cwd());
      const probe = this.probe.getCaptureConfig();
      const capability = await hssCapabilityProbe({
        dllPath: input.dllPath ?? configuredJlinkDllPath(probe),
        device: targetIdentity.targetId,
        interface: input.interface ?? (probe?.interface as "SWD" | "JTAG" | undefined),
        speedKhz: input.speedKhz ?? probe?.speed,
        serial: input.serial ?? probe?.serialNumber,
        jlinkScriptFile: input.jlinkScriptFile,
        approvedJlinkScriptSha256: input.approvedJlinkScriptSha256,
      }, {
        env: this.env(),
        helperPath: this.options.helperPath,
        helperArgsPrefix: this.options.helperArgsPrefix,
        validatedDllSha256: this.options.validatedDllSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        adapterPath: this.options.adapterPath,
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
        cwd: this.cwd(),
        targetIdentity,
      });
      enforceCapabilityRate(capability, input.requestedRateHz ?? 1000);
      const startReady = Boolean((capability.hss as { startReadStopReady?: boolean }).startReadStopReady);
      const plan = await buildHssCapturePlan(input, this.cwd(), startReady, targetIdentity);
      await this.bindCapturePlan(plan, input, capability);
      this.plans.set(plan.planId, plan);
      return plan;
    });
  }

  async captureStart(input: HssCaptureStartInput = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_start", input, async () => {
      const env = this.env();
      if (this.active) throw new HssError(HSS_ERROR.HSS_CAPTURE_ACTIVE, "an HSS capture is already active", { captureId: this.active.captureId });
      const storedPlan = input.planId ? this.requirePlan(input.planId) : undefined;
      const targetIdentity = storedPlan && !hasTargetSelectionInput(input)
        ? storedPlan.target
        : await resolveHssTargetIdentity(input, { cwd: this.cwd() });
      if (storedPlan && storedPlan.target.targetId !== targetIdentity.targetId) {
        throw new HssError(HSS_ERROR.HSS_TARGET_SELECTION_REQUIRED, "HSS capture plan target does not match the selected target", {
          reason: "plan_target_mismatch",
          planTarget: storedPlan.target,
          selectedTarget: targetIdentity,
        });
      }
      const probe = this.probe.getCaptureConfig();
      const discovery = discoverHssDll({
        dllPath: input.dllPath ?? storedPlan?.runtimeIdentity?.dllPath ?? configuredJlinkDllPath(probe),
        device: targetIdentity.targetId,
        interface: input.interface,
        speedKhz: input.speedKhz,
        serial: input.serial,
      }, env, {
        validatedDllSha256: this.options.validatedDllSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        adapterPath: this.options.adapterPath,
      });
      if (!discovery.selectedDllPath) throw new HssError(HSS_ERROR.HSS_DLL_MISSING, "JLink_x64.dll was not found");
      if (discovery.architecture !== "x64") {
        throw new HssError(HSS_ERROR.HSS_DLL_ARCH_UNSUPPORTED, "the resolved J-Link DLL is not Windows x64", { discovery });
      }
      if (!discovery.exportsFound) throw new HssError(HSS_ERROR.HSS_DLL_EXPORTS_MISSING, "required JLINK_HSS_* exports were not found");
      if (!discovery.identityValidated) {
        throw new HssError(HSS_ERROR.HSS_DLL_IDENTITY_UNVALIDATED, "the resolved J-Link DLL identity has not passed the project validation suite", { discovery });
      }
      const helperPath = resolveHssHelperPath(env, this.options.helperPath);
      if (!existsSync(helperPath)) throw new HssError(HSS_ERROR.HSS_HELPER_MISSING, "native HSS helper was not found", { helperPath });
      const requestedDevice = requestedTarget(input);
      const target = {
        device: targetIdentity.targetId,
        targetId: targetIdentity.targetId,
        source: targetIdentity.source,
        confidence: targetIdentity.confidence,
        ...(targetIdentity.configurationSource ? { configurationSource: targetIdentity.configurationSource } : {}),
        ...(requestedDevice ? { requestedDevice } : {}),
        resolvedDevice: targetIdentity.targetId,
        interface: input.interface ?? probe?.interface ?? "SWD",
        speedKhz: input.speedKhz ?? probe?.speed ?? 4000,
      } as const;
      const serial = input.serial ?? probe?.serialNumber;
      const capabilityInput = {
        dllPath: input.dllPath ?? storedPlan?.runtimeIdentity?.dllPath ?? configuredJlinkDllPath(probe),
        device: targetIdentity.targetId,
        interface: target.interface,
        speedKhz: target.speedKhz,
        serial,
        jlinkScriptFile: input.jlinkScriptFile ?? storedPlan?.scriptIdentity?.path,
        approvedJlinkScriptSha256: input.approvedJlinkScriptSha256 ?? storedPlan?.scriptIdentity?.sha256,
      };
      const capability = await hssCapabilityProbe(capabilityInput, {
        env,
        helperPath,
        helperArgsPrefix: this.options.helperArgsPrefix,
        validatedDllSha256: this.options.validatedDllSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        adapterPath: this.options.adapterPath,
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
        cwd: this.cwd(),
        targetIdentity,
      });
      const runtimeIdentity = capability.runtimeIdentity as HssRuntimeIdentity;
      if (!runtimeIdentity?.validated) {
        throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_UNVALIDATED, "the reported DLL/helper/adapter identity tuple has not passed the project validation suite", { runtimeIdentity });
      }
      const hss = capability.hss as {
        getCapsOk?: boolean;
        targetWasHalted?: boolean;
        targetWasHaltedRaw?: number;
        unavailableCode?: string;
      };
      if (!hss.getCapsOk) {
        throw new HssError(HSS_ERROR.HSS_GETCAPS_FAILED, "JLINK_HSS_GetCaps did not validate the resolved DLL and target", {
          unavailableCode: hss.unavailableCode,
          getCaps: capability.getCaps,
        });
      }
      const plan = storedPlan ?? await buildHssCapturePlan(input, this.cwd(), true, targetIdentity);
      if (!storedPlan) await this.bindCapturePlan(plan, input, capability);
      if (!plan.scriptIdentity
          || plan.scriptIdentity.path !== runtimeIdentity.jlinkScriptFile
          || plan.scriptIdentity.sha256 !== runtimeIdentity.jlinkScriptSha256
          || plan.scriptIdentity.approvalSha256 !== runtimeIdentity.jlinkScriptApprovalSha256) {
        throw new HssError(HSS_ERROR.HSS_JLINK_SCRIPT_IDENTITY_CHANGED, "capture ScriptFile identity does not match the approved plan", { plan: plan.scriptIdentity, runtimeIdentity });
      }
      if (!plan.runtimeIdentity?.sha256 || plan.runtimeIdentity.sha256 !== runtimeIdentity.sha256) {
        throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "capture runtime identity does not match the approved plan", { plan: plan.runtimeIdentity, runtimeIdentity });
      }
      const targetWasHaltedBeforeCapture = Boolean(hss.targetWasHalted);
      const resumeBeforeStart = Boolean(input.resumeBeforeStart ?? false);
      const warnings: string[] = [];
      if (targetWasHaltedBeforeCapture && !resumeBeforeStart && !plan.resetBeforeCapture) {
        throw new HssError(HSS_ERROR.HSS_TARGET_HALTED, "target is halted before HSS capture start; pass resumeBeforeStart to resume explicitly", {
          targetWasHaltedBeforeCapture,
          targetWasHaltedRaw: hss.targetWasHaltedRaw,
          resumeBeforeStart,
          requestedDevice: target.requestedDevice,
          resolvedDevice: target.resolvedDevice,
        });
      }
      if (targetWasHaltedBeforeCapture && resumeBeforeStart && !plan.resetBeforeCapture) warnings.push("target was halted before capture and was explicitly resumed before HSS start");

      enforceCapabilityRate(capability, plan.sampling.requestedRateHz);
      this.plans.set(plan.planId, plan);
      if (plan.resetBeforeCapture) {
        if (!plan.resetOperation) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "resetBeforeCapture requires a bound R3 reset operation");
        if (plan.resetOperation.consumed) throw new HssError(HSS_ERROR.RESET_PLAN_ALREADY_EXECUTED, "reset operation plan is single-use", { planId: plan.resetOperation.planId });
        if (Date.now() > Date.parse(plan.resetOperation.expiresAt)) throw new HssError(HSS_ERROR.RESET_PLAN_EXPIRED, "reset operation plan expired", { expiresAt: plan.resetOperation.expiresAt });
      }
      const owner = `hss:${plan.output.captureId}`;
      const stopFile = join(plan.output.outputDir, "stop.request");
      const diagnosticFile = join(plan.output.outputDir, "capture.diag.json");
      const writeRequestFile = join(plan.output.outputDir, "write.request.json");
      const writeResponseFile = join(plan.output.outputDir, "write.response.json");
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
        targetWasHaltedRaw: hss.targetWasHaltedRaw,
        warnings,
        script: {
          ...plan.scriptIdentity,
          getCapsSelectionReturnCode: Number((capability.getCaps as Record<string, unknown> | undefined)?.jlinkScriptReturnCode ?? -1),
          noDefaultFallback: true,
        },
        reset: plan.resetBeforeCapture ? { operation: plan.resetOperation, stabilityPolicy: plan.stabilityPolicy, status: "planned" } : undefined,
      });
      this.metadataFiles.set(plan.output.captureId, plan.output.metadataFile);
      const resetResult = plan.resetBeforeCapture
        ? await this.executeResetBeforeCapture(plan, runtimeIdentity, plan.output.metadataFile, target, serial)
        : undefined;
      if (resetResult) {
        const metadata = await readHssMetadata(plan.output.metadataFile);
        metadata.reset = { ...metadata.reset, status: "completed", result: resetResult };
        await writeFile(plan.output.metadataFile, JSON.stringify(metadata, null, 2), "utf8");
      }
      if (!this.probe.acquireExclusive(owner)) throw new HssError(HSS_ERROR.HSS_CAPTURE_ACTIVE, `probe is already owned by ${this.probe.getExclusiveOwner() ?? "another operation"}`);
      const launchIdentity = refreshHssRuntimeIdentity(runtimeIdentity, {
        env,
        helperPath,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        adapterPath: this.options.adapterPath,
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, launchIdentity)) {
        this.probe.releaseExclusive(owner);
        throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "DLL/helper/adapter identity changed before capture helper launch", { runtimeIdentity: launchIdentity });
      }
      await writeHelperPlan(plan.output.planFile, {
        captureId: plan.output.captureId,
        dllPath: discovery.selectedDllPath,
        approvedDllSha256: launchIdentity.dllSha256,
        runtimeIdentityValidated: launchIdentity.validated,
        getCapsValidated: Boolean(hss.getCapsOk),
        startReadStopValidated: true,
        runtimeIdentity: launchIdentity,
        jlinkScriptFile: plan.scriptIdentity.path,
        approvedJlinkScriptSha256: plan.scriptIdentity.sha256,
        jlinkScriptApprovalSha256: plan.scriptIdentity.approvalSha256,
        resetBeforeCapture: plan.resetBeforeCapture,
        requireFirstSampleIndexZero: plan.resetBeforeCapture,
        targetWasHaltedBeforeCapture,
        device: target.device,
        interface: target.interface,
        speedKhz: target.speedKhz,
        serial,
        readMode: input.readMode ?? plan.readMode,
        resumeBeforeStart: input.resumeBeforeStart ?? plan.resumeBeforeStart,
        outputFile: plan.output.firstSegmentFile,
        stopFile,
        diagnosticFile,
        writeRequestFile,
        writeResponseFile,
        requestedRateHz: plan.sampling.requestedRateHz,
        durationSec: plan.sampling.durationSec,
        target: targetIdentity,
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
        diagnosticFile,
        writeRequestFile,
        writeResponseFile,
        child,
        stdout: "",
        stderr: "",
        writeQueue: new HssCaptureWriteQueue(),
        startTimeUs: Date.now() * 1000,
        done: Promise.resolve(),
        runtimeIdentity: launchIdentity,
      };
      active.done = new Promise((resolveDone) => {
        child.stdout.on("data", (data: Buffer) => { active.stdout += data.toString(); });
        child.stderr.on("data", (data: Buffer) => { active.stderr += data.toString(); });
        child.once("exit", (code) => {
          active.helperExited = true;
          void this.finishActive(active, code).finally(resolveDone);
        });
        child.once("error", (error) => {
          active.stderr += error.message;
          active.helperExited = true;
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
        target: targetIdentity,
        runtimeIdentity: launchIdentity,
        symbols: plan.symbols,
        outputDir: plan.output.outputDir,
        metadataFile: plan.output.metadataFile,
        segments: [plan.output.firstSegmentFile],
        safety: HSS_SAFETY_FALSE,
        targetWasHaltedBeforeCapture,
        targetWasHaltedRaw: hss.targetWasHaltedRaw,
        warnings,
        resetBeforeCapture: plan.resetBeforeCapture,
        reset: resetResult,
        risk: plan.resetBeforeCapture ? "R3" : "R1",
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
      if (!await raceWithTimeout(active.done, this.options.stopTimeoutMs ?? 30000)) {
        active.stopTimedOut = true;
        active.child.kill();
        await active.done;
      }
      return hssCaptureStopFromMetadata(active.metadataFile);
    });
  }

  async cpuControl(operation: "halt" | "resume" | "reset", input: { halt?: boolean } = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap(operation, input, async () => {
      if (this.probe.type !== "jlink") throw new HssError(HSS_ERROR.CPU_CONTROL_FAILED, "CPU control is supported only through the J-Link main backend");
      if (this.active && (operation === "halt" || operation === "reset")) {
        throw new HssError(HSS_ERROR.CAPTURE_CONFLICT, `${operation} conflicts with an active HSS capture`, { captureId: this.active.captureId, operation });
      }
      const probe = this.probe.getCaptureConfig();
      if (!probe?.device || probe.device === "Unspecified") throw new HssError(HSS_ERROR.HSS_DEVICE_REQUIRED, "CPU control requires an explicitly configured J-Link target device");
      const targetIdentity = await resolveHssTargetIdentity({ device: probe.device }, { cwd: this.cwd() });
      const script = resolveHssScriptIdentity({}, this.env(), {
        cwd: this.cwd(),
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
      });
      if (!script.validated) throw new HssError(HSS_ERROR.HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED, script.reason ?? "trusted J-Link ScriptFile identity is required");
      const capability = await hssCapabilityProbe({
        dllPath: configuredJlinkDllPath(probe),
        device: targetIdentity.targetId,
        interface: probe?.interface,
        speedKhz: probe?.speed,
        serial: probe?.serialNumber,
        jlinkScriptFile: script.path,
        approvedJlinkScriptSha256: script.sha256,
      }, {
        env: this.env(),
        helperPath: this.options.helperPath,
        helperArgsPrefix: this.options.helperArgsPrefix,
        validatedDllSha256: this.options.validatedDllSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
        adapterPath: this.options.adapterPath,
        cwd: this.cwd(),
        targetIdentity,
      });
      const runtimeIdentity = capability.runtimeIdentity as HssRuntimeIdentity;
      if (!runtimeIdentity?.validated) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_UNVALIDATED, "CPU control runtime identity is not validated");
      const resolvedArtifact = this.active
        ? { sha256: this.active.plan.artifact.sha256, symbols: this.active.plan.symbols }
        : await resolveHssDebugArtifact({ symbols: [{ name: "g_hssDbgCounterFocIsr", type: "uint32" }], cwd: this.cwd() });
      const policy = await loadHssPolicy(this.cwd());
      const createdAt = new Date();
      const binding = {
        operation,
        arguments: operation === "reset" ? { halt: input.halt === true } : {},
        risk: "R3" as const,
        planId: `cp_${randomUUID()}`,
        captureId: this.active?.captureId ?? OUTSIDE_CAPTURE_ID,
        targetId: targetIdentity.targetId,
        artifactSha256: resolvedArtifact.sha256,
        layoutSha256: this.active ? hssLayoutSha256(this.active.plan) : createHash("sha256").update(JSON.stringify(resolvedArtifact.symbols)).digest("hex"),
        policySha256: policy.policyHash,
        runtimeIdentitySha256: runtimeIdentity.sha256!,
        scriptApprovalSha256: runtimeIdentity.jlinkScriptApprovalSha256!,
        sessionId: this.sessionId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + 60000).toISOString(),
        ttlMs: 60000,
        operationDigest: "",
        consumed: false,
      };
      binding.operationDigest = createHash("sha256").update(JSON.stringify({ ...binding, operationDigest: undefined, consumed: undefined })).digest("hex");
      if (Date.now() > Date.parse(binding.expiresAt)) throw new HssError(HSS_ERROR.RESET_PLAN_EXPIRED, "CPU-control operation plan expired", { planId: binding.planId });
      const executionIdentity = refreshHssRuntimeIdentity(runtimeIdentity, {
        env: this.env(),
        helperPath: runtimeIdentity.helperPath,
        adapterPath: runtimeIdentity.adapterPath,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, executionIdentity)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "CPU-control runtime identity changed before hardware access");
      binding.consumed = true;
      const request = {
        operation,
        halt: operation === "reset" ? input.halt === true : undefined,
        binding,
        runtimeIdentity: executionIdentity,
        target: { device: targetIdentity.targetId, interface: probe?.interface ?? "SWD", speedKhz: probe?.speed ?? 4000 },
        serial: probe?.serialNumber,
        scriptIdentity: { path: runtimeIdentity.jlinkScriptFile!, sha256: runtimeIdentity.jlinkScriptSha256!, approvalSha256: runtimeIdentity.jlinkScriptApprovalSha256!, approvalSource: script.approvalSource! },
      };
      const result = this.options.cpuControlExecutor
        ? await this.options.cpuControlExecutor(request)
        : await runHssHelperCommand("cpu-control", cpuControlHelperArgs(request), {
          env: this.env(),
          helperPath: runtimeIdentity.helperPath,
          helperArgsPrefix: this.options.helperArgsPrefix,
        });
      if (result.status !== "ok") throw new HssError(HSS_ERROR.CPU_CONTROL_FAILED, String(result.reason ?? `${operation} failed`), { result, binding });
      if (!this.options.cpuControlExecutor && !helperReportedIdentityMatches(result, executionIdentity)) {
        throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "CPU-control helper reported a different runtime or ScriptFile identity", { binding, result });
      }
      const postIdentity = refreshHssRuntimeIdentity(runtimeIdentity, {
        env: this.env(),
        helperPath: runtimeIdentity.helperPath,
        adapterPath: runtimeIdentity.adapterPath,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, postIdentity)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "CPU-control runtime identity changed after hardware access", { binding, result });
      const event = this.active
        ? await appendHssTargetControlEvent(this.active.metadataFile, {
          operation,
          result: "succeeded",
          captureId: this.active.captureId,
          operationDigest: binding.operationDigest,
          beforeState: result.beforeState ?? "unknown",
          afterState: result.afterState ?? "unknown",
          startUs: Date.now() * 1000,
          endUs: Date.now() * 1000,
        })
        : undefined;
      return { operation, risk: "R3", binding, result, runtimeIdentity: postIdentity, scriptIdentity: script, eventId: event?.eventId };
    });
  }

  async captureQuery(input: Parameters<typeof queryHssCapture>[0]): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_query", input, () => queryHssCapture({ ...input, metadataFile: input.metadataFile ?? this.metadataFor(input.captureId) }, this.cwd()));
  }

  async captureExport(input: Parameters<typeof exportHssCapture>[0]): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_export", input, () => exportHssCapture({ ...input, metadataFile: input.metadataFile ?? this.metadataFor(input.captureId) }, this.cwd()));
  }

  async sessionRecover(input: { captureId?: string } = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_session_recover", input, async () => {
      const paths = hssProjectPaths(this.cwd());
      const captureIds = input.captureId ? [input.captureId] : await readdir(paths.capturesDir).catch(() => []);
      const recovered: Array<Record<string, unknown>> = [];
      const skipped: Array<Record<string, unknown>> = [];
      for (const captureId of captureIds) {
        const metadataFile = join(paths.capturesDir, captureId, "capture.json");
        assertInsideProject(metadataFile, paths.capturesDir);
        if (!existsSync(metadataFile)) {
          skipped.push({ captureId, reason: "metadata_missing" });
          continue;
        }
        const metadata = await readHssMetadata(metadataFile);
        if (!isAbandonedMetadata(metadata)) {
          skipped.push({ captureId, reason: "not_abandoned" });
          continue;
        }
        const reason = "capture abandoned by previous process";
        metadata.failures.push(reason);
        metadata.warnings.push("session recovered as abandoned");
        metadata.events.push({ type: "helperResult", helperResult: { status: "error", errorCode: HSS_ERROR.HSS_SESSION_ABANDONED, reason } });
        await writeFile(metadataFile, JSON.stringify(metadata, null, 2), "utf8");
        this.metadataFiles.set(captureId, metadataFile);
        recovered.push({ captureId, state: metadata.state, metadataFile, reason });
      }
      return { recovered: recovered.length, skipped: skipped.length, sessions: recovered, skippedSessions: skipped };
    });
  }

  async variableWritePlan(input: HssVariableWritePlanInput): Promise<HssEnvelope<HssVariableWritePlan>> {
    return this.wrap("variable_write_plan", input, async () => {
      if (!input.captureId) {
        if (this.active) throw new HssError(HSS_ERROR.ACTIVE_CAPTURE_WRITE_REQUIRES_CAPTURE_QUEUE, "active HSS capture writes require captureId and queue ownership");
        return this.createOutsideWritePlan(input);
      }
      const active = this.active?.captureId === input.captureId ? this.active : null;
      if (!active) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "active HSS capture was not found", { captureId: input.captureId });
      assertActiveWritable(active);
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
      if (!active) return this.executeOutsideWrite(input);
      const writePlanId = input.writePlanId;
      if (!writePlanId) throw new HssError(HSS_ERROR.ACTIVE_CAPTURE_WRITE_REQUIRES_CAPTURE_QUEUE, "active HSS capture writes require a queued write plan");
      assertActiveWritable(active);
      if (!active.plan.artifact.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "active HSS capture has no map file");
      const policy = await loadHssPolicy(this.cwd());
      const plan = this.writePlans.get(writePlanId, {
        captureId: active.captureId,
        captureGeneration: active.generation,
        policy,
        mapFile: active.plan.artifact.mapFile,
      });
      if (!plan.executable) throw new HssError(HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE, "write plan risk is not executable", { writePlanId: input.writePlanId, operationPlanRequired: true });
      if (!this.options.memoryIo && plan.targetRef.kind !== "scalar") {
        throw new HssError(HSS_ERROR.SYMBOL_KIND_UNSUPPORTED, "native helper capture-time writes support scalar targets only", { targetRef: plan.targetRef });
      }
      return active.writeQueue.run(async () => {
        assertActiveWritable(active);
        const io = this.options.memoryIo ?? new HelperHssVariableMemoryIo(active.writeRequestFile, active.writeResponseFile, active.captureId);
        try {
          const result = await executeHssVariableWritePlan(plan, io, this.options.targetEndian ?? "little", Boolean(input.dryRun), (stage) => active.writeQueue.setStage(stage));
          await this.attachSampleIndex(active, result);
          if (!input.dryRun) {
            active.writeQueue.setStage("EVENT_APPEND");
            await appendHssWriteEvent(active.metadataFile, plan, result, true);
            active.writeQueue.setStage("FLAG_APPEND");
            await appendHssWriteFlagIntervals(active.metadataFile, { eventId: result.eventId, writeStartUs: this.captureTimeUs(active, result), writeEndUs: this.captureTimeUs(active, result) + Math.max(1, result.writeEndUs - result.writeStartUs), requestedRateHz: active.plan.sampling.requestedRateHz });
            await materializeHssCaptureEvents(active.metadataFile);
            await materializeHssFlagIntervals(active.metadataFile);
            this.consumeWrite(plan);
            this.writePlans.markExecuted(writePlanId);
          }
          result.queueStages = active.writeQueue.history();
          return result;
        } catch (error) {
          if (error instanceof HssError && error.details.writeIssued === true) {
            const maybeResult = "writeId" in error.details ? error.details as unknown as HssVariableWriteExecuteResult : undefined;
            if (maybeResult) await this.attachSampleIndex(active, maybeResult);
            active.writeQueue.setStage("EVENT_APPEND");
            await appendHssWriteEvent(active.metadataFile, plan, maybeResult, false, error.code);
            active.writeQueue.setStage("FLAG_APPEND");
            if (maybeResult) await appendHssWriteFlagIntervals(active.metadataFile, { eventId: maybeResult.eventId, writeStartUs: this.captureTimeUs(active, maybeResult), writeEndUs: this.captureTimeUs(active, maybeResult) + Math.max(1, maybeResult.writeEndUs - maybeResult.writeStartUs), requestedRateHz: active.plan.sampling.requestedRateHz, backendBusy: error.code === HSS_ERROR.UNKNOWN_WRITE_STATE });
            await materializeHssCaptureEvents(active.metadataFile);
            await materializeHssFlagIntervals(active.metadataFile);
            if (maybeResult) maybeResult.queueStages = active.writeQueue.history();
            this.consumeWrite(plan);
            this.writePlans.markExecuted(writePlanId);
          }
          throw error;
        }
      });
    });
  }

  async dispose(): Promise<void> {
    const active = this.active;
    if (!active) return;
    try {
      await writeFile(active.stopFile, "stop", "utf8");
      active.child.kill();
      await active.done;
    } finally {
      this.probe.releaseExclusive(active.owner);
      if (this.active?.captureId === active.captureId) this.active = null;
    }
  }

  private async createOutsideWritePlan(input: HssVariableWritePlanInput): Promise<HssVariableWritePlan> {
    const path = outsideScalarTargetPath(input);
    const artifact = await resolveHssDebugArtifact({
      artifactFile: input.artifactFile,
      mapFile: input.mapFile,
      symbols: [{ name: path, type: input.type }],
      cwd: this.cwd(),
    });
    if (!artifact.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "write target map file was not found");
    const policy = await loadHssPolicy(this.cwd());
    const plan = this.writePlans.put(createHssVariableWritePlan(input, {
      captureId: OUTSIDE_CAPTURE_ID,
      captureGeneration: 0,
      backend: "jlink-hss",
      mapFile: artifact.mapFile,
      policy,
      willEnterCaptureQueue: false,
      ...this.writeCounts(OUTSIDE_CAPTURE_ID, path),
    }));
    this.outsideWritePlanMapFiles.set(plan.writePlanId, artifact.mapFile);
    return plan;
  }

  private async executeOutsideWrite(input: HssVariableWriteExecuteInput): Promise<HssVariableWriteExecuteResult> {
    const policy = await loadHssPolicy(this.cwd());
    const storedMapFile = input.writePlanId ? this.outsideWritePlanMapFiles.get(input.writePlanId) : undefined;
    if (input.writePlanId && !storedMapFile) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "outside-capture write plan was not found", { writePlanId: input.writePlanId });
    const plan = input.writePlanId
      ? this.writePlans.get(input.writePlanId, {
        captureId: OUTSIDE_CAPTURE_ID,
        captureGeneration: 0,
        policy,
        mapFile: storedMapFile!,
      })
      : await this.createOutsideWritePlan(input);
    const io = this.options.memoryIo ?? new ProbeDirectHssVariableMemoryIo(this.probe, this.options.targetEndian ?? "little");
    try {
      const result = await executeHssVariableWritePlan(plan, io, this.options.targetEndian ?? "little", Boolean(input.dryRun));
      if (!input.dryRun) {
        this.consumeWrite(plan);
        this.writePlans.markExecuted(plan.writePlanId);
      }
      return result;
    } catch (error) {
      if (error instanceof HssError && error.details.writeIssued === true) {
        this.writePlans.markExecuted(plan.writePlanId);
      }
      throw error;
    }
  }

  private async finishActive(active: ActiveCapture, code: number | null): Promise<void> {
    if (this.active?.captureId !== active.captureId) return;
    let state: "completed" | "stopped" | "failed" = "failed";
    let helperResult: Record<string, unknown> | undefined;
    let failure: string | undefined;
    if (active.stopTimedOut) {
      failure = "capture stop timed out; helper was killed";
      helperResult = { status: "error", errorCode: HSS_ERROR.HSS_CAPTURE_STOP_TIMEOUT, reason: failure, exitCode: code, stdout: active.stdout, stderr: active.stderr };
    } else {
      try {
        helperResult = JSON.parse(active.stdout.trim() || "{}") as Record<string, unknown>;
        state = helperResult.status === "ok" ? "completed" : helperResult.status === "stopped" ? "stopped" : "failed";
        if (state === "failed") failure = String(helperResult.reason ?? helperResult.errorCode ?? `helper exited ${code}`);
        else if (helperResult.lifecycleValidated !== true) {
          state = "failed";
          failure = "Start/Read/Stop lifecycle validation did not complete successfully";
          helperResult = { ...helperResult, status: "error", errorCode: HSS_ERROR.HSS_LIFECYCLE_VALIDATION_FAILED, reason: failure };
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        helperResult = { status: "error", errorCode: HSS_ERROR.HSS_HELPER_BAD_JSON, exitCode: code, stdout: active.stdout, stderr: active.stderr, reason: failure };
      }
    }
    const postIdentity = refreshHssRuntimeIdentity(active.runtimeIdentity, {
      env: this.env(),
      helperPath: active.runtimeIdentity.helperPath,
      validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
      adapterPath: active.runtimeIdentity.adapterPath,
    });
    const helperIdentityMatches = active.stopTimedOut || (helperResult?.helperVersion === active.runtimeIdentity.helperVersion
      && helperResult?.helperProtocolVersion === active.runtimeIdentity.helperProtocolVersion
      && String(helperResult?.dllVersion ?? "") === active.runtimeIdentity.dllVersion
      && helperResult?.jlinkScriptFile === active.runtimeIdentity.jlinkScriptFile
      && helperResult?.jlinkScriptSha256 === active.runtimeIdentity.jlinkScriptSha256
      && helperResult?.jlinkScriptReturnCode === 0);
    if (!hssRuntimeIdentityMatches(active.runtimeIdentity, postIdentity) || !helperIdentityMatches) {
      state = "failed";
      failure = "DLL/helper/adapter identity changed or helper-reported versions did not match after capture";
      helperResult = {
        ...helperResult,
        status: "error",
        errorCode: HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED,
        reason: failure,
      };
    }
    const diagnostic = await readHelperDiagnostic(active.diagnosticFile);
    helperResult = { ...helperResult, runtimeIdentity: postIdentity, ...(diagnostic ? { diagnostic } : {}) };
    try {
      if (active.plan.resetBeforeCapture && helperResult.lifecycleValidated === true) {
        await appendHssTargetControlEvent(active.metadataFile, {
          type: "capture_lifecycle",
          captureId: active.captureId,
          state,
          resetPlanId: active.plan.resetOperation?.planId,
          resetOperationDigest: active.plan.resetOperation?.operationDigest,
          startUs: active.startTimeUs,
          endUs: Date.now() * 1000,
          lifecycleValidated: true,
        });
      }
      const metadata = await finalizeMetadata({ metadataFile: active.metadataFile, state, segmentFile: active.segmentFile, helperResult, failure });
      if (state !== "failed") {
        const validationErrorCode = metadata.failures.length > 0
          ? HSS_ERROR.HSS_DECODE_VALIDATION_FAILED
          : metadata.semanticValidationStatus === "failed" || metadata.payloadValidationStatus === "failed"
            ? HSS_ERROR.HSS_SEMANTIC_VALIDATION_FAILED
            : undefined;
        if (validationErrorCode) {
          state = "failed";
          failure = validationErrorCode === HSS_ERROR.HSS_DECODE_VALIDATION_FAILED
            ? "decoded HSS record sequence failed validation"
            : "decoded HSS values, order, timebase, or payload semantics failed validation";
          helperResult = { ...helperResult, status: "error", errorCode: validationErrorCode, reason: failure };
          metadata.state = "failed";
          metadata.failures.push(failure);
          metadata.events.push({ type: "helperResult", helperResult });
          await writeFile(active.metadataFile, JSON.stringify(metadata, null, 2), "utf8");
        }
      }
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

  private async attachSampleIndex(active: ActiveCapture, result: HssVariableWriteExecuteResult): Promise<void> {
    const hostStartUs = result.hostWriteStartUs ?? result.writeStartUs;
    const hostEndUs = result.hostWriteEndUs ?? result.writeEndUs;
    const fallbackStartUs = Math.max(0, hostStartUs - active.startTimeUs);
    const fallbackEndUs = Math.max(fallbackStartUs, hostEndUs - active.startTimeUs);
    const anchor = await readSampleAnchor(active, fallbackStartUs).catch(() => null);
    if (anchor) {
      const durationUs = Math.max(1, hostEndUs - hostStartUs);
      result.captureWriteStartUs = anchor.captureTimeUs;
      result.captureWriteEndUs = anchor.captureTimeUs + durationUs;
      result.sampleIndexNear = anchor.sampleIndex;
      return;
    }
    result.captureWriteStartUs = fallbackStartUs;
    result.captureWriteEndUs = fallbackEndUs;
    result.sampleIndexNear = Math.max(0, Math.round(fallbackStartUs * active.plan.sampling.requestedRateHz / 1_000_000));
  }

  private captureTimeUs(active: ActiveCapture, result: HssVariableWriteExecuteResult): number {
    return result.captureWriteStartUs ?? Math.max(0, (result.hostWriteStartUs ?? result.writeStartUs) - active.startTimeUs);
  }

  private async bindCapturePlan(plan: HssCapturePlan, input: HssCapturePlanInput, capability: Record<string, unknown>): Promise<void> {
    const runtimeIdentity = capability.runtimeIdentity as HssRuntimeIdentity | undefined;
    if (!runtimeIdentity?.validated || !runtimeIdentity.jlinkScriptFile || !runtimeIdentity.jlinkScriptSha256 || !runtimeIdentity.jlinkScriptApprovalSha256) {
      const preflight = capability.preflight as Record<string, unknown> | undefined;
      const script = preflight?.scriptIdentity as HssScriptIdentity | undefined;
      throw new HssError((script?.errorCode as keyof typeof HSS_ERROR | undefined) && HSS_ERROR[script!.errorCode as keyof typeof HSS_ERROR]
        ? HSS_ERROR[script!.errorCode as keyof typeof HSS_ERROR]
        : HSS_ERROR.HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED, script?.reason ?? "trusted J-Link ScriptFile identity is required before HSS planning", { runtimeIdentity, preflight });
    }
    const preflight = capability.preflight as Record<string, unknown>;
    const script = preflight.scriptIdentity as HssScriptIdentity;
    plan.scriptIdentity = {
      path: runtimeIdentity.jlinkScriptFile,
      sha256: runtimeIdentity.jlinkScriptSha256,
      approvalSha256: runtimeIdentity.jlinkScriptApprovalSha256,
      approvalSource: script.approvalSource ?? "trusted-allowlist",
    };
    plan.runtimeIdentity = runtimeIdentity;
    if (!plan.resetBeforeCapture) return;
    const policy = await loadHssPolicy(this.cwd());
    const ttlMs = input.resetPlanTtlMs ?? 60000;
    const createdAtMs = Date.now();
    const binding = {
      operation: "reset" as const,
      risk: "R3" as const,
      planId: `rp_${randomUUID()}`,
      captureId: plan.output.captureId,
      targetId: plan.target.targetId,
      artifactSha256: plan.artifact.sha256,
      layoutSha256: hssLayoutSha256(plan),
      policySha256: policy.policyHash,
      runtimeIdentitySha256: runtimeIdentity.sha256!,
      scriptApprovalSha256: runtimeIdentity.jlinkScriptApprovalSha256,
      sessionId: this.sessionId,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
      ttlMs,
      operationDigest: "",
      consumed: false,
    };
    binding.operationDigest = resetBindingDigest(binding);
    plan.resetOperation = binding;
  }

  private async executeResetBeforeCapture(plan: HssCapturePlan, runtimeIdentity: HssRuntimeIdentity, metadataFile: string, target: { device: string; interface: "SWD" | "JTAG"; speedKhz: number }, serial?: string): Promise<Record<string, unknown>> {
    const binding = plan.resetOperation;
    if (!binding) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "resetBeforeCapture requires a bound R3 reset operation");
    if (binding.consumed) throw new HssError(HSS_ERROR.RESET_PLAN_ALREADY_EXECUTED, "reset operation plan is single-use", { planId: binding.planId });
    if (Date.now() > Date.parse(binding.expiresAt)) throw new HssError(HSS_ERROR.RESET_PLAN_EXPIRED, "reset operation plan expired", { expiresAt: binding.expiresAt });
    const policy = await loadHssPolicy(this.cwd());
    const currentDigest = resetBindingDigest(binding);
    if (binding.targetId !== plan.target.targetId
        || binding.artifactSha256 !== plan.artifact.sha256
        || binding.layoutSha256 !== hssLayoutSha256(plan)
        || binding.policySha256 !== policy.policyHash
        || binding.runtimeIdentitySha256 !== runtimeIdentity.sha256
        || binding.scriptApprovalSha256 !== plan.scriptIdentity?.approvalSha256
        || binding.sessionId !== this.sessionId
        || binding.captureId !== plan.output.captureId
        || binding.operationDigest !== currentDigest) {
      throw new HssError(HSS_ERROR.RESET_PLAN_BINDING_MISMATCH, "reset operation binding changed before execution", { planId: binding.planId });
    }
    binding.consumed = true;
    const resetStartedUs = Date.now() * 1000;
    let result: Record<string, unknown> = {};
    try {
      const before = refreshHssRuntimeIdentity(runtimeIdentity, {
        env: this.env(),
        helperPath: runtimeIdentity.helperPath,
        adapterPath: runtimeIdentity.adapterPath,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, before)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "runtime or ScriptFile identity changed before reset");
      const request = {
        operation: "reset",
        halt: false,
        resetBeforeCapture: true,
        binding,
        runtimeIdentity: before,
        target,
        serial,
        scriptIdentity: plan.scriptIdentity,
      };
      result = this.options.cpuControlExecutor
        ? await this.options.cpuControlExecutor(request)
        : await runHssHelperCommand("cpu-control", cpuControlHelperArgs(request), {
          env: this.env(),
          helperPath: runtimeIdentity.helperPath,
          helperArgsPrefix: this.options.helperArgsPrefix,
          timeoutMs: plan.stabilityPolicy.timeoutMs,
        });
      if (result.status !== "ok" || result.targetReset !== true || result.resetIssued !== true) {
        throw new HssError(HSS_ERROR.RESET_FAILED, String(result.reason ?? "J-Link reset failed"), { result });
      }
      if (!this.options.cpuControlExecutor && !helperReportedIdentityMatches(result, before)) {
        throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "reset helper reported a different runtime or ScriptFile identity", { result });
      }
      const after = refreshHssRuntimeIdentity(runtimeIdentity, {
        env: this.env(),
        helperPath: runtimeIdentity.helperPath,
        adapterPath: runtimeIdentity.adapterPath,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, after)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "runtime or ScriptFile identity changed after reset");
      const stability = await this.waitForTargetStability(plan, runtimeIdentity, target, serial);
      const resetEndedUs = Date.now() * 1000;
      const auditFile = await appendHssAudit(this.sessionId, "reset", binding, { ok: true, risk: { level: "R3" }, data: { ...result, ...stability, policyHash: binding.policySha256, symbolLayoutHash: binding.layoutSha256 } }, this.cwd());
      const event = await appendHssTargetControlEvent(metadataFile, {
        operation: "reset",
        result: "succeeded",
        captureId: plan.output.captureId,
        resetBeforeCapture: true,
        startUs: resetStartedUs,
        endUs: resetEndedUs,
        beforeState: result.beforeState ?? "unknown",
        afterState: result.afterState ?? "running",
        operationDigest: binding.operationDigest,
        targetId: binding.targetId,
        artifactSha256: binding.artifactSha256,
        layoutSha256: binding.layoutSha256,
        policySha256: binding.policySha256,
        sessionId: binding.sessionId,
        expiresAt: binding.expiresAt,
        auditFile,
        ...stability,
      });
      return { ...result, ...stability, auditFile, eventId: event.eventId };
    } catch (error) {
      const hss = error instanceof HssError ? error : new HssError(HSS_ERROR.RESET_FAILED, error instanceof Error ? error.message : String(error));
      const auditFile = await appendHssAudit(this.sessionId, "reset", binding, { ok: false, risk: { level: "R3" }, data: result, error: { code: hss.code, message: hss.message, details: hss.details } }, this.cwd()).catch(() => undefined);
      await appendHssTargetControlEvent(metadataFile, {
        operation: "reset",
        result: "failed",
        captureId: plan.output.captureId,
        resetBeforeCapture: true,
        startUs: resetStartedUs,
        endUs: Date.now() * 1000,
        operationDigest: binding.operationDigest,
        targetId: binding.targetId,
        artifactSha256: binding.artifactSha256,
        layoutSha256: binding.layoutSha256,
        policySha256: binding.policySha256,
        sessionId: binding.sessionId,
        expiresAt: binding.expiresAt,
        reason: hss.message,
        errorCode: hss.code,
        beforeState: result.beforeState ?? "unknown",
        afterState: result.afterState ?? "unknown",
        targetReset: result.targetReset === true,
        resetIssued: result.resetIssued === true,
        auditFile,
      }).catch(() => undefined);
      const metadata = await readHssMetadata(metadataFile).catch(() => undefined);
      if (metadata) {
        metadata.reset = { ...metadata.reset, status: "failed", result: { ...result, errorCode: hss.code, reason: hss.message, auditFile } };
        metadata.safety = {
          ...metadata.safety,
          targetReset: metadata.safety.targetReset || result.targetReset === true,
          resetIssued: metadata.safety.resetIssued || result.resetIssued === true,
        };
        await writeFile(metadataFile, JSON.stringify(metadata, null, 2), "utf8").catch(() => undefined);
      }
      await materializeHssCaptureEvents(metadataFile).catch(() => undefined);
      throw hss;
    }
  }

  private async waitForTargetStability(plan: HssCapturePlan, runtimeIdentity: HssRuntimeIdentity, target: { device: string; interface: "SWD" | "JTAG"; speedKhz: number }, serial?: string): Promise<Record<string, unknown>> {
    const started = Date.now();
    let checks = 0;
    let consecutive = 0;
    while (Date.now() - started <= plan.stabilityPolicy.timeoutMs) {
      if (Date.now() - started < plan.stabilityPolicy.minimumRecoveryMs) {
        await sleep(plan.stabilityPolicy.pollIntervalMs);
        continue;
      }
      const identity = refreshHssRuntimeIdentity(runtimeIdentity, {
        env: this.env(),
        helperPath: runtimeIdentity.helperPath,
        adapterPath: runtimeIdentity.adapterPath,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, identity)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "runtime or ScriptFile identity changed during target stabilization");
      const request = { operation: "target-state", runtimeIdentity: identity, target, serial, scriptIdentity: plan.scriptIdentity };
      const state = this.options.targetStateReader
        ? await this.options.targetStateReader(request)
        : await targetStateFromHelper(await runHssHelperCommand("target-state", cpuControlHelperArgs(request), {
          env: this.env(),
          helperPath: runtimeIdentity.helperPath,
          helperArgsPrefix: this.options.helperArgsPrefix,
          timeoutMs: plan.stabilityPolicy.timeoutMs,
        }), identity);
      checks += 1;
      consecutive = state.halted ? 0 : consecutive + 1;
      if (consecutive >= plan.stabilityPolicy.requiredConsecutiveRunningChecks) {
        return { stabilizationElapsedMs: Date.now() - started, stabilizationCheckCount: checks, stabilityPolicy: plan.stabilityPolicy };
      }
      await sleep(plan.stabilityPolicy.pollIntervalMs);
    }
    throw new HssError(HSS_ERROR.HSS_TARGET_STABILITY_TIMEOUT, "target did not reach the bounded running-state stability gate", { ...plan.stabilityPolicy, checks, consecutive });
  }

  private async wrap<T>(operation: Parameters<typeof hssOk<T>>[0], input: unknown, fn: () => Promise<T> | T): Promise<HssEnvelope<T>> {
    const resetRisk = (operation === "hss_capture_plan" || operation === "hss_capture_start")
      && input && typeof input === "object"
      && ((input as { resetBeforeCapture?: unknown }).resetBeforeCapture === true
        || (operation === "hss_capture_start"
          && typeof (input as { planId?: unknown }).planId === "string"
          && this.plans.get((input as { planId: string }).planId)?.resetBeforeCapture === true));
    try {
      const data = await fn();
      const artifacts = artifactList(data);
      const envelope = hssOk(operation, data, artifacts, warningList(data));
      if (resetRisk || ((operation === "hss_capture_plan" || operation === "hss_capture_start")
          && data && typeof data === "object" && (data as { resetBeforeCapture?: unknown }).resetBeforeCapture === true)) {
        envelope.risk.level = "R3";
      }
      await this.safeAudit(operation, input, envelope);
      return envelope;
    } catch (error) {
      const envelope = hssFail<T>(operation, error);
      if (resetRisk) envelope.risk.level = "R3";
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

function hasTargetSelectionInput(input: HssTargetIdentityInput): boolean {
  return [input.targetId, input.device, input.projectRoot, input.projectConfigFile]
    .some((value) => typeof value === "string" && value.trim().length > 0);
}

function requestedTarget(input: HssTargetIdentityInput): string | undefined {
  const target = input.targetId?.trim() || input.device?.trim();
  return target && !/^unspecified$/i.test(target) ? target : undefined;
}

function assertActiveWritable(active: ActiveCapture): void {
  if (active.helperExited || active.child.exitCode !== null || active.child.killed) {
    throw new HssError(HSS_ERROR.CAPTURE_NOT_ACTIVE, "active HSS capture helper is no longer running; writes after helper completion are rejected", { captureId: active.captureId });
  }
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

async function readSampleAnchor(active: ActiveCapture, fallbackStartUs: number): Promise<SampleAnchor | null> {
  if (!existsSync(active.segmentFile)) return null;
  const recordSize = 24 + active.plan.symbols.length * 4;
  const data = await readFile(active.segmentFile);
  const sampleCount = Math.floor(data.length / recordSize);
  if (sampleCount < 1) return null;
  const firstTicks = data.readBigInt64LE(8);
  const requestedRateHz = active.plan.sampling.requestedRateHz;
  const fallbackIndex = requestedRateHz > 0 ? Math.round(fallbackStartUs * requestedRateHz / 1_000_000) : 0;
  let bestOffset = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let index = 0; index < sampleCount; index += 1) {
    const offset = index * recordSize;
    const sampleIndex = Number(data.readBigUInt64LE(offset));
    const delta = Math.abs(sampleIndex - fallbackIndex);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestOffset = offset;
    }
  }
  const sampleIndex = Number(data.readBigUInt64LE(bestOffset));
  const timestampTicks = data.readBigInt64LE(bestOffset + 8);
  return {
    sampleIndex,
    captureTimeUs: Math.max(0, Number(timestampTicks - firstTicks) / 1000),
  };
}

function isAbandonedMetadata(metadata: HssCaptureMetadata): boolean {
  return metadata.backend === "jlink-hss" && metadata.state === "failed" && metadata.segments.length === 0 && metadata.failures.length === 0;
}

function outsideScalarTargetPath(input: Pick<HssVariableWritePlanInput, "target" | "targetRef">): string {
  if (input.targetRef) {
    if (input.targetRef.kind === "scalar") return input.targetRef.path;
    throw new HssError(HSS_ERROR.SYMBOL_KIND_UNSUPPORTED, "outside-capture writes support scalar targets only", { targetRef: input.targetRef });
  }
  if (input.target && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(input.target)) return input.target;
  throw new HssError(HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED, "outside-capture write target must be a scalar variable path", { target: input.target });
}

async function raceWithTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hssLayoutSha256(plan: HssCapturePlan): string {
  return createHash("sha256").update(JSON.stringify(plan.symbols.map((symbol) => ({
    name: symbol.name,
    address: symbol.address,
    size: symbol.size,
    type: symbol.type,
  })))).digest("hex");
}

function resetBindingDigest(binding: NonNullable<HssCapturePlan["resetOperation"]>): string {
  return createHash("sha256").update(JSON.stringify({
    operation: binding.operation,
    risk: binding.risk,
    planId: binding.planId,
    captureId: binding.captureId,
    targetId: binding.targetId,
    artifactSha256: binding.artifactSha256,
    layoutSha256: binding.layoutSha256,
    policySha256: binding.policySha256,
    runtimeIdentitySha256: binding.runtimeIdentitySha256,
    scriptApprovalSha256: binding.scriptApprovalSha256,
    sessionId: binding.sessionId,
    createdAt: binding.createdAt,
    expiresAt: binding.expiresAt,
    ttlMs: binding.ttlMs,
  })).digest("hex");
}

function configuredJlinkDllPath(probe: { jlinkExePath: string } | null): string | undefined {
  if (!probe?.jlinkExePath) return undefined;
  const candidate = join(dirname(probe.jlinkExePath), "JLink_x64.dll");
  return existsSync(candidate) ? candidate : undefined;
}

function cpuControlHelperArgs(input: Record<string, unknown>): string[] {
  const runtime = input.runtimeIdentity as HssRuntimeIdentity;
  const target = input.target as { device: string; interface: "SWD" | "JTAG"; speedKhz: number };
  const script = input.scriptIdentity as HssCapturePlan["scriptIdentity"];
  return [
    "--dll", runtime.dllPath ?? "",
    "--approved-dll-sha256", runtime.dllSha256 ?? "",
    "--device", target.device,
    "--interface", target.interface,
    "--speed", String(target.speedKhz),
    "--operation", String(input.operation ?? ""),
    ...(input.halt === true ? ["--halt", "true"] : []),
    ...(input.serial ? ["--serial", String(input.serial)] : []),
    "--jlink-script-file", script?.path ?? "",
    "--approved-jlink-script-sha256", script?.sha256 ?? "",
  ];
}

function targetStateFromHelper(result: Record<string, unknown>, identity: HssRuntimeIdentity): { halted: boolean; raw?: number } {
  if (result.status !== "ok" || typeof result.targetWasHalted !== "boolean") {
    throw new HssError(HSS_ERROR.HSS_TARGET_STABILITY_TIMEOUT, String(result.reason ?? "target-state helper failed"), { result });
  }
  if (!helperReportedIdentityMatches(result, identity)) {
    throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "target-state helper reported a different runtime or ScriptFile identity", { result });
  }
  return { halted: result.targetWasHalted, raw: typeof result.targetWasHaltedRaw === "number" ? result.targetWasHaltedRaw : undefined };
}

function helperReportedIdentityMatches(result: Record<string, unknown>, identity: HssRuntimeIdentity): boolean {
  return result.helperVersion === identity.helperVersion
    && result.helperProtocolVersion === identity.helperProtocolVersion
    && String(result.dllVersion ?? "") === identity.dllVersion
    && result.jlinkScriptFile === identity.jlinkScriptFile
    && result.jlinkScriptSha256 === identity.jlinkScriptSha256
    && result.jlinkScriptReturnCode === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readHelperDiagnostic(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
