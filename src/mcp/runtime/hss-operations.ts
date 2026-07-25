import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicReplaceSync } from "../../utils/atomic-file";
import { isValidAcceptanceRunId } from "../acceptance/run-id";
import { resolveArtifactGeneration, writeArtifactMatchManifest, type ArtifactGeneration } from "../artifact/artifact-catalog";
import { symbolLogicalIdentity, type ResolvedSymbol } from "../artifact/symbol-catalog";
import { HSS_SCALAR_TYPES } from "../hss/hss-contract";
import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";
import { decodeHssValue, encodeHssValue, hssTypedByteSize } from "../hss/hss-typed-value";
import {
  appendJcapV1Event,
  createJcapV1Metadata,
  finalizeJcapV1Metadata,
  JcapV1QueryService,
  JcapV1Writer,
  readJcapV1Metadata,
  readJcapV1Raw,
  rebuildJcapV1Index,
  refreshActiveJcapV1Metadata,
  verifyJcapV1Index,
  type JcapV1CaptureState,
  type JcapV1Event,
  type JcapV1Metadata,
  type AnalysisV0RunRequest,
  type JcapV1VariableDescriptor,
  type JcapRunMutationGuard,
} from "../jcap/jcap-v1";
import { ANALYSIS_V0_MAX_POINTS } from "../jcap/analysis-v0";
import type {
  CaptureVariableAccessDelegate,
  ArtifactVariableService,
  VariableRefInput,
  VariableWriteInput,
} from "./artifact-operations";
import type { NonObserveComparator, ScalarComparator } from "./direct-operations";
import { withDirectoryLease } from "./file-lease";
import {
  HSS_EFFECTIVE_LIMITS,
  HssAdapterError,
  NativeHssHelperAdapter,
  type HssCapabilityFacts,
  type HssCaptureLaunch,
  type HssCaptureControlFiles,
  type HssHelperAdapter,
  type HssMemoryResponse,
  type HssMemoryTransaction,
  type HssRuntimeFacts,
  type HssTargetState,
} from "./hss-helper-adapter";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./operation-envelope";
import { ProbeQueue, ProbeQueueError, type ProbeOwner } from "./probe-queue";
import { MemorySessionError, type MemorySessionManager } from "./memory-session";
import { assertArtifactBindingsCurrent, TargetStore, TargetStoreError, type StoredTarget } from "./target-store";

const ACTIVE_SESSION_STATES = new Set<HssSessionState>(["starting", "capturing", "stopping"]);
const TERMINAL_SESSION_STATES = new Set<HssSessionState>(["completed", "stopped", "interrupted", "failed"]);
const NATIVE_HSS_SCALAR_TYPES = new Set<string>(HSS_SCALAR_TYPES);
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface HssVariableInput {
  ref: VariableRefInput;
  alias?: string;
  unit?: string;
}

export interface HssQualityOracleInput {
  ref: VariableRefInput;
  expectedIncrement: number;
  tolerance: number;
}

export interface HssCaptureInput {
  projectRoot: string;
  variables: HssVariableInput[];
  writeVariables?: VariableRefInput[];
  rateHz: number;
  durationSec: number;
  qualityOracle?: HssQualityOracleInput;
  dryRun?: boolean;
  runId?: string;
}

export interface HssCaptureSelector {
  projectRoot: string;
  captureId?: string;
}

interface PreparedVariable {
  requested: HssVariableInput;
  resolved: ResolvedSymbol;
  descriptor: JcapV1VariableDescriptor;
  cacheRefreshed: boolean;
}

interface PreparedCapture {
  target: StoredTarget;
  variables: PreparedVariable[];
  writeVariables: PreparedVariable[];
  rateHz: number;
  durationSec: number;
  qualityOracle?: PreparedQualityOracle;
  runId?: string;
  blockCount: number;
}

interface PreparedQualityOracle {
  logicalIdentity: string;
  expectedIncrement: number;
  tolerance: number;
  modulus: number;
}

interface HssStartPreflight {
  target: StoredTarget;
  capability: HssCapabilityFacts;
  targetStateBefore: Exclude<HssTargetState, "unknown">;
  targetStateAfter: Exclude<HssTargetState, "unknown">;
  artifact: ArtifactGeneration;
  nonvolatileRanges: Array<{ start: number; end: number }>;
  ramRanges: Array<{ start: number; end: number }>;
}

type HssSessionState = "starting" | "capturing" | "stopping" | "completed" | "stopped" | "interrupted" | "failed";

interface HssSessionRecord {
  formatVersion: 1;
  captureId: string;
  projectRoot: string;
  targetGeneration: string;
  artifactGeneration: string;
  probeSerial: string;
  state: HssSessionState;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  stopRequestedAt?: string;
  endedAt?: string;
  runId?: string;
  packageDir: string;
  sessionDir: string;
  control: HssCaptureControlFiles;
  helperPid: number;
  helperNonce: string;
  ownerToken: string;
  qpcEpochCounter: string;
  qpcFrequency: string;
  configuredInterface?: StoredTarget["interface"];
  configuredSpeedKHz?: number;
  expectedTargetState?: Exclude<HssTargetState, "unknown">;
  statePreservationPending?: boolean;
  rateHz: number;
  durationSec: number;
  descriptors: JcapV1VariableDescriptor[];
  writeDescriptors?: JcapV1VariableDescriptor[];
  qualityOracle?: PreparedQualityOracle;
  runtime: HssRuntimeFacts;
  capability: HssCapabilityFacts;
  result?: Record<string, unknown>;
  lastError?: { code: string; message: string };
}

export class HssOperations implements CaptureVariableAccessDelegate {
  readonly query: JcapV1QueryService;
  private readonly sessionsRoot: string;
  private readonly outputRoot: string;
  private readonly sessionWorkRoot: string;
  private readonly captureTails = new Map<string, Promise<void>>();
  private readonly monitoredCaptures = new Set<string>();

  constructor(
    private readonly targets: TargetStore,
    private readonly queue: ProbeQueue,
    private readonly artifacts: ArtifactVariableService,
    private readonly adapter: HssHelperAdapter = new NativeHssHelperAdapter(),
    outputRoot = resolve(process.cwd(), "test-output"),
    stateRoot = dirname(targets.filePath),
    sessionWorkRoot = resolve(tmpdir(), "jlink-mcp-hss"),
    captureMutationGuard?: JcapRunMutationGuard,
    private readonly memorySessions?: MemorySessionManager,
  ) {
    this.outputRoot = resolve(outputRoot);
    this.sessionsRoot = resolve(stateRoot, "hss-sessions");
    this.sessionWorkRoot = resolve(sessionWorkRoot);
    mkdirSync(this.outputRoot, { recursive: true });
    mkdirSync(this.sessionsRoot, { recursive: true });
    mkdirSync(this.sessionWorkRoot, { recursive: true });
    this.query = new JcapV1QueryService(this.outputRoot, captureMutationGuard);
    try {
      for (const session of this.sessions()) {
        if (ACTIVE_SESSION_STATES.has(session.state) || session.statePreservationPending) this.scheduleMonitor(session.captureId);
      }
    } catch { /* explicit hss_status surfaces malformed durable session records */ }
  }

