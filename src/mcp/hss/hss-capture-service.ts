import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, createReadStream, existsSync, fsyncSync, openSync, readFileSync, statSync } from "node:fs";
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
import type { HssCapturePlan, HssCapturePlanInput, HssStableVariableRef } from "./hss-plan";
import { buildHssCapturePlan, revalidateHssCapturePlan } from "./hss-plan";
import { HSS_SAFETY_FALSE, type HssCaptureMetadata, type HssScalarType } from "./hss-contract";
import { appendHssJcapEvent, hssQpcTick, parseHssQpcTimebase, type HssJcapEventJournal } from "./hss-events";
import { hssFail, hssOk, type HssEnvelope } from "./hss-envelope";
import { HSS_ERROR, HssError, type HssErrorCode } from "./hss-errors";
import { HelperHssVariableMemoryIo, type HssVariableMemoryIo } from "./hss-memory-io";
import { loadHssPolicy } from "./hss-policy";
import { createHssVariableWritePlan, HssWritePlanStore, type HssVariableWritePlan, type HssVariableWritePlanInput, type HssWritePlanRevalidateContext } from "./hss-write-plan";
import { executeHssVariableWritePlan, hssVariableWriteResultFromBytes, type HssVariableWriteExecuteInput, type HssVariableWriteExecuteResult } from "./hss-write-execute";
import { encodeHssValues } from "./hss-typed-value";
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
import { discoverArtifacts, resolveArtifactGeneration, writeArtifactMatchManifest, type AddressRange, type ArtifactGeneration } from "../artifact/artifact-catalog";
import { HotVariables, type HotVariableContext } from "../artifact/hot-variables";
import { catalogFromIarMap, SymbolCatalog, symbolLogicalIdentity, type ResolvedSymbol, type SymbolRef } from "../artifact/symbol-catalog";
import { claimOperationPlan, createOperationPlan, type CpuControlOperationPlan } from "../operation-contract";
import type { R4ExecuteTool } from "../approval-broker";
import { checkR4ExecutionPermit, type R4ApprovalConsumptionEvidence, type R4PlanInput } from "../risk-operations";
import { assertHssR4NativeExceptionEnvelope, createHssR4NativeExceptionEnvelope, type HssR4NativeExceptionEnvelope } from "./hss-r4-native-envelope";

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
  qpcEpochSeen: boolean;
  helperResult?: Record<string, unknown>;
  helperResultCount: number;
  stdoutError?: Error;
  hssStarted: boolean;
  artifactMatchStatus?: "verified" | "unverified" | "mismatch";
  artifactMatchEvidence?: Record<string, unknown>;
  artifactGate: Promise<"verified" | "unverified" | "mismatch">;
  resolveArtifactGate: (status: "verified" | "unverified" | "mismatch") => void;
  rejectArtifactGate: (error: Error) => void;
  warnings: string[];
  writeReadbackMismatch?: boolean;
}

interface OutsideWriteBinding {
  mapFile: string;
  artifact: ArtifactGeneration;
  runtimeIdentity: HssRuntimeIdentity;
  scriptIdentity: HssScriptIdentity & { validated: true; approvalSha256: string };
  targetId: string;
  serial?: string;
  interface: "SWD" | "JTAG";
  speedKhz: number;
  nonvolatileRanges: AddressRange[];
  ramRanges: AddressRange[];
  targetArtifactMatch: "unverified";
  evidenceGeneration: string;
  connectionGeneration: number;
}

export class HssCaptureService {
  private readonly sessionId = randomUUID();
  private readonly hotVariables = new HotVariables();
  private readonly resolvedTypes = new Map<string, HssScalarType>();
  private catalogState?: { artifact: ArtifactGeneration; catalog: SymbolCatalog };
  private readonly plans = new Map<string, HssCapturePlan>();
  private readonly planVariableRefs = new Map<string, HssStableVariableRef[]>();
  private readonly writePlans = new HssWritePlanStore();
  private readonly outsideWriteBindings = new Map<string, OutsideWriteBinding>();
  private readonly writeCounters = new Map<string, { ops: number; elements: number }>();
  private captureGeneration = 0;
  private active: ActiveCapture | null = null;
  private readonly paths: HssProjectPaths;
  private operationTail: Promise<void> = Promise.resolve();

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

  async artifactProbe(input: { artifactFile?: string; mapFile?: string } = {}): Promise<Record<string, unknown>> {
    return this.catalogCall(async () => {
      const discovery = await discoverArtifacts({
        projectRoot: this.cwd(),
        ...(input.artifactFile ? { explicitArtifact: input.artifactFile } : {}),
        ...(input.mapFile ? { explicitMap: input.mapFile } : {}),
      });
      if (discovery.candidates.length !== 1) {
        return { status: "selection_required", candidates: discovery.candidates, mapCandidates: discovery.mapCandidates };
      }
      const { artifact } = await this.loadCatalog(input);
      return { artifact, candidates: discovery.candidates, mapCandidates: discovery.mapCandidates };
    });
  }

  async symbolSearch(input: { artifactGeneration: string; query: string; limit?: number }): Promise<Record<string, unknown>> {
    return this.catalogCall(async () => {
      const state = await this.loadCatalog({}, input.artifactGeneration);
      return { artifactGeneration: state.artifact.generation, refs: state.catalog.search(input.query, input.limit) };
    });
  }

  async symbolResolve(input: { artifactGeneration: string; selector: string; type: HssScalarType }): Promise<Record<string, unknown>> {
    return this.catalogCall(async () => ({ symbol: await this.resolveCurrentSymbol(input.selector, input.type, input.artifactGeneration) }));
  }

  async hotVariableAdd(input: { ref: SymbolRef }): Promise<Record<string, unknown>> {
    return this.catalogCall(async () => {
      const state = await this.loadCatalog({}, input.ref.artifactGeneration);
      const resolved = this.requireResolvedSymbol(input.ref);
      const value = this.hotVariables.add(resolved, await this.hotVariableContext(state.artifact));
      return { ref: value.resolved.ref, logicalIdentity: value.logicalIdentity, validatedAt: value.validatedAt };
    });
  }

  async hotVariableList(): Promise<Record<string, unknown>> {
    return this.catalogCall(async () => {
      const state = await this.loadCatalog();
      return { artifactGeneration: state.artifact.generation, variables: this.hotVariables.list(await this.hotVariableContext(state.artifact)).map((value) => ({ ref: value.resolved.ref, logicalIdentity: value.logicalIdentity, validatedAt: value.validatedAt, stale: value.stale })) };
    });
  }

  async hotVariableRefresh(input: { refs: SymbolRef[] }): Promise<Record<string, unknown>> {
    return this.catalogCall(async () => {
      const state = await this.loadCatalog();
      const context = await this.hotVariableContext(state.artifact);
      const refreshed = await this.hotVariables.refresh(input.refs, context, async (ref) => {
        const identity = symbolLogicalIdentity(ref);
        const type = this.resolvedTypes.get(identity);
        if (!type) throw new HssError(HSS_ERROR.HOT_VARIABLE_STALE, `no server-issued type is available to refresh ${identity}`);
        return this.resolveCurrentSymbol(identity, type, state.artifact.generation);
      });
      return { artifactGeneration: state.artifact.generation, refs: refreshed.map((value) => value.resolved.ref) };
    });
  }

  async capturePlan(input: HssCapturePlanInput = {}): Promise<HssEnvelope<HssCapturePlan>> {
    return this.wrap("hss_capture_plan", input, async () => {
      const targetIdentity = await resolveHssTargetIdentity(input, { cwd: this.cwd() });
      await ensureHssProjectDirs(this.cwd());
      const planInput = await this.preparePlanInput(input);
      const plan = await buildHssCapturePlan(planInput, this.cwd(), false, targetIdentity);
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
      const startReady = Boolean((capability.hss as { startReadStopReady?: boolean }).startReadStopReady);
      plan.startReady = startReady;
      enforceHssCapability(capability, plan);
      await this.bindCapturePlan(plan, planInput, capability);
      this.plans.set(plan.planId, plan);
      if (input.variableRefs?.length) this.planVariableRefs.set(plan.planId, input.variableRefs.map((value) => ({ source: value.source, ref: { ...value.ref } })));
      return plan;
    });
  }

