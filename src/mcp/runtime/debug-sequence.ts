import { performance } from "node:perf_hooks";
import { symbolLogicalIdentity, type ResolvedSymbol } from "../artifact/symbol-catalog";
import { encodeHssValue } from "../hss/hss-typed-value";
import type { HssCaptureInput } from "./hss-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./operation-envelope";
import type { VariableAccess, VariableRefInput } from "./variable-access-contract";

export type DebugSequenceStep =
  | ({ atMs: number; action: "hss_start" } & Omit<HssCaptureInput, "projectRoot" | "dryRun" | "runId">)
  | { atMs: number; action: "write_variable"; ref: VariableRefInput; value: number; captureOld?: boolean; verify?: boolean; restore?: boolean }
  | { atMs: number; action: "read_variable"; ref: VariableRefInput }
  | { atMs: number; action: "hss_stop" };

export type DebugSequenceCleanup =
  | { action: "restore_variable"; ref: VariableRefInput; value: number }
  | { action: "hss_stop" };

export interface DebugSequenceInput {
  projectRoot: string;
  steps: DebugSequenceStep[];
  cleanup?: DebugSequenceCleanup[];
  timeoutMs?: number;
}

export interface DebugSequenceVariableAccess extends Pick<VariableAccess, "readVariable" | "writeVariable"> {
  resolveVariable(projectRoot: string, ref: VariableRefInput): Promise<{
    resolved: Pick<ResolvedSymbol, "ref" | "region" | "type" | "endian">;
  }>;
}

export interface DebugSequenceHssOperations {
  plan(input: HssCaptureInput): Promise<OperationEnvelope>;
  start(input: HssCaptureInput): Promise<OperationEnvelope>;
  stop(input: { projectRoot: string; captureId?: string }): Promise<OperationEnvelope>;
}

export interface DebugSequenceScheduler {
  now(): number;
  wait(delayMs: number, signal?: AbortSignal): Promise<void>;
}

interface StepResult {
  index: number;
  action: DebugSequenceStep["action"];
  plannedAtMs: number;
  actualAtMs: number;
  delayMs: number;
  queueDelayMs: number;
  durationMs: number;
  ok: boolean;
  result: Record<string, unknown>;
}

interface SequenceCaptureState {
  activeId?: string;
  createdIds: string[];
}

interface PlannedCaptureInterval {
  descriptors: Set<string>;
  startIndex: number;
  stopIndex?: number;
}

const defaultScheduler: DebugSequenceScheduler = {
  now: () => performance.now(),
  wait: (delayMs, signal) => abortableDelay(delayMs, signal),
};

export class DebugSequenceExecutor {
  constructor(
    private readonly variables: DebugSequenceVariableAccess,
    private readonly hss: DebugSequenceHssOperations,
    private readonly scheduler: DebugSequenceScheduler = defaultScheduler,
  ) {}

  async execute(input: DebugSequenceInput, signal?: AbortSignal): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("debug_sequence_execute");
    let plannedDurationMs = 0;
    let timeoutMs = 0;
    try {
      ({ plannedDurationMs, timeoutMs } = await this.preflight(input));
    } catch (error) {
      return failEnvelope(envelope, sequenceError("DEBUG_SEQUENCE_INVALID", "preflight", error));
    }

    envelope.requestedEffects = ["execute_timed_debug_sequence"];
    const executionStartedAt = this.scheduler.now();
    const deadline = executionStartedAt + timeoutMs;
    const leadingHssBootstrap = input.steps[0]?.action === "hss_start" && input.steps[0].atMs === 0;
    let timelineEpoch = executionStartedAt;
    let setupDurationMs = 0;
    let previousCompletedAt = executionStartedAt;
    const steps: StepResult[] = [];
    const cleanup: Array<{ action: DebugSequenceCleanup["action"]; automatic?: boolean; ok: boolean; result: Record<string, unknown> }> = [];
    const captures: SequenceCaptureState = { createdIds: [] };
    const possiblyWrittenRefs = new Set<string>();
    let failure: { code: string; message: string; state: "failed" | "timed_out" | "cancelled" } | undefined;
    let failedStepStateUnknown = false;