  async capability(projectRoot: string): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); }
    catch (error) { return this.failure(createOperationEnvelope("hss_capability"), error, "target_lookup"); }
    const envelope = createOperationEnvelope("hss_capability", target);
    envelope.requestedEffects = ["connect_probe", "read_hss_capability"];
    try {
      envelope.before = { owner: this.queue.getOwner(target.probeSerial) ?? null };
      const execution = await this.queue.runExclusive(target.probeSerial, async () => {
        const current = this.targets.requireCurrent(target);
        const runtime = await this.adapter.inspectRuntime(current);
        return this.capabilityPreservingTargetState(current, runtime);
      });
      applyQueue(envelope, execution);
      envelope.before = { ...envelope.before, targetState: execution.value.targetStateBefore };
      envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, targetState: execution.value.targetStateAfter };
      envelope.data = execution.value.capability;
      envelope.observedEffects = execution.value.capability.available ? ["probe_connected", "hss_capability_observed"] : [];
      envelope.verification = { status: "observed", method: "helper_abi_and_JLINK_HSS_GetCaps" };
      if (!execution.value.capability.available) envelope.warnings.push("HSS is unavailable; no fallback backend was selected.");
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(envelope, error, "capability");
    }
  }

  async plan(input: HssCaptureInput): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("hss_plan");
    try {
      const prepared = await this.prepare(input);
      const planned = createOperationEnvelope("hss_plan", prepared.target);
      const runtime = await this.adapter.inspectRuntime(prepared.target);
      planned.data = {
        ready: runtime.available,
        backend: this.adapter.backend,
        variables: prepared.variables.map(({ descriptor }) => ({ ...descriptor } as Record<string, unknown>)),
        writeVariables: prepared.writeVariables.map(({ descriptor }) => ({ ...descriptor } as Record<string, unknown>)),
        rateHz: prepared.rateHz,
        durationSec: prepared.durationSec,
        requestedSamples: prepared.rateHz * prepared.durationSec,
        configuredInterface: prepared.target.interface,
        configuredSpeedKHz: prepared.target.speed,
        linkRate: linkRateDiagnostic(prepared),
        blockCount: prepared.blockCount,
        qualityOracle: prepared.qualityOracle ?? null,
        limits: HSS_EFFECTIVE_LIMITS,
        runtime,
        runId: prepared.runId ?? null,
        executionAuthority: false,
      };
      planned.before = { targetGeneration: prepared.target.generation, artifactGeneration: prepared.target.artifact!.generation };
      planned.after = planned.before;
      planned.verification = { status: "verified", method: "typed_artifact_resolution_and_static_bounds" };
      if (!runtime.available) planned.warnings.push("The plan is structurally valid, but the configured HSS runtime is unavailable; hss_start will revalidate and reject without fallback.");
      if (linkRateDiagnostic(prepared).warning) planned.warnings.push("LINK_SPEED_MAY_LIMIT_RATE: the configured debug-link speed may limit the requested HSS rate and variable count.");
      return finishEnvelope(planned, true);
    } catch (error) {
      return this.failure(envelope, error, "planning");
    }
  }

  private async preflightStart(prepared: PreparedCapture, runtime: HssRuntimeFacts): Promise<HssStartPreflight> {
    const target = this.targets.requireCurrent(prepared.target);
    if (this.activeSession(target.projectRoot)) throw new HssOperationError("CAPTURE_ACTIVE", "an active capture owns this Target; no second Helper was started", true);
    if (target.liveArtifactMatch.status !== "verified") throw new HssOperationError("ARTIFACT_NOT_VERIFIED", "symbol HSS requires a verified live Artifact match");
    const preserved = await this.capabilityPreservingTargetState(target, runtime);
    const capability = preserved.capability;
    if (!capability.available) throw new HssOperationError(capability.errorCode ?? "HSS_UNAVAILABLE", capability.reason ?? "HSS capability is unavailable", true);
    if (prepared.rateHz > Math.floor(capability.hardware?.maxFreq ?? 0)) throw new HssOperationError("HSS_RATE_UNSUPPORTED", `rateHz ${prepared.rateHz} exceeds hardware maxFreq ${capability.hardware?.maxFreq ?? 0}`);
    if (prepared.blockCount > (capability.hardware?.maxBlocks ?? 0)) throw new HssOperationError("HSS_BLOCK_LIMIT", `capture needs ${prepared.blockCount} blocks but hardware reports ${capability.hardware?.maxBlocks ?? 0}`);
    const capture = await this.validateCapturePrerequisites({ ...prepared, target }, runtime);
    return { target, capability, targetStateBefore: preserved.targetStateBefore, targetStateAfter: preserved.targetStateAfter, ...capture };
  }

  private async capabilityPreservingTargetState(
    target: StoredTarget,
    runtime: HssRuntimeFacts,
  ): Promise<{
    capability: HssCapabilityFacts;
    targetStateBefore: Exclude<HssTargetState, "unknown">;
    targetStateAfter: Exclude<HssTargetState, "unknown">;
  }> {
    const before = await this.adapter.observeTargetState(target, runtime);
    if (before === "unknown") {
      throw new HssOperationError("HSS_TARGET_STATE_OBSERVE_FAILED", "HSS capability requires a known pre-operation target state", true, false, true);
    }
    let capability: HssCapabilityFacts | undefined;
    let capabilityError: unknown;
    try {
      capability = await this.adapter.capability(target, runtime, before);
    } catch (error) {
      capabilityError = error;
    }
    let after: HssTargetState = "unknown";
    let observationError: unknown;
    try {
      after = await this.adapter.observeTargetState(target, runtime);
    } catch (error) {
      observationError = error;
    }
    if (after !== before || observationError) {
      if (before === "halted") {
        try {
          const restored = await this.adapter.restoreHaltedState(target, runtime);
          if (restored !== "halted") throw new Error(`restoration returned ${restored}`);
        } catch (error) {
          throw new HssOperationError(
            "HSS_TARGET_STATE_RESTORE_FAILED",
            `HSS capability changed or obscured the halted target state and restoration failed: ${error instanceof Error ? error.message : String(error)}`,
            false,
            false,
            true,
          );
        }
      }
      throw new HssOperationError(
        observationError ? "HSS_TARGET_STATE_OBSERVE_FAILED" : "HSS_TARGET_STATE_CHANGED",
        observationError
          ? "HSS capability completed without a trustworthy post-operation target-state observation"
          : `HSS capability changed target state from ${before} to ${after}; halted state was restored when authorized`,
        false,
        false,
        Boolean(observationError) || before !== "halted",
      );
    }
    if (capabilityError) throw capabilityError;
    if (!capability?.available && capability?.errorCode && (
      capability.errorCode === "HSS_TARGET_STATE_CHANGED"
      || capability.errorCode === "HSS_TARGET_STATE_RESTORE_FAILED"
      || capability.errorCode === "HSS_TARGET_STATE_OBSERVE_FAILED"
    )) {
      throw new HssOperationError(
        capability.errorCode,
        capability.reason ?? "HSS capability changed or obscured target state",
        false,
        false,
        capability.errorCode !== "HSS_TARGET_STATE_CHANGED",
      );
    }
    return { capability: capability!, targetStateBefore: before, targetStateAfter: after };
  }

  private async verifyTargetStateAfterHelper(
    target: StoredTarget,
    runtime: HssRuntimeFacts,
    expected: Exclude<HssTargetState, "unknown">,
  ): Promise<Exclude<HssTargetState, "unknown">> {
    let observed: HssTargetState = "unknown";
    let observationError: unknown;
    try {
      observed = await this.adapter.observeTargetState(target, runtime);
    } catch (error) {
      observationError = error;
    }
    if (!observationError && observed === expected) return observed;
    if (expected === "halted") {
      try {
        const restored = await this.adapter.restoreHaltedState(target, runtime);
        if (restored !== "halted") throw new Error(`restoration returned ${restored}`);
      } catch (error) {
        throw new HssOperationError(
          "HSS_TARGET_STATE_RESTORE_FAILED",
          `HSS helper exited without preserving halted state and restoration failed: ${error instanceof Error ? error.message : String(error)}`,
          false,
          false,
          true,
        );
      }
    }
    throw new HssOperationError(
      observationError ? "HSS_TARGET_STATE_OBSERVE_FAILED" : "HSS_TARGET_STATE_CHANGED",
      observationError
        ? "HSS helper exited without a trustworthy target-state observation"
        : `HSS helper changed target state from ${expected} to ${observed}; halted state was restored when authorized`,
      false,
      false,
      expected !== "halted",
    );
  }

  private async settleTargetStateAndOwner(session: HssSessionRecord): Promise<void> {
    const visibleOwner = this.queue.getOwner(session.probeSerial);
    const ownerMatches = visibleOwner?.kind === "hss"
      && visibleOwner.projectRoot === session.projectRoot
      && visibleOwner.targetGeneration === session.targetGeneration
      && visibleOwner.details?.captureId === session.captureId;
    await this.queue.runExclusive(session.probeSerial, async () => {
      let current = this.readSession(session.captureId);
      if (current.expectedTargetState) {
        const target = this.targets.require(current.projectRoot);
        try {
          await this.verifyTargetStateAfterHelper(target, current.runtime, current.expectedTargetState);
        } catch (error) {
          const normalized = normalizeHssError(error instanceof Error ? error : new Error(String(error)), "HSS_TARGET_STATE_OBSERVE_FAILED", false);
          if (normalized.stateUnknown) throw error;
          current = {
            ...current,
            state: "failed",
            updatedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            lastError: { code: normalized.code, message: normalized.message },
          };
        }
      }
      current = { ...current, statePreservationPending: false, updatedAt: new Date().toISOString() };
      this.writeSession(current);
      const owner = this.queue.getOwner(current.probeSerial);
      if (owner?.token === current.ownerToken) this.queue.releaseOwner(current.probeSerial, current.ownerToken);
    }, ownerMatches ? {
      allowedOwnerKinds: ["hss"],
      ownerTarget: { projectRoot: session.projectRoot, targetGeneration: session.targetGeneration },
      requiredOwner: visibleOwner!,
    } : {});
  }

  private async validateCapturePrerequisites(prepared: PreparedCapture, runtime: HssRuntimeFacts): Promise<Pick<HssStartPreflight, "artifact" | "nonvolatileRanges" | "ramRanges">> {
    const target = prepared.target;
    if (!target.artifact || !runtime.runtimePath || !runtime.runtimeSha256 || !runtime.helperPath || !SHA256.test(runtime.runtimeSha256)) {
      throw new HssOperationError("HSS_RUNTIME_IDENTITY_UNAVAILABLE", "HSS start requires a configured Artifact and hashed helper/runtime identity");
    }
    if (!/^\d+$/.test(target.probeSerial)) throw new HssOperationError("PROBE_SELECTION_REQUIRED", "native HSS requires an explicit numeric J-Link serial");
    const nonvolatileRanges = target.memoryRegions.filter((region) => region.kind === "flash" || region.kind === "rom").map((region) => ({ start: region.start, end: region.start + region.length }));
    const ramRanges = target.memoryRegions.filter((region) => region.kind === "ram").map((region) => ({ start: region.start, end: region.start + region.length }));
    if (!nonvolatileRanges.length || !ramRanges.length) throw new HssOperationError("ARTIFACT_REGION_UNKNOWN", "HSS start requires explicit nonvolatile and RAM memoryRegions in target_configure");
    for (const variable of [...prepared.variables, ...prepared.writeVariables]) {
      if (!ramRanges.some((range) => variable.resolved.address >= range.start && variable.resolved.address + variable.resolved.size <= range.end)) {
        throw new HssOperationError("HSS_VARIABLE_REGION_UNVERIFIED", `${variable.descriptor.logicalIdentity} is outside explicit RAM memoryRegions`);
      }
    }
    const artifact = await resolveArtifactGeneration({
      projectRoot: target.projectRoot,
      explicitArtifact: target.artifact.path,
      explicitMap: target.map?.path,
      maxFiles: 2,
      maxDepth: 0,
      maxCandidates: 1,
    });
    if (artifact.generation !== target.artifact.generation || artifact.sha256 !== target.artifact.sha256) {
      throw new HssOperationError("ARTIFACT_GENERATION_STALE", "configured Artifact changed before HSS start");
    }
    return { artifact, nonvolatileRanges, ramRanges };
  }

  private async dryRun(prepared: PreparedCapture): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("hss_start", prepared.target);
    try {
      const runtime = await this.adapter.inspectRuntime(prepared.target);
      if (!runtime.available) throw new HssOperationError(runtime.errorCode ?? "HSS_UNAVAILABLE", runtime.reason ?? "HSS runtime is unavailable");
      const execution = await this.queue.runExclusive(prepared.target.probeSerial, async () => this.preflightStart(prepared, runtime));
      const layout = frameLayout(prepared);
      applyQueue(envelope, execution);
      envelope.before = { targetGeneration: execution.value.target.generation, artifactGeneration: execution.value.target.artifact!.generation, owner: this.queue.getOwner(execution.value.target.probeSerial) ?? null, targetState: execution.value.targetStateBefore };
      envelope.after = envelope.before;
      envelope.data = {
        dryRun: true,
        backend: this.adapter.backend,
        variables: prepared.variables.map(({ descriptor, cacheRefreshed }) => ({ ...descriptor, cacheRefreshed } as Record<string, unknown>)),
        writeVariables: prepared.writeVariables.map(({ descriptor, cacheRefreshed }) => ({ ...descriptor, cacheRefreshed } as Record<string, unknown>)),
        rateHz: prepared.rateHz,
        durationSec: prepared.durationSec,
        requestedSamples: prepared.rateHz * prepared.durationSec,
        configuredInterface: prepared.target.interface,
        configuredSpeedKHz: prepared.target.speed,
        linkRate: linkRateDiagnostic(prepared),
        frameLayout: layout,
        estimatedDataBytes: layout.hssSampleStrideBytes * prepared.rateHz * prepared.durationSec,
        blockCount: prepared.blockCount,
        qualityOracle: prepared.qualityOracle ?? null,
        limits: HSS_EFFECTIVE_LIMITS,
        runtime,
        capability: execution.value.capability,
      };
      envelope.verification = { status: "verified", method: "typed_resolution_runtime_capability_current_artifact_and_static_layout" };
      if (linkRateDiagnostic(prepared).warning) envelope.warnings.push("LINK_SPEED_MAY_LIMIT_RATE: the configured debug-link speed may limit the requested HSS rate and variable count.");
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(envelope, error, "dry_run");
    }
  }

  async start(input: HssCaptureInput): Promise<OperationEnvelope> {
    const initial = createOperationEnvelope("hss_start");
    let prepared: PreparedCapture;
    try { prepared = await this.prepare(input); }
    catch (error) { return this.failure(initial, error, "validation"); }
    if (input.dryRun) return this.dryRun(prepared);
    const envelope = createOperationEnvelope("hss_start", prepared.target);
    envelope.requestedEffects = ["connect_probe", "start_hss_capture", "create_jcap_package"];
    try {
      const existing = this.activeSession(prepared.target.projectRoot);
      if (existing) throw new HssOperationError("CAPTURE_ACTIVE", `capture ${existing.captureId} is already active for this project`, true);
      const localMemoryOwner = this.memorySessions?.localOwnerForTarget(prepared.target);
      const execution = await this.queue.runExclusive(prepared.target.probeSerial, async (metadata) => {
        const currentBeforeClose = this.targets.requireCurrent(prepared.target);
        const runtime = await this.adapter.inspectRuntime(currentBeforeClose);
        if (!runtime.available) throw new HssOperationError(runtime.errorCode ?? "HSS_UNAVAILABLE", runtime.reason ?? "HSS runtime is unavailable");
        const memoryClose = await this.memorySessions?.closeForTarget(currentBeforeClose);
        if (memoryClose) {
          const targetStateAfterReconnect = await this.adapter.observeTargetState(currentBeforeClose, runtime);
          envelope.data = {
            ...(envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {}),
            memorySessionClose: { targetStateBeforeClose: memoryClose.targetStateBeforeClose, targetStateAfterReconnect },
          };
          if (memoryClose.targetStateBeforeClose === "unknown" || targetStateAfterReconnect === "unknown") {
            throw new HssOperationError("POST_OPERATION_STATE_UNKNOWN", "memory-session close could not prove the target state before HSS start", false, false, true);
          }
          if (memoryClose.targetStateBeforeClose !== targetStateAfterReconnect) {
            throw new HssOperationError("HIDDEN_STATE_CHANGE", `memory-session close changed target state from ${memoryClose.targetStateBeforeClose} to ${targetStateAfterReconnect}`);
          }
        }
        const preflight = await this.preflightStart(prepared, runtime);
        const current = preflight.target;
        const capability = preflight.capability;
        const created = await this.createCapture({ ...prepared, target: current }, runtime, capability, preflight);
        let session: HssSessionRecord = {
          formatVersion: 1,
          captureId: created.captureId,
          projectRoot: current.projectRoot,
          targetGeneration: current.generation,
          artifactGeneration: current.artifact!.generation,
          probeSerial: current.probeSerial,
          state: "starting",
          createdAt: created.createdAt,
          updatedAt: created.createdAt,
          startedAt: created.createdAt,
          ...(prepared.runId ? { runId: prepared.runId } : {}),
          packageDir: created.packageDir,
          sessionDir: created.sessionDir,
          control: created.control,
          helperPid: 0,
          helperNonce: created.helperNonce,
          ownerToken: "pending",
          qpcEpochCounter: created.qpcEpochCounter,
          qpcFrequency: created.qpcFrequency,
          configuredInterface: current.interface,
          configuredSpeedKHz: current.speed,
          expectedTargetState: preflight.targetStateBefore,
          rateHz: prepared.rateHz,
          durationSec: prepared.durationSec,
          descriptors: prepared.variables.map(({ descriptor }) => descriptor),
          writeDescriptors: prepared.writeVariables.map(({ descriptor }) => descriptor),
          ...(prepared.qualityOracle ? { qualityOracle: prepared.qualityOracle } : {}),
          runtime,
          capability,
        };
        this.writeSession(session);
        let launch: HssCaptureLaunch | undefined;
        let claimedOwner: ProbeOwner | undefined;
        try {
          const launched = await this.adapter.launchCapture(runtime, created.control);
          launch = launched;
          session = this.updateSession(created.captureId, (provisional) => ({ ...provisional, helperPid: launched.pid, startedAt: launched.launchedAt, updatedAt: launched.launchedAt }));
          const owner = this.queue.claimOwner(current.probeSerial, {
            kind: "hss",
            projectRoot: current.projectRoot,
            targetGeneration: current.generation,
            resourcePid: launch.pid,
            details: { captureId: created.captureId, packageDir: created.packageDir },
          }, metadata.leaseToken);
          claimedOwner = owner;
          session = this.updateSession(created.captureId, (provisional) => ({
            ...provisional,
            ownerToken: owner.token,
            updatedAt: new Date().toISOString(),
          }));
          await this.adapter.waitUntilReady(created.control, launched);
          if (TERMINAL_SESSION_STATES.has(session.state)) {
            try { await this.adapter.requestStop(created.control); } catch { /* termination below remains fail-closed */ }
            try { this.adapter.terminate(launched.pid); } catch { /* surfaced by the live-helper cleanup path */ }
            throw new HssOperationError("HSS_START_CANCELLED", `capture became ${session.state} while helper startup was publishing its identity`, true);
          }
          session = this.updateSession(created.captureId, (provisional) => ({
            ...provisional,
            state: provisional.state === "stopping" ? "stopping" : "capturing",
            updatedAt: new Date().toISOString(),
          }));
          return session;
        } catch (error) {
          let terminalError: unknown = error;
          if (launch?.pid) {
            try { await this.adapter.requestStop(created.control); } catch { /* best-effort cleanup of the just-created helper */ }
            const deadline = Date.now() + 2_000;
            while (this.adapter.isAlive(launch.pid) && Date.now() < deadline) await delay(25);
            if (this.adapter.isAlive(launch.pid)) {
              let captureIdentityConfirmed = false;
              try {
                captureIdentityConfirmed = await this.adapter.confirmCaptureAlive(created.control, launch.pid, created.captureId, created.helperNonce);
              } catch { /* an unverifiable PID must never be terminated */ }
              if (captureIdentityConfirmed) {
                try { this.adapter.terminate(launch.pid); } catch { /* owner remains fail-closed when termination cannot be proven */ }
              }
            }
            if (this.adapter.isAlive(launch.pid)) {
              let failClosedOwner = claimedOwner ?? this.queue.getOwner(current.probeSerial);
              if (!failClosedOwner) {
                try {
                  failClosedOwner = this.queue.claimOwner(current.probeSerial, {
                    kind: "hss",
                    projectRoot: current.projectRoot,
                    targetGeneration: current.generation,
                    resourcePid: launch.pid,
                    details: { captureId: created.captureId, packageDir: created.packageDir, cleanupFailed: true },
                  }, metadata.leaseToken);
                } catch { /* a concurrently published owner still blocks direct Probe operations */ }
              }
              session = this.updateSession(created.captureId, (provisional) => ({
                ...provisional,
                state: "stopping",
                helperPid: launch!.pid,
                ownerToken: failClosedOwner?.token ?? provisional.ownerToken,
                updatedAt: new Date().toISOString(),
                lastError: {
                  code: "HSS_START_CLEANUP_INCOMPLETE",
                  message: "helper remained alive after failed start cleanup; Probe access remains fail-closed until terminal reconciliation",
                },
              }));
              this.scheduleMonitor(session.captureId);
            }
          }
          if (!launch?.pid || !this.adapter.isAlive(launch.pid)) {
            let statePreservationPending = false;
            if (launch?.pid) {
              try {
                await this.verifyTargetStateAfterHelper(current, runtime, preflight.targetStateBefore);
              } catch (stateError) {
                terminalError = stateError;
                statePreservationPending = normalizeHssError(
                  stateError instanceof Error ? stateError : new Error(String(stateError)),
                  "HSS_TARGET_STATE_OBSERVE_FAILED",
                  false,
                ).stateUnknown;
              }
            }
            this.finalizeCreatedFailure(created.packageDir, terminalError);
            this.updateSession(created.captureId, (provisional) => ({
              ...provisional,
              state: "failed",
              statePreservationPending,
              updatedAt: new Date().toISOString(),
              endedAt: new Date().toISOString(),
              lastError: { code: errorCode(terminalError, "HSS_START_FAILED"), message: terminalError instanceof Error ? terminalError.message : String(terminalError) },
            }));
            if (!statePreservationPending && claimedOwner) {
              try { this.queue.releaseOwner(current.probeSerial, claimedOwner.token); } catch { /* already released or replaced */ }
            } else if (statePreservationPending) {
              this.scheduleMonitor(created.captureId);
            }
          }
          const normalized = normalizeHssError(terminalError instanceof Error ? terminalError : new Error(String(terminalError)), "HSS_START_FAILED", false);
          throw new HssOperationError(normalized.code, normalized.message, normalized.retryable, normalized.writeIssued, normalized.stateUnknown, { captureId: created.captureId, packageDir: created.packageDir });
        }
      }, localMemoryOwner ? {
        allowedOwnerKinds: ["memory"],
        ownerTarget: { projectRoot: prepared.target.projectRoot, targetGeneration: prepared.target.generation },
        requiredOwner: localMemoryOwner,
      } : {});
      applyQueue(envelope, execution);
      envelope.before = { owner: null, targetGeneration: prepared.target.generation };
      envelope.after = { owner: this.queue.getOwner(prepared.target.probeSerial) ?? null, targetGeneration: prepared.target.generation };
      envelope.capture = captureSummary(execution.value);
      envelope.data = {
        ...(envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {}),
        captureId: execution.value.captureId,
        state: execution.value.state,
        packageDir: execution.value.packageDir,
        limits: HSS_EFFECTIVE_LIMITS,
        configuredInterface: prepared.target.interface,
        configuredSpeedKHz: prepared.target.speed,
        linkRate: linkRateDiagnostic(prepared),
        variableResolution: prepared.variables.map(({ descriptor, cacheRefreshed }) => ({ logicalIdentity: descriptor.logicalIdentity, cacheRefreshed })),
        writeVariableResolution: prepared.writeVariables.map(({ descriptor, cacheRefreshed }) => ({ logicalIdentity: descriptor.logicalIdentity, cacheRefreshed })),
      };
      envelope.outputFiles = packageFiles(execution.value.packageDir);
      envelope.observedEffects = ["hss_helper_started", "hss_helper_ready", "probe_owner_claimed", "jcap_capture_active"];
      envelope.verification = { status: "observed", method: "helper_ready_journal_pid_owner_and_active_jcap_metadata" };
      this.scheduleMonitor(execution.value.captureId);
      if (execution.value.state === "stopping") {
        envelope.verification = { status: "state_unknown", method: "concurrent_durable_stop_request_during_helper_startup" };
        return this.failure(envelope, new HssOperationError("HSS_START_CANCELLED", "capture start was concurrently cancelled by a durable stop request", true, false, true), "start");
      }
      await delay(25);
      if (!this.captureHelperAlive(execution.value)) {
        if (this.adapter.isAlive(execution.value.helperPid)) {
          return this.failure(envelope, new HssOperationError("HSS_HELPER_IDENTITY_UNVERIFIED", "the started Helper lost its capture-bound heartbeat", true, false, true), "start");
        }
        const settlement = await this.settle(execution.value.captureId);
        const settled = this.readSession(execution.value.captureId);
        envelope.after = { owner: this.queue.getOwner(settled.probeSerial) ?? null, targetGeneration: settled.targetGeneration };
        envelope.capture = captureSummary(settled);
        envelope.data = {
          captureId: settled.captureId,
          state: settled.state,
          packageDir: settled.packageDir,
          limits: HSS_EFFECTIVE_LIMITS,
          configuredInterface: prepared.target.interface,
          configuredSpeedKHz: prepared.target.speed,
          linkRate: linkRateDiagnostic(prepared),
          variableResolution: prepared.variables.map(({ descriptor, cacheRefreshed }) => ({ logicalIdentity: descriptor.logicalIdentity, cacheRefreshed })),
          writeVariableResolution: prepared.writeVariables.map(({ descriptor, cacheRefreshed }) => ({ logicalIdentity: descriptor.logicalIdentity, cacheRefreshed })),
        };
        envelope.outputFiles = packageFiles(settled.packageDir);
        envelope.observedEffects = ["hss_helper_started", "probe_owner_claimed", "helper_exited_during_start", "capture_finalized", "probe_owner_released"];
        if (settlement.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
        envelope.verification = { status: settled.state === "completed" || settled.state === "stopped" ? "verified" : "observed", method: "terminal_jcap_state_after_start_probe" };
        if (settled.state === "failed" || settled.state === "interrupted") {
          return this.failure(envelope, new HssOperationError(settled.lastError?.code ?? "HSS_START_FAILED", settled.lastError?.message ?? "HSS helper exited during start", false, false, false), "start");
        }
      }
      return finishEnvelope(envelope, true);
    } catch (error) {
      const evidence = error instanceof HssOperationError ? error.captureEvidence : undefined;
      if (evidence) {
        try {
          const session = this.readSession(evidence.captureId);
          envelope.capture = captureSummary(session);
          envelope.data = { captureId: session.captureId, state: session.state, packageDir: session.packageDir };
          envelope.outputFiles = packageFiles(session.packageDir);
          envelope.after = { owner: this.queue.getOwner(session.probeSerial) ?? null, targetGeneration: session.targetGeneration };
          envelope.observedEffects = ["jcap_package_created", ...(session.helperPid > 0 ? ["hss_helper_started"] : []), ...(TERMINAL_SESSION_STATES.has(session.state) ? ["capture_finalized"] : [])];
        } catch { /* retain the originating start failure when evidence inspection also fails */ }
      }
      return this.failure(envelope, error, "start");
    }
  }

  async status(input: HssCaptureSelector): Promise<OperationEnvelope> {
    let envelope = createOperationEnvelope("hss_status");
    try {
      const target = this.targets.require(input.projectRoot);
      envelope = createOperationEnvelope("hss_status", target);
      envelope.requestedEffects = ["read_capture_state", "reconcile_capture_if_helper_exited", "reconcile_durable_memory_transactions"];
      let session = this.selectSession(target.projectRoot, input.captureId);
      const initialSession = session;
      const initialOwner = this.queue.getOwner(target.probeSerial) ?? null;
      envelope.before = { owner: initialOwner, captureState: session.state, helperPid: session.helperPid, helperAlive: this.adapter.isAlive(session.helperPid) };
      session = await this.reconcileSession(session.captureId);
      if (session.helperPid !== initialSession.helperPid) envelope.observedEffects.push("helper_pid_recovered_from_start_journal");
      if (session.ownerToken !== initialSession.ownerToken) envelope.observedEffects.push("probe_owner_reconciled");
      if (TERMINAL_SESSION_STATES.has(session.state) && session.statePreservationPending) {
        const ownerExisted = Boolean(this.queue.getOwner(target.probeSerial));
        await this.settle(session.captureId);
        session = this.readSession(session.captureId);
        envelope.observedEffects.push("target_state_reconciled");
        if (ownerExisted && !this.queue.getOwner(target.probeSerial)) envelope.observedEffects.push("probe_owner_released");
      } else if (ACTIVE_SESSION_STATES.has(session.state) && !this.adapter.isAlive(session.helperPid) && !this.startupJournalPending(session)) {
        const databaseExisted = existsSync(join(session.packageDir, "capture.db"));
        const ownerExisted = Boolean(this.queue.getOwner(target.probeSerial));
        const settlement = await this.settle(session.captureId);
        session = this.readSession(session.captureId);
        envelope.observedEffects.push("capture_finalized");
        if (settlement.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
        if (!databaseExisted && existsSync(join(session.packageDir, "capture.db"))) envelope.observedEffects.push("capture_index_rebuilt");
        if (ownerExisted && !this.queue.getOwner(target.probeSerial)) envelope.observedEffects.push("probe_owner_released");
        if (!existsSync(session.sessionDir)) envelope.observedEffects.push("session_work_cleaned");
      } else if (ACTIVE_SESSION_STATES.has(session.state) && existsSync(join(session.packageDir, "raw", "samples.bin"))) {
        const progressPublished = await this.captureExclusive(session.captureId, async () => {
          const current = this.readSession(session.captureId);
          if (!ACTIVE_SESSION_STATES.has(current.state) || !this.captureHelperAlive(current)) return { published: false, recovered: 0 };
          const recovered = this.recoverDurableMemoryTransactions(current);
          let published = false;
          try {
            refreshActiveJcapV1Metadata(current.packageDir);
            published = true;
          } catch { /* an in-flight partial frame is reported on terminal recovery */ }
          return { published, recovered: recovered.count };
        });
        session = this.readSession(session.captureId);
        if (progressPublished.published) envelope.observedEffects.push("capture_progress_published");
        if (progressPublished.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
      }
      envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: this.adapter.isAlive(session.helperPid) };
      envelope.capture = captureSummary(session);
      envelope.data = { session, metadata: safeMetadata(session.packageDir), helperAlive: this.adapter.isAlive(session.helperPid) };
      envelope.outputFiles = packageFiles(session.packageDir);
      envelope.verification = { status: "observed", method: "durable_session_helper_pid_owner_and_jcap_metadata" };
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(envelope, error, "status");
    }
  }

  async stop(input: HssCaptureSelector): Promise<OperationEnvelope> {
    let envelope = createOperationEnvelope("hss_stop");
    let session: HssSessionRecord | undefined;
    try {
      const target = this.targets.require(input.projectRoot);
      envelope = createOperationEnvelope("hss_stop", target);
      envelope.requestedEffects = ["reconcile_durable_memory_transactions", "request_hss_stop", "finalize_capture", "rebuild_capture_index", "release_probe_owner"];
      session = this.selectSession(target.projectRoot, input.captureId, true);
      envelope.before = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: this.adapter.isAlive(session.helperPid) };
      const originalPid = session.helperPid;
      const originalOwnerToken = session.ownerToken;
      session = await this.reconcileSession(session.captureId);
      if (session.helperPid !== originalPid) envelope.observedEffects.push("helper_pid_recovered_from_start_journal");
      if (session.ownerToken !== originalOwnerToken) envelope.observedEffects.push("probe_owner_reconciled");
      if (!ACTIVE_SESSION_STATES.has(session.state)) throw new HssOperationError("CAPTURE_NOT_ACTIVE", `capture ${session.captureId} is ${session.state}`);
      if (this.startupJournalPending(session)) {
        session = await this.captureExclusive(session.captureId, async () => {
          const current = this.readSession(session!.captureId);
          await this.adapter.requestStop(current.control);
          return this.updateSession(current.captureId, (record) => ({
            ...record,
            state: "stopping",
            stopRequestedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
        });
        this.scheduleMonitor(session.captureId);
        envelope.observedEffects.push("hss_stop_requested", "capture_marked_stopping");
        envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: false };
        envelope.capture = captureSummary(session);
        envelope.data = { session, metadata: safeMetadata(session.packageDir) };
        envelope.outputFiles = packageFiles(session.packageDir);
        envelope.verification = { status: "state_unknown", method: "durable_stop_request_waiting_for_helper_pid_journal" };
        throw new HssOperationError("HSS_STOP_PENDING_STARTUP", "the stop request is durable while helper startup identity is still pending; query hss_status until terminal", true, false, true);
      }
      if (!this.adapter.isAlive(session.helperPid)) {
        const databaseExisted = existsSync(join(session.packageDir, "capture.db"));
        const ownerExisted = Boolean(this.queue.getOwner(target.probeSerial));
        const settlement = await this.settle(session.captureId);
        session = this.readSession(session.captureId);
        envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: false };
        envelope.capture = captureSummary(session);
        envelope.data = { session, metadata: safeMetadata(session.packageDir) };
        envelope.outputFiles = packageFiles(session.packageDir);
        envelope.observedEffects.push("capture_finalized");
        if (settlement.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
        if (!databaseExisted && existsSync(join(session.packageDir, "capture.db"))) envelope.observedEffects.push("capture_index_rebuilt");
        if (ownerExisted && !this.queue.getOwner(target.probeSerial)) envelope.observedEffects.push("probe_owner_released");
        if (!existsSync(session.sessionDir)) envelope.observedEffects.push("session_work_cleaned");
        envelope.warnings.push("The helper had already exited; available Raw data was finalized without issuing a stop request.");
        envelope.verification = { status: "observed", method: "terminal_jcap_state_after_helper_exit" };
        if (session.lastError?.code.startsWith("HSS_TARGET_STATE_")) {
          throw new HssOperationError(session.lastError.code, session.lastError.message);
        }
        return finishEnvelope(envelope, session.state !== "failed");
      }
      const guarded = await this.captureExclusive(session.captureId, async () => {
        let current = this.readSession(session!.captureId);
        if (!ACTIVE_SESSION_STATES.has(current.state) || !this.adapter.isAlive(current.helperPid)) return { session: current, stopRequested: false, recovered: 0 };
        current = await this.ensureSessionOwner(current);
        const recovered = this.recoverDurableMemoryTransactions(current);
        const owner = this.requiredOwner(current);
        const execution = await this.queue.runExclusive(target.probeSerial, async () => {
          this.targets.requireCurrent(target);
          const latest = this.readSession(current.captureId);
          if (!ACTIVE_SESSION_STATES.has(latest.state) || !this.adapter.isAlive(latest.helperPid)) return latest;
          await this.adapter.requestStop(latest.control);
          return this.updateSession(latest.captureId, (record) => ({ ...record, state: "stopping", stopRequestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
        }, { allowedOwnerKinds: ["hss"], ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation }, requiredOwner: owner });
        return { session: execution.value, stopRequested: execution.value.state === "stopping", execution, recovered: recovered.count };
      });
      session = guarded.session;
      if (guarded.execution) applyQueue(envelope, guarded.execution);
      if (guarded.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
      if (guarded.stopRequested) envelope.observedEffects.push("hss_stop_requested", "capture_marked_stopping");
      if (!guarded.stopRequested && !this.adapter.isAlive(session.helperPid)) {
        const settlement = await this.settle(session.captureId);
        if (settlement.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
        session = this.readSession(session.captureId);
      }
      const deadline = Date.now() + 15_000;
      while (this.adapter.isAlive(session.helperPid) && Date.now() < deadline) await delay(25);
      if (this.adapter.isAlive(session.helperPid)) {
        session = this.readSession(session.captureId);
        envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: true };
        envelope.capture = captureSummary(session);
        envelope.data = { session, metadata: safeMetadata(session.packageDir) };
        envelope.outputFiles = packageFiles(session.packageDir);
        envelope.verification = { status: "state_unknown", method: "stop_request_persisted_but_helper_remained_alive" };
        throw new HssOperationError("HSS_STOP_TIMEOUT", "the helper did not finish within 15 seconds; capture remains owned and can be queried again", true, false, true);
      }
      const settlement = await this.settle(session.captureId);
      if (settlement.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
      session = this.readSession(session.captureId);
      envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: false };
      envelope.capture = captureSummary(session);
      envelope.data = { session, metadata: safeMetadata(session.packageDir) };
      envelope.outputFiles = packageFiles(session.packageDir);
      if (TERMINAL_SESSION_STATES.has(session.state)) envelope.observedEffects.push("capture_finalized");
      if (!this.queue.getOwner(session.probeSerial)) envelope.observedEffects.push("probe_owner_released");
      if (!existsSync(session.sessionDir)) envelope.observedEffects.push("session_work_cleaned");
      if (existsSync(join(session.packageDir, "capture.db"))) envelope.observedEffects.push("capture_index_ready");
      envelope.verification = { status: session.state === "stopped" || session.state === "completed" ? "verified" : "observed", method: "terminal_jcap_state_and_helper_exit" };
      if (session.lastError?.code.startsWith("HSS_TARGET_STATE_")) {
        throw new HssOperationError(session.lastError.code, session.lastError.message);
      }
      return finishEnvelope(envelope, session.state !== "failed");
    } catch (error) {
      return this.failure(envelope, error, "stop");
    }
  }

  async recover(input: HssCaptureSelector): Promise<OperationEnvelope> {
    let envelope = createOperationEnvelope("hss_recover");
    try {
      const target = this.targets.require(input.projectRoot);
      envelope = createOperationEnvelope("hss_recover", target);
      envelope.requestedEffects = ["reconcile_durable_memory_transactions", "finalize_interrupted_capture_if_needed", "rebuild_capture_index_from_raw"];
      let session = this.selectSession(target.projectRoot, input.captureId);
      session = await this.reconcileSession(session.captureId);
      envelope.before = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: this.adapter.isAlive(session.helperPid), raw: safeMetadata(session.packageDir) };
      if (this.adapter.isAlive(session.helperPid) || this.startupJournalPending(session)) throw new HssOperationError("CAPTURE_ACTIVE", "an active or starting helper cannot be recovered; call hss_stop or hss_status", true);
      if (TERMINAL_SESSION_STATES.has(session.state) && session.statePreservationPending) {
        const ownerExisted = Boolean(this.queue.getOwner(target.probeSerial));
        await this.settle(session.captureId);
        envelope.observedEffects.push("target_state_reconciled");
        if (ownerExisted && !this.queue.getOwner(target.probeSerial)) envelope.observedEffects.push("probe_owner_released");
      } else if (ACTIVE_SESSION_STATES.has(session.state)) {
        const ownerExisted = Boolean(this.queue.getOwner(target.probeSerial));
        const settlement = await this.settle(session.captureId);
        envelope.observedEffects.push("capture_finalized");
        if (settlement.recovered > 0) envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
        if (ownerExisted && !this.queue.getOwner(target.probeSerial)) envelope.observedEffects.push("probe_owner_released");
      }
      session = this.readSession(session.captureId);
      if (session.state === "failed") throw new HssOperationError(session.lastError?.code ?? "CAPTURE_FAILED", session.lastError?.message ?? "failed capture has no trustworthy rebuild source");
      if (session.state !== "interrupted") throw new HssOperationError("CAPTURE_NOT_INTERRUPTED", `hss_recover applies only to interrupted captures; capture is ${session.state}`);
      let index = await verifyJcapV1Index(session.packageDir);
      if (index.indexStatus !== "ready") {
        const rebuilt = await rebuildJcapV1Index(session.packageDir);
        index = { captureState: rebuilt.captureState, indexStatus: rebuilt.indexStatus };
        envelope.observedEffects.push("capture_index_rebuilt");
      }
      envelope.after = { owner: this.queue.getOwner(target.probeSerial) ?? null, captureState: session.state, helperPid: session.helperPid, helperAlive: false, raw: readJcapV1Metadata(session.packageDir).raw };
      envelope.capture = captureSummary(session);
      envelope.data = { session, metadata: readJcapV1Metadata(session.packageDir), index };
      envelope.outputFiles = packageFiles(session.packageDir);
      if (index.indexStatus === "ready") envelope.observedEffects.push("valid_raw_prefix_indexed");
      envelope.verification = { status: "verified", method: "raw_integrity_and_atomic_db_rebuild" };
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(envelope, error, "recover");
    }
  }

  async tryReadVariable(target: StoredTarget, resolved: ResolvedSymbol): Promise<OperationEnvelope | undefined> {
    const session = this.activeSession(target.projectRoot);
    if (!session) return undefined;
    const envelope = createOperationEnvelope("read_variable", target);
    const logicalIdentity = symbolLogicalIdentity(resolved.ref);
    const descriptor = [...session.descriptors, ...(session.writeDescriptors ?? [])].find((current) => current.logicalIdentity === logicalIdentity
      && current.artifactGeneration === resolved.ref.artifactGeneration
      && current.layoutHash === resolved.ref.layoutHash
      && current.address.toLowerCase() === hexAddress(resolved.address)
      && current.type === resolved.type
      && current.size === resolved.size);
    if (!descriptor) return this.failure(envelope, new HssOperationError("VARIABLE_NOT_IN_CAPTURE", "capture-aware reads require an immutable descriptor-declared variable"), "capture_descriptor");
    if (session.state !== "capturing") return this.failure(envelope, new HssOperationError("CAPTURE_NOT_READABLE", `capture is ${session.state}`), "capture_state");
    return this.captureExclusive(session.captureId, async () => {
      try {
        let activeSession = this.readSession(session.captureId);
        if (activeSession.state !== "capturing") throw new HssOperationError("CAPTURE_NOT_READABLE", `capture is ${activeSession.state}`);
        activeSession = this.discoverHelperPid(activeSession);
        if (!this.captureHelperAlive(activeSession)) throw new HssOperationError("HSS_HELPER_IDENTITY_UNVERIFIED", "capture Helper identity or heartbeat is unavailable", true, false, true);
        activeSession = await this.ensureSessionOwner(activeSession);
        const owner = this.requiredOwner(activeSession);
        const execution = await this.queue.runExclusive(target.probeSerial, async () => {
          const current = this.targets.requireCurrent(target);
          assertArtifactBindingsCurrent(current);
          if (current.liveArtifactMatch.status !== "verified") throw new HssOperationError("ARTIFACT_NOT_VERIFIED", "capture-aware read requires a verified live Artifact match");
          if (!this.captureHelperAlive(activeSession)) throw new HssOperationError("HSS_HELPER_IDENTITY_UNVERIFIED", "capture Helper identity or heartbeat is unavailable", true, false, true);
          return this.readViaOwner(activeSession, resolved, randomUUID());
        }, {
          allowedOwnerKinds: ["hss"],
          ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
          requiredOwner: owner,
        });
        applyQueue(envelope, execution);
        envelope.before = { captureId: activeSession.captureId };
        envelope.after = { captureId: activeSession.captureId };
        envelope.capture = captureSummary(this.readSession(activeSession.captureId));
        envelope.data = {
          address: hexAddress(resolved.address),
          byteCount: resolved.size,
          dataHex: execution.value.toString("hex"),
          captureId: activeSession.captureId,
          readConnection: "capture_owner",
        };
        envelope.verification = { status: "observed", method: "capture_owner_read" };
        return finishEnvelope(envelope, true);
      } catch (error) {
        return this.failure(envelope, error, "capture_read");
      }
    });
  }

  async tryWriteVariable(
    input: VariableWriteInput,
    target: StoredTarget,
    resolved: ResolvedSymbol,
    requested: Buffer,
    comparator: ScalarComparator,
  ): Promise<OperationEnvelope | undefined> {
    let session = this.activeSession(target.projectRoot);
    if (!session) return undefined;
    const envelope = createOperationEnvelope("write_variable", target);
    const logicalIdentity = symbolLogicalIdentity(resolved.ref);
    const descriptor = [...session.descriptors, ...(session.writeDescriptors ?? [])].find((current) => current.logicalIdentity === logicalIdentity
      && current.artifactGeneration === resolved.ref.artifactGeneration
      && current.layoutHash === resolved.ref.layoutHash
      && current.address.toLowerCase() === hexAddress(resolved.address)
      && current.type === resolved.type
      && current.size === resolved.size);
    if (!descriptor) return this.failure(envelope, new HssOperationError("VARIABLE_NOT_IN_CAPTURE", "capture-aware writes require an immutable descriptor-declared variable"), "capture_descriptor");
    if (session.state !== "capturing") return this.failure(envelope, new HssOperationError("CAPTURE_NOT_WRITABLE", `capture is ${session.state}`), "capture_state");
    envelope.requestedEffects = ["reconcile_durable_memory_transactions", "write_variable", ...(input.restore ? ["restore_variable"] : [])];
    const captureId = session.captureId;
    return this.captureExclusive(captureId, async () => {
      let activeSession: HssSessionRecord;
      try {
        activeSession = this.readSession(captureId);
        if (activeSession.state !== "capturing") throw new HssOperationError("CAPTURE_NOT_WRITABLE", `capture is ${activeSession.state}`);
        activeSession = this.discoverHelperPid(activeSession);
        if (!this.captureHelperAlive(activeSession)) throw new HssOperationError("HSS_HELPER_IDENTITY_UNVERIFIED", "capture Helper identity or heartbeat is unavailable", true, false, true);
        activeSession = await this.ensureSessionOwner(activeSession);
        const recovered = this.recoverDurableMemoryTransactions(activeSession);
        if (recovered.count > 0) {
          envelope.observedEffects.push("capture_write_event_recovered", "memory_receipt_acknowledged");
          envelope.data = { captureId: activeSession.captureId, recoveredTransactions: recovered.count, currentWriteIssued: false };
          throw new HssOperationError(
            "HSS_MEMORY_LATE_RESPONSE_RECONCILED",
            `${recovered.count} durable capture-owner write transaction(s) were recorded; the current write was not issued`,
            true,
            recovered.writeIssued,
            recovered.stateUnknown,
          );
        }
      } catch (error) {
        return this.failure(envelope, error, "capture_state");
      }
      const owner = this.requiredOwner(activeSession);
      const operationId = randomUUID();
      const transactionIds: string[] = [];
      let writeIssued = false;
      let writeStateUnknown = false;
      let old: Buffer | undefined;
      let readback: Buffer | undefined;
      let restoreReadback: Buffer | undefined;
      let verification: { pass: boolean; details: Record<string, unknown> } | undefined;
      let restoreError: Error | undefined;
      let operationError: Error | undefined;
      let writeResponse: HssMemoryResponse | undefined;
      let writeRequestDispatched = false;
      let restoreAttempted = false;
      let restoreIssued = false;
      let restoreStateUnknown = false;
      let eventAppended = false;
      let helperOperationStartTick: string | undefined;
      let helperOperationEndTick: string | undefined;
      const eventStartedAt = new Date().toISOString();
      const fallbackStartTick = elapsedTick(activeSession.startedAt);
      try {
        const execution = await this.queue.runExclusive(target.probeSerial, async () => {
          try {
            const current = this.targets.requireCurrent(target);
            assertArtifactBindingsCurrent(current);
            if (current.liveArtifactMatch.status !== "verified") throw new HssOperationError("ARTIFACT_NOT_VERIFIED", "capture-aware write requires a verified live Artifact match");
            if (!this.captureHelperAlive(activeSession)) throw new HssOperationError("HSS_HELPER_IDENTITY_UNVERIFIED", "capture Helper identity or heartbeat is unavailable", true, false, true);
            if (input.captureOld || input.restore) old = await this.readViaOwner(activeSession, resolved, operationId);
            writeRequestDispatched = true;
            writeResponse = await this.adapter.requestMemory(activeSession.control, {
              captureId: activeSession.captureId,
              op: "write",
              operationId,
              eventContext: { logicalIdentity, requestedValue: input.value, phase: "write", endian: resolved.endian },
              address: hexAddress(resolved.address),
              length: resolved.size,
              accessSize: resolved.size as 1 | 2 | 4,
              bytesHex: requested.toString("hex"),
            });
            transactionIds.push(writeResponse.requestId);
            writeIssued = writeResponse.writeIssued === true;
            writeStateUnknown = writeResponse.stateUnknown === true;
            const responseStartTick = qpcTick(activeSession, writeResponse.operationBeforeQpcCounter);
            const responseEndTick = qpcTick(activeSession, writeResponse.operationAfterQpcCounter);
            if (responseStartTick && responseEndTick && BigInt(responseEndTick) >= BigInt(responseStartTick)) {
              helperOperationStartTick = responseStartTick;
              helperOperationEndTick = responseEndTick;
            }
            requireMemoryOk(writeResponse, "HSS_VARIABLE_WRITE_FAILED", writeIssued);
            if (!writeIssued) {
              writeIssued = true;
              writeStateUnknown = true;
              throw new HssOperationError("HSS_MEMORY_RESPONSE_INVALID", "successful capture-owner write did not confirm writeIssued", false, true, true);
            }
            if (!helperOperationStartTick || !helperOperationEndTick || BigInt(helperOperationEndTick) < BigInt(helperOperationStartTick)) {
              writeStateUnknown = true;
              throw new HssOperationError("HSS_MEMORY_RESPONSE_INVALID", "successful capture-owner write returned an invalid QPC interval", false, true, true);
            }
            if (input.verify) {
              const observed = await this.verifyViaOwner(activeSession, resolved, requested, comparator, operationId);
              readback = observed.readback;
              verification = { pass: observed.pass, details: observed.details };
              if (!observed.pass) throw new HssOperationError("READBACK_MISMATCH", "capture-owner readback did not satisfy the comparator", false, true, false);
            }
          } catch (error) {
            if (writeRequestDispatched && error instanceof HssAdapterError && error.stateUnknown) {
              writeIssued ||= error.currentRequestIssued;
              writeStateUnknown = true;
            }
            if (error instanceof HssOperationError) {
              writeIssued ||= error.writeIssued;
              writeStateUnknown ||= error.stateUnknown;
            }
            operationError = error instanceof Error ? error : new Error(String(error));
          } finally {
            if (input.restore && old && writeIssued) {
              restoreAttempted = true;
              try {
                const response = await this.adapter.requestMemory(activeSession.control, {
                  captureId: activeSession.captureId,
                  op: "write",
                  operationId,
                  eventContext: { logicalIdentity, requestedValue: decodeHssValue(resolved.type, old, resolved.endian), phase: "restore", endian: resolved.endian },
                  address: hexAddress(resolved.address),
                  length: resolved.size,
                  accessSize: resolved.size as 1 | 2 | 4,
                  bytesHex: old.toString("hex"),
                });
                transactionIds.push(response.requestId);
                restoreIssued = response.writeIssued === true;
                restoreStateUnknown = response.stateUnknown === true;
                requireMemoryOk(response, "RESTORE_FAILED", restoreIssued);
                if (!restoreIssued) {
                  restoreIssued = true;
                  restoreStateUnknown = true;
                  throw new HssOperationError("HSS_MEMORY_RESPONSE_INVALID", "successful capture-owner restore did not confirm writeIssued", false, true, true);
                }
                restoreReadback = await this.readViaOwner(activeSession, resolved, operationId);
                if (!restoreReadback.equals(old)) throw new HssOperationError("RESTORE_READBACK_MISMATCH", "restore readback does not match the captured old value", false, true, false);
              } catch (error) {
                if (error instanceof HssAdapterError && error.stateUnknown) {
                  restoreIssued ||= error.currentRequestIssued;
                  restoreStateUnknown = true;
                }
                if (error instanceof HssOperationError) {
                  restoreIssued ||= error.writeIssued;
                  restoreStateUnknown ||= error.stateUnknown;
                }
                restoreError = error instanceof Error ? error : new Error(String(error));
              }
            }
          }
          if (restoreError) throw restoreError;
          if (operationError) throw operationError;
          return true;
        }, {
          allowedOwnerKinds: ["hss"],
          ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
          requiredOwner: owner,
        });
        applyQueue(envelope, execution);
      } catch (error) {
        operationError ??= error instanceof Error ? error : new Error(String(error));
      }
      const eventEndedAt = new Date().toISOString();
      let operationStartTick = helperOperationStartTick ?? qpcTick(activeSession, writeResponse?.operationBeforeQpcCounter) ?? fallbackStartTick;
      let operationEndTick = maxTick(operationStartTick, helperOperationEndTick ?? qpcTick(activeSession, writeResponse?.operationAfterQpcCounter) ?? elapsedTick(activeSession.startedAt));
      let timingSource = helperOperationStartTick && helperOperationEndTick ? "helper_qpc" : "controller_fallback";
      let timingDegraded = false;
      const neighbors: Record<string, unknown> = { status: "pending_terminal_index", before: null, after: null };
      const verificationState = verification
        ? { state: verification.pass ? "verified" : "failed", ...verification.details }
        : input.verify
          ? { state: writeStateUnknown ? "state_unknown" : writeIssued ? "failed" : "not_executed" }
          : { state: writeStateUnknown ? "state_unknown" : writeIssued ? "executed_unverified" : "not_executed" };
      try {
        if (timingSource === "helper_qpc") {
          const lastEventTick = jcapTail(activeSession.packageDir).lastEventTick;
          if (BigInt(operationEndTick) < BigInt(lastEventTick)) {
            timingDegraded = true;
            operationError ??= new HssOperationError("HSS_TIMEBASE_REGRESSION", "capture-owner QPC interval regressed behind the durable event timeline", false, writeIssued, false);
            operationStartTick = maxTick(lastEventTick, fallbackStartTick);
            operationEndTick = maxTick(operationStartTick, elapsedTick(activeSession.startedAt));
            timingSource = "controller_fallback";
          }
        }
        this.appendVariableWriteEvent(activeSession, {
          logicalIdentity,
          selector: logicalIdentity,
          descriptor,
          startedAt: eventStartedAt,
          endedAt: eventEndedAt,
          tick: operationEndTick,
          operationStartTick,
          operationEndTick,
          timingSource,
          helperOperationStartTick: helperOperationStartTick ?? null,
          helperOperationEndTick: helperOperationEndTick ?? null,
          timingDegraded,
          operationId,
          ipcRequestIds: [...transactionIds],
          writeAttempted: writeRequestDispatched,
          writeIssued,
          stateUnknown: writeStateUnknown || restoreStateUnknown,
          requested: { value: input.value, bytesHex: requested.toString("hex") },
          old: old ? { state: "captured", value: decodeHssValue(resolved.type, old, resolved.endian), bytesHex: old.toString("hex") } : { state: input.captureOld || input.restore ? "failed" : "not_requested", value: null, bytesHex: null },
          readback: readback ? { state: "observed", value: decodeHssValue(resolved.type, readback, resolved.endian), bytesHex: readback.toString("hex") } : { state: input.verify ? "failed" : "not_requested", value: null, bytesHex: null },
          verification: verificationState,
          restore: input.restore ? {
            state: !writeIssued ? "not_needed" : restoreError ? "failed" : restoreAttempted ? "restored" : "failed",
            attempted: restoreAttempted,
            writeIssued: restoreIssued,
            stateUnknown: restoreStateUnknown,
            readback: restoreReadback ? decodeHssValue(resolved.type, restoreReadback, resolved.endian) : null,
            readbackHex: restoreReadback?.toString("hex") ?? null,
          } : { state: "not_requested", attempted: false, writeIssued: false, stateUnknown: false, readback: null, readbackHex: null },
          sampleAlignment: { method: "terminal_raw_nearest", status: "derive_on_rebuild" },
          outcome: restoreError ? "restore_failed" : operationError ? "failed" : "completed",
          error: restoreError ? { code: errorCode(restoreError, "RESTORE_FAILED"), message: restoreError.message, writeIssued: writeIssued || restoreIssued, stateUnknown: writeStateUnknown || restoreStateUnknown } : operationError ? { code: errorCode(operationError, "HSS_VARIABLE_WRITE_FAILED"), message: operationError.message, writeIssued, stateUnknown: writeStateUnknown } : null,
        });
        eventAppended = true;
      } catch (eventError) {
        operationError = new HssOperationError("CAPTURE_EVENT_PERSIST_FAILED", eventError instanceof Error ? eventError.message : String(eventError), false, writeIssued || restoreIssued, writeStateUnknown || restoreStateUnknown);
      }
      if (eventAppended && transactionIds.length > 0) {
        try { this.adapter.acknowledgeMemoryTransactions(activeSession.control, transactionIds); }
        catch (error) { envelope.warnings.push(`The variable-write event is durable, but memory receipt cleanup is pending: ${error instanceof Error ? error.message : String(error)}`); }
      }
      envelope.before = { captureId: activeSession.captureId, oldHex: old?.toString("hex") ?? null };
      envelope.after = { captureId: activeSession.captureId, readbackHex: readback?.toString("hex") ?? null, restoreReadbackHex: restoreReadback?.toString("hex") ?? null };
      envelope.capture = captureSummary(this.readSession(activeSession.captureId));
      envelope.data = {
        resolved,
        requestedValue: input.value,
        requestedHex: requested.toString("hex"),
        oldHex: old?.toString("hex") ?? null,
        readbackHex: readback?.toString("hex") ?? null,
        verificationConnection: "capture_owner",
        verificationSource: input.verify ? "capture_owner_readback" : "not_requested",
        targetConsumption: "not_observed",
        writeAttempted: writeRequestDispatched,
        writeIssued,
        stateUnknown: writeStateUnknown || restoreStateUnknown,
        restore: input.restore ? { requested: true, attempted: restoreAttempted, writeIssued: restoreIssued, stateUnknown: restoreStateUnknown, readbackHex: restoreReadback?.toString("hex") ?? null, ok: !writeIssued || restoreAttempted && !restoreError } : { requested: false },
        captureId: activeSession.captureId,
        neighbors,
      };
      envelope.observedEffects = [
        ...(writeIssued ? [writeStateUnknown ? "target_memory_write_maybe_issued" : "target_memory_written"] : []),
        ...(restoreIssued ? [restoreStateUnknown ? "target_memory_restore_maybe_issued" : "target_memory_restored"] : []),
        ...(eventAppended ? ["capture_event_appended"] : []),
      ];
      if (timingDegraded) envelope.warnings.push("The helper QPC interval regressed behind the durable event timeline; the event uses an explicit controller fallback interval and the operation is reported as failed.");
      envelope.verification = input.verify
        ? { status: verification?.pass ? "verified" : writeStateUnknown ? "state_unknown" : writeIssued ? "failed" : "not_executed", method: comparatorMethod(comparator), details: { source: "capture_owner_readback", ...(verification?.details ?? {}) } }
        : { status: writeStateUnknown ? "state_unknown" : writeIssued ? "executed_unverified" : "not_executed", method: writeIssued ? "helper_write_acknowledged_without_readback" : "write_not_issued" };
      if (restoreError) {
        const normalized = normalizeHssError(restoreError, "RESTORE_FAILED", writeIssued || restoreIssued);
        return this.failure(envelope, new HssOperationError(normalized.code, normalized.message, normalized.retryable, writeIssued || restoreIssued || normalized.writeIssued, writeStateUnknown || restoreStateUnknown || normalized.stateUnknown), "restore");
      }
      if (operationError) {
        const normalized = normalizeHssError(operationError, "HSS_VARIABLE_WRITE_FAILED", writeIssued || restoreIssued);
        return this.failure(envelope, new HssOperationError(normalized.code, normalized.message, normalized.retryable, writeIssued || restoreIssued || normalized.writeIssued, writeStateUnknown || restoreStateUnknown || normalized.stateUnknown), "capture_write");
      }
      return finishEnvelope(envelope, true);
    });
  }

  async captureList(input: { limit?: number; cursor?: string }): Promise<OperationEnvelope> {
    return this.queryEnvelope("capture_list", () => this.query.list(input));
  }

  async captureSummary(captureId: string): Promise<OperationEnvelope> {
    return this.queryEnvelope("capture_summary", () => this.query.summary({ captureId }));
  }

  async captureSeries(input: { captureId: string; variables: string[]; startTick: string; endTick: string; bucketCount: number }): Promise<OperationEnvelope> {
    return this.queryEnvelope("capture_series", () => this.query.series(input));
  }

  async captureEventWindow(input: { captureId: string; eventId: string; variables: string[]; beforeMs: number; afterMs: number; bucketCount: number }): Promise<OperationEnvelope> {
    return this.queryEnvelope("capture_event_window", () => this.query.eventWindow(input));
  }

  async captureRebuild(captureId: string): Promise<OperationEnvelope> {
    return this.queryEnvelope("capture_index_rebuild", () => this.query.rebuild({ captureId }));
  }

  async captureExport(captureId: string): Promise<OperationEnvelope> {
    return this.queryEnvelope("capture_export_csv", () => this.query.exportCsv({ captureId }));
  }

  analysisProfiles(): OperationEnvelope {
    const envelope = createOperationEnvelope("analysis_profiles");
    envelope.data = {
      analyzerVersion: "analysis-v0",
      maxPoints: ANALYSIS_V0_MAX_POINTS,
      profiles: [
        { name: "generic_control", version: 0, roles: ["command", "feedback"], findings: ["write_window_comparison", "control_response"] },
        { name: "generic_state_machine", version: 0, roles: ["state"], findings: ["state_transition", "state_duration"] },
      ],
    };
    envelope.verification = { status: "verified", method: "implemented_profile_registry" };
    return finishEnvelope(envelope, true);
  }

  async analysisRun(input: AnalysisV0RunRequest): Promise<OperationEnvelope> {
    return this.queryEnvelope("analysis_run", () => this.query.analysisRun(input));
  }

  private async prepare(input: HssCaptureInput): Promise<PreparedCapture> {
    if (!Number.isSafeInteger(input.rateHz) || input.rateHz < 1 || input.rateHz > HSS_EFFECTIVE_LIMITS.maxRateHz) throw new HssOperationError("HSS_RATE_BOUNDS", `rateHz must be 1..${HSS_EFFECTIVE_LIMITS.maxRateHz}`);
    if (!Number.isSafeInteger(input.durationSec) || input.durationSec < 1 || input.durationSec > HSS_EFFECTIVE_LIMITS.maxDurationSec) throw new HssOperationError("HSS_DURATION_BOUNDS", `durationSec must be 1..${HSS_EFFECTIVE_LIMITS.maxDurationSec}`);
    if (!Array.isArray(input.variables) || input.variables.length < 1 || input.variables.length > HSS_EFFECTIVE_LIMITS.maxVariables) throw new HssOperationError("HSS_VARIABLE_BOUNDS", `variables must contain 1..${HSS_EFFECTIVE_LIMITS.maxVariables} entries`);
    if (input.writeVariables !== undefined && (!Array.isArray(input.writeVariables) || input.writeVariables.length > HSS_EFFECTIVE_LIMITS.maxWriteVariables)) throw new HssOperationError("HSS_WRITE_VARIABLE_BOUNDS", `writeVariables must contain at most ${HSS_EFFECTIVE_LIMITS.maxWriteVariables} entries`);
    if (input.runId !== undefined && !isValidHssRunId(input.runId)) throw new HssOperationError("RUN_ID_INVALID", "runId must be a bounded immutable non-reserved directory name");
    const target = this.targets.require(input.projectRoot);
    if (!target.artifact) throw new HssOperationError("ARTIFACT_NOT_CONFIGURED", "HSS requires a configured typed ELF Artifact");
    if (target.liveArtifactMatch.status !== "verified") throw new HssOperationError("ARTIFACT_NOT_VERIFIED", "symbol HSS requires a verified live Artifact match");
    const prepared: PreparedVariable[] = [];
    const logical = new Set<string>();
    const aliases = new Set<string>();
    for (const variable of input.variables) {
      const current = await this.artifacts.resolveCaptureVariable(target.projectRoot, variable.ref);
      if (current.target.generation !== target.generation) throw new HssOperationError("TARGET_GENERATION_CHANGED", "Target generation changed during HSS variable resolution", true);
      const resolved = current.resolved;
      if (!resolved.hssEligible || resolved.region !== "ram" || resolved.source !== "elf-dwarf" || resolved.confidence !== "dwarf") throw new HssOperationError("HSS_VARIABLE_INELIGIBLE", `${symbolLogicalIdentity(resolved.ref)} is not a verified typed DWARF RAM scalar`);
      if (resolved.endian !== "little") throw new HssOperationError("HSS_ENDIAN_UNSUPPORTED", `${symbolLogicalIdentity(resolved.ref)} uses unsupported ${resolved.endian}-endian encoding`);
      const identity = symbolLogicalIdentity(resolved.ref);
      if (!NATIVE_HSS_SCALAR_TYPES.has(resolved.type) || resolved.size !== hssTypedByteSize(resolved.type)) throw new HssOperationError("HSS_SCALAR_UNSUPPORTED", `${identity} is not one of the native JCAP scalar layouts`);
      if (Buffer.byteLength(identity, "utf8") > 256) throw new HssOperationError("HSS_VARIABLE_NAME_TOO_LONG", "capture logical identities must be at most 256 UTF-8 bytes");
      if (logical.has(identity)) throw new HssOperationError("HSS_VARIABLE_DUPLICATE", `duplicate capture variable: ${identity}`);
      logical.add(identity);
      if (variable.alias) {
        if (Buffer.byteLength(variable.alias, "utf8") > 128 || aliases.has(variable.alias)) throw new HssOperationError("HSS_ALIAS_INVALID", "capture aliases must be unique and at most 128 UTF-8 bytes");
        aliases.add(variable.alias);
      }
      if (variable.unit && Buffer.byteLength(variable.unit, "utf8") > 64) throw new HssOperationError("HSS_UNIT_INVALID", "capture units must be at most 64 UTF-8 bytes");
      prepared.push({
        requested: variable,
        resolved,
        cacheRefreshed: current.cacheRefreshed,
        descriptor: {
          logicalIdentity: identity,
          type: resolved.type,
          address: hexAddress(resolved.address),
          size: resolved.size,
          artifactGeneration: resolved.ref.artifactGeneration,
          layoutHash: resolved.ref.layoutHash,
          ...(variable.alias ? { alias: variable.alias } : {}),
          ...(variable.unit ? { unit: variable.unit } : {}),
        },
      });
    }
    const writeVariables: PreparedVariable[] = [];
    const writeLogical = new Set<string>();
    for (const ref of input.writeVariables ?? []) {
      const current = await this.artifacts.resolveCaptureVariable(target.projectRoot, ref);
      if (current.target.generation !== target.generation) throw new HssOperationError("TARGET_GENERATION_CHANGED", "Target generation changed during HSS write-variable resolution", true);
      const resolved = current.resolved;
      if (!resolved.hssEligible || resolved.region !== "ram" || resolved.source !== "elf-dwarf" || resolved.confidence !== "dwarf") throw new HssOperationError("HSS_WRITE_VARIABLE_INELIGIBLE", `${symbolLogicalIdentity(resolved.ref)} is not a verified typed DWARF RAM scalar`);
      if (resolved.endian !== "little") throw new HssOperationError("HSS_ENDIAN_UNSUPPORTED", `${symbolLogicalIdentity(resolved.ref)} uses unsupported ${resolved.endian}-endian encoding`);
      const identity = symbolLogicalIdentity(resolved.ref);
      if (!NATIVE_HSS_SCALAR_TYPES.has(resolved.type) || resolved.size !== hssTypedByteSize(resolved.type)) throw new HssOperationError("HSS_SCALAR_UNSUPPORTED", `${identity} is not one of the native JCAP scalar layouts`);
      if (Buffer.byteLength(identity, "utf8") > 256) throw new HssOperationError("HSS_VARIABLE_NAME_TOO_LONG", "write-variable logical identities must be at most 256 UTF-8 bytes");
      if (logical.has(identity)) continue;
      if (writeLogical.has(identity)) throw new HssOperationError("HSS_WRITE_VARIABLE_DUPLICATE", `duplicate HSS write variable: ${identity}`);
      writeLogical.add(identity);
      writeVariables.push({
        requested: { ref },
        resolved,
        cacheRefreshed: current.cacheRefreshed,
        descriptor: {
          logicalIdentity: identity,
          type: resolved.type,
          address: hexAddress(resolved.address),
          size: resolved.size,
          artifactGeneration: resolved.ref.artifactGeneration,
          layoutHash: resolved.ref.layoutHash,
        },
      });
    }
    let qualityOracle: PreparedQualityOracle | undefined;
    if (input.qualityOracle) {
      if (!Number.isSafeInteger(input.qualityOracle.expectedIncrement) || input.qualityOracle.expectedIncrement < 1
        || !Number.isSafeInteger(input.qualityOracle.tolerance) || input.qualityOracle.tolerance < 0) {
        throw new HssOperationError("HSS_QUALITY_ORACLE_BOUNDS", "qualityOracle expectedIncrement must be positive and tolerance must be non-negative safe integers");
      }
      const oracle = await this.artifacts.resolveCaptureVariable(target.projectRoot, input.qualityOracle.ref);
      if (oracle.target.generation !== target.generation) throw new HssOperationError("TARGET_GENERATION_CHANGED", "Target generation changed during HSS quality-oracle resolution", true);
      const logicalIdentity = symbolLogicalIdentity(oracle.resolved.ref);
      const variable = prepared.find((candidate) => candidate.descriptor.logicalIdentity === logicalIdentity);
      if (!variable) throw new HssOperationError("HSS_QUALITY_ORACLE_UNDECLARED", "qualityOracle.ref must identify one of the declared capture variables");
      if (!/^uint(?:8|16|32)$/.test(variable.descriptor.type)) throw new HssOperationError("HSS_QUALITY_ORACLE_TYPE", "qualityOracle requires a declared unsigned scalar capture variable");
      const modulus = 2 ** (variable.descriptor.size * 8);
      if (input.qualityOracle.expectedIncrement + input.qualityOracle.tolerance >= modulus) {
        throw new HssOperationError("HSS_QUALITY_ORACLE_BOUNDS", "qualityOracle expectedIncrement plus tolerance must be smaller than the counter modulus");
      }
      qualityOracle = {
        logicalIdentity,
        expectedIncrement: input.qualityOracle.expectedIncrement,
        tolerance: input.qualityOracle.tolerance,
        modulus,
      };
    }
    return {
      target,
      variables: prepared,
      writeVariables,
      rateHz: input.rateHz,
      durationSec: input.durationSec,
      ...(qualityOracle ? { qualityOracle } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      blockCount: blockCount(prepared.map(({ resolved }) => resolved)),
    };
  }

  private async createCapture(prepared: PreparedCapture, runtime: HssRuntimeFacts, capability: HssCapabilityFacts, preflight: HssStartPreflight): Promise<{
    captureId: string;
    createdAt: string;
    packageDir: string;
    sessionDir: string;
    control: HssCaptureControlFiles;
    helperNonce: string;
    qpcEpochCounter: string;
    qpcFrequency: string;
  }> {
    const target = preflight.target;
    if (!target.artifact) throw new HssOperationError("ARTIFACT_NOT_CONFIGURED", "HSS start requires a configured typed ELF Artifact");
    if (!runtime.runtimePath || !runtime.runtimeSha256 || !runtime.helperPath || !SHA256.test(runtime.runtimeSha256)) {
      throw new HssOperationError("HSS_RUNTIME_IDENTITY_UNAVAILABLE", "HSS start requires a hashed helper/runtime identity");
    }
    const { artifact, nonvolatileRanges, ramRanges } = preflight;
    const captureId = randomUUID();
    const helperNonce = randomUUID();
    const createdAt = new Date().toISOString();
    const capturesDir = prepared.runId ? join(this.outputRoot, prepared.runId, "captures") : join(this.outputRoot, "captures");
    mkdirSync(capturesDir, { recursive: true });
    const packageDir = join(capturesDir, `${captureId}.jcap`);
    const sessionDir = mkdtempSync(join(this.sessionWorkRoot, `${captureId}-`));
    const control: HssCaptureControlFiles = {
      planPath: join(sessionDir, "capture-plan.json"),
      pidFile: join(sessionDir, "helper.owner.json"),
      readyFile: join(sessionDir, "helper.ready.json"),
      stdoutPath: join(sessionDir, "helper.stdout.ndjson"),
      stderrPath: join(sessionDir, "helper.stderr.log"),
      stopFile: join(sessionDir, "stop.request"),
      requestFile: join(sessionDir, "memory.request.json"),
      claimFile: join(sessionDir, "memory.request.claimed.json"),
      responseFile: join(sessionDir, "memory.response.json"),
    };
    try {
    const manifest = await writeArtifactMatchManifest({
      projectRoot: target.projectRoot,
      sessionRoot: sessionDir,
      artifact,
      captureId,
      targetId: target.device,
      probeSerial: target.probeSerial,
      runtimeIdentitySha256: runtime.runtimeSha256,
      nonvolatileRanges,
      ramRanges,
    });
    const timebase = await this.adapter.qpcTimebase(runtime);
    const persistedBackend = this.adapter.backend === "fake-hss" ? "fake-jlink-hss" : "jlink-hss";
    const metadata = createJcapV1Metadata({
      captureId,
      backend: persistedBackend,
      requestedRateHz: prepared.rateHz,
      durationSec: prepared.durationSec,
      variables: prepared.variables.map(({ descriptor }) => descriptor),
      createdAt,
      provenance: {
        captureId,
        backend: persistedBackend,
        runtime: {
          helperVersion: runtime.helperVersion ?? null,
          helperProtocolVersion: runtime.helperProtocolVersion ?? null,
          architecture: runtime.architecture ?? null,
          helperSha256: runtime.helperSha256 ?? null,
          runtimeSha256: runtime.runtimeSha256,
          capability: capability.hardware ?? null,
          effectiveLimits: capability.effective,
          qualityOracle: prepared.qualityOracle ?? null,
        },
        target: { projectRoot: target.projectRoot, generation: target.generation, device: target.device, probeSerial: target.probeSerial, interface: target.interface, speed: target.speed },
        script: { mode: "none" },
        artifact: { path: target.artifact.path, generation: target.artifact.generation, sha256: target.artifact.sha256 },
        variables: prepared.variables.map(({ descriptor }) => ({ ...descriptor } as Record<string, unknown>)),
        artifactMatch: { manifestSha256: manifest.sha256, statusAtStart: target.liveArtifactMatch.status },
      },
    });
    const writer = new JcapV1Writer({ packageDir, metadata, externalSamples: true });
    try {
      writer.appendEvent({ eventId: randomUUID(), eventSequence: 0, type: "lifecycle", tick: "0", state: "active", createdAt });
      writer.syncEvents();
      writer.closeEvents();
    } catch (error) {
      writer.close();
      throw error;
    }
    const plan = {
      planFormatVersion: 2,
      dllPath: runtime.runtimePath,
      dllSha256: runtime.runtimeSha256,
      runtimeIdentityValidated: true,
      artifactMatchManifestPath: manifest.path,
      artifactMatchManifestSha256: manifest.sha256,
      artifactMatchRuntimeIdentitySha256: runtime.runtimeSha256,
      artifactGeneration: target.artifact.generation,
      artifactSha256: target.artifact.sha256,
      outputFile: join(packageDir, "raw", "samples.bin"),
      pidFile: control.pidFile,
      readyFile: control.readyFile,
      stopFile: control.stopFile,
      writeRequestFile: control.requestFile,
      writeClaimFile: control.claimFile,
      writeResponseFile: control.responseFile,
      captureId,
      helperInstanceNonce: helperNonce,
      qpcEpochCounter: timebase.qpcCounter,
      qpcFrequency: timebase.qpcFrequency,
      device: target.device,
      interface: target.interface,
      serial: target.probeSerial,
      speedKhz: target.speed,
      requestedRateHz: prepared.rateHz,
      durationSec: prepared.durationSec,
      readMode: "periodic",
      resumeBeforeStart: false,
      expectedTargetState: preflight.targetStateBefore,
      requireFirstSampleIndexZero: false,
      postConnectStabilityRequired: false,
      qualityOracle: prepared.qualityOracle ?? null,
      symbols: prepared.variables.map(({ descriptor, resolved }) => ({ name: descriptor.logicalIdentity, address: hexAddress(resolved.address), size: resolved.size, type: descriptor.type })),
      writeSymbols: prepared.writeVariables.map(({ descriptor, resolved }) => ({ name: descriptor.logicalIdentity, address: hexAddress(resolved.address), size: resolved.size, type: descriptor.type })),
    };
    writeFileSync(control.planPath, JSON.stringify(plan), { encoding: "utf8", flag: "wx" });
    return { captureId, createdAt, packageDir, sessionDir, control, helperNonce, qpcEpochCounter: timebase.qpcCounter, qpcFrequency: timebase.qpcFrequency };
    } catch (error) {
      if (existsSync(join(packageDir, "capture.json"))) this.finalizeCreatedFailure(packageDir, error);
      else rmSync(packageDir, { recursive: true, force: true });
      const failed: HssSessionRecord = {
        formatVersion: 1,
        captureId,
        projectRoot: target.projectRoot,
        targetGeneration: target.generation,
        artifactGeneration: target.artifact.generation,
        probeSerial: target.probeSerial,
        state: "failed",
        createdAt,
        updatedAt: new Date().toISOString(),
        startedAt: createdAt,
        endedAt: new Date().toISOString(),
        ...(prepared.runId ? { runId: prepared.runId } : {}),
        packageDir,
        sessionDir,
        control,
        helperPid: 0,
        helperNonce,
        ownerToken: "pending",
        qpcEpochCounter: "0",
        qpcFrequency: "1",
        configuredInterface: target.interface,
        configuredSpeedKHz: target.speed,
        rateHz: prepared.rateHz,
        durationSec: prepared.durationSec,
        descriptors: prepared.variables.map(({ descriptor }) => descriptor),
        writeDescriptors: prepared.writeVariables.map(({ descriptor }) => descriptor),
        ...(prepared.qualityOracle ? { qualityOracle: prepared.qualityOracle } : {}),
        runtime,
        capability,
        lastError: { code: errorCode(error, "HSS_CREATE_FAILED"), message: error instanceof Error ? error.message : String(error) },
      };
      this.writeSession(failed);
      this.preserveSessionLogs(failed);
      this.cleanupSessionWork(failed);
      throw new HssOperationError(errorCode(error, "HSS_CREATE_FAILED"), error instanceof Error ? error.message : String(error), false, false, false, { captureId, packageDir });
    }
  }

  private scheduleMonitor(captureId: string): void {
    if (this.monitoredCaptures.has(captureId)) return;
    this.monitoredCaptures.add(captureId);
    const timer = setTimeout(() => { void this.monitor(captureId).finally(() => this.monitoredCaptures.delete(captureId)); }, 50);
    timer.unref();
  }

  private async monitor(captureId: string): Promise<void> {
    let lastProgressPublishedAt = 0;
    for (;;) {
      let session: HssSessionRecord;
      try { session = this.readSession(captureId); } catch { return; }
      if (TERMINAL_SESSION_STATES.has(session.state)) {
        if (session.statePreservationPending) {
          try { await this.settle(captureId); }
          catch { await delay(250); continue; }
          return;
        }
        try { this.queue.releaseOwner(session.probeSerial, session.ownerToken); } catch { /* only the owning MCP process may release a still-live owner record */ }
        return;
      }
      try { session = await this.reconcileSession(captureId); }
      catch { await delay(250); continue; }
      if (this.startupJournalPending(session)) {
        await delay(100);
        continue;
      }
      if (!this.adapter.isAlive(session.helperPid)) {
        try { await this.settle(captureId); } catch { /* a concurrent teardown or restarted process will retry from durable state */ }
        return;
      }
      if (Date.now() - lastProgressPublishedAt >= 1_000) {
        try {
          await this.captureExclusive(captureId, async () => {
            const current = this.readSession(captureId);
            if (!TERMINAL_SESSION_STATES.has(current.state) && this.captureHelperAlive(current)) refreshActiveJcapV1Metadata(current.packageDir);
          });
          lastProgressPublishedAt = Date.now();
        } catch { /* an in-flight partial frame is retried on the next bounded progress interval */ }
      }
      await delay(100);
    }
  }

  private discoverHelperPid(session: HssSessionRecord): HssSessionRecord {
    if (session.helperPid > 0 || !existsSync(session.control.pidFile)) return session;
    try {
      const owner = JSON.parse(readFileSync(session.control.pidFile, "utf8")) as { captureId?: unknown; helperNonce?: unknown; pid?: unknown };
      if (owner.captureId !== session.captureId || owner.helperNonce !== session.helperNonce || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) throw new Error("helper PID journal does not match the capture instance");
      return this.updateSession(session.captureId, (current) => ({ ...current, helperPid: Number(owner.pid), updatedAt: new Date().toISOString() }));
    } catch (error) {
      if (this.startupJournalPending(session)) return session;
      throw new HssOperationError("HSS_HELPER_PID_INVALID", error instanceof Error ? error.message : String(error), true);
    }
  }

  private startupJournalPending(session: HssSessionRecord): boolean {
    return (session.state === "starting" || session.state === "stopping")
      && session.helperPid === 0
      && Date.now() - Date.parse(session.createdAt) < 5_000;
  }

  private reconcileSession(captureId: string): Promise<HssSessionRecord> {
    return this.captureExclusive(captureId, async () => {
      let session = this.readSession(captureId);
      session = this.discoverHelperPid(session);
      if (ACTIVE_SESSION_STATES.has(session.state) && this.captureHelperAlive(session)) {
        session = await this.ensureSessionOwner(session);
      } else if (ACTIVE_SESSION_STATES.has(session.state) && this.adapter.isAlive(session.helperPid) && !this.startupJournalPending(session)) {
        throw new HssOperationError("HSS_HELPER_IDENTITY_UNVERIFIED", "the live PID does not have a fresh capture-bound Helper heartbeat", true, false, true);
      }
      return session;
    });
  }

  private async ensureSessionOwner(session: HssSessionRecord): Promise<HssSessionRecord> {
    if (session.helperPid < 1 || !this.captureHelperAlive(session)) return session;
    const matches = (owner: ProbeOwner): boolean => owner.kind === "hss" && owner.projectRoot === session.projectRoot && owner.targetGeneration === session.targetGeneration
      && owner.resourcePid === session.helperPid && owner.details?.captureId === session.captureId;
    const existing = this.queue.getOwner(session.probeSerial);
    if ((!existing || existing.token !== session.ownerToken)
      && !await this.adapter.confirmCaptureAlive(session.control, session.helperPid, session.captureId, session.helperNonce)) {
      throw new HssOperationError("HSS_HELPER_IDENTITY_UNVERIFIED", "the Helper heartbeat did not advance, so Probe ownership cannot be adopted", true, false, true);
    }
    let owner: ProbeOwner;
    if (existing) {
      if (!matches(existing)) throw new HssOperationError("CAPTURE_OWNER_CHANGED", "the live Probe owner does not match the durable capture journal", true);
      owner = existing.token === session.ownerToken ? existing : this.queue.adoptOwner(session.probeSerial, {
        kind: "hss",
        projectRoot: session.projectRoot,
        targetGeneration: session.targetGeneration,
        resourcePid: session.helperPid,
        captureId: session.captureId,
      });
    } else {
      const execution = await this.queue.runExclusive(session.probeSerial, async (metadata) => this.queue.claimOwner(session.probeSerial, {
        kind: "hss",
        projectRoot: session.projectRoot,
        targetGeneration: session.targetGeneration,
        resourcePid: session.helperPid,
        details: { captureId: session.captureId, packageDir: session.packageDir },
      }, metadata.leaseToken));
      owner = execution.value;
    }
    if (session.ownerToken === owner.token && session.state !== "starting") return session;
    return this.updateSession(session.captureId, (current) => ({ ...current, state: current.state === "starting" ? "capturing" : current.state, ownerToken: owner.token, updatedAt: new Date().toISOString() }));
  }

  private async settle(captureId: string): Promise<{ recovered: number }> {
    return this.captureExclusive(captureId, async () => {
      let session = this.readSession(captureId);
      if (TERMINAL_SESSION_STATES.has(session.state)) {
        if (session.statePreservationPending) {
          await this.settleTargetStateAndOwner(session);
          session = this.readSession(captureId);
          this.preserveSessionLogs(session);
          this.cleanupSessionWork(session);
        } else {
          try { this.queue.releaseOwner(session.probeSerial, session.ownerToken); } catch { /* another live MCP may still own the record */ }
        }
        return { recovered: 0 };
      }
      if (this.adapter.isAlive(session.helperPid)) return { recovered: 0 };
      const memoryRecovery = this.recoverDurableMemoryTransactions(session);
      const samplesFile = join(session.packageDir, "raw", "samples.bin");
      if (!existsSync(samplesFile)) writeFileSync(samplesFile, Buffer.alloc(0), { flag: "wx" });
      const records = this.adapter.readRecords(session.control);
      const result = [...records].reverse().find((record) => record.record === "result") ?? [...records].reverse().find((record) => typeof record.status === "string");
      let state: Exclude<JcapV1CaptureState, "active" | "finalizing"> = result?.status === "ok" ? "completed" : result?.status === "stopped" ? "stopped" : result?.status === "error" ? "failed" : "interrupted";
      let raw: ReturnType<typeof readJcapV1Raw> | undefined;
      let damagedEventTail = false;
      try {
        raw = readJcapV1Raw(session.packageDir);
        damagedEventTail = raw.diagnostics.some((entry) => entry.file === "raw/events.bin");
        if (raw.diagnostics.some((entry) => entry.reason === "corrupt_suffix")) state = "failed";
        else if (raw.diagnostics.length || state === "failed" && raw.samples.length > 0) state = "interrupted";
      } catch (error) {
        state = "failed";
        session = { ...session, lastError: { code: "JCAP_RAW_INVALID", message: error instanceof Error ? error.message : String(error) } };
      }
      try {
        const qualityEvidence = qualityEvidenceFrom(result, raw, session.qualityOracle, session.rateHz);
        if (state === "completed" && qualityEvidence.durationValidated !== true) {
          state = "failed";
          session = {
            ...session,
            lastError: {
              code: "HSS_DURATION_UNVERIFIED",
              message: "helper terminal result did not prove the requested capture duration elapsed",
            },
          };
        }
        if (!damagedEventTail) {
          const initialTail = jcapTail(session.packageDir);
          const terminalTick = maxTick(initialTail.lastEventTick, initialTail.lastSampleTick, elapsedTick(session.startedAt));
          this.appendHelperEvidenceEvents(session, records, qualityEvidence, terminalTick);
          const tail = jcapTail(session.packageDir);
          appendJcapV1Event(session.packageDir, { eventId: randomUUID(), eventSequence: tail.nextEventSequence, type: "lifecycle", tick: terminalTick, state: "finalizing" });
          appendJcapV1Event(session.packageDir, {
            eventId: randomUUID(),
            eventSequence: tail.nextEventSequence + 1,
            type: "lifecycle",
            tick: terminalTick,
            state,
            helperStatus: result?.status ?? null,
            errorCode: result?.errorCode ?? null,
          });
        }
        finalizeJcapV1Metadata(session.packageDir, state, qualityEvidence.counters, qualityEvidence.status, qualityEvidence.source);
        if (state !== "failed") await rebuildJcapV1Index(session.packageDir);
        session = {
          ...session,
          state,
          updatedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          result: result ? sanitizeResult(result) : undefined,
          statePreservationPending: Boolean(session.expectedTargetState),
          ...(state === "failed" ? { lastError: { code: String(result?.errorCode ?? session.lastError?.code ?? "HSS_CAPTURE_FAILED"), message: String(result?.reason ?? session.lastError?.message ?? "HSS capture failed") } } : {}),
        };
      } catch (error) {
        session = {
          ...session,
          state: "failed",
          updatedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          lastError: { code: errorCode(error, "HSS_FINALIZE_FAILED"), message: error instanceof Error ? error.message : String(error) },
          result: result ? sanitizeResult(result) : undefined,
          statePreservationPending: Boolean(session.expectedTargetState),
        };
      }
      this.writeSession(session);
      await this.settleTargetStateAndOwner(session);
      session = this.readSession(captureId);
      this.preserveSessionLogs(session);
      this.cleanupSessionWork(session);
      return { recovered: memoryRecovery.count };
    });
  }

  private captureHelperAlive(session: HssSessionRecord): boolean {
    return this.adapter.isCaptureAlive(session.control, session.helperPid, session.captureId, session.helperNonce);
  }

  private appendHelperEvidenceEvents(session: HssSessionRecord, records: Array<Record<string, unknown>>, quality: QualityEvidence, terminalTick: string): void {
    const evidence = records.filter((record) => record.record === "artifact_match" || record.record === "fault").slice(0, 256);
    for (const record of evidence) {
      const tail = jcapTail(session.packageDir);
      const sourceTick = qpcTick(session, record.qpcCounter);
      const details = sanitizeResult(record);
      delete details.record;
      delete details.captureId;
      delete details.qpcCounter;
      appendJcapV1Event(session.packageDir, {
        eventId: randomUUID(),
        eventSequence: tail.nextEventSequence,
        type: record.record === "artifact_match" ? "artifact_match" : "fault",
        tick: maxTick(tail.lastEventTick, sourceTick ?? terminalTick),
        sourceTick: sourceTick ?? null,
        ...details,
      });
    }
    const tail = jcapTail(session.packageDir);
    appendJcapV1Event(session.packageDir, {
      eventId: randomUUID(),
      eventSequence: tail.nextEventSequence,
      type: "quality",
      tick: maxTick(tail.lastEventTick, terminalTick),
      qualityStatus: quality.status,
      qualitySource: quality.source,
      missingSamples: quality.counters.missingSamples,
      droppedSamples: quality.counters.droppedSamples,
      overflows: quality.counters.overflows,
      readErrors: quality.counters.readErrors,
      timeouts: quality.counters.timeouts,
      durationValidated: quality.durationValidated,
      qualityEvidence: quality.provenance,
      inferredDroppedBeforeSampleIndexes: quality.inferredDroppedBeforeSampleIndexes,
    });
  }

  private finalizeCreatedFailure(packageDir: string, error: unknown): void {
    try {
      const samplesFile = join(packageDir, "raw", "samples.bin");
      if (!existsSync(samplesFile)) writeFileSync(samplesFile, Buffer.alloc(0), { flag: "wx" });
      const tail = jcapTail(packageDir);
      appendJcapV1Event(packageDir, { eventId: randomUUID(), eventSequence: tail.nextEventSequence, type: "lifecycle", tick: tail.lastEventTick, state: "finalizing" });
      appendJcapV1Event(packageDir, { eventId: randomUUID(), eventSequence: tail.nextEventSequence + 1, type: "lifecycle", tick: tail.lastEventTick, state: "failed", errorCode: errorCode(error, "HSS_START_FAILED") });
      finalizeJcapV1Metadata(packageDir, "failed");
    } catch { /* preserve the original start error; the package remains inspectable for diagnostics */ }
  }

  private cleanupSessionWork(session: HssSessionRecord): void {
    const rel = relative(this.sessionWorkRoot, resolve(session.sessionDir));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return;
    try { rmSync(resolve(session.sessionDir), { recursive: true, force: true }); } catch { /* terminal JCAP remains authoritative */ }
  }

  private preserveSessionLogs(session: HssSessionRecord): void {
    if (!session.runId) return;
    const logsRoot = join(this.outputRoot, session.runId, "logs");
    mkdirSync(logsRoot, { recursive: true });
    const files: Array<[string, string]> = [
      [session.control.planPath, `${session.captureId}.capture-plan.json`],
      [session.control.stdoutPath, `${session.captureId}.helper.stdout.ndjson`],
      [session.control.stderrPath, `${session.captureId}.helper.stderr.log`],
    ];
    for (const [source, name] of files) {
      try {
        if (!existsSync(source) || statSync(source).size > 16 * 1024 * 1024) continue;
        writeFileSync(join(logsRoot, name), readFileSync(source), { flag: "wx" });
      } catch { /* evidence copy failure is surfaced by the acceptance file audit */ }
    }
  }

  private recoverDurableMemoryTransactions(session: HssSessionRecord): { count: number; writeIssued: boolean; stateUnknown: boolean } {
    const transactions = this.adapter.listMemoryTransactions(session.control);
    if (transactions.length === 0) return { count: 0, writeIssued: false, stateUnknown: false };
    const recorded = new Set(readJcapV1Raw(session.packageDir).events.flatMap((event) => Array.isArray(event.ipcRequestIds)
      ? event.ipcRequestIds.filter((value): value is string => typeof value === "string")
      : []));
    let writeIssued = false;
    let stateUnknown = false;
    for (const transaction of transactions) {
      const requestId = transaction.request.requestId;
      const responseIssued = transaction.response.writeIssued === true;
      const responseUnknown = transaction.response.stateUnknown === true;
      writeIssued ||= responseIssued;
      stateUnknown ||= responseUnknown;
      if (!recorded.has(requestId)) this.appendRecoveredMemoryTransaction(session, transaction);
      this.adapter.acknowledgeMemoryTransactions(session.control, [requestId]);
      recorded.add(requestId);
    }
    return { count: transactions.length, writeIssued, stateUnknown };
  }

  private appendRecoveredMemoryTransaction(session: HssSessionRecord, transaction: HssMemoryTransaction): void {
    const request = transaction.request;
    const context = request.eventContext;
    const descriptor = context && [...session.descriptors, ...(session.writeDescriptors ?? [])].find((candidate) => candidate.logicalIdentity === context.logicalIdentity
      && candidate.address.toLowerCase() === String(request.address ?? "").toLowerCase()
      && candidate.size === request.length);
    const bytesHex = request.bytesHex;
    if (!context || !descriptor || typeof bytesHex !== "string" || !new RegExp(`^[0-9a-fA-F]{${descriptor.size * 2}}$`).test(bytesHex)) {
      throw new HssOperationError("HSS_MEMORY_RECEIPT_INVALID", "durable write transaction does not match an immutable capture descriptor", false, true, true);
    }
    if (!NATIVE_HSS_SCALAR_TYPES.has(descriptor.type)
      || !encodeHssValue(descriptor.type as typeof HSS_SCALAR_TYPES[number], context.requestedValue, context.endian).equals(Buffer.from(bytesHex, "hex"))) {
      throw new HssOperationError("HSS_MEMORY_RECEIPT_INVALID", "durable write transaction value evidence does not match its encoded bytes", false, true, true);
    }
    const tail = jcapTail(session.packageDir);
    const helperStartTick = qpcTick(session, transaction.response.operationBeforeQpcCounter);
    const helperEndTick = qpcTick(session, transaction.response.operationAfterQpcCounter);
    const helperTimingValid = helperStartTick !== undefined && helperEndTick !== undefined
      && BigInt(helperEndTick) >= BigInt(helperStartTick) && BigInt(helperEndTick) >= BigInt(tail.lastEventTick);
    const operationStartTick = helperTimingValid ? helperStartTick : maxTick(tail.lastEventTick, elapsedTick(session.startedAt));
    const operationEndTick = helperTimingValid ? helperEndTick : operationStartTick;
    const writeIssued = transaction.response.writeIssued === true;
    const unknown = transaction.response.stateUnknown === true;
    const completed = transaction.response.status === "ok" && writeIssued && !unknown;
    const endedAt = Date.parse(transaction.receivedAt) >= Date.parse(request.createdAt) ? transaction.receivedAt : request.createdAt;
    this.appendVariableWriteEvent(session, {
      eventId: request.requestId,
      logicalIdentity: descriptor.logicalIdentity,
      selector: descriptor.logicalIdentity,
      descriptor,
      startedAt: request.createdAt,
      endedAt,
      tick: operationEndTick,
      operationStartTick,
      operationEndTick,
      timingSource: helperTimingValid ? "helper_qpc" : "controller_fallback",
      helperOperationStartTick: helperStartTick ?? null,
      helperOperationEndTick: helperEndTick ?? null,
      timingDegraded: !helperTimingValid,
      operationId: request.operationId,
      ipcRequestIds: [request.requestId],
      recoveredTransaction: { source: "durable_hss_memory_receipt", phase: context.phase },
      writeAttempted: true,
      writeIssued,
      stateUnknown: unknown,
      requested: { value: context.requestedValue, bytesHex: bytesHex.toLowerCase() },
      old: { state: "not_requested", value: null, bytesHex: null },
      readback: { state: "not_requested", value: null, bytesHex: null },
      verification: { state: unknown ? "state_unknown" : writeIssued ? "executed_unverified" : "not_executed" },
      restore: { state: "not_requested", attempted: false, writeIssued: false, stateUnknown: false, readback: null, readbackHex: null },
      sampleAlignment: { method: "terminal_raw_nearest", status: "derive_on_rebuild" },
      outcome: completed ? "completed" : "failed",
      error: completed ? null : {
        code: String(transaction.response.errorCode ?? "HSS_MEMORY_DURABLE_RESPONSE_RECOVERED"),
        message: String(transaction.response.reason ?? "durable Helper write response was recovered after controller interruption"),
        writeIssued,
        stateUnknown: unknown,
      },
    });
  }

  private async readViaOwner(session: HssSessionRecord, resolved: ResolvedSymbol, operationId: string): Promise<Buffer> {
    const response = await this.adapter.requestMemory(session.control, { captureId: session.captureId, op: "read", operationId, address: hexAddress(resolved.address), length: resolved.size, accessSize: resolved.size as 1 | 2 | 4 });
    requireMemoryOk(response, "HSS_VARIABLE_READ_FAILED", false);
    if (typeof response.bytesHex !== "string" || !new RegExp(`^[0-9a-fA-F]{${resolved.size * 2}}$`).test(response.bytesHex)) throw new HssOperationError("HSS_MEMORY_RESPONSE_INVALID", "capture-owner read returned an invalid byte count", false, false, true);
    return Buffer.from(response.bytesHex, "hex");
  }

  private async verifyViaOwner(session: HssSessionRecord, resolved: ResolvedSymbol, expected: Buffer, comparator: ScalarComparator, operationId: string): Promise<{ pass: boolean; readback: Buffer; details: Record<string, unknown> }> {
    if (comparator.mode !== "observe") {
      const readback = await this.readViaOwner(session, resolved, operationId);
      const comparison = compare(readback, expected, comparator);
      return { ...comparison, readback, details: { ...comparison.details, observationCount: 1 } };
    }
    const observations: Array<{ at: string; hex: string; numeric?: number }> = [];
    const started = Date.now();
    let readback: Buffer = Buffer.alloc(resolved.size);
    for (let index = 0; index < comparator.maxPolls; index += 1) {
      readback = await this.readViaOwner(session, resolved, operationId);
      const comparison = compare(readback, expected, comparator.comparator);
      const observedNumeric = numeric(readback, comparator.comparator);
      observations.push({ at: new Date().toISOString(), hex: readback.toString("hex"), ...(observedNumeric === undefined ? {} : { numeric: observedNumeric }) });
      if (comparison.pass) return { pass: true, readback, details: { ...comparison.details, observationCount: observations.length, observations } };
      const elapsed = Date.now() - started;
      if (elapsed >= comparator.durationMs) break;
      await delay(Math.min(comparator.intervalMs, comparator.durationMs - elapsed));
    }
    const last = compare(readback, expected, comparator.comparator);
    return { pass: false, readback, details: { ...last.details, observationCount: observations.length, observations } };
  }

  private appendVariableWriteEvent(session: HssSessionRecord, data: Record<string, unknown> & { tick: string }): void {
    const tail = jcapTail(session.packageDir);
    if (BigInt(data.tick) < BigInt(tail.lastEventTick)) throw new HssOperationError("CAPTURE_EVENT_TICK_REGRESSION", "variable-write event tick regressed behind the durable event timeline", false, data.writeIssued === true, false);
    appendJcapV1Event(session.packageDir, {
      eventId: randomUUID(),
      eventSequence: tail.nextEventSequence,
      type: "variable_write",
      ...data,
      operationEndTick: data.tick,
      tick: data.tick,
    });
    try { refreshActiveJcapV1Metadata(session.packageDir); } catch { /* terminal status will publish exact identities */ }
  }

  private requiredOwner(session: HssSessionRecord): Pick<ProbeOwner, "kind" | "token" | "projectRoot" | "targetGeneration"> {
    const owner = this.queue.getOwner(session.probeSerial);
    if (!owner || owner.kind !== "hss" || owner.token !== session.ownerToken || owner.projectRoot !== session.projectRoot || owner.targetGeneration !== session.targetGeneration) throw new HssOperationError("CAPTURE_OWNER_CHANGED", "the active capture no longer owns the configured Probe", true);
    return { kind: "hss", token: owner.token, projectRoot: owner.projectRoot, targetGeneration: owner.targetGeneration };
  }

  private activeSession(projectRoot: string): HssSessionRecord | undefined {
    const matches = this.sessions().filter((session) => session.projectRoot === projectRoot && ACTIVE_SESSION_STATES.has(session.state));
    if (matches.length > 1) throw new HssOperationError("HSS_SESSION_STATE_INVALID", "multiple active captures exist for one projectRoot");
    return matches[0];
  }

  private selectSession(projectRoot: string, captureId?: string, activePreferred = false): HssSessionRecord {
    const matches = this.sessions().filter((session) => session.projectRoot === projectRoot && (!captureId || session.captureId === captureId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const selected = activePreferred ? matches.find((session) => ACTIVE_SESSION_STATES.has(session.state)) ?? matches[0] : matches[0];
    if (!selected) throw new HssOperationError("CAPTURE_NOT_FOUND", captureId ? `capture not found: ${captureId}` : "no HSS capture exists for this projectRoot");
    return selected;
  }

  private sessions(): HssSessionRecord[] {
    const entries = readdirSync(this.sessionsRoot, { withFileTypes: true });
    if (entries.length > 10_000) throw new HssOperationError("HSS_SESSION_LIMIT", "HSS session store exceeds 10,000 records");
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => this.readSession(entry.name.slice(0, -5)));
  }

  private readSession(captureId: string): HssSessionRecord {
    const file = this.sessionFile(captureId);
    const bytes = readFileSync(file, "utf8");
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new HssOperationError("HSS_SESSION_INVALID", "HSS session record exceeds 4 MiB");
    const value = JSON.parse(bytes) as HssSessionRecord;
    validateSession(value, captureId);
    return value;
  }

  private writeSession(session: HssSessionRecord): void {
    validateSession(session, session.captureId);
    const file = this.sessionFile(session.captureId);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      atomicReplaceSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private updateSession(captureId: string, update: (current: HssSessionRecord) => HssSessionRecord): HssSessionRecord {
    const next = update(this.readSession(captureId));
    this.writeSession(next);
    return this.readSession(captureId);
  }

  private sessionFile(captureId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(captureId)) throw new HssOperationError("CAPTURE_ID_INVALID", "captureId must be a UUID");
    return join(this.sessionsRoot, `${captureId}.json`);
  }

  private async captureExclusive<T>(captureId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.captureTails.get(captureId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveNext) => { release = resolveNext; });
    const tail = previous.then(() => next, () => next);
    this.captureTails.set(captureId, tail);
    await previous.catch(() => undefined);
    try {
      return await withDirectoryLease(join(this.sessionsRoot, ".locks", `${captureId}.lock`), operation, {
        timeoutMs: 30_000,
        errorCode: "CAPTURE_METADATA_BUSY",
      });
    }
    finally {
      release();
      if (this.captureTails.get(captureId) === tail) this.captureTails.delete(captureId);
    }
  }

  private async queryEnvelope(tool: string, operation: () => Promise<Record<string, unknown>>): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope(tool);
    envelope.requestedEffects = tool === "capture_index_rebuild"
      ? ["read_authoritative_capture", "build_temporary_capture_index", "atomically_publish_capture_db"]
      : tool === "capture_export_csv"
        ? ["read_bounded_capture_rows", "create_external_csv"]
        : tool === "analysis_run"
          ? ["read_bounded_capture_index", "persist_derived_analysis"]
        : ["read_bounded_capture_index"];
    try {
      envelope.data = await operation();
      const data = envelope.data as Record<string, unknown>;
      if (tool === "capture_index_rebuild") {
        if (data.indexStatus === "ready") envelope.observedEffects.push("capture_db_atomically_published", "raw_identities_revalidated");
        envelope.verification = { status: data.indexStatus === "ready" ? "verified" : "observed", method: "raw_identity_revalidation_and_sqlite_integrity_check" };
      } else if (tool === "capture_export_csv") {
        if (typeof data.exportFile === "string") {
          envelope.outputFiles.push(data.exportFile);
          envelope.observedEffects.push("external_csv_created");
        }
        envelope.verification = { status: typeof data.exportFile === "string" ? "verified" : "observed", method: "bounded_external_csv_export" };
      } else if (tool === "analysis_run") {
        if (typeof data.analysisRunId === "string") envelope.observedEffects.push("derived_analysis_persisted");
        envelope.verification = { status: typeof data.analysisRunId === "string" ? "verified" : "observed", method: "deterministic_bounded_jcap_analysis" };
      } else {
        envelope.verification = { status: "verified", method: "bounded_jcap_v1_query" };
      }
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(envelope, error, "query");
    }
  }

  private failure(envelope: OperationEnvelope, error: unknown, stage: string): OperationEnvelope {
    if (error instanceof HssOperationError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: error.retryable, writeIssued: error.writeIssued, stateUnknown: error.stateUnknown });
    if (error instanceof HssAdapterError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: error.retryable, writeIssued: false, stateUnknown: error.stateUnknown });
    if (error instanceof TargetStoreError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: false, writeIssued: false, stateUnknown: false });
    if (error instanceof MemorySessionError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: error.retryable, writeIssued: false, stateUnknown: error.stateUnknown });
    if (error instanceof ProbeQueueError) {
      attachQueueOwner(envelope, error);
      const code = queueFailureCode(error);
      return failEnvelope(envelope, { code, stage, message: error.message, retryable: code.endsWith("_ACTIVE"), writeIssued: false, stateUnknown: false });
    }
    const coded = error as { code?: unknown };
    return failEnvelope(envelope, { code: typeof coded?.code === "string" ? coded.code : "HSS_OPERATION_FAILED", stage, message: error instanceof Error ? error.message : String(error), retryable: false, writeIssued: false, stateUnknown: false });
  }
}

