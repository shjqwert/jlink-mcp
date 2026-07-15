import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, createReadStream, existsSync, fsyncSync, openSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProbeBackend } from "../../probe/backend";
import {
  discoverHssDll,
  hssScriptHelperArgs,
  hssRuntimeIdentityMatches,
  refreshHssRuntimeIdentity,
  resolveHssScriptIdentity,
  resolveHssHelperPath,
  runHssHelperCommand,
  type HssDllPreflightInput,
  type HssRuntimeIdentity,
  type HssScriptIdentity,
} from "../hss-dll/hss-dll-adapter";
import { readHssTrustProfile, type HssScriptSpec, type HssTrustProfile } from "../trust/trust-profile";
import { resolveHssDebugArtifact } from "./debug-artifact";
import { appendHssAudit } from "./audit-log";
import { hmC095Validation, type HssQueryInput, type HssSampleRecord } from "./hss-artifact";
import { hssCapabilityProbe } from "./hss-capability";
import type { HssCapturePlan, HssCapturePlanInput } from "./hss-plan";
import { buildHssCapturePlan } from "./hss-plan";
import { HSS_SAFETY_FALSE, type HssCaptureMetadata } from "./hss-contract";
import { appendHssJcapEvent, hssQpcTick, parseHssQpcTimebase, type HssJcapEventJournal } from "./hss-events";
import { hssFail, hssOk, type HssEnvelope } from "./hss-envelope";
import { HSS_ERROR, HssError } from "./hss-errors";
import { HelperHssVariableMemoryIo, ProbeDirectHssVariableMemoryIo, type HssVariableMemoryIo } from "./hss-memory-io";
import { loadHssPolicy } from "./hss-policy";
import { createHssVariableWritePlan, HssWritePlanStore, type HssVariableWritePlan, type HssVariableWritePlanInput } from "./hss-write-plan";
import { executeHssVariableWritePlan, type HssVariableWriteExecuteInput, type HssVariableWriteExecuteResult } from "./hss-write-execute";
import { HssCaptureWriteQueue } from "./hss-write-queue";
import { assertInsideProject, configureHssProjectPaths, ensureHssProjectDirs, hssProjectPaths, type HssProjectPaths } from "./project-paths";
import { resolveHssTargetIdentity, type HssTargetIdentityInput } from "./target-identity";
import {
  finalizeJcapV0Capture,
  JcapV0Writer,
  jcapCaptureEventWindow,
  jcapCaptureExportCsv,
  jcapCaptureSeries,
  jcapCaptureSummary,
  rebuildJcapV0Index,
  readJcapV0Raw,
  verifyJcapV0Index,
} from "../jcap/jcap-v0";

const OUTSIDE_CAPTURE_ID = "outside-capture";

export interface HssCaptureStartInput extends HssDllPreflightInput, HssCapturePlanInput {
  planId?: string;
}

export interface HssCaptureServiceOptions {
  cwd?: string;
  storageRoot?: string;
  evidenceRoot?: string;
  env?: Record<string, string | undefined>;
  helperPath?: string;
  helperArgsPrefix?: string[];
  validatedDllSha256?: readonly string[];
  validatedRuntimeIdentitySha256?: readonly string[];
  validatedJlinkScriptSha256?: readonly string[];
  trustValidation?: boolean;
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
  stderr: string;
  writeQueue: HssCaptureWriteQueue;
  done: Promise<void>;
  stopTimedOut?: boolean;
  helperExited?: boolean;
  runtimeIdentity: HssRuntimeIdentity;
  journal: HssJcapEventJournal;
  stdoutRemainder: string;
  helperResult?: Record<string, unknown>;
  helperResultCount: number;
  stdoutError?: Error;
  hssStarted: boolean;
}

export class HssCaptureService {
  private readonly sessionId = randomUUID();
  private readonly plans = new Map<string, HssCapturePlan>();
  private readonly writePlans = new HssWritePlanStore();
  private readonly outsideWritePlanMapFiles = new Map<string, string>();
  private readonly writeCounters = new Map<string, { ops: number; elements: number }>();
  private captureGeneration = 0;
  private active: ActiveCapture | null = null;
  private readonly paths: HssProjectPaths;