  async captureStart(input: HssCaptureStartInput = {}): Promise<HssEnvelope<Record<string, unknown>>> {
    return this.wrap("hss_capture_start", input, async () => {
      const env = this.env();
      if (this.active) throw new HssError(HSS_ERROR.HSS_CAPTURE_ACTIVE, "an HSS capture is already active", { captureId: this.active.captureId });
      const storedPlan = input.planId ? this.requirePlan(input.planId) : undefined;
      if (storedPlan) {
        await revalidateHssCapturePlan(storedPlan, this.cwd());
        await this.revalidatePlanVariableRefs(storedPlan);
      }
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
      const planInput = await this.preparePlanInput(input);
      const plan = storedPlan ?? await buildHssCapturePlan(planInput, this.cwd(), true, targetIdentity);
      if (!storedPlan) await this.bindCapturePlan(plan, planInput, capability);
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

      enforceHssCapability(capability, plan);
      this.plans.set(plan.planId, plan);
      if (plan.resetBeforeCapture) {
        if (!plan.resetOperation) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "resetBeforeCapture requires a bound R3 reset operation");
        if (plan.resetOperation.state !== "planned") throw new HssError(HSS_ERROR.RESET_PLAN_ALREADY_EXECUTED, "reset operation plan is single-use", { planId: plan.resetOperation.planId });
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
      const manifest = await writeArtifactMatchManifest({
        projectRoot: plan.projectRoot,
        sessionRoot: plan.output.sessionDir,
        artifact: planArtifactGeneration(plan),
        captureId: plan.output.captureId,
        targetId: plan.target.targetId,
        probeSerial: serial ?? (plan.hmC095 ? "acceptance-fixture" : requiredText(serial, "serial")),
        runtimeIdentitySha256: runtimeIdentity.sha256!,
        nonvolatileRanges: plan.artifactMatch.nonvolatileRanges,
        ramRanges: plan.artifactMatch.ramRanges,
        connectOrdinal: 1,
      });
      const writer = new JcapV0Writer({
        packageDir: plan.output.packageDir,
        externalSamples: true,
        provenance: {
          captureId: plan.output.captureId,
          ...(input.sessionName ? { sessionName: input.sessionName } : {}),
          backend: "jlink-hss",
          runtime: plainJsonRecord({ ...runtimeIdentity, roots: { projectRoot: plan.projectRoot, storageRoot: plan.storageRoot, evidenceRoot: plan.evidenceRoot } }),
          target: plainJsonRecord({ ...target, targetWasHaltedBeforeCapture, targetWasHaltedRaw: hss.targetWasHaltedRaw }),
          artifact: plainJsonRecord({ ...plan.artifact, manifestSha256: manifest.sha256 }),
          variables: plan.symbols.map((symbol) => plainJsonRecord(symbol)),
          artifactMatch: { targetArtifactMatch: "unverified", status: "pending", historyOnly: false, manifestSha256: manifest.sha256 },
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
      let activeCapture: ActiveCapture | undefined;
      let resetResult: Record<string, unknown> | undefined;
      try {
        resetResult = plan.resetBeforeCapture
          ? await this.withOperationLock(() => this.executeResetBeforeCapture(plan, runtimeIdentity, journal, target, serial))
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
        postConnectStabilityRequired: Boolean(plan.hmC095),
        postConnectCounterAddress: plan.hmC095?.counterAddress,
        postConnectCounterType: plan.hmC095?.counterType,
        postConnectCounterModulus: plan.hmC095?.modulus,
        postConnectExpectedRateHz: plan.hmC095?.focIsrFreqHz,
        postConnectRateToleranceRatio: plan.hmC095?.rateToleranceRatio,
        postConnectMinimumRecoveryMs: plan.stabilityPolicy.minimumRecoveryMs,
        postConnectTimeoutMs: plan.stabilityPolicy.timeoutMs,
        postConnectPollIntervalMs: plan.stabilityPolicy.pollIntervalMs,
        postConnectRequiredConsecutiveRunningChecks: plan.stabilityPolicy.requiredConsecutiveRunningChecks,
        target: targetIdentity,
        symbols: plan.symbols,
        artifactMatchManifestPath: manifest.path,
        artifactMatchManifestSha256: manifest.sha256,
        artifactMatchRuntimeIdentitySha256: runtimeIdentity.sha256,
        artifactGeneration: plan.artifact.generation,
        artifactSha256: plan.artifact.sha256,
        layoutHashes: plan.symbols.map((symbol) => symbol.layoutHash),
        });
        let resolveArtifactGate!: (status: "verified" | "unverified" | "mismatch") => void;
        let rejectArtifactGate!: (error: Error) => void;
        const artifactGate = new Promise<"verified" | "unverified" | "mismatch">((resolve, reject) => {
          resolveArtifactGate = resolve;
          rejectArtifactGate = reject;
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
        qpcEpochSeen: false,
        helperResultCount: 0,
        hssStarted: false,
        artifactGate,
        resolveArtifactGate,
        rejectArtifactGate,
        warnings,
        };
        activeCapture = active;
        active.done = new Promise((resolveDone) => {
        child.stdout.on("data", (data: Buffer) => { this.consumeHelperStdout(active, data.toString("utf8")); });
        child.stderr.on("data", (data: Buffer) => { active.stderr += data.toString(); });
        child.once("close", (code) => {
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
        const artifactStatus = await artifactGateWithTimeout(active.artifactGate, 30000);
        if (artifactStatus === "mismatch") {
          await active.done;
          throw new HssError(HSS_ERROR.ARTIFACT_MATCH_MISMATCH, "target content does not match the planned Artifact", active.artifactMatchEvidence);
        }
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
        targetArtifactMatch: artifactStatus,
        artifactMatch: active.artifactMatchEvidence,
        risk: plan.resetBeforeCapture ? "R3" : "R1",
        };
      } catch (error) {
        if (activeCapture && error instanceof HssError && error.code.startsWith("ARTIFACT_MATCH_")) {
          await activeCapture.done;
          throw error;
        }
        if (acquired) this.probe.releaseExclusive(owner);
        if (error instanceof HssError && error.code === HSS_ERROR.ARTIFACT_MATCH_MISMATCH) throw error;
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
           targetArtifactMatch: active.artifactMatchStatus,
           artifactMatch: active.artifactMatchEvidence,
           warnings: active.warnings,
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
    return this.withOperationLock(() => this.wrap(operation, input, async () => {
      if (this.probe.type !== "jlink") throw new HssError(HSS_ERROR.CPU_CONTROL_FAILED, "CPU control is supported only through the J-Link main backend");
      if (this.active && (operation === "halt" || operation === "reset")) {
        throw new HssError(HSS_ERROR.CAPTURE_CONFLICT, `${operation} conflicts with an active HSS capture`, { captureId: this.active.captureId, operation, hardwareActionIssued: false });
      }
      if (this.active && operation === "resume") return this.resumeActiveCapture(this.active);
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
      const layoutSha256 = createHash("sha256").update(JSON.stringify(resolvedArtifact.symbols)).digest("hex");
      const binding = createOperationPlan<CpuControlOperationPlan>({
        kind: "cpu_control",
        tool: operation,
        canonicalArgs: operation === "reset" ? { halt: input.halt === true } : {},
        risk: "R3",
        runtime: { identitySha256: runtimeIdentity.sha256!, scriptApprovalSha256: runtimeIdentity.jlinkScriptApprovalSha256! },
        target: { targetId: targetIdentity.targetId, ...(probe.serialNumber ? { probeSerial: probe.serialNumber } : {}), connectionGeneration: 1 },
        artifact: { generation: resolvedArtifact.sha256, sha256: resolvedArtifact.sha256, match: "unverified", evidenceGeneration: resolvedArtifact.sha256 },
        layout: { sha256: layoutSha256 },
        policy: { sha256: policy.policyHash, rule: `cpu:${operation}`, maxWrites: 0, remainingWrites: 0, maxElements: 0, remainingElements: 0 },
        session: { id: this.sessionId, captureId: OUTSIDE_CAPTURE_ID, captureGeneration: 0 },
        readback: { required: false },
        ttlMs: 60000,
      });
      const executionIdentity = refreshHssRuntimeIdentity(runtimeIdentity, {
        env: this.env(),
        helperPath: runtimeIdentity.helperPath,
        adapterPath: runtimeIdentity.adapterPath,
        validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(runtimeIdentity),
      });
      if (!hssRuntimeIdentityMatches(runtimeIdentity, executionIdentity)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "CPU-control runtime identity changed before hardware access");
      claimOperationPlan(binding);
      await appendHssAudit(this.sessionId, operation, binding, { phase: "intent", auditId: binding.auditId }, this.cwd());
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
          operationDigest: binding.digest,
          auditId: binding.auditId,
          beforeState: result.beforeState ?? "unknown",
          afterState: result.afterState ?? "unknown",
        })
        : undefined;
      return { operation, risk: "R3", binding, planId: binding.planId, planDigest: binding.digest, auditId: binding.auditId, result, runtimeIdentity: postIdentity, scriptIdentity: script, eventId: event?.eventId };
    }));
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
      const artifactMatch = active.artifactMatchStatus ?? await artifactGateWithTimeout(active.artifactGate, 5000);
      if (!active.plan.artifact.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "active HSS capture has no map file");
      const policy = await loadHssPolicy(this.cwd());
      await revalidateHssCapturePlan(active.plan, this.cwd());
      return this.writePlans.put(createHssVariableWritePlan(input, {
        captureId: active.captureId,
        captureGeneration: active.generation,
        backend: "jlink-hss",
        mapFile: active.plan.artifact.mapFile,
        policy,
        ...this.writeCounts(active.captureId, input.targetRef?.path ?? input.target ?? ""),
        ...this.activeWriteBinding(active),
      }));
    });
  }

  async r4Binding(tool: Exclude<R4ExecuteTool, "variable_write_execute">, canonicalArgs: Record<string, unknown>, gdbConnectionGeneration?: number): Promise<R4PlanInput> {
    const probe = this.probe.getCaptureConfig();
    if (!probe?.device || probe.device === "Unspecified") throw new HssError(HSS_ERROR.HSS_DEVICE_REQUIRED, "R4 planning requires an explicitly configured J-Link target");
    const target = await resolveHssTargetIdentity({ device: probe.device }, { cwd: this.cwd() });
    const policy = await loadHssPolicy(this.cwd());
    const active = this.active;
    const artifact = active
      ? { generation: active.plan.artifact.generation, sha256: active.plan.artifact.sha256, mapSha256: active.plan.artifact.mapSha256 }
      : tool === "flash"
        ? await resolveArtifactGeneration({ projectRoot: this.cwd(), explicitArtifact: String(canonicalArgs.filePath) })
        : this.catalogState?.artifact ?? await resolveArtifactGeneration({ projectRoot: this.cwd() });
    const connectionGeneration = tool === "gdb_command" ? gdbConnectionGeneration : this.probe.getConnectionGeneration() + 1;
    if (!Number.isSafeInteger(connectionGeneration) || Number(connectionGeneration) < 1) throw new HssError(HSS_ERROR.HSS_DEVICE_REQUIRED, "R4 planning requires a current or reserved physical connection generation");
    const artifactMatch = active?.artifactMatchStatus ?? "unverified";
    return {
      tool,
      canonicalArgs,
      target: { targetId: target.targetId, artifactMatch },
      probe: { kind: tool === "gdb_command" ? "gdb" : "jlink", ...(probe.serialNumber ? { serial: probe.serialNumber } : {}), interface: probe.interface, speedKhz: probe.speed },
      artifact: { generation: artifact.generation, sha256: artifact.sha256 },
      layoutHash: active ? hssLayoutSha256(active.plan) : artifact.mapSha256 ?? artifact.generation,
      policy: { sha256: policy.policyHash, unverifiedWriteException: false },
      session: { id: this.sessionId, ...(active ? { captureId: active.captureId } : {}) },
      connectionGeneration: Number(connectionGeneration),
    };
  }

  variableWriteRisk(writePlanId: string): "R2" | "R4" { return this.writePlans.peek(writePlanId).risk; }

  async variableWriteApprovalBinding(writePlanId: string): Promise<R4PlanInput> {
    const plan = await this.revalidateVariableWritePlan(writePlanId);
    if (plan.risk !== "R4" || plan.operationPlan.artifact.match !== "unverified") throw new HssError(HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE, "only an explicit unverified-target R4 write plan may request approval", { writePlanId, risk: plan.risk });
    const operation = plan.operationPlan;
    const probe = this.probe.getCaptureConfig();
    return {
      tool: "variable_write_execute",
      canonicalArgs: { writePlanId },
      target: { targetId: operation.target.targetId, artifactMatch: operation.artifact.match },
      probe: { kind: "jlink", ...(operation.target.probeSerial ? { serial: operation.target.probeSerial } : {}), ...(probe ? { interface: probe.interface, speedKhz: probe.speed } : {}) },
      artifact: { generation: operation.artifact.generation, sha256: operation.artifact.sha256 },
      layoutHash: operation.layout.sha256,
      policy: { sha256: operation.policy.sha256, unverifiedWriteException: true },
      session: { id: operation.session.id, ...(operation.session.captureId ? { captureId: operation.session.captureId } : {}) },
      connectionGeneration: operation.target.connectionGeneration,
    };
  }

  async executeR4VariableWrite(writePlanId: string, approval: R4ApprovalConsumptionEvidence): Promise<HssVariableWriteExecuteResult | { success: false; code: "native_r4_unavailable" | "execution_failed"; message: string }> {
    const plan = await this.revalidateVariableWritePlan(writePlanId);
    const approvalBinding = await this.variableWriteApprovalBinding(writePlanId);
    const permit = checkR4ExecutionPermit("variable_write_execute", { writePlanId }, approvalBinding.connectionGeneration);
    if (permit) return { success: false, code: "execution_failed", message: permit.message };
    claimOperationPlan(plan.operationPlan);
    const binding = this.outsideWriteBindings.get(writePlanId);
    if (!binding) return { success: false, code: "native_r4_unavailable", message: "active-capture Native R4 variable-write execution is not supported; approval was consumed without a hardware write" };
    const runtimeIdentity = refreshHssRuntimeIdentity(binding.runtimeIdentity, { env: this.env(), helperPath: binding.runtimeIdentity.helperPath, adapterPath: binding.runtimeIdentity.adapterPath, validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(binding.runtimeIdentity) });
    if (!hssRuntimeIdentityMatches(binding.runtimeIdentity, runtimeIdentity)) return { success: false, code: "execution_failed", message: "R4 variable-write runtime identity changed before helper launch" };
    const envelope = createHssR4NativeExceptionEnvelope(plan, approvalBinding, approval, this.options.targetEndian ?? "little");
    return this.executeR4OutsideWriteHelper(plan, binding, runtimeIdentity, envelope);
  }

  async variableWriteExecute(input: HssVariableWriteExecuteInput): Promise<HssEnvelope<HssVariableWriteExecuteResult>> {
    let outcomeAuditAppended = false;
    return this.wrap("variable_write_execute", input, async () => {
      const active = this.active;
      if (!active) return this.executeOutsideWrite(input);
      const writePlanId = input.writePlanId;
      if (!writePlanId) throw new HssError(HSS_ERROR.ACTIVE_CAPTURE_WRITE_REQUIRES_CAPTURE_QUEUE, "active HSS capture writes require a queued write plan");
      assertActiveWritable(active);
      if (!active.plan.artifact.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "active HSS capture has no map file");
      return active.writeQueue.run(async () => {
        assertActiveWritable(active);
        await revalidateHssCapturePlan(active.plan, this.cwd());
        const policy = await loadHssPolicy(this.cwd());
        const preflightPlan = this.writePlans.peek(writePlanId);
        const counts = this.writeCounts(active.captureId, preflightPlan.targetRef.path);
        const plan = this.writePlans.claim(writePlanId, { ...this.activeWriteRevalidateContext(active, policy, active.plan.artifact.mapFile!), ...counts });
        this.consumeWrite(plan);
        await appendHssAudit(this.sessionId, "variable_write_execute", plan.operationPlan, { phase: "intent", auditId: plan.operationPlan.auditId }, this.cwd());
        const io = this.options.memoryIo ?? new HelperHssVariableMemoryIo(active.writeRequestFile, active.writeResponseFile, active.captureId);
        try {
          const result = await executeHssVariableWritePlan(plan, io, this.options.targetEndian ?? "little", Boolean(input.dryRun), (stage) => active.writeQueue.setStage(stage));
          result.auditId = plan.operationPlan.auditId;
          result.policyHash = plan.policyHash;
          result.symbolLayoutHash = plan.symbolLayoutHash;
          if (!input.dryRun) {
            active.writeQueue.setStage("EVENT_APPEND");
            const writeQpcCounter = result.operationAfterQpcCounter ?? (this.options.memoryIo ? await this.qpcCounter(active) : undefined);
            if (!writeQpcCounter) throw new HssError(HSS_ERROR.HSS_HELPER_BAD_JSON, "capture helper write response omitted the same-connection QPC timestamp", { writeIssued: true, ...result });
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
              auditId: plan.operationPlan.auditId,
              operationDigest: plan.operationPlan.digest,
              ok: true,
            });
            result.eventId = event.eventId;
            appendHssJcapEvent(active.journal, "flag", writeQpcCounter, { flag: "write_nearby", sourceEventId: event.eventId, ok: true });
            active.journal.writer.syncEvents();
          }
          return result;
        } catch (error) {
          const hss = error instanceof HssError ? error : new HssError(HSS_ERROR.UNKNOWN_WRITE_STATE, error instanceof Error ? error.message : String(error), { writeIssued: true });
          hss.details.auditId = plan.operationPlan.auditId;
          hss.details.policyHash = plan.policyHash;
          hss.details.symbolLayoutHash = plan.symbolLayoutHash;
          if (hss.details.writeIssued === true) {
            const maybeResult = "writeId" in hss.details ? hss.details as unknown as HssVariableWriteExecuteResult : undefined;
            active.writeQueue.setStage("EVENT_APPEND");
            const writeQpcCounter = maybeResult?.operationAfterQpcCounter ?? helperErrorQpc(hss) ?? (this.options.memoryIo ? await this.qpcCounter(active) : active.journal.qpcEpochCounter.toString());
            const event = appendHssJcapEvent(active.journal, "variable_write", writeQpcCounter, {
              writeId: maybeResult?.writeId ?? randomUUID(),
              writeKind: plan.targetRef.kind,
              canonicalTarget: plan.canonicalTarget,
              targetRef: plan.targetRef,
              readbackOk: maybeResult?.readbackOk ?? false,
              mismatches: maybeResult?.mismatches ?? [],
              risk: plan.risk,
              auditId: plan.operationPlan.auditId,
              operationDigest: plan.operationPlan.digest,
              ok: false,
              errorCode: hss.code,
            });
            appendHssJcapEvent(active.journal, "flag", writeQpcCounter, { flag: "backend_busy", sourceEventId: event.eventId, ok: false, errorCode: hss.code });
            active.journal.writer.syncEvents();
            if (maybeResult) maybeResult.eventId = event.eventId;
            if (maybeResult) maybeResult.queueStages = active.writeQueue.history();
            if (hss.code === HSS_ERROR.READBACK_MISMATCH) active.writeReadbackMismatch = true;
          }
          throw hss;
        }
      }, async (outcome) => {
        active.writeQueue.setStage("AUDIT_APPEND");
        if (outcome.ok) {
          outcome.value.queueStages = active.writeQueue.history();
          await appendHssAudit(this.sessionId, "variable_write_execute", input, hssOk("variable_write_execute", outcome.value), this.cwd());
          outcomeAuditAppended = true;
          return;
        }
        const failure = outcome.error instanceof HssError
          ? outcome.error
          : new HssError(HSS_ERROR.UNKNOWN_WRITE_STATE, outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
        failure.details.queueStages = active.writeQueue.history();
        await appendHssAudit(this.sessionId, "variable_write_execute", input, hssFail("variable_write_execute", failure), this.cwd());
        outcomeAuditAppended = true;
      });
    }, { audit: () => !outcomeAuditAppended });
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
    const path = outsideTargetPath(input);
    const resolved = await resolveHssDebugArtifact({
      artifactFile: input.artifactFile,
      mapFile: input.mapFile,
      symbols: [{ name: path, type: input.type }],
      cwd: this.cwd(),
    });
    if (!resolved.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "write target map file was not found");
    const artifact = await resolveArtifactGeneration({ projectRoot: this.cwd(), explicitArtifact: resolved.artifactFile, explicitMap: resolved.mapFile });
    const policy = await loadHssPolicy(this.cwd());
    const probe = this.probe.getCaptureConfig();
    if (!probe?.device || probe.device === "Unspecified") throw new HssError(HSS_ERROR.HSS_DEVICE_REQUIRED, "outside variable writes require an explicitly configured J-Link target device");
    if (!this.options.memoryIo && !probe.serialNumber) throw new HssError(HSS_ERROR.HSS_DEVICE_REQUIRED, "outside variable writes require an explicitly configured J-Link probe serial");
    const targetIdentity = await resolveHssTargetIdentity({ device: probe.device }, { cwd: this.cwd() });
    const trustProfile = readHssTrustProfile(this.cwd());
    const scriptSpec = trustProfileScript(trustProfile);
    const scriptIdentity = resolveHssScriptIdentity({ script: scriptSpec, device: targetIdentity.targetId, interface: probe.interface, speedKhz: probe.speed, serial: probe.serialNumber }, this.env(), {
      cwd: this.cwd(), validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256, validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256, trustProfile,
    });
    if (!scriptIdentity.validated || !scriptIdentity.approvalSha256) throw new HssError(HSS_ERROR.HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED, scriptIdentity.reason ?? "trusted J-Link ScriptFile identity is required");
    const capability = await hssCapabilityProbe({ dllPath: configuredJlinkDllPath(probe), device: targetIdentity.targetId, interface: probe.interface, speedKhz: probe.speed, serial: probe.serialNumber, script: scriptSpec }, {
      env: this.env(), helperPath: this.options.helperPath, helperArgsPrefix: this.options.helperArgsPrefix,
      validatedDllSha256: this.options.validatedDllSha256, validatedRuntimeIdentitySha256: this.options.validatedRuntimeIdentitySha256,
      validatedJlinkScriptSha256: this.options.validatedJlinkScriptSha256, adapterPath: this.options.adapterPath,
      cwd: this.cwd(), targetIdentity, scriptIdentity, trustProfile,
    });
    const runtimeIdentity = capability.runtimeIdentity as HssRuntimeIdentity;
    if (!runtimeIdentity?.validated || !runtimeIdentity.sha256) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_UNVALIDATED, "outside variable-write runtime identity is not validated");
    const ranges = this.options.memoryIo
      ? { nonvolatileRanges: [{ start: 0, end: 0x20000000 }], ramRanges: [{ start: 0x20000000, end: 0x40000000 }] }
      : elfOperationRanges(resolved.artifactFile);
    const plan = this.writePlans.put(createHssVariableWritePlan(input, {
      captureId: OUTSIDE_CAPTURE_ID,
      captureGeneration: 0,
      backend: "jlink-hss",
      mapFile: resolved.mapFile,
      policy,
      willEnterCaptureQueue: false,
      ...this.writeCounts(OUTSIDE_CAPTURE_ID, path),
      runtimeIdentitySha256: runtimeIdentity.sha256,
      scriptApprovalSha256: scriptIdentity.approvalSha256,
      targetId: targetIdentity.targetId,
      ...(probe.serialNumber ? { probeSerial: probe.serialNumber } : {}),
      artifactGeneration: artifact.generation,
      artifactSha256: artifact.sha256,
      targetArtifactMatch: "unverified",
      evidenceGeneration: artifact.generation,
      connectionGeneration: this.probe.getConnectionGeneration() + 1,
      sessionId: this.sessionId,
    }));
    this.outsideWriteBindings.set(plan.writePlanId, {
      mapFile: resolved.mapFile, artifact, runtimeIdentity,
      scriptIdentity: scriptIdentity as HssScriptIdentity & { validated: true; approvalSha256: string },
      targetId: targetIdentity.targetId, serial: probe.serialNumber, interface: probe.interface, speedKhz: probe.speed,
      ...ranges, targetArtifactMatch: "unverified", evidenceGeneration: artifact.generation, connectionGeneration: this.probe.getConnectionGeneration() + 1,
    });
    return plan;
  }

  private async executeOutsideWrite(input: HssVariableWriteExecuteInput): Promise<HssVariableWriteExecuteResult> {
    if (!input.writePlanId) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "variable_write_execute requires a prior writePlanId");
    const policy = await loadHssPolicy(this.cwd());
    const binding = this.outsideWriteBindings.get(input.writePlanId);
    if (!binding) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "outside-capture write plan was not found", { writePlanId: input.writePlanId });
    const artifact = await resolveArtifactGeneration({ projectRoot: this.cwd(), explicitArtifact: binding.artifact.path, explicitMap: binding.mapFile });
    const executionIdentity = refreshHssRuntimeIdentity(binding.runtimeIdentity, { env: this.env(), helperPath: binding.runtimeIdentity.helperPath, adapterPath: binding.runtimeIdentity.adapterPath, validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(binding.runtimeIdentity) });
    if (!hssRuntimeIdentityMatches(binding.runtimeIdentity, executionIdentity) || artifact.generation !== binding.artifact.generation) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "outside variable-write runtime or Artifact identity changed before hardware access");
    const peek = this.writePlans.peek(input.writePlanId);
    const counts = this.writeCounts(OUTSIDE_CAPTURE_ID, peek.targetRef.path);
    const plan = this.writePlans.claim(input.writePlanId, {
      captureId: OUTSIDE_CAPTURE_ID, captureGeneration: 0, policy, mapFile: binding.mapFile,
      runtimeIdentitySha256: executionIdentity.sha256!, scriptApprovalSha256: binding.scriptIdentity.approvalSha256,
      targetId: binding.targetId, ...(binding.serial ? { probeSerial: binding.serial } : {}),
      artifactGeneration: artifact.generation, artifactSha256: artifact.sha256, targetArtifactMatch: "verified", evidenceGeneration: artifact.generation,
      connectionGeneration: 1, sessionId: this.sessionId, ...counts,
    });
    this.consumeWrite(plan);
    await appendHssAudit(this.sessionId, "variable_write_execute", plan.operationPlan, { phase: "intent", auditId: plan.operationPlan.auditId }, this.cwd());
    try {
      const result = input.dryRun
        ? await executeHssVariableWritePlan(plan, { read: async () => Buffer.alloc(0), write: async () => undefined }, this.options.targetEndian ?? "little", true)
        : this.options.memoryIo
        ? await executeHssVariableWritePlan(plan, this.options.memoryIo, this.options.targetEndian ?? "little", Boolean(input.dryRun))
        : await this.executeOutsideWriteHelper(plan, binding, executionIdentity);
      result.auditId = plan.operationPlan.auditId;
      result.policyHash = plan.policyHash;
      result.symbolLayoutHash = plan.symbolLayoutHash;
      return result;
    } catch (error) {
      if (error instanceof HssError) {
        error.details.auditId = plan.operationPlan.auditId;
        error.details.policyHash = plan.policyHash;
        error.details.symbolLayoutHash = plan.symbolLayoutHash;
      }
      throw error;
    }
  }

  private async revalidateVariableWritePlan(writePlanId: string): Promise<HssVariableWritePlan> {
    const plan = this.writePlans.peek(writePlanId);
    const policy = await loadHssPolicy(this.cwd());
    if (plan.captureId !== OUTSIDE_CAPTURE_ID) {
      const active = this.active;
      if (!active || active.captureId !== plan.captureId) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "active write plan owner changed", { writePlanId });
      assertActiveWritable(active);
      if (!active.plan.artifact.mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "active HSS capture has no map file");
      await revalidateHssCapturePlan(active.plan, this.cwd());
      return this.writePlans.get(writePlanId, { ...this.activeWriteRevalidateContext(active, policy, active.plan.artifact.mapFile), ...this.writeCounts(active.captureId, plan.targetRef.path) });
    }
    const binding = this.outsideWriteBindings.get(writePlanId);
    if (!binding) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "outside-capture write plan was not found", { writePlanId });
    const probe = this.probe.getCaptureConfig();
    if (!probe || probe.device !== binding.targetId || probe.serialNumber !== binding.serial || probe.interface !== binding.interface || probe.speed !== binding.speedKhz) {
      throw new HssError(HSS_ERROR.WRITE_PLAN_CAPTURE_MISMATCH, "outside variable-write target or probe binding changed", { writePlanId });
    }
    const artifact = await resolveArtifactGeneration({ projectRoot: this.cwd(), explicitArtifact: binding.artifact.path, explicitMap: binding.mapFile });
    const identity = refreshHssRuntimeIdentity(binding.runtimeIdentity, { env: this.env(), helperPath: binding.runtimeIdentity.helperPath, adapterPath: binding.runtimeIdentity.adapterPath, validatedRuntimeIdentitySha256: this.validatedRuntimeHashes(binding.runtimeIdentity) });
    if (!hssRuntimeIdentityMatches(binding.runtimeIdentity, identity) || artifact.generation !== binding.artifact.generation) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "outside variable-write runtime or Artifact identity changed before approval execution");
    return this.writePlans.get(writePlanId, {
      captureId: OUTSIDE_CAPTURE_ID, captureGeneration: 0, policy, mapFile: binding.mapFile,
      runtimeIdentitySha256: identity.sha256!, scriptApprovalSha256: binding.scriptIdentity.approvalSha256,
      targetId: binding.targetId, ...(binding.serial ? { probeSerial: binding.serial } : {}),
      artifactGeneration: artifact.generation, artifactSha256: artifact.sha256, targetArtifactMatch: binding.targetArtifactMatch, evidenceGeneration: binding.evidenceGeneration,
      connectionGeneration: binding.connectionGeneration, sessionId: this.sessionId, ...this.writeCounts(OUTSIDE_CAPTURE_ID, plan.targetRef.path),
    });
  }

  private async executeOutsideWriteHelper(plan: HssVariableWritePlan, binding: OutsideWriteBinding, runtimeIdentity: HssRuntimeIdentity): Promise<HssVariableWriteExecuteResult> {
    const sessionRoot = join(this.paths.sessionsDir, this.sessionId, plan.writePlanId);
    await mkdir(sessionRoot, { recursive: true });
    const helperPlanFile = join(sessionRoot, "helper-plan.json");
    await writeHelperPlan(helperPlanFile, { writePlanId: plan.writePlanId, operationDigest: plan.operationPlan.digest });
    const manifest = await writeArtifactMatchManifest({
      projectRoot: this.cwd(), sessionRoot, artifact: binding.artifact,
      captureId: OUTSIDE_CAPTURE_ID, targetId: binding.targetId,
      probeSerial: requiredText(binding.serial, "probe serial"), runtimeIdentitySha256: runtimeIdentity.sha256!,
      nonvolatileRanges: binding.nonvolatileRanges, ramRanges: binding.ramRanges, connectOrdinal: 1,
    });
    const address = plan.address ?? plan.elementAddress;
    const accessSize = plan.byteSize ?? plan.elementSize;
    if (address === undefined || (accessSize !== 1 && accessSize !== 2 && accessSize !== 4)) throw new HssError(HSS_ERROR.WRITE_MEMORY_FAILED, "outside write plan address or access size is invalid");
    const type = (plan.dataType ?? plan.elementType) as HssScalarType;
    const bytes = encodeHssValues(type, plan.newValues ?? [plan.newValue as number], this.options.targetEndian ?? "little");
    const response = await runHssHelperCommand("variable-write", [
      "--dll", runtimeIdentity.dllPath ?? "", "--approved-dll-sha256", runtimeIdentity.dllSha256 ?? "",
      "--device", binding.targetId, "--interface", binding.interface, "--speed", String(binding.speedKhz),
      ...(binding.serial ? ["--serial", binding.serial] : []), ...hssScriptHelperArgs(binding.scriptIdentity),
      "--capture-id", OUTSIDE_CAPTURE_ID,
      "--plan", helperPlanFile,
      "--artifact-match-manifest", manifest.path, "--artifact-match-manifest-sha256", manifest.sha256,
      "--artifact-match-runtime-identity-sha256", runtimeIdentity.sha256!, "--artifact-generation", binding.artifact.generation, "--artifact-sha256", binding.artifact.sha256,
      "--address", `0x${address.toString(16)}`, "--length", String(bytes.length), "--access-size", String(accessSize), "--bytes-hex", bytes.toString("hex"),
    ], { env: this.env(), helperPath: runtimeIdentity.helperPath, helperArgsPrefix: this.options.helperArgsPrefix, timeoutMs: 30000 });
    if (response.status !== "ok" || response.targetArtifactMatch !== "verified") {
      throw new HssError(response.targetArtifactMatch === "mismatch" ? HSS_ERROR.ARTIFACT_MATCH_MISMATCH : HSS_ERROR.UNKNOWN_WRITE_STATE, String(response.reason ?? "outside variable-write helper failed"), { ...response, writeIssued: response.writeIssued === true });
    }
    if (!helperReportedIdentityMatches(response, runtimeIdentity)) throw new HssError(HSS_ERROR.HSS_RUNTIME_IDENTITY_CHANGED, "outside variable-write helper reported a different runtime or ScriptFile identity", { response, writeIssued: response.writeIssued === true });
    const oldBytes = strictHexBytes(response.oldBytesHex, plan.writeByteCount, "oldBytesHex");
    const readbackBytes = strictHexBytes(response.readbackBytesHex, plan.writeByteCount, "readbackBytesHex");
    return hssVariableWriteResultFromBytes(
      plan, oldBytes, readbackBytes, this.options.targetEndian ?? "little",
      requiredText(response.operationBeforeQpcCounter, "operationBeforeQpcCounter"),
      requiredText(response.operationAfterQpcCounter, "operationAfterQpcCounter"),
    );
  }

  private async executeR4OutsideWriteHelper(plan: HssVariableWritePlan, binding: OutsideWriteBinding, runtimeIdentity: HssRuntimeIdentity, envelope: HssR4NativeExceptionEnvelope): Promise<HssVariableWriteExecuteResult | { success: false; code: "native_r4_unavailable" | "execution_failed"; message: string }> {
    const sessionRoot = join(this.paths.sessionsDir, this.sessionId, plan.writePlanId);
    await mkdir(sessionRoot, { recursive: true });
    const helperPlanFile = join(sessionRoot, "r4-native-exception.json");
    await writeHelperPlan(helperPlanFile, envelope);
    assertHssR4NativeExceptionEnvelope(JSON.parse(await readFile(helperPlanFile, "utf8")), envelope.summarySha256);
    const manifest = await writeArtifactMatchManifest({
      projectRoot: this.cwd(), sessionRoot, artifact: binding.artifact,
      captureId: OUTSIDE_CAPTURE_ID, targetId: binding.targetId,
      probeSerial: requiredText(binding.serial, "probe serial"), runtimeIdentitySha256: runtimeIdentity.sha256!,
      nonvolatileRanges: binding.nonvolatileRanges, ramRanges: binding.ramRanges, connectOrdinal: 1,
    });
    const response = await runHssHelperCommand("variable-write-r4", [
      "--dll", runtimeIdentity.dllPath ?? "", "--approved-dll-sha256", runtimeIdentity.dllSha256 ?? "",
      "--device", binding.targetId, "--interface", binding.interface, "--speed", String(binding.speedKhz),
      ...(binding.serial ? ["--serial", binding.serial] : []), ...hssScriptHelperArgs(binding.scriptIdentity),
      "--capture-id", OUTSIDE_CAPTURE_ID, "--plan", helperPlanFile, "--r4-exception-summary-sha256", envelope.summarySha256,
      "--artifact-match-manifest", manifest.path, "--artifact-match-manifest-sha256", manifest.sha256,
      "--artifact-match-runtime-identity-sha256", runtimeIdentity.sha256!, "--artifact-generation", binding.artifact.generation, "--artifact-sha256", binding.artifact.sha256,
      "--address", `0x${envelope.write.address.toString(16)}`, "--length", String(envelope.write.byteLength), "--access-size", String(envelope.write.accessSize), "--bytes-hex", envelope.write.bytesHex,
    ], { env: this.env(), helperPath: runtimeIdentity.helperPath, helperArgsPrefix: this.options.helperArgsPrefix, timeoutMs: 30000 });
    if (response.writeIssued === true) this.consumeWrite(plan);
    const errorCode = String(response.errorCode ?? "");
    if (response.writeIssued !== true && (errorCode === "HSS_HELPER_UNKNOWN_COMMAND" || errorCode === "HSS_R4_NATIVE_EXCEPTION_UNSUPPORTED")) {
      return { success: false, code: "native_r4_unavailable", message: String(response.reason ?? "Native R4 variable exception is not supported") };
    }
    if (response.status !== "ok" || response.r4ExceptionConsumed !== true || response.r4ExceptionSummarySha256 !== envelope.summarySha256 || response.targetArtifactMatch !== "unverified") {
      return { success: false, code: "execution_failed", message: String(response.reason ?? "Native rejected the R4 variable exception envelope") };
    }
    if (!helperReportedIdentityMatches(response, runtimeIdentity)) return { success: false, code: "execution_failed", message: "Native reported a different runtime or ScriptFile identity" };
    const oldBytes = strictHexBytes(response.oldBytesHex, plan.writeByteCount, "oldBytesHex");
    const readbackBytes = strictHexBytes(response.readbackBytesHex, plan.writeByteCount, "readbackBytesHex");
    return hssVariableWriteResultFromBytes(plan, oldBytes, readbackBytes, this.options.targetEndian ?? "little", requiredText(response.operationBeforeQpcCounter, "operationBeforeQpcCounter"), requiredText(response.operationAfterQpcCounter, "operationAfterQpcCounter"));
  }

  private async finishActive(active: ActiveCapture, code: number | null): Promise<void> {
    if (this.active?.captureId !== active.captureId) return;
    this.consumeHelperStdout(active, "", true);
    if (!active.artifactMatchStatus && !active.stdoutError) {
      active.rejectArtifactGate(new HssError(HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED, "helper exited without reporting Artifact match evidence"));
    }
    let state: "completed" | "stopped" | "recoverable" | "failed" = "failed";
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
      if (active.artifactMatchStatus === "mismatch" && !active.hssStarted && helperResult.rawOpened !== true) {
        active.journal.writer.close();
        await rm(active.plan.output.packageDir, { recursive: true, force: true });
        return;
      }
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
      if (active.writeReadbackMismatch && state !== "failed") state = "recoverable";
      const counter = await this.qpcCounter(active).catch(() => active.journal.qpcEpochCounter.toString());
      if (rawProof && active.hssStarted) {
        const raw = readJcapV0Raw(active.plan.output.packageDir);
        const records: HssSampleRecord[] = raw.samples.map((sample) => ({
          sampleIndex: BigInt(sample.sampleIndex),
          timestampTicks: BigInt(sample.tick),
          statusFlags: sample.statusFlags,
          rawValues: active.plan.symbols.map((symbol) => Number(sample.values[symbol.name])),
        }));
        const semantic = active.plan.hmC095 ? hmC095Validation(records, active.plan.symbols, active.plan.sampling.requestedRateHz, {
          transportStatus: "pass",
          reset: active.plan.resetBeforeCapture ? { operation: active.plan.resetOperation } : undefined,
          hmC095Oracle: active.plan.hmC095,
        } as unknown as HssCaptureMetadata) : { semanticPass: true, profile: "not_requested" };
        if (active.plan.hmC095) appendHssJcapEvent(active.journal, "quality", counter, { check: "hm_c095", ...semantic });
        if (active.plan.hmC095 && semantic.semanticPass !== true) {
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
      active.rejectArtifactGate(active.stdoutError);
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
      catch (error) {
        active.stdoutError = error instanceof Error ? error : new Error(String(error));
        active.rejectArtifactGate(active.stdoutError);
        break;
      }
    }
  }

  private acceptHelperRecord(active: ActiveCapture, record: Record<string, unknown>): void {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("helper NDJSON record must be an object");
    if (record.captureId !== active.captureId) throw new Error("helper NDJSON captureId mismatch");
    if (record.record === "lifecycle" && record.phase === "qpc_epoch") {
      if (active.qpcEpochSeen) throw new Error("helper emitted duplicate qpc_epoch");
      const streamQpc = parseHssQpcTimebase(record);
      if (streamQpc.qpcEpochCounter !== active.journal.qpcEpochCounter || streamQpc.qpcFrequency !== active.journal.qpcFrequency) throw new Error("helper lifecycle QPC timebase mismatch");
      active.qpcEpochSeen = true;
      return;
    }
    if (!active.qpcEpochSeen) throw new Error("helper emitted a record before qpc_epoch");
    if (record.record === "result") {
      const resultQpc = parseHssQpcTimebase(record);
      if (resultQpc.qpcEpochCounter !== active.journal.qpcEpochCounter || resultQpc.qpcFrequency !== active.journal.qpcFrequency) throw new Error("helper result QPC timebase mismatch");
      active.helperResultCount += 1;
      if (active.helperResultCount !== 1) throw new Error("helper emitted more than one result record");
      active.helperResult = record;
      const resultStatus = artifactMatchStatus(record.targetArtifactMatch);
      if (!active.artifactMatchStatus) {
        const errorCode = typeof record.errorCode === "string" ? record.errorCode : "";
        if (record.status === "error" && /^ARTIFACT_MATCH_[A-Z0-9_]+$/.test(errorCode)) {
          active.rejectArtifactGate(new HssError(errorCode as HssErrorCode, typeof record.reason === "string" && record.reason ? record.reason : "native Artifact match gate failed"));
          return;
        }
        throw new HssError(HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED, "helper result arrived without one native artifact_match record");
      }
      if (resultStatus && resultStatus !== active.artifactMatchStatus) throw new Error("helper result Artifact match status disagrees with native artifact_match");
      return;
    }
    if (record.record === "artifact_match") {
      const status = artifactMatchStatus(record.targetArtifactMatch);
      if (!status) throw new Error("helper artifact_match record has an invalid status");
      if (active.artifactMatchStatus) throw new Error("helper emitted duplicate Artifact match evidence");
      this.recordArtifactMatch(active, status, record.artifactMatch);
      return;
    }
    if (record.record === "fault") {
      appendHssJcapEvent(active.journal, "fault", record.qpcCounter, { errorCode: record.errorCode, reason: record.reason });
      return;
    }
    if (record.record !== "lifecycle") throw new Error("helper emitted an unknown NDJSON record kind");
    if (record.phase === "hss_start") {
      if (!Number.isSafeInteger(record.returnCode) || Number(record.returnCode) < 0 || record.crashed !== false) return;
      if (!active.artifactMatchStatus) throw new HssError(HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED, "helper reported HSS Start before native artifact_match");
      if (active.hssStarted) throw new Error("helper emitted duplicate successful hss_start");
      appendHssJcapEvent(active.journal, "lifecycle", record.qpcCounter, { state: "active", phase: "hss_start", returnCode: record.returnCode });
      active.hssStarted = true;
      return;
    }
    appendHssJcapEvent(active.journal, "quality", record.qpcCounter, { phase: record.phase, returnCode: record.returnCode, crashed: record.crashed, samplesBytes: record.samplesBytes, samplesByteBudget: record.samplesByteBudget });
  }

  private recordArtifactMatch(active: ActiveCapture, status: "verified" | "unverified" | "mismatch", evidence: unknown): void {
    active.artifactMatchStatus = status;
    active.artifactMatchEvidence = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence as Record<string, unknown> : {};
    const counter = active.journal.qpcEpochCounter
      + ((active.journal.lastTick * active.journal.qpcFrequency + 999_999_999n) / 1_000_000_000n);
    appendHssJcapEvent(active.journal, "artifact_match", counter.toString(), { targetArtifactMatch: status, ...active.artifactMatchEvidence });
    const gateErrorCode = typeof active.artifactMatchEvidence.gateErrorCode === "string" ? active.artifactMatchEvidence.gateErrorCode : "";
    if (status === "unverified" && (active.artifactMatchEvidence.captureAllowed === false || gateErrorCode)) {
      active.rejectArtifactGate(new HssError(HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED, String(active.artifactMatchEvidence.reason || "Native helper rejected incomplete Artifact verification"), { nativeGateErrorCode: gateErrorCode, ...active.artifactMatchEvidence }));
      return;
    }
    if (status === "unverified") active.warnings.push("target Artifact match is unverified; read-only capture continued");
    active.resolveArtifactGate(status);
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

  private acceptancePlanInput(input: HssCapturePlanInput): HssCapturePlanInput {
    return this.options.trustValidation && !input.variableRefs?.length && !input.variables?.length && !input.symbols?.length
      ? { ...input, acceptanceProfile: "hm_c095" }
      : input;
  }

  private async preparePlanInput(input: HssCapturePlanInput): Promise<HssCapturePlanInput> {
    const prepared = this.acceptancePlanInput(input);
    if (!prepared.variableRefs?.length) return prepared;
    const state = await this.loadCatalog({ artifactFile: prepared.artifactFile, mapFile: prepared.mapFile });
    const context = await this.hotVariableContext(state.artifact);
    const seen = new Set<string>();
    const variables = prepared.variableRefs.map(({ source, ref }) => {
      if (ref.artifactGeneration !== state.artifact.generation) throw new HssError(HSS_ERROR.HOT_VARIABLE_STALE, "HSS variable reference uses a stale Artifact generation", { ref, currentArtifactGeneration: state.artifact.generation });
      const identity = symbolLogicalIdentity(ref);
      if (seen.has(identity)) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, `duplicate HSS variable reference: ${identity}`);
      seen.add(identity);
      if (source === "hot_variable") {
        const hot = this.hotVariables.get(ref, context);
        if (!hot.ok) throw new HssError(HSS_ERROR.HOT_VARIABLE_STALE, hot.error.reason, { code: hot.error.code });
        return hot.value.resolved;
      }
      return this.requireResolvedSymbol(ref);
    });
    return { ...prepared, variables };
  }

  private async revalidatePlanVariableRefs(plan: HssCapturePlan): Promise<void> {
    const refs = this.planVariableRefs.get(plan.planId);
    if (!refs) return;
    const state = await this.loadCatalog({ artifactFile: plan.artifact.file, mapFile: plan.artifact.mapFile }, plan.artifact.generation);
    const context = await this.hotVariableContext(state.artifact);
    for (const { source, ref } of refs) {
      const resolved = source === "hot_variable"
        ? (() => {
            const hot = this.hotVariables.get(ref, context);
            if (!hot.ok) throw new HssError(HSS_ERROR.HOT_VARIABLE_STALE, hot.error.reason, { code: hot.error.code });
            return hot.value.resolved;
          })()
        : this.requireResolvedSymbol(ref);
      const planned = plan.symbols.find((symbol) => symbol.layoutHash === ref.layoutHash && symbol.name === symbolLogicalIdentity(ref));
      if (!planned || planned.address !== `0x${resolved.address.toString(16)}` || planned.type !== resolved.type || planned.size !== resolved.size) {
        throw new HssError(HSS_ERROR.HOT_VARIABLE_STALE, "server-issued variable layout changed after HSS planning", { ref });
      }
    }
  }

  private async loadCatalog(input: { artifactFile?: string; mapFile?: string } = {}, expectedGeneration?: string): Promise<{ artifact: ArtifactGeneration; catalog: SymbolCatalog }> {
    const artifactFile = input.artifactFile ?? this.catalogState?.artifact.path;
    const mapFile = input.mapFile ?? this.catalogState?.artifact.mapPath;
    const artifact = await resolveArtifactGeneration({ projectRoot: this.cwd(), ...(artifactFile ? { explicitArtifact: artifactFile } : {}), ...(mapFile ? { explicitMap: mapFile } : {}) });
    if (expectedGeneration && artifact.generation !== expectedGeneration) throw new HssError(HSS_ERROR.HOT_VARIABLE_STALE, "Artifact generation changed", { expectedGeneration, currentArtifactGeneration: artifact.generation });
    if (!artifact.mapPath) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "Symbol Catalog requires a paired MAP file");
    if (this.catalogState?.artifact.generation !== artifact.generation) this.catalogState = { artifact, catalog: catalogFromIarMap(artifact, artifact.mapPath) };
    return this.catalogState!;
  }

  private async resolveCurrentSymbol(selector: string, type: HssScalarType, expectedGeneration?: string): Promise<ResolvedSymbol> {
    const state = await this.loadCatalog({}, expectedGeneration);
    if (selector.includes(".")) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, "MAP-only fixed members require DWARF layout support");
    const artifact = await resolveHssDebugArtifact({ artifactFile: state.artifact.path, mapFile: state.artifact.mapPath, symbols: [{ name: selector, type }], cwd: this.cwd() });
    const current = artifact.symbols[0];
    const address = Number.parseInt(current.address, 16);
    const result = state.catalog.issue({ qualifiedName: selector, rootAddress: address, type: current.type, size: current.size, region: "ram", source: current.source, confidence: current.source === "elf-dwarf" ? "dwarf" : "map", kind: selector.includes("::") ? "static" : "global" });
    if (!result.ok) throw new HssError(HSS_ERROR.SYMBOL_UNSAFE, result.error.reason, { code: result.error.code });
    this.resolvedTypes.set(symbolLogicalIdentity(result.value.ref), result.value.type);
    return result.value;
  }

  private requireResolvedSymbol(ref: SymbolRef): ResolvedSymbol {
    const resolved = this.catalogState?.catalog.resolveRef(ref);
    if (!resolved?.ok) throw new HssError(HSS_ERROR.HOT_VARIABLE_STALE, resolved?.error.reason ?? "symbol reference was not issued by the current server", { ref });
    return resolved.value;
  }

  private async hotVariableContext(artifact: ArtifactGeneration): Promise<HotVariableContext> {
    const policy = await loadHssPolicy(this.cwd());
    return { artifactGeneration: artifact.generation, ...(artifact.mapSha256 ? { mapSha256: artifact.mapSha256 } : {}), policyGeneration: policy.policyHash, sessionGeneration: this.sessionId };
  }

  private async catalogCall(work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    try {
      return { status: "ok", ...await work() };
    } catch (error) {
      return { status: "error", code: error instanceof HssError ? error.code : error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "catalog_error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  private writeCounts(captureId: string, path: string): { writeOpsUsed: number; elementsUsed: number } {
    const counter = this.writeCounters.get(`${captureId}:${path}`) ?? { ops: 0, elements: 0 };
    return { writeOpsUsed: counter.ops, elementsUsed: counter.elements };
  }

  private async resumeActiveCapture(active: ActiveCapture): Promise<Record<string, unknown>> {
    assertActiveWritable(active);
    const policy = await loadHssPolicy(this.cwd());
    const bindingFacts = this.activeWriteBinding(active);
    const binding = createOperationPlan<CpuControlOperationPlan>({
      kind: "cpu_control",
      tool: "resume",
      canonicalArgs: {},
      risk: "R3",
      runtime: { identitySha256: bindingFacts.runtimeIdentitySha256, scriptApprovalSha256: bindingFacts.scriptApprovalSha256 },
      target: { targetId: bindingFacts.targetId, ...(bindingFacts.probeSerial ? { probeSerial: bindingFacts.probeSerial } : {}), connectionGeneration: bindingFacts.connectionGeneration },
      artifact: { generation: bindingFacts.artifactGeneration, sha256: bindingFacts.artifactSha256, match: bindingFacts.targetArtifactMatch, evidenceGeneration: bindingFacts.evidenceGeneration },
      layout: { sha256: hssLayoutSha256(active.plan) },
      policy: { sha256: policy.policyHash, rule: "cpu:resume", maxWrites: 0, remainingWrites: 0, maxElements: 0, remainingElements: 0 },
      session: { id: this.sessionId, captureId: active.captureId, captureGeneration: active.generation },
      readback: { required: false },
      ttlMs: 60000,
    });
    claimOperationPlan(binding);
    await appendHssAudit(this.sessionId, "resume", binding, { phase: "intent", auditId: binding.auditId }, this.cwd());
    return active.writeQueue.run(async () => {
      const result = await new HelperHssVariableMemoryIo(active.writeRequestFile, active.writeResponseFile, active.captureId).resume();
      if (result.status !== "ok" || result.afterState !== "running") throw new HssError(HSS_ERROR.CPU_CONTROL_FAILED, String(result.reason ?? "capture-owner resume failed"), { result, auditId: binding.auditId });
      const qpcCounter = requiredText(result.operationAfterQpcCounter, "operationAfterQpcCounter");
      const event = appendHssJcapEvent(active.journal, "target_control", qpcCounter, {
        operation: "resume", result: "succeeded", captureId: active.captureId,
        beforeState: result.beforeState, afterState: result.afterState,
        operationDigest: binding.digest, auditId: binding.auditId,
      });
      active.journal.writer.syncEvents();
      return { operation: "resume", risk: "R3", binding, planId: binding.planId, planDigest: binding.digest, auditId: binding.auditId, result, eventId: event.eventId };
    });
  }

  private async withOperationLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }

  private activeWriteBinding(active: ActiveCapture): Omit<HssWritePlanRevalidateContext, "captureId" | "captureGeneration" | "policy" | "mapFile" | "writeOpsUsed" | "elementsUsed"> {
    const runtimeIdentitySha256 = requiredText(active.runtimeIdentity.sha256, "runtimeIdentity.sha256");
    const scriptApprovalSha256 = requiredText(active.runtimeIdentity.jlinkScriptApprovalSha256, "runtimeIdentity.jlinkScriptApprovalSha256");
    const evidenceGeneration = requiredText(active.artifactMatchEvidence?.manifestSha256 ?? active.plan.artifact.sha256, "artifact match evidence generation");
    const connectionGeneration = requiredBoundedInteger(active.artifactMatchEvidence?.connectOrdinal ?? 1, "connection generation");
    return {
      runtimeIdentitySha256,
      scriptApprovalSha256,
      targetId: active.plan.target.targetId,
      ...(this.probe.getCaptureConfig()?.serialNumber ? { probeSerial: this.probe.getCaptureConfig()!.serialNumber } : {}),
      artifactGeneration: active.plan.artifact.generation,
      artifactSha256: active.plan.artifact.sha256,
      targetArtifactMatch: active.artifactMatchStatus ?? "unverified",
      evidenceGeneration,
      connectionGeneration,
      sessionId: this.sessionId,
    };
  }

  private activeWriteRevalidateContext(active: ActiveCapture, policy: Awaited<ReturnType<typeof loadHssPolicy>>, mapFile: string): HssWritePlanRevalidateContext {
    return {
      captureId: active.captureId,
      captureGeneration: active.generation,
      policy,
      mapFile,
      writeOpsUsed: 0,
      elementsUsed: 0,
      ...this.activeWriteBinding(active),
    };
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
    plan.resetOperation = createOperationPlan<CpuControlOperationPlan>({
      kind: "cpu_control",
      tool: "reset",
      canonicalArgs: { halt: false, resetBeforeCapture: true },
      risk: "R3",
      runtime: { identitySha256: runtimeIdentity.sha256!, scriptApprovalSha256: runtimeIdentity.jlinkScriptApprovalSha256 },
      target: { targetId: plan.target.targetId, ...(input.serial ? { probeSerial: input.serial } : {}), connectionGeneration: 1 },
      artifact: { generation: plan.artifact.generation, sha256: plan.artifact.sha256, match: "unverified", evidenceGeneration: plan.artifact.generation },
      layout: { sha256: hssLayoutSha256(plan) },
      policy: { sha256: policy.policyHash, rule: "cpu:resetBeforeCapture", maxWrites: 0, remainingWrites: 0, maxElements: 0, remainingElements: 0 },
      session: { id: this.sessionId, captureId: plan.output.captureId, captureGeneration: this.captureGeneration + 1 },
      readback: { required: false },
      ttlMs: input.resetPlanTtlMs ?? 60000,
    });
  }

  private async executeResetBeforeCapture(plan: HssCapturePlan, runtimeIdentity: HssRuntimeIdentity, journal: HssJcapEventJournal, target: { device: string; interface: "SWD" | "JTAG"; speedKhz: number }, serial?: string): Promise<Record<string, unknown>> {
    const binding = plan.resetOperation;
    if (!binding) throw new HssError(HSS_ERROR.RESET_PLAN_INVALID, "resetBeforeCapture requires a bound R3 reset operation");
    if (binding.state !== "planned") throw new HssError(HSS_ERROR.RESET_PLAN_ALREADY_EXECUTED, "reset operation plan is single-use", { planId: binding.planId });
    if (Date.now() > Date.parse(binding.expiresAt)) throw new HssError(HSS_ERROR.RESET_PLAN_EXPIRED, "reset operation plan expired", { expiresAt: binding.expiresAt });
    const policy = await loadHssPolicy(this.cwd());
    if (binding.target.targetId !== plan.target.targetId
        || binding.artifact.generation !== plan.artifact.generation
        || binding.artifact.sha256 !== plan.artifact.sha256
        || binding.layout.sha256 !== hssLayoutSha256(plan)
        || binding.policy.sha256 !== policy.policyHash
        || binding.runtime.identitySha256 !== runtimeIdentity.sha256
        || binding.runtime.scriptApprovalSha256 !== plan.scriptIdentity?.approvalSha256
        || binding.session.id !== this.sessionId
        || binding.session.captureId !== plan.output.captureId
        || binding.session.captureGeneration !== this.captureGeneration + 1) {
      throw new HssError(HSS_ERROR.RESET_PLAN_BINDING_MISMATCH, "reset operation binding changed before execution", { planId: binding.planId });
    }
    try { claimOperationPlan(binding); }
    catch (error) { throw new HssError(HSS_ERROR.RESET_PLAN_BINDING_MISMATCH, error instanceof Error ? error.message : String(error), { planId: binding.planId }); }
    await appendHssAudit(this.sessionId, "reset", binding, { phase: "intent", auditId: binding.auditId }, this.cwd());
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
      const auditFile = await appendHssAudit(this.sessionId, "reset", binding, { ok: true, risk: { level: "R3" }, data: { ...result, ...stability, auditId: binding.auditId, policyHash: binding.policy.sha256, symbolLayoutHash: binding.layout.sha256 } }, this.cwd());
      const event = appendHssJcapEvent(journal, "target_control", result.operationAfterQpcCounter ?? journal.qpcEpochCounter.toString(), {
        operation: "reset",
        result: "succeeded",
        captureId: plan.output.captureId,
        resetBeforeCapture: true,
        operationBeforeQpcCounter: result.operationBeforeQpcCounter,
        operationAfterQpcCounter: result.operationAfterQpcCounter,
        beforeState: result.beforeState ?? "unknown",
        afterState: result.afterState ?? "running",
        operationDigest: binding.digest,
        auditId: binding.auditId,
        targetId: binding.target.targetId,
        artifactSha256: binding.artifact.sha256,
        layoutSha256: binding.layout.sha256,
        policySha256: binding.policy.sha256,
        sessionId: binding.session.id,
        expiresAt: binding.expiresAt,
        auditFile,
        ...stability,
      });
      return { ...result, ...stability, auditFile, eventId: event.eventId };
    } catch (error) {
      const hss = error instanceof HssError ? error : new HssError(HSS_ERROR.RESET_FAILED, error instanceof Error ? error.message : String(error));
      let auditFile: string | undefined;
      try {
        auditFile = await appendHssAudit(this.sessionId, "reset", binding, { ok: false, risk: { level: "R3" }, data: result, error: { code: hss.code, message: hss.message, details: hss.details } }, this.cwd());
      } catch (auditError) {
        hss.details.auditAppendError = auditError instanceof Error ? auditError.message : String(auditError);
      }
      appendHssJcapEvent(journal, "target_control", result.operationAfterQpcCounter ?? journal.qpcEpochCounter.toString(), {
        operation: "reset",
        result: "failed",
        captureId: plan.output.captureId,
        resetBeforeCapture: true,
        operationBeforeQpcCounter: result.operationBeforeQpcCounter,
        operationAfterQpcCounter: result.operationAfterQpcCounter,
        operationDigest: binding.digest,
        auditId: binding.auditId,
        targetId: binding.target.targetId,
        artifactSha256: binding.artifact.sha256,
        layoutSha256: binding.layout.sha256,
        policySha256: binding.policy.sha256,
        sessionId: binding.session.id,
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

  private async wrap<T>(operation: Parameters<typeof hssOk<T>>[0], input: unknown, fn: () => Promise<T> | T, options: { audit?: boolean | (() => boolean) } = {}): Promise<HssEnvelope<T>> {
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
      if ((operation === "variable_write_plan" || operation === "variable_write_execute")
          && data && typeof data === "object" && (data as { risk?: unknown }).risk === "R4") {
        envelope.risk = { level: "R4", requiresUserApproval: true };
      }
      if (typeof options.audit === "function" ? options.audit() : options.audit !== false) await this.safeAudit(operation, input, envelope);
      return envelope;
    } catch (error) {
      const envelope = hssFail<T>(operation, error);
      if (resetRisk) envelope.risk.level = "R3";
      if (typeof options.audit === "function" ? options.audit() : options.audit !== false) await this.safeAudit(operation, input, envelope);
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

async function writeHelperPlan(file: string, plan: unknown): Promise<void> {
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

export function enforceHssCapability(capability: Record<string, unknown>, plan: Pick<HssCapturePlan, "symbols" | "sampling">): void {
  const hss = capability.hss as { maxBlocks?: unknown; maxFreqHz?: unknown } | undefined;
  const maxBlocks = Number(hss?.maxBlocks ?? 0);
  const maxFreqHz = Number(hss?.maxFreqHz ?? 0);
  const recordBytes = 24 + plan.symbols.length * 4;
  const bandwidthBytesPerSec = recordBytes * plan.sampling.requestedRateHz;
  const segmentBytes = plan.sampling.segmentSizeMb * 1024 * 1024;
  const alternatives: Record<string, unknown> = {
    maxVariables: Math.max(0, Math.floor(maxBlocks)),
    maxRateHz: Math.max(0, Math.floor(maxFreqHz)),
    maxDurationSec: Math.max(1, Math.floor(segmentBytes / Math.max(1, bandwidthBytesPerSec))),
    supportedTypes: ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32"],
  };
  const invalid = plan.symbols.find((symbol) => ![1, 2, 4].includes(symbol.size) || symbol.region !== "ram");
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || plan.symbols.length > maxBlocks) throw new HssError(HSS_ERROR.HSS_CAPABILITY_LIMIT, "HSS variable count exceeds maxBlocks", { requested: plan.symbols.length, maxBlocks, alternatives });
  if (!Number.isSafeInteger(maxFreqHz) || maxFreqHz < 1 || plan.sampling.requestedRateHz > maxFreqHz) throw new HssError(HSS_ERROR.HSS_CAPABILITY_LIMIT, "HSS sample rate exceeds maxFreq", { requestedRateHz: plan.sampling.requestedRateHz, maxFreqHz, alternatives });
  if (invalid) throw new HssError(HSS_ERROR.HSS_CAPABILITY_LIMIT, "HSS variable type, size, or region is unsupported", { variable: invalid.name, alternatives });
  if (plan.sampling.estimatedBytes > segmentBytes) throw new HssError(HSS_ERROR.HSS_CAPABILITY_LIMIT, "HSS capture exceeds the configured segment bound", { estimatedBytes: plan.sampling.estimatedBytes, segmentBytes, alternatives });
  if (recordBytes > 64 * 1024 || bandwidthBytesPerSec > 64 * 1024 * 1024) throw new HssError(HSS_ERROR.HSS_CAPABILITY_LIMIT, "HSS record bandwidth exceeds the production bound", { recordBytes, bandwidthBytesPerSec, alternatives });
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

function outsideTargetPath(input: Pick<HssVariableWritePlanInput, "target" | "targetRef">): string {
  if (input.targetRef) return input.targetRef.path;
  const match = input.target?.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\[\d+(?:\.\.\d+)?\])?$/);
  if (match) return match[1];
  throw new HssError(HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED, "outside-capture write target must be a variable path", { target: input.target });
}

function strictHexBytes(value: unknown, length: number, name: string): Buffer {
  if (typeof value !== "string" || value.length !== length * 2 || /[^0-9a-f]/i.test(value)) throw new HssError(HSS_ERROR.HSS_HELPER_BAD_JSON, `${name} is not the expected hex byte sequence`);
  return Buffer.from(value, "hex");
}

function helperErrorQpc(error: HssError): string | undefined {
  const helper = error.details.helper;
  if (!helper || typeof helper !== "object") return undefined;
  const response = helper as Record<string, unknown>;
  const value = response.operationAfterQpcCounter ?? response.operationBeforeQpcCounter;
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? value : undefined;
}

function elfOperationRanges(file: string): { nonvolatileRanges: AddressRange[]; ramRanges: AddressRange[] } {
  const data = readFileSync(file);
  if (data.length < 52 || data[4] !== 1 || data[5] !== 1) throw new HssError(HSS_ERROR.ARTIFACT_MATCH_PLAN_INVALID, "outside writes require a little-endian ELF32 Artifact");
  const offset = data.readUInt32LE(28);
  const entrySize = data.readUInt16LE(42);
  const count = data.readUInt16LE(44);
  const ram: AddressRange[] = [];
  const nonvolatile: AddressRange[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = offset + index * entrySize;
    if (entry + 32 > data.length || data.readUInt32LE(entry) !== 1) continue;
    const virtualAddress = data.readUInt32LE(entry + 8);
    const physicalAddress = data.readUInt32LE(entry + 12);
    const fileSize = data.readUInt32LE(entry + 16);
    const memorySize = data.readUInt32LE(entry + 20);
    const writable = (data.readUInt32LE(entry + 24) & 2) !== 0;
    if (writable) ram.push({ start: virtualAddress, end: virtualAddress + Math.max(fileSize, memorySize) });
    else if (fileSize > 0) nonvolatile.push({ start: Math.min(virtualAddress, physicalAddress), end: Math.max(virtualAddress, physicalAddress) + fileSize });
  }
  const result = { nonvolatileRanges: mergeAddressRanges(nonvolatile), ramRanges: mergeAddressRanges(ram) };
  if (!result.nonvolatileRanges.length || !result.ramRanges.length) throw new HssError(HSS_ERROR.ARTIFACT_MATCH_PLAN_INVALID, "ELF PT_LOAD flags do not provide explicit nonvolatile and RAM ranges");
  return result;
}

function mergeAddressRanges(ranges: AddressRange[]): AddressRange[] {
  const sorted = ranges.filter(({ start, end }) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= 0x1_0000_0000).sort((left, right) => left.start - right.start);
  const merged: AddressRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
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

async function artifactGateWithTimeout(work: Promise<"verified" | "unverified" | "mismatch">, timeoutMs: number): Promise<"verified" | "unverified" | "mismatch"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HssError(HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED, "helper did not report Artifact match before HSS Start")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function artifactMatchStatus(value: unknown): "verified" | "unverified" | "mismatch" | undefined {
  return value === "verified" || value === "unverified" || value === "mismatch" ? value : undefined;
}

function planArtifactGeneration(plan: HssCapturePlan): ArtifactGeneration {
  return {
    path: plan.artifact.file,
    format: plan.artifact.format,
    sha256: plan.artifact.sha256,
    generation: plan.artifact.generation,
    size: plan.artifact.size,
    supportedOperations: plan.artifact.supportedOperations,
    ...(plan.artifact.mapFile && plan.artifact.mapSha256 ? { mapPath: plan.artifact.mapFile, mapSha256: plan.artifact.mapSha256 } : {}),
  };
}

function hssLayoutSha256(plan: HssCapturePlan): string {
  return createHash("sha256").update(JSON.stringify(plan.symbols.map((symbol) => ({
    name: symbol.name,
    address: symbol.address,
    size: symbol.size,
    type: symbol.type,
  })))).digest("hex");
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