function queueFailureCode(error: ProbeQueueError): string {
  return error.code === "OWNER_CHANGED" && error.owner?.kind === "memory" ? "MEMORY_SESSION_ACTIVE" : error.code;
}

function attachQueueOwner(envelope: OperationEnvelope, error: ProbeQueueError): void {
  if (!error.owner) return;
  if (envelope.probe) envelope.probe.owner = error.owner;
  const before = envelope.before && typeof envelope.before === "object" && !Array.isArray(envelope.before)
    ? envelope.before as Record<string, unknown>
    : {};
  envelope.before = { ...before, owner: error.owner };
}

class HssOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly writeIssued = false,
    readonly stateUnknown = false,
    readonly captureEvidence?: { captureId: string; packageDir: string },
  ) {
    super(message);
    this.name = "HssOperationError";
  }
}

function blockCount(symbols: ResolvedSymbol[]): number {
  const sorted = [...symbols].sort((left, right) => left.address - right.address);
  let blocks = 0;
  let end = -1;
  for (const symbol of sorted) {
    if (symbol.address !== end) blocks += 1;
    end = symbol.address + symbol.size;
  }
  return blocks;
}

function frameLayout(prepared: PreparedCapture): {
  hssSampleHeaderBytes: number;
  valueBytes: number;
  hssSampleStrideBytes: number;
  values: Array<{ logicalIdentity: string; type: string; bytes: number }>;
} {
  const values = prepared.variables.map(({ descriptor, resolved }) => ({
    logicalIdentity: descriptor.logicalIdentity,
    type: descriptor.type,
    bytes: resolved.size,
  }));
  const valueBytes = values.reduce((total, value) => total + value.bytes, 0);
  const hssSampleHeaderBytes = 4;
  return { hssSampleHeaderBytes, valueBytes, hssSampleStrideBytes: hssSampleHeaderBytes + valueBytes, values };
}