    for (let index = 0; index < input.steps.length; index += 1) {
      const step = input.steps[index];
      try {
        this.assertCanContinue(signal, deadline);
        const targetAt = timelineEpoch + step.atMs;
        if (targetAt > deadline) throw new DebugSequenceError("DEBUG_SEQUENCE_TIMEOUT", "sequence deadline occurs before the next planned step");
        const previousStep = input.steps[index - 1];
        if (previousStep && step.atMs > previousStep.atMs && previousCompletedAt > targetAt) {
          throw new DebugSequenceError(
            "DEBUG_SEQUENCE_SCHEDULE_OVERRUN",
            `the previous operation completed after the ${step.atMs} ms schedule point`,
          );
        }
        await this.scheduler.wait(Math.max(0, targetAt - this.scheduler.now()), signal);
        this.assertCanContinue(signal, deadline);
      } catch (error) {
        failure = classifySequenceFailure(error);
        break;
      }

      const dispatchedAt = this.scheduler.now();
      let result: OperationEnvelope;
      try {
        result = await this.executeStep(input.projectRoot, step, captures);
      } catch (error) {
        result = failEnvelope(createOperationEnvelope(step.action), sequenceError("DEBUG_SEQUENCE_STEP_FAILED", "dispatch", error));
      }
      if (step.action === "write_variable" && (
        result.ok
        || result.error?.writeIssued === true
        || result.error?.stateUnknown === true
      )) {
        possiblyWrittenRefs.add(refKey(step.ref));
      }
      const completedAt = this.scheduler.now();
      const stepTimelineEpoch = timelineEpoch;
      steps.push({
        index,
        action: step.action,
        plannedAtMs: step.atMs,
        actualAtMs: Math.max(0, Math.round(dispatchedAt - stepTimelineEpoch)),
        delayMs: Math.max(0, Math.round(dispatchedAt - stepTimelineEpoch - step.atMs)),
        queueDelayMs: queueDelayMs(result),
        durationMs: Math.max(0, Math.round(completedAt - dispatchedAt)),
        ok: result.ok,
        result: boundedResult(result),
      });
      if (!result.ok) {
        failedStepStateUnknown = result.error?.stateUnknown === true;
        failure = {
          code: "DEBUG_SEQUENCE_STEP_FAILED",
          message: `${step.action} failed: ${result.error?.code ?? "UNKNOWN_ERROR"} ${result.error?.message ?? ""}`.trim(),
          state: "failed",
        };
        break;
      }
      if (leadingHssBootstrap && index === 0) {
        timelineEpoch = completedAt;
        setupDurationMs = Math.max(0, Math.round(completedAt - executionStartedAt));
      }
      previousCompletedAt = completedAt;
      try {
        this.assertCanContinue(signal, deadline);
      } catch (error) {
        failure = classifySequenceFailure(error);
        break;
      }
    }

    if (failure) {
      for (const action of input.cleanup ?? []) {
        const result = await this.executeCleanup(input.projectRoot, action, captures, possiblyWrittenRefs);
        cleanup.push({ action: action.action, ok: result.ok, result: boundedResult(result) });
      }
      if (captures.activeId) {
        const result = await this.executeCleanup(input.projectRoot, { action: "hss_stop" }, captures, possiblyWrittenRefs);
        cleanup.push({ action: "hss_stop", automatic: true, ok: result.ok, result: boundedResult(result) });
      }
    }