  constructor(private readonly probe: ProbeBackend, private readonly options: HssCaptureServiceOptions = {}) {
    if (Boolean(options.storageRoot) !== Boolean(options.evidenceRoot)) {
      throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, "storageRoot and evidenceRoot must be supplied together");
    }
    this.paths = options.storageRoot && options.evidenceRoot
      ? configureHssProjectPaths(options.cwd ?? process.cwd(), { storageRoot: options.storageRoot, evidenceRoot: options.evidenceRoot })
      : hssProjectPaths(options.cwd ?? process.cwd());
  }

  async capabilityProbe(input: HssDllPreflightInput & HssTargetIdentityInput = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capability_probe", input, async () => {
      const targetIdentity = await resolveHssTargetIdentity(input, { cwd: this.cwd() });
      await ensureHssProjectDirs(this.cwd());
      return hssCapabilityProbe({ ...input, script: input.script ?? trustProfileScript(readHssTrustProfile(this.cwd())) }, {
        env: this.env(),
        helperPath: this.options.helperPath,
        helperArgsPrefix: this.options.helperArgsPrefix,
        validatedDllSha256: this.options.validatedDllSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        adapterPath: this.options.adapterPath,
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
        trustValidation: this.options.trustValidation,
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
        script: input.script ?? trustProfileScript(readHssTrustProfile(this.cwd())),
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
        trustValidation: this.options.trustValidation,
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
      const script = input.script ?? storedPlanScript(storedPlan) ?? trustProfileScript(readHssTrustProfile(this.cwd()));
      const capabilityInput = {
        dllPath: input.dllPath ?? storedPlan?.runtimeIdentity?.dllPath ?? configuredJlinkDllPath(probe),
        device: targetIdentity.targetId,
        interface: target.interface,
        speedKhz: target.speedKhz,
        serial,
        script,
        jlinkScriptFile: input.jlinkScriptFile,
        approvedJlinkScriptSha256: input.approvedJlinkScriptSha256,
      };
      const capability = await hssCapabilityProbe(capabilityInput, {
        env,
        helperPath,
        helperArgsPrefix: this.options.helperArgsPrefix,
        validatedDllSha256: this.options.validatedDllSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        adapterPath: this.options.adapterPath,
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
        trustValidation: this.options.trustValidation,
        cwd: this.cwd(),
        targetIdentity,
      });
      const runtimeIdentity = capability.runtimeIdentity as HssRuntimeIdentity;
      const discovery = ((capability.preflight as Record<string, unknown> | undefined)?.discovery ?? {}) as ReturnType<typeof discoverHssDll>;
      if (!discovery.selectedDllPath) throw new HssError(HSS_ERROR.HSS_DLL_MISSING, "JLink_x64.dll was not found");
      if (!runtimeIdentity?.validated) {
        const code = discovery.unavailableCode === HSS_ERROR.HSS_DLL_IDENTITY_UNVALIDATED
          ? HSS_ERROR.HSS_DLL_IDENTITY_UNVALIDATED
          : HSS_ERROR.HSS_RUNTIME_IDENTITY_UNVALIDATED;
        throw new HssError(code, "the reported DLL/helper/adapter identity tuple has not passed the project validation suite", { runtimeIdentity });
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
          || plan.scriptIdentity.mode !== runtimeIdentity.jlinkScriptMode
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
      const stopFile = join(plan.output.sessionDir, "stop.request");
      const diagnosticFile = join(plan.output.sessionDir, "capture.diag.json");
      const writeRequestFile = join(plan.output.sessionDir, "write.request.json");
      const writeResponseFile = join(plan.output.sessionDir, "write.response.json");
      const qpcResponse = await runHssHelperCommand("qpc-timebase", [], {
        env,
        helperPath,
        helperArgsPrefix: this.options.helperArgsPrefix,
      });
      if (qpcResponse.status !== "ok") throw new HssError(HSS_ERROR.HSS_HELPER_BAD_JSON, "qpc-timebase helper command failed", { qpcResponse });
      const qpc = parseHssQpcTimebase(qpcResponse);
      const writer = new JcapV0Writer({
        packageDir: plan.output.packageDir,
        externalSamples: true,
        provenance: {
          captureId: plan.output.captureId,
          sessionName: input.sessionName ?? "hm_c095_hss",
          backend: "jlink-hss",
          runtime: plainJsonRecord({ ...runtimeIdentity, roots: { projectRoot: plan.projectRoot, storageRoot: plan.storageRoot, evidenceRoot: plan.evidenceRoot } }),
          target: plainJsonRecord({ ...target, targetWasHaltedBeforeCapture, targetWasHaltedRaw: hss.targetWasHaltedRaw }),
          script: plan.scriptIdentity.mode === "file"
            ? { mode: "file", path: plan.scriptIdentity.path, sha256: plan.scriptIdentity.sha256 }
            : { mode: "none" },
          ...(plan.resetBeforeCapture ? { reset: plainJsonRecord({ operation: plan.resetOperation, stabilityPolicy: plan.stabilityPolicy }) } : {}),
        },
      });
      const journal: HssJcapEventJournal = {
        captureId: plan.output.captureId,
        writer,
        qpcEpochCounter: qpc.qpcEpochCounter,
        qpcFrequency: qpc.qpcFrequency,
        nextEventSequence: 0,
        lastTick: 0n,
      };
      appendHssJcapEvent(journal, "lifecycle", qpc.qpcEpochCounter.toString(), { state: "planned", phase: "capture_planned" });
      writer.syncEvents();
      let acquired = false;
      let resetResult: Record<string, unknown> | undefined;
      try {
        resetResult = plan.resetBeforeCapture
          ? await this.executeResetBeforeCapture(plan, runtimeIdentity, journal, target, serial)
          : undefined;
        if (!this.probe.acquireExclusive(owner)) throw new HssError(HSS_ERROR.HSS_CAPTURE_ACTIVE, `probe is already owned by ${this.probe.getExclusiveOwner() ?? "another operation"}`);
        acquired = true;
        const launchIdentity = refreshHssRuntimeIdentity(runtimeIdentity, {
          env,
          helperPath,
          validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(runtimeIdentity),
          adapterPath: this.options.adapterPath,
        });
        if (!hssRuntimeIdentityMatches(runtimeIdentity, launchIdentity)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "DLL/helper/adapter identity changed before capture helper launch", { runtimeIdentity: launchIdentity });
        await writeHelperPlan(plan.output.planFile, {
        captureId: plan.output.captureId,
        qpcEpochCounter: qpc.qpcEpochCounter.toString(),
        qpcFrequency: qpc.qpcFrequency.toString(),
        dllPath: discovery.selectedDllPath,
        approvedDllSha256: launchIdentity.dllSha256,
        runtimeIdentityValidated: launchIdentity.validated,
        getCapsValidated: Boolean(hss.getCapsOk),
        startReadStopValidated: true,
        runtimeIdentity: launchIdentity,
        jlinkScriptFile: plan.scriptIdentity.path,
        approvedJlinkScriptSha256: plan.scriptIdentity.sha256,
        jlinkScriptApprovalSha256: plan.scriptIdentity.approvalSha256,
        jlinkScriptMode: plan.scriptIdentity.mode,
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
        postConnectCounterAddress: plan.hmC095.counterAddress,
        postConnectCounterType: plan.hmC095.counterType,
        postConnectCounterModulus: plan.hmC095.modulus,
        postConnectExpectedRateHz: plan.hmC095.focIsrFreqHz,
        postConnectRateToleranceRatio: plan.hmC095.rateToleranceRatio,
        postConnectMinimumRecoveryMs: plan.stabilityPolicy.minimumRecoveryMs,
        postConnectTimeoutMs: plan.stabilityPolicy.timeoutMs,
        postConnectPollIntervalMs: plan.stabilityPolicy.pollIntervalMs,
        postConnectRequiredConsecutiveRunningChecks: plan.stabilityPolicy.requiredConsecutiveRunningChecks,
        target: targetIdentity,
        symbols: plan.symbols,
        });
        const child = spawn(helperPath, [...(this.options.helperArgsPrefix ?? []), "hss-capture", "--jlink-script-mode", plan.scriptIdentity.mode, "--plan", plan.output.planFile], {
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
        stderr: "",
        writeQueue: new HssCaptureWriteQueue(),
        done: Promise.resolve(),
        runtimeIdentity: launchIdentity,
        journal,
        stdoutRemainder: "",
        helperResultCount: 0,
        hssStarted: false,
        };
        active.done = new Promise((resolveDone) => {
        child.stdout.on("data", (data: Buffer) => { this.consumeHelperStdout(active, data.toString("utf8")); });
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
        packageDir: plan.output.packageDir,
        samplesFile: plan.output.firstSegmentFile,
        safety: HSS_SAFETY_FALSE,
        targetWasHaltedBeforeCapture,
        targetWasHaltedRaw: hss.targetWasHaltedRaw,
        warnings,
        resetBeforeCapture: plan.resetBeforeCapture,
        reset: resetResult,
        risk: plan.resetBeforeCapture ? "R3" : "R1",
        };
      } catch (error) {
        if (acquired) this.probe.releaseExclusive(owner);
        await this.finalizePreStartFailure(journal, error);
        throw error;
      }
    });
  }

  async captureStatus(input: { captureId: string }): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_status", input, async () => {
      const active = this.active?.captureId === input.captureId ? this.active : null;
      if (active) {
        return {
          captureId: input.captureId,
          state: active.hssStarted ? "active" : "planned",
          indexStatus: "not_ready",
          requestedRateHz: active.plan.sampling.requestedRateHz,
          samplesBytes: existsSync(active.segmentFile) ? statSync(active.segmentFile).size : 0,
          packageDir: active.plan.output.packageDir,
          helperExited: active.helperExited === true,
          helperResultCount: active.helperResultCount,
          stdoutError: active.stdoutError?.message,
          warnings: [],
        };
      }
      return { captureId: input.captureId, ...await jcapCaptureSummary(this.packageFor(input.captureId)) };
    });
  }

  async captureStop(input: { captureId: string }): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_stop", input, async () => {
      const active = this.active?.captureId === input.captureId ? this.active : null;
      if (!active) return { captureId: input.captureId, ...await jcapCaptureSummary(this.packageFor(input.captureId)) };
      active.writeQueue.beginStopping();
      await active.writeQueue.waitForIdle();
      await writeFile(active.stopFile, "stop", "utf8");
      if (!await raceWithTimeout(active.done, this.options.stopTimeoutMs ?? 30000)) {
        active.stopTimedOut = true;
        active.child.kill();
        await active.done;
      }
      return { captureId: input.captureId, ...await jcapCaptureSummary(active.plan.output.packageDir) };
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
      const trustProfile = readHssTrustProfile(this.cwd());
      const scriptSpec = trustProfileScript(trustProfile);
      const script = resolveHssScriptIdentity({
        script: scriptSpec,
        device: targetIdentity.targetId,
        interface: probe.interface,
        speedKhz: probe.speed,
        serial: probe.serialNumber,
      }, this.env(), {
        cwd: this.cwd(),
        validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256,
        validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
        trustProfile,
      });
      if (!script.validated) throw new HssError(HSS_ERROR.HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED, script.reason ?? "trusted J-Link ScriptFile identity is required");
      const capability = await hssCapabilityProbe({
        dllPath: configuredJlinkDllPath(probe),
        device: targetIdentity.targetId,
        interface: probe?.interface,
        speedKhz: probe?.speed,
        serial: probe?.serialNumber,
        script: scriptSpec,
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
        scriptIdentity: script,
        trustProfile,
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
        validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(runtimeIdentity),
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
        scriptIdentity: script,
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
        validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(runtimeIdentity),
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, postIdentity)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "CPU-control runtime identity changed after hardware access", { binding, result });
      const event = this.active
        ? appendHssJcapEvent(this.active.journal, "target_control", result.operationAfterQpcCounter ?? await this.qpcCounter(this.active), {
          operation,
          result: "succeeded",
          captureId: this.active.captureId,
          operationDigest: binding.operationDigest,
          beforeState: result.beforeState ?? "unknown",
          afterState: result.afterState ?? "unknown",
        })
        : undefined;
      return { operation, risk: "R3", binding, result, runtimeIdentity: postIdentity, scriptIdentity: script, eventId: event?.eventId };
    });
  }

  async captureQuery(input: HssQueryInput): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_query", input, async () => {
      if (this.active?.captureId === input.captureId) throw new HssError(HSS_ERROR.CAPTURE_NOT_ACTIVE, "active/finalizing JCAP captures are not query-ready", { captureId: input.captureId, indexStatus: "not_ready" });
      if (input.includeRawSamples) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "full raw samples are not available through bounded JCAP queries");
      if (input.metadataFile || input.maxSamples !== undefined || input.flagFilter || input.summary || input.hmC095Profile !== undefined) {
        throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "legacy metadata/raw/flag query options are not supported by the JCAP query path");
      }
      const packageDir = this.packageFor(input.captureId);
      if (input.mode === "event_window") {
        return jcapCaptureEventWindow({
          packageDir,
          eventId: requiredText(input.eventId, "eventId"),
          variables: input.variables ?? [],
          beforeMs: requiredBoundedInteger(input.windowBeforeMs, "windowBeforeMs"),
          afterMs: requiredBoundedInteger(input.windowAfterMs, "windowAfterMs"),
          bucketCount: requiredBoundedInteger(input.buckets, "buckets"),
        });
      }
      if (!input.variables?.length) return jcapCaptureSummary(packageDir);
      return jcapCaptureSeries({
        packageDir,
        variables: input.variables,
        startTick: secondsToTick(input.startSec, "startSec"),
        endTick: secondsToTick(input.endSec, "endSec"),
        bucketCount: requiredBoundedInteger(input.buckets, "buckets"),
      });
    });
  }

  async captureExport(input: { captureId: string; metadataFile?: string; format?: "csv"; variables?: string[]; eventAware?: boolean; eventId?: string; windowBeforeMs?: number; windowAfterMs?: number }): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_export", input, async () => {
      if (input.format && input.format !== "csv") throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "JCAP export supports CSV only");
      const packageDir = this.packageFor(input.captureId);
      if (input.metadataFile || input.variables || input.eventAware !== undefined || input.eventId || input.windowBeforeMs !== undefined || input.windowAfterMs !== undefined) {
        throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "legacy or event-aware export options are not supported; request the explicit JCAP CSV export");
      }
      if (this.active?.captureId === input.captureId) throw new HssError(HSS_ERROR.CAPTURE_NOT_ACTIVE, "active/finalizing JCAP captures are not export-ready");
      return jcapCaptureExportCsv(packageDir);
    });
  }

  async sessionRecover(input: { captureId?: string } = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_session_recover", input, async () => {
      const paths = this.paths;
      const captureIds = input.captureId ? [input.captureId] : (await readdir(paths.capturesDir).catch(() => []))
        .filter((name) => name.endsWith(".jcap")).map((name) => name.slice(0, -5));
      const recovered: Array<Record<string, unknown>> = [];
      const skipped: Array<Record<string, unknown>> = [];
      for (const captureId of captureIds) {
        const packageDir = this.packageFor(captureId);
        if (!existsSync(packageDir)) {
          skipped.push({ captureId, reason: "package_missing" });
          continue;
        }
        const status = await verifyJcapV0Index(packageDir);
        if (status.indexStatus !== "rebuild_required") {
          skipped.push({ captureId, reason: "index_not_rebuild_required", ...status });
          continue;
        }
        recovered.push({ captureId, ...await rebuildJcapV0Index(packageDir) });
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
          if (!input.dryRun) {
            active.writeQueue.setStage("EVENT_APPEND");
            const writeQpcCounter = await this.qpcCounter(active);
            const event = appendHssJcapEvent(active.journal, "variable_write", writeQpcCounter, {
              writeId: result.writeId,
              writeKind: plan.targetRef.kind,
              canonicalTarget: plan.canonicalTarget,
              targetRef: plan.targetRef,
              oldValue: result.oldValue,
              oldValues: result.oldValues,
              newValue: result.newValue,
              newValues: result.newValues,
              readback: result.readback,
              readbackValues: result.readbackValues,
              readbackOk: result.readbackOk,
              mismatches: result.mismatches,
              risk: plan.risk,
              ok: true,
            });
            result.eventId = event.eventId;
            appendHssJcapEvent(active.journal, "flag", writeQpcCounter, { flag: "write_nearby", sourceEventId: event.eventId, ok: true });
            this.consumeWrite(plan);
            this.writePlans.markExecuted(writePlanId);
          }
          result.queueStages = active.writeQueue.history();
          return result;
        } catch (error) {
          if (error instanceof HssError && error.details.writeIssued === true) {
            const maybeResult = "writeId" in error.details ? error.details as unknown as HssVariableWriteExecuteResult : undefined;
            active.writeQueue.setStage("EVENT_APPEND");
            const writeQpcCounter = await this.qpcCounter(active);
            const event = appendHssJcapEvent(active.journal, "variable_write", writeQpcCounter, {
              writeId: maybeResult?.writeId ?? randomUUID(),
              writeKind: plan.targetRef.kind,
              canonicalTarget: plan.canonicalTarget,
              targetRef: plan.targetRef,
              readbackOk: maybeResult?.readbackOk ?? false,
              mismatches: maybeResult?.mismatches ?? [],
              risk: plan.risk,
              ok: false,
              errorCode: error.code,
            });
            appendHssJcapEvent(active.journal, "flag", writeQpcCounter, { flag: "backend_busy", sourceEventId: event.eventId, ok: false, errorCode: error.code });
            if (maybeResult) maybeResult.eventId = event.eventId;
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
    this.consumeHelperStdout(active, "", true);
    let state: "completed" | "stopped" | "failed" = "failed";
    let helperResult = active.helperResult;
    let failure: string | undefined;
    if (active.stopTimedOut) {
      failure = "capture stop timed out; helper was killed";
      helperResult = { status: "error", errorCode: HSS_ERROR.HSS_CAPTURE_STOP_TIMEOUT, reason: failure, exitCode: code, stderr: active.stderr };
    } else if (active.stdoutError || active.helperResultCount !== 1 || !helperResult) {
      failure = active.stdoutError?.message ?? `helper produced ${active.helperResultCount} result records`;
      helperResult = { status: "error", errorCode: HSS_ERROR.HSS_HELPER_BAD_JSON, reason: failure, exitCode: code, stderr: active.stderr };
    } else {
      state = helperResult.status === "ok" ? "completed" : helperResult.status === "stopped" ? "stopped" : "failed";
      if (state === "failed") failure = String(helperResult.reason ?? helperResult.errorCode ?? `helper exited ${code}`);
    }
    const postIdentity = refreshHssRuntimeIdentity(active.runtimeIdentity, {
      env: this.env(),
      helperPath: active.runtimeIdentity.helperPath,
      validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(active.runtimeIdentity),
      adapterPath: active.runtimeIdentity.adapterPath,
    });
    const helperIdentityMatches = state === "failed" || (helperResult?.helperVersion === active.runtimeIdentity.helperVersion
      && helperResult?.helperProtocolVersion === active.runtimeIdentity.helperProtocolVersion
      && String(helperResult?.dllVersion ?? "") === active.runtimeIdentity.dllVersion
      && helperResult?.jlinkScriptMode === active.runtimeIdentity.jlinkScriptMode
      && (helperResult?.jlinkScriptFile || undefined) === active.runtimeIdentity.jlinkScriptFile
      && (helperResult?.jlinkScriptSha256 || undefined) === active.runtimeIdentity.jlinkScriptSha256
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
      const rawProof = helperResult.rawClosed === true
        && typeof helperResult.samplesSha256 === "string"
        && /^[0-9a-f]{64}$/.test(helperResult.samplesSha256)
        && existsSync(active.segmentFile)
        && await sha256FileAsync(active.segmentFile) === helperResult.samplesSha256;
      if (!rawProof) {
        state = "failed";
        failure = failure ?? "helper did not prove samples flush/close/hash identity";
      }
      if (!existsSync(active.segmentFile)) createEmptySyncedFile(active.segmentFile);
      const counter = await this.qpcCounter(active).catch(() => active.journal.qpcEpochCounter.toString());
      if (rawProof && active.hssStarted) {
        const raw = readJcapV0Raw(active.plan.output.packageDir);
        const records: HssSampleRecord[] = raw.samples.map((sample) => ({
          sampleIndex: BigInt(sample.sampleIndex),
          timestampTicks: BigInt(sample.tick),
          statusFlags: sample.statusFlags,
          rawValues: active.plan.symbols.map((symbol) => Number(sample.values[symbol.name])),
        }));
        const semantic = hmC095Validation(records, active.plan.symbols, active.plan.sampling.requestedRateHz, {
          transportStatus: "pass",
          reset: active.plan.resetBeforeCapture ? { operation: active.plan.resetOperation } : undefined,
          hmC095Oracle: active.plan.hmC095,
        } as unknown as HssCaptureMetadata);
        appendHssJcapEvent(active.journal, "quality", counter, { check: "hm_c095", ...semantic });
        if (semantic.semanticPass !== true) {
          state = "failed";
          failure = failure ?? "HM_C095 strict semantic validation failed";
        }
      }
      if (!active.hssStarted) {
        appendHssJcapEvent(active.journal, "fault", counter, { errorCode: String(helperResult.errorCode ?? HSS_ERROR.HSS_LIFECYCLE_VALIDATION_FAILED), reason: failure ?? "HSS did not start" });
        appendHssJcapEvent(active.journal, "lifecycle", counter, { state: "failed", phase: "capture_terminal" });
        active.journal.writer.closeEvents();
        await rebuildJcapV0Index(active.plan.output.packageDir);
      } else {
        const tick = hssQpcTick(active.journal, counter).toString();
        const event = (sequence: number, terminalState: string) => ({
          eventId: randomUUID(), eventSequence: sequence, type: "lifecycle" as const, tick,
          state: terminalState, phase: terminalState === "finalizing" ? "raw_closed" : "capture_terminal",
        });
        await finalizeJcapV0Capture({
          writer: active.journal.writer,
          finalizingEvent: event(active.journal.nextEventSequence, "finalizing"),
          terminalEvent: event(active.journal.nextEventSequence + 1, state),
          recoverableEvent: event(active.journal.nextEventSequence + 1, "recoverable"),
        });
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      active.journal.writer.close();
    } finally {
      this.writePlans.invalidateCapture(active.captureId, active.generation);
      active.writeQueue.close();
      await appendHssAudit(this.sessionId, "hss_capture_status", { event: "capture_terminal", captureId: active.captureId }, {
        captureId: active.captureId,
        state,
        packageDir: active.plan.output.packageDir,
        samplesFile: active.segmentFile,
        helperResult,
        failure,
      }, this.cwd()).catch(() => undefined);
      await rm(active.stopFile, { force: true });
      this.probe.releaseExclusive(active.owner);
      this.active = null;
    }
  }

  private consumeHelperStdout(active: ActiveCapture, chunk: string, final = false): void {
    if (active.stdoutError) return;
    active.stdoutRemainder += chunk;
    if (active.stdoutRemainder.length > 1024 * 1024) {
      active.stdoutError = new Error("helper NDJSON record exceeds the bounded stdout buffer");
      return;
    }
    const lines = active.stdoutRemainder.split(/\r?\n/);
    active.stdoutRemainder = lines.pop() ?? "";
    if (final && active.stdoutRemainder.trim()) {
      lines.push(active.stdoutRemainder);
      active.stdoutRemainder = "";
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.acceptHelperRecord(active, JSON.parse(line) as Record<string, unknown>); }
      catch (error) { active.stdoutError = error instanceof Error ? error : new Error(String(error)); break; }
    }
  }

  private acceptHelperRecord(active: ActiveCapture, record: Record<string, unknown>): void {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("helper NDJSON record must be an object");
    if (record.captureId !== active.captureId) throw new Error("helper NDJSON captureId mismatch");
    if (record.record === "result") {
      const resultQpc = parseHssQpcTimebase(record);
      if (resultQpc.qpcEpochCounter !== active.journal.qpcEpochCounter || resultQpc.qpcFrequency !== active.journal.qpcFrequency) throw new Error("helper result QPC timebase mismatch");
      active.helperResultCount += 1;
      if (active.helperResultCount !== 1) throw new Error("helper emitted more than one result record");
      active.helperResult = record;
      return;
    }
    if (record.record === "fault") {
      appendHssJcapEvent(active.journal, "fault", record.qpcCounter, { errorCode: record.errorCode, reason: record.reason });
      return;
    }
    if (record.record !== "lifecycle") throw new Error("helper emitted an unknown NDJSON record kind");
    if (record.phase === "qpc_epoch") {
      const streamQpc = parseHssQpcTimebase(record);
      if (streamQpc.qpcEpochCounter !== active.journal.qpcEpochCounter || streamQpc.qpcFrequency !== active.journal.qpcFrequency) throw new Error("helper lifecycle QPC timebase mismatch");
      return;
    }
    if (record.phase === "hss_start") {
      if (!Number.isSafeInteger(record.returnCode) || Number(record.returnCode) < 0 || record.crashed !== false) return;
      if (active.hssStarted) throw new Error("helper emitted duplicate successful hss_start");
      appendHssJcapEvent(active.journal, "lifecycle", record.qpcCounter, { state: "active", phase: "hss_start", returnCode: record.returnCode });
      active.hssStarted = true;
      return;
    }
    appendHssJcapEvent(active.journal, "quality", record.qpcCounter, { phase: record.phase, returnCode: record.returnCode, crashed: record.crashed, samplesBytes: record.samplesBytes, samplesByteBudget: record.samplesByteBudget });
  }

  private async qpcCounter(active: ActiveCapture): Promise<string> {
    const response = await runHssHelperCommand("qpc-timebase", [], { env: this.env(), helperPath: active.runtimeIdentity.helperPath, helperArgsPrefix: this.options.helperArgsPrefix });
    if (response.status !== "ok") throw new Error("qpc-timebase helper command failed");
    const parsed = parseHssQpcTimebase(response);
    if (parsed.qpcFrequency !== active.journal.qpcFrequency) throw new Error("QPC frequency changed during capture");
    const reported = BigInt(String(response.qpcCounter ?? response.qpcEpochCounter));
    const minimum = active.journal.qpcEpochCounter
      + ((active.journal.lastTick * active.journal.qpcFrequency + 999_999_999n) / 1_000_000_000n);
    return (reported < minimum ? minimum : reported).toString();
  }

  private async finalizePreStartFailure(journal: HssJcapEventJournal, error: unknown): Promise<void> {
    createEmptySyncedFile(journal.writer.samplesFile);
    const reason = error instanceof Error ? error.message : String(error);
    const counter = (journal.qpcEpochCounter
      + ((journal.lastTick * journal.qpcFrequency + 999_999_999n) / 1_000_000_000n)).toString();
    appendHssJcapEvent(journal, "fault", counter, { errorCode: error instanceof HssError ? error.code : HSS_ERROR.HSS_LIFECYCLE_VALIDATION_FAILED, reason });
    appendHssJcapEvent(journal, "lifecycle", counter, { state: "failed", phase: "pre_start_failure" });
    journal.writer.closeEvents();
    await rebuildJcapV0Index(journal.writer.packageDir);
  }

  private requirePlan(planId: string): HssCapturePlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, `unknown HSS planId: ${planId}`);
    return plan;
  }

  private packageFor(captureId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(captureId)) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "captureId must be a UUID", { captureId });
    const packageDir = join(this.paths.capturesDir, `${captureId}.jcap`);
    assertInsideProject(packageDir, this.paths.capturesDir);
    return packageDir;
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

  private async bindCapturePlan(plan: HssCapturePlan, input: HssCapturePlanInput, capability: Record<string, unknown>): Promise<void> {
    const runtimeIdentity = capability.runtimeIdentity as HssRuntimeIdentity | undefined;
    if (!runtimeIdentity?.validated || !runtimeIdentity.jlinkScriptMode || !runtimeIdentity.jlinkScriptApprovalSha256
        || (runtimeIdentity.jlinkScriptMode === "file" && (!runtimeIdentity.jlinkScriptFile || !runtimeIdentity.jlinkScriptSha256))) {
      const preflight = capability.preflight as Record<string, unknown> | undefined;
      const script = preflight?.scriptIdentity as HssScriptIdentity | undefined;
      throw new HssError((script?.errorCode as keyof typeof HSS_ERROR | undefined) && HSS_ERROR[script!.errorCode as keyof typeof HSS_ERROR]
        ? HSS_ERROR[script!.errorCode as keyof typeof HSS_ERROR]
        : HSS_ERROR.HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED, script?.reason ?? "trusted J-Link ScriptFile identity is required before HSS planning", { runtimeIdentity, preflight });
    }
    const preflight = capability.preflight as Record<string, unknown>;
    const script = preflight.scriptIdentity as HssScriptIdentity;
    plan.scriptIdentity = {
      mode: runtimeIdentity.jlinkScriptMode,
      sourcePath: script.sourcePath,
      path: runtimeIdentity.jlinkScriptFile,
      sha256: runtimeIdentity.jlinkScriptSha256,
      approvalSha256: runtimeIdentity.jlinkScriptApprovalSha256,
      approvalSource: script.approvalSource ?? "trusted-allowlist",
      validated: true,
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

  private async executeResetBeforeCapture(plan: HssCapturePlan, runtimeIdentity: HssRuntimeIdentity, journal: HssJcapEventJournal, target: { device: string; interface: "SWD" | "JTAG"; speedKhz: number }, serial?: string): Promise<Record<string, unknown>> {
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
    let result: Record<string, unknown> = {};
    try {
      const before = refreshHssRuntimeIdentity(runtimeIdentity, {
        env: this.env(),
        helperPath: runtimeIdentity.helperPath,
        adapterPath: runtimeIdentity.adapterPath,
        validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(runtimeIdentity),
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
        validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(runtimeIdentity),
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, after)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "runtime or ScriptFile identity changed after reset");
      const stability = await this.waitForTargetStability(plan, runtimeIdentity, target, serial);
      const auditFile = await appendHssAudit(this.sessionId, "reset", binding, { ok: true, risk: { level: "R3" }, data: { ...result, ...stability, policyHash: binding.policySha256, symbolLayoutHash: binding.layoutSha256 } }, this.cwd());
      const event = appendHssJcapEvent(journal, "target_control", result.operationAfterQpcCounter ?? journal.qpcEpochCounter.toString(), {
        operation: "reset",
        result: "succeeded",
        captureId: plan.output.captureId,
        resetBeforeCapture: true,
        operationBeforeQpcCounter: result.operationBeforeQpcCounter,
        operationAfterQpcCounter: result.operationAfterQpcCounter,
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
      appendHssJcapEvent(journal, "target_control", result.operationAfterQpcCounter ?? journal.qpcEpochCounter.toString(), {
        operation: "reset",
        result: "failed",
        captureId: plan.output.captureId,
        resetBeforeCapture: true,
        operationBeforeQpcCounter: result.operationBeforeQpcCounter,
        operationAfterQpcCounter: result.operationAfterQpcCounter,
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
      });
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
        validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(runtimeIdentity),
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

  private validatedRuntimeHashes(identity: HssRuntimeIdentity): readonly string[] | undefined {
    return this.options.validatedRuntimeIdentitySha256 ?? (identity.validated && identity.sha256 ? [identity.sha256] : undefined);
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
  const direct = values.filter((value): value is string => typeof value === "string" && /(?:\.jcap|capture\.db|\.csv)$/i.test(value));
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

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `${name} is required`);
  return value;
}

function plainJsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function requiredBoundedInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `${name} must be a non-negative safe integer`);
  return Number(value);
}

function secondsToTick(value: unknown, name: string): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `${name} must be a finite non-negative number`);
  const nanoseconds = value * 1_000_000_000;
  if (!Number.isSafeInteger(nanoseconds)) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `${name} exceeds exact nanosecond bounds`);
  return String(nanoseconds);
}

function createEmptySyncedFile(file: string): void {
  const handle = openSync(file, existsSync(file) ? "r+" : "ax");
  try { fsyncSync(handle); } finally { closeSync(handle); }
}

async function sha256FileAsync(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
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

function trustProfileScript(profile?: HssTrustProfile): HssScriptSpec | undefined {
  if (!profile) return undefined;
  return profile.script.mode === "none" ? { mode: "none" } : { mode: "file", path: profile.script.path! };
}

function storedPlanScript(plan?: HssCapturePlan): HssScriptSpec | undefined {
  if (!plan?.scriptIdentity) return undefined;
  return plan.scriptIdentity.mode === "none" ? { mode: "none" } : { mode: "file", path: plan.scriptIdentity.path! };
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
    ...hssScriptHelperArgs(script!),
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
    && result.jlinkScriptMode === identity.jlinkScriptMode
    && (result.jlinkScriptFile || undefined) === identity.jlinkScriptFile
    && (result.jlinkScriptSha256 || undefined) === identity.jlinkScriptSha256
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