export const isValidHssRunId = isValidAcceptanceRunId;

function applyQueue<T>(envelope: OperationEnvelope, execution: { queueSequence: number; queuedAt: string; startedAt: string; endedAt: string; value: T }): void {
  envelope.queueSequence = execution.queueSequence;
  envelope.timestamps.queuedAt = execution.queuedAt;
  envelope.timestamps.startedAt = execution.startedAt;
  envelope.timestamps.endedAt = execution.endedAt;
}

function captureSummary(session: HssSessionRecord): Record<string, unknown> {
  const result = session.result ?? {};
  const requestedSamples = Number.isSafeInteger(result.requestedSamples)
    ? Number(result.requestedSamples)
    : session.rateHz * session.durationSec;
  const sampleCount = Number.isSafeInteger(result.sampleCount) ? Number(result.sampleCount) : null;
  const sampleRatio = typeof result.sampleRatio === "number" && Number.isFinite(result.sampleRatio)
    ? result.sampleRatio
    : sampleCount !== null && requestedSamples > 0
      ? sampleCount / requestedSamples
      : null;
  return {
    captureId: session.captureId,
    state: session.state,
    packageDir: session.packageDir,
    requestedRateHz: session.rateHz,
    configuredInterface: session.configuredInterface ?? null,
    configuredSpeedKHz: session.configuredSpeedKHz ?? null,
    actualRateHz: typeof result.actualRateHz === "number" ? result.actualRateHz : null,
    requestedSamples,
    sampleCount,
    sampleRatio,
    sampleThresholdMet: typeof result.sampleThresholdMet === "boolean" ? result.sampleThresholdMet : null,
    readStatistics: {
      attempts: Number.isSafeInteger(result.readAttempts) ? result.readAttempts : null,
      emptyReads: Number.isSafeInteger(result.emptyReads) ? result.emptyReads : null,
      shortReads: Number.isSafeInteger(result.shortReads) ? result.shortReads : null,
      readErrors: Number.isSafeInteger(result.readErrors) ? result.readErrors : null,
      rawWriteTimeNsTotal: Number.isSafeInteger(result.rawWriteTimeNsTotal) ? result.rawWriteTimeNsTotal : null,
      rawWriteTimeNsMax: Number.isSafeInteger(result.rawWriteTimeNsMax) ? result.rawWriteTimeNsMax : null,
      rawWriteTimeNsAverage: typeof result.rawWriteTimeNsAverage === "number" ? result.rawWriteTimeNsAverage : null,
    },
    durationSec: session.durationSec,
    variables: session.descriptors.length,
    qualityOracle: session.qualityOracle ?? null,
  };
}