    const actualDurationMs = Math.max(0, Math.round(this.scheduler.now() - executionStartedAt));
    envelope.data = {
      state: failure?.state ?? "completed",
      plannedDurationMs,
      actualDurationMs,
      setupDurationMs,
      timelineAnchor: leadingHssBootstrap ? "hss_ready" : "sequence_start",
      timeoutMs,
      steps,
      cleanup,
      createdCaptureIds: captures.createdIds,
    };
    envelope.observedEffects = steps.filter(({ ok }) => ok).map(({ action }) => `sequence_${action}_completed`);
    if (cleanup.length > 0) envelope.observedEffects.push("sequence_cleanup_executed");
    envelope.verification = {
      status: failure ? "failed" : "observed",
      method: "monotonic_absolute_schedule_and_operation_envelopes",
    };
    if (failure) {
      return failEnvelope(envelope, {
        code: failure.code,
        stage: "sequence",
        message: failure.message,
        retryable: false,
        writeIssued: steps.some(({ result }) => result.error && (result.error as { writeIssued?: unknown }).writeIssued === true)
          || envelope.observedEffects.some((effect) => effect.includes("write_variable")),
        stateUnknown: failedStepStateUnknown || cleanup.some(({ ok }) => !ok),
      });
    }
    return finishEnvelope(envelope, true);
  }

  private async preflight(input: DebugSequenceInput): Promise<{ plannedDurationMs: number; timeoutMs: number }> {
    if (!input.projectRoot) throw new Error("projectRoot is required");
    if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 32) throw new Error("steps must contain 2..32 actions");
    if (!Array.isArray(input.cleanup ?? []) || (input.cleanup?.length ?? 0) > 4) throw new Error("cleanup must contain at most 4 actions");
    let previousAt = -1;
    let activeCapturePlanned = false;
    let activeCaptureDescriptors: Set<string> | undefined;
    let activeCaptureInterval: PlannedCaptureInterval | undefined;
    const captureIntervals: PlannedCaptureInterval[] = [];
    const firstWriteIndex = new Map<string, number>();
    for (let index = 0; index < input.steps.length; index += 1) {
      const step = input.steps[index];
      if (!Number.isSafeInteger(step.atMs) || step.atMs < 0 || step.atMs > 30_000 || step.atMs < previousAt) throw new Error("step atMs values must be monotonic safe integers within 0..30000");
      previousAt = step.atMs;
      if (step.action === "hss_start") {
        if (activeCapturePlanned) throw new Error("a sequence cannot start another HSS capture before stopping its own capture");
        const planned = await this.hss.plan({ projectRoot: input.projectRoot, ...captureInput(step) });
        if (!planned.ok) throw new Error(`hss_start preflight failed: ${planned.error?.code ?? "UNKNOWN_ERROR"} ${planned.error?.message ?? ""}`.trim());
        activeCapturePlanned = true;
        activeCaptureDescriptors = plannedDescriptorIdentities(planned);
        activeCaptureInterval = { descriptors: activeCaptureDescriptors, startIndex: index };
        captureIntervals.push(activeCaptureInterval);
      } else if (step.action === "hss_stop") {
        if (!activeCapturePlanned) throw new Error("hss_stop requires a preceding sequence hss_start");
        if (activeCaptureInterval) activeCaptureInterval.stopIndex = index;
        activeCapturePlanned = false;
        activeCaptureDescriptors = undefined;
        activeCaptureInterval = undefined;
      } else {
        const { resolved } = await this.variables.resolveVariable(input.projectRoot, step.ref);
        const identity = symbolLogicalIdentity(resolved.ref);
        if (activeCaptureDescriptors && !activeCaptureDescriptors.has(identity)) {
          throw new Error(`${identity} is not declared by the active immutable HSS descriptor set`);
        }
        if (step.action === "write_variable") {
          if (resolved.region !== "ram") throw new Error("write_variable requires a typed RAM variable");
          encodeHssValue(resolved.type, step.value, resolved.endian);
          if (!firstWriteIndex.has(refKey(step.ref))) firstWriteIndex.set(refKey(step.ref), index);
        }
      }
    }
    for (const action of input.cleanup ?? []) {
      if (action.action === "restore_variable") {
        const resolved = await this.variables.resolveVariable(input.projectRoot, action.ref);
        if (resolved.resolved.region !== "ram") throw new Error("cleanup restore_variable requires a typed RAM variable");
        encodeHssValue(resolved.resolved.type, action.value, resolved.resolved.endian);
        const earliestWrite = firstWriteIndex.get(refKey(action.ref));
        if (earliestWrite !== undefined) {
          const identity = symbolLogicalIdentity(resolved.resolved.ref);
          for (const interval of captureIntervals) {
            if ((interval.stopIndex ?? Number.POSITIVE_INFINITY) < earliestWrite) continue;
            if (!interval.descriptors.has(identity)) {
              throw new Error(`cleanup restore ${identity} is incompatible with a reachable immutable HSS descriptor set`);
            }
          }
        }
      }
    }
    const plannedDurationMs = input.steps.at(-1)!.atMs;
    if (plannedDurationMs < 1_000 || plannedDurationMs > 30_000) throw new Error("the planned sequence duration must be 1000..30000 ms");
    const leadingHssBootstrap = input.steps[0]?.action === "hss_start" && input.steps[0].atMs === 0;
    const timeoutMs = input.timeoutMs ?? Math.min(60_000, plannedDurationMs + (leadingHssBootstrap ? 30_000 : 10_000));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < plannedDurationMs || timeoutMs > 60_000) throw new Error("timeoutMs must cover the planned duration and be at most 60000 ms");
    return { plannedDurationMs, timeoutMs };
  }

  private async executeStep(projectRoot: string, step: DebugSequenceStep, captures: SequenceCaptureState): Promise<OperationEnvelope> {
    switch (step.action) {
      case "hss_start": {
        const result = await this.hss.start({ projectRoot, ...captureInput(step) });
        const captureId = isRecord(result.data) && typeof result.data.captureId === "string" ? result.data.captureId : undefined;
        if (result.ok && !captureId) return failEnvelope(result, sequenceError("DEBUG_SEQUENCE_CAPTURE_ID_MISSING", "hss_start", new Error("hss_start returned no captureId")));
        if (captureId) {
          captures.createdIds.push(captureId);
          captures.activeId = captureId;
        }
        return result;
      }
      case "write_variable":
        return this.variables.writeVariable({
          projectRoot,
          ref: step.ref,
          value: step.value,
          captureOld: step.captureOld,
          verify: step.verify ?? true,
          restore: step.restore,
        });
      case "read_variable":
        return this.variables.readVariable(projectRoot, step.ref);
      case "hss_stop": {
        const captureId = captures.activeId;
        if (!captureId) return failEnvelope(createOperationEnvelope("hss_stop"), sequenceError("DEBUG_SEQUENCE_CAPTURE_MISSING", "hss_stop", new Error("no sequence-created HSS capture is available")));
        const result = await this.hss.stop({ projectRoot, captureId });
        if (result.ok) captures.activeId = undefined;
        return result;
      }
    }
  }

  private async executeCleanup(
    projectRoot: string,
    action: DebugSequenceCleanup,
    captures: SequenceCaptureState,
    possiblyWrittenRefs: ReadonlySet<string>,
  ): Promise<OperationEnvelope> {
    try {
      if (action.action === "restore_variable") {
        if (!possiblyWrittenRefs.has(refKey(action.ref))) {
          const skipped = createOperationEnvelope("restore_variable");
          skipped.data = { skipped: true, reason: "matching_sequence_write_not_issued" };
          return finishEnvelope(skipped, true);
        }
        return await this.variables.writeVariable({
          projectRoot,
          ref: action.ref,
          value: action.value,
          captureOld: false,
          verify: true,
          restore: false,
        });
      }
      const captureId = captures.activeId;
      if (!captureId) return finishEnvelope(createOperationEnvelope("hss_stop"), true);
      const result = await this.hss.stop({ projectRoot, captureId });
      if (result.ok) captures.activeId = undefined;
      return result;
    } catch (error) {
      return failEnvelope(createOperationEnvelope(action.action), sequenceError("DEBUG_SEQUENCE_CLEANUP_FAILED", "cleanup", error));
    }
  }

  private assertCanContinue(signal: AbortSignal | undefined, deadline: number): void {
    if (signal?.aborted) throw new DebugSequenceError("DEBUG_SEQUENCE_CANCELLED", "the MCP client cancelled the debug sequence");
    if (this.scheduler.now() > deadline) throw new DebugSequenceError("DEBUG_SEQUENCE_TIMEOUT", "the debug sequence exceeded timeoutMs");
  }
}

class DebugSequenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function captureInput(step: Extract<DebugSequenceStep, { action: "hss_start" }>): Omit<HssCaptureInput, "projectRoot"> {
  return {
    variables: step.variables,
    writeVariables: step.writeVariables,
    rateHz: step.rateHz,
    durationSec: step.durationSec,
    qualityOracle: step.qualityOracle,
  };
}

function classifySequenceFailure(error: unknown): { code: string; message: string; state: "failed" | "timed_out" | "cancelled" } {
  if (error instanceof DebugSequenceError && error.code === "DEBUG_SEQUENCE_CANCELLED") return { code: error.code, message: error.message, state: "cancelled" };
  if (error instanceof DebugSequenceError && error.code === "DEBUG_SEQUENCE_TIMEOUT") return { code: error.code, message: error.message, state: "timed_out" };
  if (error instanceof DebugSequenceError && error.code === "DEBUG_SEQUENCE_SCHEDULE_OVERRUN") return { code: error.code, message: error.message, state: "failed" };
  return { code: "DEBUG_SEQUENCE_STEP_FAILED", message: error instanceof Error ? error.message : String(error), state: "failed" };
}

function sequenceError(code: string, stage: string, error: unknown): {
  code: string;
  stage: string;
  message: string;
  retryable: boolean;
  writeIssued: boolean;
  stateUnknown: boolean;
} {
  return {
    code,
    stage,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    writeIssued: false,
    stateUnknown: false,
  };
}