function linkRateDiagnostic(prepared: PreparedCapture): Record<string, unknown> {
  const payloadBytes = prepared.variables.reduce((sum, variable) => sum + variable.resolved.size, 0);
  const estimatedTransferBitsPerSample = 32 + prepared.variables.reduce((sum, variable) => sum + variable.resolved.size * 8 + 64, 0);
  const configuredBitsPerSecond = prepared.target.speed * 1_000;
  const estimatedUtilization = configuredBitsPerSecond > 0
    ? estimatedTransferBitsPerSample * prepared.rateHz / configuredBitsPerSecond
    : null;
  return {
    configuredInterface: prepared.target.interface,
    configuredSpeedKHz: prepared.target.speed,
    requestedRateHz: prepared.rateHz,
    variableCount: prepared.variables.length,
    payloadBytesPerSample: payloadBytes,
    estimatedTransferBitsPerSample,
    estimatedUtilization,
    estimateOnly: true,
    warning: estimatedUtilization !== null && estimatedUtilization > 0.5,
  };
}

function packageFiles(packageDir: string): string[] {
  return ["capture.json", join("raw", "samples.bin"), join("raw", "events.bin"), "capture.db"].map((file) => join(packageDir, file)).filter(existsSync);
}

function safeMetadata(packageDir: string): JcapV1Metadata | { error: string } {
  try { return readJcapV1Metadata(packageDir); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}

interface QualityEvidence {
  status: JcapV1Metadata["qualityStatus"];
  source: JcapV1Metadata["qualitySource"];
  counters: JcapV1Metadata["quality"];
  durationValidated: boolean | null;
  provenance: Record<string, unknown>;
  inferredDroppedBeforeSampleIndexes: number[];
}

function qualityEvidenceFrom(
  result: Record<string, unknown> | undefined,
  raw: ReturnType<typeof readJcapV1Raw> | undefined,
  oracle: PreparedQualityOracle | undefined,
  rateHz: number,
): QualityEvidence {
  const names = ["missingSamples", "droppedSamples", "overflows", "readErrors", "timeouts"] as const;
  const counters = Object.fromEntries(names.map((name) => [name, Number.isSafeInteger(result?.[name]) && Number(result?.[name]) >= 0 ? Number(result![name]) : null])) as JcapV1Metadata["quality"];
  const durationValidated = result?.durationValidated === true ? true : result?.durationValidated === false ? false : null;
  const provenance = result?.qualityEvidence && typeof result.qualityEvidence === "object" && !Array.isArray(result.qualityEvidence)
    ? sanitizeResult(result.qualityEvidence as Record<string, unknown>)
    : {};
  const rateDiagnostics = Object.fromEntries([
    "configuredInterface",
    "configuredSpeedKHz",
    "requestedRateHz",
    "actualRateHz",
    "sampleCount",
    "requestedSamples",
    "sampleRatio",
    "sampleThresholdMet",
    "readAttempts",
    "emptyReads",
    "shortReads",
    "readErrors",
    "rawWriteTimeNsTotal",
    "rawWriteTimeNsMax",
    "rawWriteTimeNsAverage",
  ].filter((name) => result?.[name] !== undefined).map((name) => [name, result![name]]));
  if (result?.qualitySource === "jlink" && result.qualityCountersValidated === true && names.every((name) => counters[name] !== null)) {
    return {
      status: "reported",
      source: "jlink",
      counters,
      durationValidated,
      provenance: { source: "jlink", countersValidated: true, ...rateDiagnostics, ...provenance },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  if (oracle) return targetCounterQualityEvidence(raw, oracle, durationValidated, rateHz);
  if (names.some((name) => counters[name] !== null)) {
    return {
      status: "partial",
      source: "jlink",
      counters,
      durationValidated,
      provenance: { source: "jlink", countersValidated: false, ...rateDiagnostics, ...provenance },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  return {
    status: "partial",
    source: "none",
    counters: { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
    durationValidated,
    provenance: { source: "none", reason: "no_qualified_quality_source" },
    inferredDroppedBeforeSampleIndexes: [],
  };
}

function targetCounterQualityEvidence(
  raw: ReturnType<typeof readJcapV1Raw> | undefined,
  oracle: PreparedQualityOracle,
  durationValidated: boolean | null,
  rateHz: number,
): QualityEvidence {
  const configuration = {
    logicalIdentity: oracle.logicalIdentity,
    expectedIncrement: oracle.expectedIncrement,
    tolerance: oracle.tolerance,
    modulus: oracle.modulus,
  };
  if (!raw) {
    return {
      status: "partial",
      source: "target_counter",
      counters: { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
      durationValidated,
      provenance: { source: "target_counter", configuration, diagnostic: "raw_unavailable" },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  const writeIntervals = raw.events.flatMap((event) => {
    if (event.type !== "variable_write" || event.logicalIdentity !== oracle.logicalIdentity) return [];
    const start = validTick(event.operationStartTick) ?? validTick(event.tick);
    const end = validTick(event.operationEndTick) ?? validTick(event.tick);
    return start !== undefined && end !== undefined ? [{ start: BigInt(start), end: BigInt(end) }] : [];
  });
  let evaluatedPairs = 0;
  let inferredMissedFrames = 0;
  let ambiguous = false;
  const diagnostics = new Set<string>();
  const inferredDroppedBeforeSampleIndexes: number[] = [];
  for (let index = 1; index < raw.samples.length; index += 1) {
    const previous = raw.samples[index - 1];
    const current = raw.samples[index];
    if (!oracleSampleIsValid(previous) || !oracleSampleIsValid(current)) {
      ambiguous = true;
      diagnostics.add("invalid_sample");
      continue;
    }
    const previousTick = BigInt(previous.tick);
    const currentTick = BigInt(current.tick);
    if (writeIntervals.some((interval) => interval.start <= currentTick && interval.end >= previousTick)) {
      ambiguous = true;
      diagnostics.add("write_interval");
      continue;
    }
    const previousValue = previous.values[oracle.logicalIdentity];
    const currentValue = current.values[oracle.logicalIdentity];
    if (!validCounterValue(previousValue, oracle.modulus) || !validCounterValue(currentValue, oracle.modulus)) {
      ambiguous = true;
      diagnostics.add("counter_value_invalid");
      continue;
    }
    if (currentValue < previousValue) {
      ambiguous = true;
      diagnostics.add("counter_wrap_or_reset_ambiguous");
      continue;
    }
    const delta = currentValue - previousValue;
    const frames = counterFrameCount(delta, oracle);
    if (!frames) {
      ambiguous = true;
      diagnostics.add(delta < oracle.expectedIncrement ? "counter_reset_or_nonadvancing" : "counter_delta_ambiguous");
      continue;
    }
    if (additionalModuloWrapCouldFit(delta, frames, previousTick, currentTick, oracle, rateHz)) {
      ambiguous = true;
      diagnostics.add("counter_modulo_alias_ambiguous");
      continue;
    }
    evaluatedPairs += 1;
    if (frames >= 2) {
      inferredMissedFrames += frames - 1;
      inferredDroppedBeforeSampleIndexes.push(current.sampleIndex);
    }
  }
  if (ambiguous || evaluatedPairs === 0) {
    return {
      status: "partial",
      source: "target_counter",
      counters: { missingSamples: null, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
      durationValidated,
      provenance: {
        source: "target_counter",
        configuration,
        evaluatedPairs,
        diagnostics: [...diagnostics].sort(),
      },
      inferredDroppedBeforeSampleIndexes: [],
    };
  }
  return {
    status: "reported",
    source: "target_counter",
    counters: { missingSamples: inferredMissedFrames, droppedSamples: null, overflows: null, readErrors: null, timeouts: null },
    durationValidated,
    provenance: {
      source: "target_counter",
      configuration,
      evaluatedPairs,
      inferredMissedFrames,
    },
    inferredDroppedBeforeSampleIndexes,
  };
}

function validTick(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+$/.test(value) ? value : undefined;
}

function validCounterValue(value: unknown, modulus: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < modulus;
}

function counterFrameCount(delta: number, oracle: PreparedQualityOracle): number | undefined {
  const candidates = counterFrameRange(delta, oracle);
  return candidates && candidates.minimumFrames === candidates.maximumFrames ? candidates.minimumFrames : undefined;
}

function counterFrameRange(
  delta: number,
  oracle: PreparedQualityOracle,
): { minimumFrames: number; maximumFrames: number } | undefined {
  if (delta < 1) return undefined;
  const minimumFrames = Math.max(1, Math.ceil((delta - oracle.tolerance) / oracle.expectedIncrement));
  const maximumFrames = Math.floor((delta + oracle.tolerance) / oracle.expectedIncrement);
  return minimumFrames <= maximumFrames ? { minimumFrames, maximumFrames } : undefined;
}

function additionalModuloWrapCouldFit(
  delta: number,
  frames: number,
  previousTick: bigint,
  currentTick: bigint,
  oracle: PreparedQualityOracle,
  rateHz: number,
): boolean {
  const wrappedCandidates = counterFrameRange(delta + oracle.modulus, oracle);
  if (!wrappedCandidates) return false;
  const minimumWrappedFrames = Math.max(wrappedCandidates.minimumFrames, frames + 1);
  if (minimumWrappedFrames > wrappedCandidates.maximumFrames) return false;
  if (!Number.isSafeInteger(rateHz) || rateHz < 1 || currentTick <= previousTick) return true;
  const elapsedFramesUpperBound = ((currentTick - previousTick) * BigInt(rateHz) + 999_999_999n) / 1_000_000_000n + 1n;
  return BigInt(minimumWrappedFrames) <= elapsedFramesUpperBound;
}

function oracleSampleIsValid(sample: { statusFlags: number }): boolean {
  const invalid = HSS_STATUS_FLAGS.read_error
    | HSS_STATUS_FLAGS.timeout
    | HSS_STATUS_FLAGS.overflow
    | HSS_STATUS_FLAGS.dropped_before_this_sample
    | HSS_STATUS_FLAGS.target_halted
    | HSS_STATUS_FLAGS.write_nearby
    | HSS_STATUS_FLAGS.write_in_progress
    | HSS_STATUS_FLAGS.backend_busy;
  return (sample.statusFlags & HSS_STATUS_FLAGS.valid) !== 0 && (sample.statusFlags & invalid) === 0;
}

function jcapTail(packageDir: string): { nextEventSequence: number; lastEventTick: string; lastSampleTick: string } {
  const raw = readJcapV1Raw(packageDir);
  if (raw.diagnostics.some((diagnostic) => diagnostic.file === "raw/events.bin")) throw new HssOperationError("JCAP_EVENTS_TAIL_INVALID", "cannot append after an incomplete, corrupt, or semantically invalid events journal tail");
  const lastEvent = raw.events.at(-1)!;
  const lastSample = raw.samples.at(-1);
  return { nextEventSequence: lastEvent.eventSequence + 1, lastEventTick: lastEvent.tick, lastSampleTick: lastSample?.tick ?? "0" };
}

function maxTick(...ticks: string[]): string {
  return ticks.map(BigInt).reduce((left, right) => left > right ? left : right, 0n).toString();
}

function elapsedTick(startedAt: string): string {
  const milliseconds = Math.max(0, Date.now() - Date.parse(startedAt));
  return (BigInt(milliseconds) * 1_000_000n).toString();
}

function qpcTick(session: HssSessionRecord, counter: unknown): string | undefined {
  if (typeof counter !== "string" || !/^\d+$/.test(counter)) return undefined;
  const current = BigInt(counter);
  const epoch = BigInt(session.qpcEpochCounter);
  const frequency = BigInt(session.qpcFrequency);
  if (current < epoch || frequency <= 0n) return undefined;
  return ((current - epoch) * 1_000_000_000n / frequency).toString();
}

function compare(actual: Buffer, expected: Buffer, comparator: NonObserveComparator): { pass: boolean; details: Record<string, unknown> } {
  if (comparator.mode === "exact") return { pass: actual.equals(expected), details: { mode: "exact", expectedHex: expected.toString("hex"), actualHex: actual.toString("hex") } };
  if (comparator.mode === "masked") {
    const mask = Buffer.from(comparator.maskHex, "hex");
    const pass = actual.length === expected.length && mask.length === expected.length && actual.every((value, index) => (value & mask[index]) === (expected[index] & mask[index]));
    return { pass, details: { mode: "masked", maskHex: comparator.maskHex, expectedHex: expected.toString("hex"), actualHex: actual.toString("hex") } };
  }
  const actualValue = decodeHssValue(comparator.type, actual, comparator.endian);
  const difference = Math.abs(actualValue - comparator.expected);
  const limit = comparator.absTolerance + comparator.relTolerance * Math.abs(comparator.expected);
  return { pass: difference <= limit, details: { mode: "tolerance", expected: comparator.expected, actual: actualValue, difference, limit, absTolerance: comparator.absTolerance, relTolerance: comparator.relTolerance } };
}

function numeric(bytes: Buffer, comparator: NonObserveComparator): number | undefined {
  return comparator.type && comparator.endian ? decodeHssValue(comparator.type, bytes, comparator.endian) : undefined;
}

function comparatorMethod(comparator: ScalarComparator): string {
  return comparator.mode === "observe" ? `observe:${comparator.comparator.mode}` : comparator.mode;
}

function requireMemoryOk(response: HssMemoryResponse, fallbackCode: string, writeIssued: boolean): void {
  if (response.status === "ok") return;
  throw new HssOperationError(
    response.errorCode ?? fallbackCode,
    response.reason ?? fallbackCode,
    false,
    writeIssued || response.writeIssued === true,
    response.stateUnknown === true,
  );
}

function normalizeHssError(error: Error, fallbackCode: string, writeIssued: boolean): HssOperationError {
  if (error instanceof HssOperationError) return error;
  if (error instanceof HssAdapterError) return new HssOperationError(error.code, error.message, error.retryable, error.currentRequestIssued, error.stateUnknown);
  return new HssOperationError(fallbackCode, error.message, false, writeIssued, writeIssued);
}

function sanitizeResult(result: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(result);
  delete copy.dll;
  delete copy.jlinkScriptFile;
  delete copy.jlinkScriptExecOutput;
  return copy;
}

function errorCode(error: unknown, fallback: string): string {
  return typeof (error as { code?: unknown })?.code === "string" ? String((error as { code: string }).code) : fallback;
}

function validateSession(value: HssSessionRecord, captureId: string): void {
  const provisional = value?.state === "starting" || value?.state === "failed";
  if (!value || value.formatVersion !== 1 || value.captureId !== captureId || !value.projectRoot || !value.targetGeneration || !value.probeSerial || !ACTIVE_SESSION_STATES.has(value.state) && !TERMINAL_SESSION_STATES.has(value.state) || !value.packageDir || !value.sessionDir
    || !value.control || !value.control.planPath || !value.control.pidFile || !value.control.readyFile || !value.control.stdoutPath || !value.control.stderrPath || !value.control.stopFile || !value.control.requestFile || !value.control.claimFile || !value.control.responseFile
    || !Number.isSafeInteger(value.helperPid) || value.helperPid < 0 || !provisional && value.helperPid < 1 || !value.ownerToken || !provisional && value.ownerToken === "pending"
    || !UUID.test(value.helperNonce) || !/^\d+$/.test(value.qpcEpochCounter) || !/^\d+$/.test(value.qpcFrequency) || BigInt(value.qpcFrequency) < 1n || !Array.isArray(value.descriptors)
    || value.writeDescriptors !== undefined && !Array.isArray(value.writeDescriptors)
    || value.qualityOracle !== undefined && (!value.qualityOracle.logicalIdentity || !Number.isSafeInteger(value.qualityOracle.expectedIncrement) || value.qualityOracle.expectedIncrement < 1
      || !Number.isSafeInteger(value.qualityOracle.tolerance) || value.qualityOracle.tolerance < 0 || !Number.isSafeInteger(value.qualityOracle.modulus) || value.qualityOracle.modulus < 2
      || value.qualityOracle.expectedIncrement + value.qualityOracle.tolerance >= value.qualityOracle.modulus)) throw new HssOperationError("HSS_SESSION_INVALID", `invalid HSS session record: ${basename(captureId)}`);
}

function hexAddress(address: number): string {
  return `0x${address.toString(16).padStart(8, "0")}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