function queueDelayMs(envelope: OperationEnvelope): number {
  const queuedAt = envelope.timestamps.queuedAt;
  const startedAt = envelope.timestamps.startedAt;
  if (!queuedAt || !startedAt) return 0;
  const queued = Date.parse(queuedAt);
  const started = Date.parse(startedAt);
  return Number.isFinite(queued) && Number.isFinite(started) ? Math.max(0, started - queued) : 0;
}

function boundedResult(envelope: OperationEnvelope): Record<string, unknown> {
  return {
    ok: envelope.ok,
    error: envelope.error ?? null,
    verification: envelope.verification ?? null,
    data: envelope.data ?? null,
    capture: envelope.capture ?? null,
  };
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return signal?.aborted ? Promise.reject(signal.reason ?? new Error("cancelled")) : Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function plannedDescriptorIdentities(envelope: OperationEnvelope): Set<string> {
  if (!isRecord(envelope.data)) throw new Error("hss_start preflight returned no descriptor data");
  const descriptors = [...descriptorArray(envelope.data.variables), ...descriptorArray(envelope.data.writeVariables)];
  if (descriptors.length === 0) throw new Error("hss_start preflight returned an empty descriptor set");
  return new Set(descriptors.map(({ logicalIdentity }) => logicalIdentity));
}

function descriptorArray(value: unknown): Array<{ logicalIdentity: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is { logicalIdentity: string } => isRecord(entry) && typeof entry.logicalIdentity === "string");
}

function refKey(ref: VariableRefInput): string {
  return typeof ref === "string" ? ref : JSON.stringify(ref);
}
