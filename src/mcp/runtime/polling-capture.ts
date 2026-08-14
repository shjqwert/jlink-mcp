import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProbeBackend } from "../../probe/backend";
import { decodeHssValue } from "../hss/hss-typed-value";
import {
  appendJcapV1Event,
  createJcapV1Metadata,
  finalizeJcapV1Metadata,
  finalizeJcapV2FromV1Package,
  JcapV1Writer,
  readJcapV1Raw,
  type JcapV1CaptureState,
  type JcapV1VariableDescriptor,
} from "../jcap/jcap-v1";
import { decodeProbeMemoryBytes } from "./direct-operations";
import type { HssCapabilityFacts, HssCaptureControlFiles, HssRuntimeFacts } from "./hss-helper-adapter";
import { HssSessionStore, isActiveHssSessionState, type HssSessionRecord } from "./hss-session-store";
import { selectMemorySessionAttachDevice, type MemorySessionManager, type MemorySessionReleaseIdentity } from "./memory-session";
import { ProbeQueue } from "./probe-queue";
import { TargetStore, type StoredTarget } from "./target-store";
import type { ResolvedSymbol } from "../artifact/symbol-catalog";
import type { OperationEnvelope } from "./operation-envelope";
import type { CaptureExternalWriteToken, VariableWriteInput } from "./variable-access-contract";

export type PollingCaptureBackend = "background_poll" | "stop_poll";

export interface PollingCaptureVariable {
  descriptor: JcapV1VariableDescriptor;
  resolved: ResolvedSymbol;
}

export interface PollingCaptureStartInput {
  target: StoredTarget;
  variables: PollingCaptureVariable[];
  writeDescriptors: JcapV1VariableDescriptor[];
  rateHz: number;
  durationSec: number;
  runId?: string;
  runtime: HssRuntimeFacts;
  capability: HssCapabilityFacts;
  fallbackCode: string;
  fallbackReason: string;
  initialBackend?: PollingCaptureBackend;
}

interface PollingJob {
  captureId: string;
  input: PollingCaptureStartInput;
  writer: JcapV1Writer;
  startedNs: bigint;
  stopRequested: boolean;
  backend: PollingCaptureBackend;
  pauseTotalUs: number;
  sampleCount: number;
  missingSamples: number;
  readErrors: number;
  timeouts: number;
  eventSequence: number;
  externalOperations: number;
  acceptingExternalWrites: boolean;
  promise: Promise<void>;
}

export class PollingCaptureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly stateUnknown = false,
    readonly writeIssued = false,
  ) {
    super(message);
    this.name = "PollingCaptureError";
  }
}

export class PollingCaptureRunner {
  private readonly jobs = new Map<string, PollingJob>();

  constructor(
    private readonly targets: TargetStore,
    private readonly queue: ProbeQueue,
    private readonly memorySessions: MemorySessionManager,
    private readonly sessions: HssSessionStore,
    private readonly outputRoot: string,
  ) {}

  isPollingSession(session: HssSessionRecord): boolean {
    return session.backend === "background_poll" || session.backend === "stop_poll";
  }

  isActive(captureId: string): boolean {
    return this.jobs.has(captureId);
  }

  beginExternalWrite(captureId: string, logicalIdentity: string): CaptureExternalWriteToken {
    const job = this.jobs.get(captureId);
    if (!job || !job.acceptingExternalWrites) {
      throw new PollingCaptureError("CAPTURE_NOT_WRITABLE", "polling capture is no longer accepting write events", true);
    }
    job.externalOperations += 1;
    return {
      captureId,
      logicalIdentity,
      operationId: randomUUID(),
      startedAt: new Date().toISOString(),
      operationStartTick: (process.hrtime.bigint() - job.startedNs).toString(),
    };
  }

  async recordExternalWrite(
    token: CaptureExternalWriteToken,
    input: VariableWriteInput,
    resolved: ResolvedSymbol,
    requested: Buffer,
    envelope: OperationEnvelope,
  ): Promise<void> {
    const job = this.jobs.get(token.captureId);
    if (!job) throw new PollingCaptureError("CAPTURE_EVENT_PERSIST_FAILED", "polling capture ended before its write event was recorded", false, envelope.error?.stateUnknown === true);
    try {
      const descriptor = [...job.input.variables.map(({ descriptor }) => descriptor), ...job.input.writeDescriptors]
        .find((candidate) => candidate.logicalIdentity === token.logicalIdentity);
      if (!descriptor) throw new PollingCaptureError("VARIABLE_NOT_IN_CAPTURE", "write event does not match a declared polling-capture descriptor");
      const data = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
        ? envelope.data as Record<string, unknown>
        : {};
      const restoreData = data.restore && typeof data.restore === "object" && !Array.isArray(data.restore)
        ? data.restore as Record<string, unknown>
        : {};
      const scalar = (hex: unknown): number | null => {
        if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
        try { return decodeHssValue(resolved.type, Buffer.from(hex, "hex"), resolved.endian); }
        catch { return null; }
      };
      const oldHex = typeof data.oldHex === "string" ? data.oldHex : null;
      const readbackHex = typeof data.readbackHex === "string"
        ? data.readbackHex
        : typeof data.transactionReadbackHex === "string" ? data.transactionReadbackHex : null;
      const restoreReadbackHex = typeof restoreData.readbackHex === "string"
        ? restoreData.readbackHex
        : typeof restoreData.transactionReadbackHex === "string" ? restoreData.transactionReadbackHex : null;
      const writeIssued = envelope.ok
        || envelope.error?.writeIssued === true
        || envelope.observedEffects.includes("structured_memory_write_issued");
      const stateUnknown = envelope.error?.stateUnknown === true;
      const writeAttempted = writeIssued || Boolean(envelope.error && [
        "write", "verification", "readback", "post_connection_readback", "restore",
        "restore_write", "restore_readback", "post_connection_restore_readback", "final_observation",
      ].includes(envelope.error.stage));
      const restoreAttempted = Boolean(input.restore && writeIssued);
      const restoreStatus = typeof restoreData.status === "string" ? restoreData.status : "not_requested";
      const restoreWriteIssued = restoreAttempted && (
        envelope.observedEffects.includes("structured_restore_write_issued")
        || restoreStatus === "verified"
        || restoreData.command !== undefined
      );
      const restoreState = !input.restore
        ? "not_requested"
        : !writeIssued ? "not_needed"
          : restoreStatus === "verified" && restoreReadbackHex ? "restored" : "failed";
      const verificationState = stateUnknown
        ? "state_unknown"
        : envelope.verification.status === "verified" ? "verified"
          : envelope.verification.status === "executed_unverified" ? "executed_unverified"
            : writeIssued || writeAttempted ? "failed" : "not_executed";
      const operationEndTick = (process.hrtime.bigint() - job.startedNs).toString();
      const eventError = envelope.ok ? null : {
        code: envelope.error?.code ?? "VARIABLE_WRITE_FAILED",
        message: envelope.error?.message ?? "variable write failed",
        writeIssued,
        stateUnknown,
      };
      job.writer.appendEvent({
        eventId: randomUUID(),
        eventSequence: job.eventSequence++,
        type: "variable_write",
        logicalIdentity: token.logicalIdentity,
        selector: token.logicalIdentity,
        descriptor,
        startedAt: token.startedAt,
        endedAt: new Date().toISOString(),
        tick: operationEndTick,
        operationStartTick: token.operationStartTick,
        operationEndTick,
        timingSource: "controller_fallback",
        helperOperationStartTick: null,
        helperOperationEndTick: null,
        timingDegraded: true,
        operationId: token.operationId,
        ipcRequestIds: [],
        writeAttempted,
        writeIssued,
        stateUnknown,
        requested: { value: input.value, bytesHex: requested.toString("hex") },
        old: oldHex ? { state: "captured", value: scalar(oldHex), bytesHex: oldHex }
          : { state: input.captureOld || input.restore ? "failed" : "not_requested", value: null, bytesHex: null },
        readback: readbackHex ? { state: "observed", value: scalar(readbackHex), bytesHex: readbackHex }
          : { state: input.verify ? "failed" : "not_requested", value: null, bytesHex: null },
        verification: { state: verificationState },
        restore: {
          state: restoreState,
          attempted: restoreAttempted,
          writeIssued: restoreWriteIssued,
          stateUnknown: Boolean(restoreAttempted && stateUnknown && restoreState === "failed"),
          readback: restoreReadbackHex ? scalar(restoreReadbackHex) : null,
          readbackHex: restoreReadbackHex,
        },
        sampleAlignment: { method: "terminal_raw_nearest", status: "derive_on_rebuild" },
        outcome: restoreState === "failed" ? "restore_failed" : envelope.ok ? "completed" : "failed",
        error: eventError,
      });
      job.writer.syncEvents();
    } finally {
      job.externalOperations = Math.max(0, job.externalOperations - 1);
    }
  }

  async controlTarget(captureId: string, requestedAction: "resume" | "continue"): Promise<{
    beforeState: "running" | "halted" | "unknown";
    afterState: "running" | "halted" | "unknown";
    noOp: boolean;
    controlIssued: boolean;
  }> {
    const job = this.jobs.get(captureId);
    if (!job || !job.acceptingExternalWrites) {
      throw new PollingCaptureError("CAPTURE_NOT_WRITABLE", "polling capture is no longer accepting target-control events", true);
    }
    job.externalOperations += 1;
    const operationId = randomUUID();
    const startedAt = new Date().toISOString();
    const operationStartTick = (process.hrtime.bigint() - job.startedNs).toString();
    let beforeState: "running" | "halted" | "unknown" = "unknown";
    let afterState: "running" | "halted" | "unknown" = "unknown";
    let controlAttempted = false;
    let controlIssued = false;
    let stateUnknown = false;
    let operationError: PollingCaptureError | undefined;
    try {
      try {
        await this.withProbe(job, async (probe) => {
          const before = await probe.observeTargetState();
          beforeState = before.state;
          if (before.state === "unknown") throw commandError(before.result, "TARGET_STATE_UNKNOWN", "target state is unknown before capture control", true);
          if (before.state === "halted") {
            controlAttempted = true;
            const resumed = await probe.resume();
            controlIssued = resumed.writeIssued ?? resumed.success;
            stateUnknown = resumed.stateUnknown === true;
            if (!resumed.success) throw commandError(resumed, "POLLING_TARGET_RESUME_FAILED", "polling capture could not resume the target", controlIssued);
          }
          const after = await probe.observeTargetState();
          afterState = after.state;
          if (after.state !== "running") {
            stateUnknown = after.state === "unknown" || controlIssued;
            throw commandError(after.result, "POLLING_TARGET_RESUME_UNCONFIRMED", "target running state could not be confirmed", stateUnknown);
          }
        });
      } catch (error) {
        operationError = normalizePollingError(error, "POLLING_TARGET_CONTROL_FAILED", stateUnknown);
        stateUnknown ||= operationError.stateUnknown;
        if (controlIssued && !operationError.writeIssued) {
          operationError = new PollingCaptureError(
            operationError.code,
            operationError.message,
            operationError.retryable,
            stateUnknown,
            true,
          );
        }
      }
      const operationEndTick = (process.hrtime.bigint() - job.startedNs).toString();
      try {
        job.writer.appendEvent({
          eventId: randomUUID(),
          eventSequence: job.eventSequence++,
          type: "target_control",
          action: "resume",
          requestedAction,
          startedAt,
          endedAt: new Date().toISOString(),
          tick: operationEndTick,
          operationStartTick,
          operationEndTick,
          timingSource: "controller_fallback",
          helperOperationStartTick: null,
          helperOperationEndTick: null,
          timingDegraded: true,
          controlAttempted,
          controlIssued,
          resumeIssued: controlIssued,
          stateUnknown,
          operationId,
          ipcRequestIds: [],
          beforeState,
          afterState,
          outcome: operationError ? "failed" : "completed",
          error: operationError ? {
            code: operationError.code,
            message: operationError.message,
            controlIssued,
            stateUnknown,
          } : null,
        });
        job.writer.syncEvents();
      } catch (error) {
        throw new PollingCaptureError(
          "CAPTURE_EVENT_PERSIST_FAILED",
          `target-control event could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          false,
          stateUnknown,
          controlIssued,
        );
      }
      if (operationError) throw operationError;
      return { beforeState, afterState, noOp: !controlAttempted, controlIssued };
    } finally {
      job.externalOperations = Math.max(0, job.externalOperations - 1);
    }
  }

  async start(input: PollingCaptureStartInput): Promise<HssSessionRecord> {
    const target = this.targets.requireCurrent(input.target);
    if (!target.gdbDevice?.trim()) {
      throw new PollingCaptureError(
        "MEMORY_ATTACH_PROFILE_REQUIRED",
        "polling capture requires an explicit runtime attach profile (gdbDevice)",
        false,
        false,
      );
    }
    const active = this.sessions.active(target.projectRoot);
    if (active) throw new PollingCaptureError("CAPTURE_ACTIVE", `capture ${active.captureId} is already active for this project`, true);

    const localMemoryOwner = this.memorySessions.localOwnerForTarget(target);
    const opened = await this.queue.runExclusive(target.probeSerial, async (metadata) => {
      const probe = await this.memorySessions.probeFor(target, metadata);
      if (!probe) throw new PollingCaptureError("POLLING_BACKEND_UNAVAILABLE", "persistent J-Link memory access is unavailable", true);
      const owner = this.memorySessions.localOwnerForTarget(target);
      if (!owner) throw new PollingCaptureError("POLLING_OWNER_UNVERIFIED", "polling memory-session ownership could not be verified", true, true);
      return owner;
    }, localMemoryOwner ? {
      allowedOwnerKinds: ["memory"],
      ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
      requiredOwner: localMemoryOwner,
    } : {});

    let sessionDir: string | undefined;
    let writer: JcapV1Writer | undefined;
    try {
      const captureId = randomUUID();
      const createdAt = new Date().toISOString();
      const capturesDir = input.runId ? join(this.outputRoot, input.runId, "captures") : join(this.outputRoot, "captures");
      mkdirSync(capturesDir, { recursive: true });
      const captureFile = join(capturesDir, `${captureId}.jcap`);
      sessionDir = mkdtempSync(join(capturesDir, `.staging-${captureId}-`));
      const packageDir = join(sessionDir, `${captureId}.jcap`);
      const control = pollingControlFiles(sessionDir);
      const metadata = createJcapV1Metadata({
        captureId,
        backend: "jlink-poll",
        requestedRateHz: input.rateHz,
        durationSec: input.durationSec,
        variables: input.variables.map(({ descriptor }) => descriptor),
        createdAt,
        provenance: {
          captureId,
          backend: "jlink-poll",
          runtime: {
            fallbackCode: input.fallbackCode,
            fallbackReason: input.fallbackReason,
            fallbackEvidence: input.capability.observed ?? null,
            helperSha256: input.runtime.helperSha256 ?? null,
            runtimeSha256: input.runtime.runtimeSha256 ?? null,
          },
          target: {
            projectRoot: target.projectRoot,
            generation: target.generation,
            device: target.device,
            configuredDevice: target.device,
            attachDevice: selectMemorySessionAttachDevice(target),
            probeSerial: target.probeSerial,
            interface: target.interface,
            speed: target.speed,
          },
          script: { mode: "none" },
          artifact: target.artifact ? { path: target.artifact.path, generation: target.artifact.generation, sha256: target.artifact.sha256 } : undefined,
          variables: input.variables.map(({ descriptor }) => ({ ...descriptor })),
        },
      });
      writer = new JcapV1Writer({ packageDir, metadata });
      const startedNs = process.hrtime.bigint();
      writer.appendEvent({
        eventId: randomUUID(),
        eventSequence: 0,
        type: "lifecycle",
        tick: "0",
        state: "active",
        createdAt,
        backend: input.initialBackend ?? "background_poll",
        fallbackCode: input.fallbackCode,
      });
      writer.syncEvents();

      const session: HssSessionRecord = {
        formatVersion: 1,
        captureId,
        projectRoot: target.projectRoot,
        targetGeneration: target.generation,
        artifactGeneration: target.artifact!.generation,
        probeSerial: target.probeSerial,
        state: "capturing",
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
        ...(input.runId ? { runId: input.runId } : {}),
        packageDir,
        captureFile,
        sessionDir,
        control,
        helperPid: process.pid,
        helperNonce: randomUUID(),
        ownerToken: opened.value.token,
        qpcEpochCounter: "0",
        qpcFrequency: "1000000000",
        configuredInterface: target.interface,
        configuredSpeedKHz: target.speed,
        rateHz: input.rateHz,
        durationSec: input.durationSec,
        descriptors: input.variables.map(({ descriptor }) => descriptor),
        writeDescriptors: input.writeDescriptors,
        runtime: input.runtime,
        capability: input.capability,
        backend: input.initialBackend ?? "background_poll",
        intrusive: input.initialBackend === "stop_poll",
        pauseTotalUs: 0,
      };
      this.sessions.write(session);

      const job: PollingJob = {
        captureId,
        input: { ...input, target },
        writer,
        startedNs,
        stopRequested: false,
        backend: input.initialBackend ?? "background_poll",
        pauseTotalUs: 0,
        sampleCount: 0,
        missingSamples: 0,
        readErrors: 0,
        timeouts: 0,
        eventSequence: 1,
        externalOperations: 0,
        acceptingExternalWrites: true,
        promise: Promise.resolve(),
      };
      job.promise = this.run(job).finally(() => this.jobs.delete(captureId));
      this.jobs.set(captureId, job);
      return this.sessions.read(captureId);
    } catch (error) {
      try { writer?.close(); } catch { /* cleanup below removes only the uncommitted staging tree */ }
      if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
      try {
        await this.memorySessions.closeForTarget(target);
      } catch (closeError) {
        throw new PollingCaptureError(
          "POLLING_START_CLEANUP_FAILED",
          `polling capture setup failed and the persistent memory session could not be closed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          true,
          true,
        );
      }
      throw error;
    }
  }

  async stop(captureId: string): Promise<HssSessionRecord> {
    const session = this.sessions.read(captureId);
    const job = this.jobs.get(captureId);
    if (!job) return this.reconcileOrphan(session);
    job.stopRequested = true;
    this.sessions.update(captureId, (current) => ({
      ...current,
      state: "stopping",
      stopRequestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    await Promise.race([
      job.promise,
      delay(15_000).then(() => { throw new PollingCaptureError("POLLING_STOP_TIMEOUT", "polling capture did not stop within 15 seconds", true, true); }),
    ]);
    return this.sessions.read(captureId);
  }

  async reconcileOrphan(session: HssSessionRecord): Promise<HssSessionRecord> {
    if (!this.isPollingSession(session) || !isActiveHssSessionState(session.state) || this.jobs.has(session.captureId)) return session;
    let raw: ReturnType<typeof readJcapV1Raw>;
    try {
      raw = readJcapV1Raw(session.packageDir);
      const lastTick = maxRawTick(raw);
      let sequence = raw.events.length ? Number(raw.events[raw.events.length - 1].eventSequence) + 1 : 0;
      appendJcapV1Event(session.packageDir, qualityEvent(sequence++, lastTick, raw.samples.length, 0, 0, false, { orphanedController: true }));
      appendJcapV1Event(session.packageDir, {
        eventId: randomUUID(),
        eventSequence: sequence,
        type: "lifecycle",
        tick: lastTick,
        state: "interrupted",
        errorCode: "POLLING_CONTROLLER_EXITED",
      });
      finalizeJcapV1Metadata(session.packageDir, "interrupted", {
        missingSamples: 0,
        droppedSamples: null,
        overflows: null,
        readErrors: 0,
        timeouts: 0,
      }, "partial", "none");
      const endedAt = new Date().toISOString();
      const final = session.captureFile ? await finalizeJcapV2FromV1Package({
        packageDir: session.packageDir,
        captureFile: session.captureFile,
        backend: session.backend ?? "background_poll",
        intrusive: session.intrusive === true,
        requestedRateHz: session.rateHz,
        pauseTotalUs: session.pauseTotalUs ?? 0,
        hostStartNs: String(BigInt(Date.parse(session.startedAt)) * 1_000_000n),
        hostEndNs: String(BigInt(Date.parse(endedAt)) * 1_000_000n),
      }) : undefined;
      const recovered = this.sessions.update(session.captureId, (current) => ({
        ...current,
        state: "interrupted",
        endedAt,
        updatedAt: endedAt,
        stateUnknown: true,
        lastError: { code: "POLLING_CONTROLLER_EXITED", message: "polling controller exited before terminal target-state confirmation" },
        result: {
          sampleCount: final?.sampleCount ?? raw.samples.length,
          jcapFormatVersion: final ? 2 : 1,
          ...(final ? { jcapChunkCount: final.chunkCount, jcapContentSha256: final.contentSha256 } : {}),
          anomalies: ["POLLING_CONTROLLER_EXITED"],
        },
      }));
      if (final && existsSync(final.captureFile)) rmSync(session.sessionDir, { recursive: true, force: true });
      return recovered;
    } catch (error) {
      return this.sessions.update(session.captureId, (current) => ({
        ...current,
        state: "failed",
        endedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stateUnknown: true,
        lastError: { code: "POLLING_RECOVERY_FAILED", message: error instanceof Error ? error.message : String(error) },
      }));
    }
  }

  private async run(job: PollingJob): Promise<void> {
    const periodNs = 1_000_000_000n / BigInt(job.input.rateHz);
    const deadlineNs = job.startedNs + BigInt(job.input.durationSec) * 1_000_000_000n;
    let nextSampleNs = job.startedNs;
    let lastSyncNs = job.startedNs;
    let terminalError: PollingCaptureError | undefined;

    try {
      while (!job.stopRequested && process.hrtime.bigint() < deadlineNs) {
        const beforeWait = process.hrtime.bigint();
        if (beforeWait < nextSampleNs) await delayNs(nextSampleNs - beforeWait);
        if (job.stopRequested) break;
        const now = process.hrtime.bigint();
        if (now > nextSampleNs + periodNs) {
          const skipped = Number((now - nextSampleNs) / periodNs);
          job.missingSamples += skipped;
          nextSampleNs += BigInt(skipped) * periodNs;
        }
        let values: Record<string, number> | undefined;
        try {
          values = await this.sample(job);
        } catch (error) {
          const normalized = normalizePollingError(error, "POLLING_READ_FAILED");
          if (normalized.stateUnknown) throw normalized;
          job.readErrors += 1;
          job.missingSamples += 1;
          if (normalized.code === "TIMEOUT") job.timeouts += 1;
        }
        const tick = process.hrtime.bigint() - job.startedNs;
        if (values) {
          if (!job.writer.appendSample({ sampleIndex: job.sampleCount, tick: tick.toString(), statusFlags: 0, values })) {
            throw new PollingCaptureError("JCAP_SAMPLE_LIMIT", "polling capture exceeded the bounded raw journal size");
          }
          job.sampleCount += 1;
        }
        nextSampleNs += periodNs;
        if (process.hrtime.bigint() - lastSyncNs >= 1_000_000_000n) {
          job.writer.syncSamples();
          job.writer.syncEvents();
          this.publishSessionProgress(job);
          lastSyncNs = process.hrtime.bigint();
        }
      }
    } catch (error) {
      terminalError = normalizePollingError(error, "POLLING_CAPTURE_FAILED");
    }

    job.acceptingExternalWrites = false;
    while (job.externalOperations > 0) await delay(5);

    try {
      await this.closeAndReconcileTarget(job);
    } catch (error) {
      const closeError = error instanceof PollingCaptureError
        ? error
        : normalizePollingError(error, "POLLING_SESSION_CLOSE_FAILED", true);
      terminalError = terminalError
        ? new PollingCaptureError(
          terminalError.code,
          `${terminalError.message}; post-close reconciliation: ${closeError.message}`,
          terminalError.retryable || closeError.retryable,
          terminalError.stateUnknown || closeError.stateUnknown,
          terminalError.writeIssued || closeError.writeIssued,
        )
        : closeError;
    }
    await this.finalize(job, terminalError);
  }

  private async sample(job: PollingJob): Promise<Record<string, number>> {
    if (job.backend === "background_poll") {
      try {
        return await this.withProbe(job, (probe) => readPollingVariables(probe, job.input.variables));
      } catch (error) {
        const normalized = normalizePollingError(error, "BACKGROUND_POLL_UNAVAILABLE");
        if (normalized.stateUnknown) throw normalized;
        job.backend = "stop_poll";
        this.appendFlag(job, "BACKEND_FALLBACK", {
          from: "background_poll",
          to: "stop_poll",
          reasonCode: normalized.code,
          reason: normalized.message,
        });
        this.sessions.update(job.captureId, (current) => ({ ...current, backend: "stop_poll", intrusive: true, updatedAt: new Date().toISOString() }));
      }
    }
    return this.withProbe(job, (probe) => this.stopPollSample(job, probe));
  }

  private async stopPollSample(job: PollingJob, probe: ProbeBackend): Promise<Record<string, number>> {
    const observed = await probe.observeTargetState();
    if (observed.state === "unknown") {
      throw commandError(observed.result, "STOP_POLL_STATE_UNKNOWN", "target state is unknown before stop-mode polling", true);
    }
    if (observed.state === "halted") return readPollingVariables(probe, job.input.variables);

    const pauseStartNs = process.hrtime.bigint();
    let values: Record<string, number> | undefined;
    let operationError: PollingCaptureError | undefined;
    const halted = await probe.halt();
    if (!halted.success) {
      operationError = commandError(halted, "STOP_POLL_HALT_FAILED", "stop-mode polling could not halt the target", false);
    } else {
      const haltedState = await probe.observeTargetState();
      if (haltedState.state !== "halted") {
        operationError = commandError(haltedState.result, "STOP_POLL_HALT_UNCONFIRMED", "target halt could not be confirmed", false);
      } else {
        try {
          values = await readPollingVariables(probe, job.input.variables);
        } catch (error) {
          const normalized = normalizePollingError(error, "STOP_POLL_READ_FAILED");
          operationError = new PollingCaptureError(normalized.code, normalized.message, normalized.retryable, false);
        }
      }
    }

    const resumed = await probe.resume();
    const runningState = resumed.success ? await probe.observeTargetState() : undefined;
    const pauseEndNs = process.hrtime.bigint();
    const durationUs = Number((pauseEndNs - pauseStartNs) / 1_000n);
    job.pauseTotalUs += durationUs;
    this.appendFlag(job, "STOP_POLL_PAUSE", {
      pauseStartNs: (pauseStartNs - job.startedNs).toString(),
      pauseEndNs: (pauseEndNs - job.startedNs).toString(),
      durationUs,
      haltConfirmed: halted.success,
      resumeIssued: true,
      resumeConfirmed: Boolean(resumed.success && runningState?.state === "running"),
    }, pauseEndNs - job.startedNs);
    if (!resumed.success || runningState?.state !== "running") {
      throw commandError(runningState?.result ?? resumed, "STOP_POLL_RESUME_UNCONFIRMED", "target resume could not be confirmed after stop-mode polling", true);
    }
    if (operationError) throw operationError;
    return values!;
  }

  private async withProbe<T>(job: PollingJob, operation: (probe: ProbeBackend) => Promise<T>): Promise<T> {
    const target = this.targets.requireCurrent(job.input.target);
    const owner = this.memorySessions.localOwnerForTarget(target);
    if (!owner || owner.token !== this.sessions.read(job.captureId).ownerToken) {
      throw new PollingCaptureError("POLLING_OWNER_UNVERIFIED", "polling capture lost its persistent memory-session owner", true, true);
    }
    const execution = await this.queue.runExclusive(target.probeSerial, async (metadata) => {
      const probe = await this.memorySessions.probeFor(target, metadata);
      if (!probe) throw new PollingCaptureError("POLLING_BACKEND_UNAVAILABLE", "persistent J-Link memory access became unavailable", true, true);
      return operation(probe);
    }, {
      allowedOwnerKinds: ["memory"],
      ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
      requiredOwner: owner,
    });
    return execution.value;
  }

  private appendFlag(job: PollingJob, code: string, data: Record<string, unknown>, tick = process.hrtime.bigint() - job.startedNs): void {
    job.writer.appendEvent({
      eventId: randomUUID(),
      eventSequence: job.eventSequence++,
      type: "flag",
      tick: tick.toString(),
      code,
      ...data,
    });
  }

  private publishSessionProgress(job: PollingJob): void {
    this.sessions.update(job.captureId, (current) => ({
      ...current,
      backend: job.backend,
      intrusive: job.backend === "stop_poll",
      pauseTotalUs: job.pauseTotalUs,
      result: {
        ...(current.result ?? {}),
        sampleCount: job.sampleCount,
        readErrors: job.readErrors,
        requestedSamples: job.input.rateHz * job.input.durationSec,
      },
      updatedAt: new Date().toISOString(),
    }));
  }

  private async closeAndReconcileTarget(job: PollingJob): Promise<void> {
    const target = job.input.target;
    const memoryOwner = this.memorySessions.localOwnerForTarget(target);
    if (!memoryOwner) {
      this.appendFlag(job, "MEMORY_SESSION_CLOSE_UNOBSERVED", {
        reason: "persistent memory-session owner was unavailable before reconciliation",
      });
      throw new PollingCaptureError(
        "POLLING_SESSION_CLOSE_UNOBSERVED",
        "polling capture could not bind post-close reconciliation to the persistent memory-session owner",
        false,
        true,
      );
    }

    await this.queue.runExclusive(target.probeSerial, async (metadata) => {
      const closed = await this.memorySessions.closeForTarget(target);
      if (!closed) {
        this.appendFlag(job, "MEMORY_SESSION_CLOSE_UNOBSERVED", {
          reason: "persistent memory session was not available for a bound close",
        });
        throw new PollingCaptureError(
          "POLLING_SESSION_CLOSE_UNOBSERVED",
          "polling capture could not bind helper exit to a persistent memory-session close",
          false,
          true,
        );
      }

      const expected = closed.targetStateBeforeClose;
      if (expected === "unknown") {
        this.appendFlag(job, "MEMORY_SESSION_CLOSE_STATE_UNKNOWN", {
          targetStateBeforeClose: expected,
          targetStateAfterClose: "unknown",
        });
        throw new PollingCaptureError(
          "POST_OPERATION_STATE_UNKNOWN",
          "polling capture could not prove target state before closing the persistent memory session",
          false,
          true,
        );
      }

      const owner = this.queue.getOwner(target.probeSerial);
      if (owner) {
        this.appendFlag(job, "MEMORY_SESSION_OWNER_RELEASE_UNCONFIRMED", {
          targetStateBeforeClose: expected,
          ownerKind: owner.kind,
        });
        throw new PollingCaptureError(
          "MEMORY_SESSION_OWNER_RELEASE_UNCONFIRMED",
          "polling capture cannot observe post-close target state while Probe ownership remains active",
          true,
          true,
        );
      }

      const observer = await this.memorySessions.probeFor(target, metadata);
      if (!observer) {
        throw new PollingCaptureError(
          "POLLING_HEALTH_OBSERVER_UNAVAILABLE",
          "polling capture could not open the configured runtime attach profile for post-close health verification",
          true,
          true,
        );
      }

      let primaryError: unknown;
      let successfulEvidence: Record<string, unknown> | undefined;
      try {
        let observedHealth: PollingTargetHealthObservation;
        try {
          observedHealth = await observePollingTargetHealth(observer);
        } catch (error) {
          this.appendFlag(job, "MEMORY_SESSION_CLOSE_STATE_UNKNOWN", {
            targetStateBeforeClose: expected,
            targetStateAfterClose: "unknown",
            reason: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof PollingCaptureError) throw error;
          throw new PollingCaptureError(
            "POLLING_TARGET_STATE_OBSERVE_FAILED",
            `polling capture could not independently observe target state after memory-session close: ${error instanceof Error ? error.message : String(error)}`,
            true,
            true,
          );
        }

        const observed = observedHealth.state;
        if (observed === "unknown") {
          this.appendFlag(job, "MEMORY_SESSION_CLOSE_STATE_UNKNOWN", {
            targetStateBeforeClose: expected,
            targetStateAfterClose: observed,
          });
          throw new PollingCaptureError(
            "POST_OPERATION_STATE_UNKNOWN",
            "polling capture received an unknown target state after memory-session close",
            false,
            true,
          );
        }

        if (observed === expected) {
          successfulEvidence = {
            targetStateBeforeClose: expected,
            targetStateAfterClose: observed,
            targetHealth: observedHealth,
          };
        } else {
          let restored: "running" | "halted" | "unknown" = "unknown";
          let confirmed: "running" | "halted" | "unknown" = "unknown";
          let restorationIssued = false;
          try {
            const restoreResult = expected === "running" ? await observer.resume() : await observer.halt();
            restorationIssued = restoreResult.writeIssued === true;
            if (!restoreResult.success) {
              throw commandError(
                restoreResult,
                "POLLING_TARGET_STATE_RESTORE_FAILED",
                `target could not be restored to ${expected}`,
                true,
              );
            }
            restored = (await observer.observeTargetState()).state;
            confirmed = (await observePollingTargetHealth(observer)).state;
            if (restored !== expected || confirmed !== expected) {
              throw new Error(`restoration returned ${restored} and independent confirmation returned ${confirmed}`);
            }
          } catch (error) {
            const writeIssued = restorationIssued || (error instanceof PollingCaptureError && error.writeIssued);
            this.appendFlag(job, "MEMORY_SESSION_CLOSE_STATE_RESTORE_FAILED", {
              targetStateBeforeClose: expected,
              targetStateAfterClose: observed,
              restoredState: restored,
              confirmedState: confirmed,
              restorationIssued: writeIssued,
              reason: error instanceof Error ? error.message : String(error),
            });
            throw new PollingCaptureError(
              "POLLING_TARGET_STATE_RESTORE_FAILED",
              `memory-session close changed target state from ${expected} to ${observed}, and restoration could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
              false,
              true,
              writeIssued,
            );
          }

          this.appendFlag(job, "MEMORY_SESSION_CLOSE_STATE_CHANGED", {
            targetStateBeforeClose: expected,
            targetStateAfterClose: observed,
            restoredState: restored,
            confirmedState: confirmed,
            restorationIssued: true,
          });
          throw new PollingCaptureError(
            "POLLING_TARGET_STATE_CHANGED",
            `memory-session close changed target state from ${expected} to ${observed}; the original state was restored, but the capture is not accepted as completed`,
            false,
            false,
            true,
          );
        }
      } catch (error) {
        primaryError = error;
      }

      let observerClosed: Awaited<ReturnType<MemorySessionManager["closeForTarget"]>>;
      try {
        observerClosed = await this.memorySessions.closeForTarget(target);
      } catch (closeError) {
        this.appendFlag(job, "POLLING_HEALTH_OBSERVER_CLOSE_UNCONFIRMED", {
          reason: closeError instanceof Error ? closeError.message : String(closeError),
          primaryCode: primaryError instanceof PollingCaptureError ? primaryError.code : null,
        });
        if (primaryError instanceof PollingCaptureError) {
          throw new PollingCaptureError(
            primaryError.code,
            `${primaryError.message}; post-close health observer exit was not confirmed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
            primaryError.retryable,
            true,
            primaryError.writeIssued,
          );
        }
        throw new PollingCaptureError(
          "POLLING_HEALTH_OBSERVER_CLOSE_UNCONFIRMED",
          `post-close health observer could not be closed with confirmed helper exit: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          true,
          true,
        );
      }
      if (!observerClosed) {
        this.appendFlag(job, "POLLING_HEALTH_OBSERVER_CLOSE_UNCONFIRMED", {
          reason: "health observer owner was absent before a bound close",
          primaryCode: primaryError instanceof PollingCaptureError ? primaryError.code : null,
        });
        if (primaryError instanceof PollingCaptureError) {
          throw new PollingCaptureError(
            primaryError.code,
            `${primaryError.message}; post-close health observer exit was not confirmed`,
            primaryError.retryable,
            true,
            primaryError.writeIssued,
          );
        }
        throw new PollingCaptureError(
          "POLLING_HEALTH_OBSERVER_CLOSE_UNCONFIRMED",
          "post-close health observer could not be closed with confirmed helper exit",
          true,
          true,
        );
      }

      if (primaryError) {
        if (primaryError instanceof PollingCaptureError) {
          throw new PollingCaptureError(
            primaryError.code,
            primaryError.message,
            primaryError.retryable,
            true,
            primaryError.writeIssued,
          );
        }
        throw new PollingCaptureError(
          "POLLING_TARGET_RECONCILIATION_FAILED",
          primaryError instanceof Error ? primaryError.message : String(primaryError),
          false,
          true,
        );
      }
      if (!successfulEvidence) {
        throw new PollingCaptureError(
          "POLLING_TARGET_HEALTH_UNKNOWN",
          "post-close target health did not produce completion evidence",
          false,
          true,
        );
      }
      if (observerClosed.targetStateBeforeClose !== expected) {
        this.appendFlag(job, "MEMORY_SESSION_RELEASE_STATE_MISMATCH", {
          expectedStateBeforeRelease: expected,
          observedStateBeforeRelease: observerClosed.targetStateBeforeClose,
        });
        throw new PollingCaptureError(
          "POLLING_RELEASE_QUALIFICATION_STATE_MISMATCH",
          `health-observer release began from ${observerClosed.targetStateBeforeClose}, expected ${expected}`,
          false,
          true,
        );
      }
      if (!sameMemorySessionReleaseIdentity(closed.releaseIdentity, observerClosed.releaseIdentity)) {
        this.appendFlag(job, "MEMORY_SESSION_RELEASE_IDENTITY_MISMATCH", {
          observedRelease: closed.releaseIdentity,
          cleanupRelease: observerClosed.releaseIdentity,
        });
        throw new PollingCaptureError(
          "POLLING_RELEASE_QUALIFICATION_MISMATCH",
          "health-observer release did not match the independently observed release configuration",
          false,
          true,
        );
      }

      this.appendFlag(job, "MEMORY_SESSION_RELEASE_QUALIFIED", {
        method: "prior_identical_release_observed",
        stateBeforeRelease: observerClosed.targetStateBeforeClose,
        identity: observerClosed.releaseIdentity,
      });
      this.appendFlag(job, "MEMORY_SESSION_CLOSE_VERIFIED", successfulEvidence);
    }, {
      allowedOwnerKinds: ["memory"],
      ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
      requiredOwner: memoryOwner,
    });
  }

  private async finalize(job: PollingJob, terminalError?: PollingCaptureError): Promise<void> {
    const endedNs = process.hrtime.bigint();
    const elapsedNs = endedNs - job.startedNs;
    const elapsedSec = Math.max(Number(elapsedNs) / 1_000_000_000, Number.EPSILON);
    const actualRateHz = job.sampleCount / elapsedSec;
    const rateDegraded = actualRateHz + Number.EPSILON < job.input.rateHz * 0.95;
    let state: Exclude<JcapV1CaptureState, "active" | "finalizing"> = terminalError
      ? job.sampleCount > 0 ? "interrupted" : "failed"
      : job.stopRequested ? "stopped" : "completed";
    const anomalies: string[] = [];
    if (job.backend === "stop_poll") anomalies.push("CAPTURE_INTRUSIVE");
    if (rateDegraded) anomalies.push("RATE_DEGRADED");
    if (job.missingSamples > 0) anomalies.push("SAMPLES_MISSING");
    if (job.readErrors > 0) anomalies.push("READ_ERRORS");
    if (terminalError?.stateUnknown) anomalies.push("STATE_UNKNOWN");
    const terminalTick = elapsedNs.toString();

    try {
      if (rateDegraded) this.appendFlag(job, "RATE_DEGRADED", { requestedRateHz: job.input.rateHz, actualRateHz }, elapsedNs);
      job.writer.appendEvent(qualityEvent(
        job.eventSequence++,
        terminalTick,
        job.missingSamples,
        job.readErrors,
        job.timeouts,
        state === "completed",
        { backend: job.backend, actualRateHz, pauseTotalUs: job.pauseTotalUs },
      ));
      job.writer.appendEvent({ eventId: randomUUID(), eventSequence: job.eventSequence++, type: "lifecycle", tick: terminalTick, state: "finalizing" });
      job.writer.appendEvent({
        eventId: randomUUID(),
        eventSequence: job.eventSequence++,
        type: "lifecycle",
        tick: terminalTick,
        state,
        errorCode: terminalError?.code ?? null,
      });
      job.writer.close();
      job.writer.finalize(state, {
        missingSamples: job.missingSamples,
        droppedSamples: null,
        overflows: null,
        readErrors: job.readErrors,
        timeouts: job.timeouts,
      }, "partial", "none");
    } catch (error) {
      try { job.writer.close(); } catch { /* preserve the original journal failure */ }
      terminalError = normalizePollingError(error, "POLLING_JCAP_FINALIZE_FAILED");
      state = job.sampleCount > 0 ? "interrupted" : "failed";
    }

    const endedAt = new Date().toISOString();
    let final: Awaited<ReturnType<typeof finalizeJcapV2FromV1Package>> | undefined;
    try {
      final = await finalizeJcapV2FromV1Package({
        packageDir: this.sessions.read(job.captureId).packageDir,
        captureFile: this.sessions.read(job.captureId).captureFile!,
        backend: job.backend,
        intrusive: job.backend === "stop_poll",
        requestedRateHz: job.input.rateHz,
        actualRateHz,
        pauseTotalUs: job.pauseTotalUs,
        hostStartNs: String(BigInt(Date.parse(this.sessions.read(job.captureId).startedAt)) * 1_000_000n),
        hostEndNs: String(BigInt(Date.parse(endedAt)) * 1_000_000n),
      });
    } catch (error) {
      terminalError = normalizePollingError(error, "POLLING_JCAP_V2_FINALIZE_FAILED");
      state = job.sampleCount > 0 ? "interrupted" : "failed";
    }
    this.sessions.update(job.captureId, (current) => ({
      ...current,
      state,
      endedAt,
      updatedAt: endedAt,
      backend: job.backend,
      intrusive: job.backend === "stop_poll",
      pauseTotalUs: job.pauseTotalUs,
      stateUnknown: terminalError?.stateUnknown === true,
      result: {
        ...(current.result ?? {}),
        sampleCount: final?.sampleCount ?? job.sampleCount,
        requestedSamples: job.input.rateHz * job.input.durationSec,
        sampleRatio: job.input.rateHz * job.input.durationSec > 0 ? job.sampleCount / (job.input.rateHz * job.input.durationSec) : null,
        actualRateHz,
        readErrors: job.readErrors,
        missingSamples: job.missingSamples,
        pauseTotalUs: job.pauseTotalUs,
        anomalies,
        ...(final ? { jcapFormatVersion: 2, jcapChunkCount: final.chunkCount, jcapContentSha256: final.contentSha256 } : {}),
      },
      ...(terminalError ? { lastError: { code: terminalError.code, message: terminalError.message } } : {}),
    }));
    if (final && existsSync(final.captureFile)) rmSync(this.sessions.read(job.captureId).sessionDir, { recursive: true, force: true });
  }
}

interface PollingTargetHealthObservation {
  state: "running" | "halted" | "unknown";
  oracle: "execution_state" | "cortex_m_scb";
  cpuid?: string;
  sampleCount: number;
  elapsedMs: number;
  threadModeObserved: boolean | null;
}

function sameMemorySessionReleaseIdentity(
  left: MemorySessionReleaseIdentity,
  right: MemorySessionReleaseIdentity,
): boolean {
  return left.projectRoot === right.projectRoot
    && left.targetGeneration === right.targetGeneration
    && left.configuredDevice === right.configuredDevice
    && left.attachDevice === right.attachDevice
    && left.probeSerial === right.probeSerial
    && left.interface === right.interface
    && left.speedKhz === right.speedKhz
    && left.helperSha256 === right.helperSha256
    && left.runtimeSha256 === right.runtimeSha256;
}

async function observePollingTargetHealth(probe: ProbeBackend): Promise<PollingTargetHealthObservation> {
  const before = await probe.observeTargetState();
  if (before.state === "unknown") {
    throw new PollingCaptureError("POLLING_TARGET_HEALTH_UNKNOWN", "target state was unknown before post-close health verification", true, true);
  }

  const cpuid = await readPollingU32(probe, 0xe000ed00, "CPUID");
  if (!isCortexMCpuid(cpuid)) {
    const after = await probe.observeTargetState();
    if (after.state === "unknown") {
      throw new PollingCaptureError("POLLING_TARGET_HEALTH_UNKNOWN", "target state was unknown after post-close health verification", true, true);
    }
    return {
      state: after.state,
      oracle: "execution_state",
      cpuid: hex32(cpuid),
      sampleCount: 0,
      elapsedMs: 0,
      threadModeObserved: null,
    };
  }

  const startedAt = Date.now();
  const delays = [0, 1, 3, 2, 5, 1, 7, 2];
  let sampleCount = 0;
  let threadModeObserved = false;
  while (sampleCount < 256 && Date.now() - startedAt < 2_500) {
    const icsr = await readPollingU32(probe, 0xe000ed04, "ICSR");
    const cfsr = await readPollingU32(probe, 0xe000ed28, "CFSR");
    const hfsr = await readPollingU32(probe, 0xe000ed2c, "HFSR");
    sampleCount += 1;
    const vectActive = icsr & 0x1ff;
    if (cfsr !== 0 || hfsr !== 0 || !allowedPollingException(vectActive)) {
      throw new PollingCaptureError(
        "POLLING_TARGET_FAULT_DETECTED",
        `post-close Cortex-M health gate failed: VECTACTIVE=${vectActive}, CFSR=${hex32(cfsr)}, HFSR=${hex32(hfsr)}`,
        false,
        true,
      );
    }
    if (vectActive === 0) threadModeObserved = true;
    const elapsedMs = Date.now() - startedAt;
    if (sampleCount >= 16 && elapsedMs >= 250 && threadModeObserved) break;
    await delay(delays[(sampleCount - 1) % delays.length]);
  }
  const elapsedMs = Date.now() - startedAt;
  if (sampleCount < 16 || elapsedMs < 250 || !threadModeObserved) {
    throw new PollingCaptureError(
      sampleCount < 16 || elapsedMs < 250
        ? "POLLING_HEALTH_OBSERVATION_INSUFFICIENT"
        : "POLLING_THREAD_MODE_NOT_OBSERVED",
      `post-close Cortex-M health gate was inconclusive after ${sampleCount} samples and ${elapsedMs} ms`,
      true,
      true,
    );
  }
  const after = await probe.observeTargetState();
  if (after.state === "unknown") {
    throw new PollingCaptureError("POLLING_TARGET_HEALTH_UNKNOWN", "target state was unknown after Cortex-M health verification", true, true);
  }
  return {
    state: after.state,
    oracle: "cortex_m_scb",
    cpuid: hex32(cpuid),
    sampleCount,
    elapsedMs,
    threadModeObserved,
  };
}

async function readPollingU32(probe: ProbeBackend, address: number, name: string): Promise<number> {
  const result = await probe.readMemory(address, 4, 4);
  if (!result.success) throw commandError(result, "POLLING_HEALTH_READ_FAILED", `failed to read Cortex-M ${name}`, true);
  const bytes = decodeProbeMemoryBytes(probe, result, address, 4, 4);
  if (bytes.length !== 4) {
    throw new PollingCaptureError("POLLING_HEALTH_READ_INCOMPLETE", `Cortex-M ${name} read returned ${bytes.length} bytes`, false, true);
  }
  return bytes.readUInt32LE(0);
}

function isCortexMCpuid(cpuid: number): boolean {
  const implementer = (cpuid >>> 24) & 0xff;
  const architecture = (cpuid >>> 16) & 0xf;
  return implementer === 0x41 && (architecture === 0xc || architecture === 0xf);
}

function allowedPollingException(vectActive: number): boolean {
  return vectActive === 0 || vectActive >= 16 || vectActive === 11 || vectActive === 14 || vectActive === 15;
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

async function readPollingVariables(probe: ProbeBackend, variables: PollingCaptureVariable[]): Promise<Record<string, number>> {
  const values: Record<string, number> = {};
  for (const variable of variables) {
    const { resolved, descriptor } = variable;
    const accessSize: 1 | 2 | 4 = resolved.address % 4 === 0 && resolved.size % 4 === 0
      ? 4
      : resolved.address % 2 === 0 && resolved.size % 2 === 0 ? 2 : 1;
    const result = await probe.readMemory(resolved.address, resolved.size, accessSize);
    if (!result.success) throw commandError(result, String(result.errorCode ?? "POLLING_READ_FAILED"), result.error ?? `failed to read ${descriptor.logicalIdentity}`, result.stateUnknown === true);
    const bytes = decodeProbeMemoryBytes(probe, result, resolved.address, resolved.size, accessSize);
    if (bytes.length !== resolved.size) throw new PollingCaptureError("READ_LENGTH_MISMATCH", `expected ${resolved.size} bytes for ${descriptor.logicalIdentity} but decoded ${bytes.length}`, false, true);
    values[descriptor.logicalIdentity] = decodeHssValue(resolved.type, bytes, resolved.endian);
  }
  return values;
}

function qualityEvent(
  eventSequence: number,
  tick: string,
  missingSamples: number,
  readErrors: number,
  timeouts: number,
  durationValidated: boolean,
  qualityEvidence: Record<string, unknown>,
) {
  return {
    eventId: randomUUID(),
    eventSequence,
    type: "quality" as const,
    tick,
    qualityStatus: "partial",
    qualitySource: "none",
    missingSamples,
    droppedSamples: null,
    overflows: null,
    readErrors,
    timeouts,
    durationValidated,
    qualityEvidence,
    inferredDroppedBeforeSampleIndexes: [],
  };
}

function commandError(
  result: { errorCode?: unknown; error?: unknown; stateUnknown?: boolean },
  fallbackCode: string,
  fallbackMessage: string,
  forceUnknown = false,
): PollingCaptureError {
  return new PollingCaptureError(
    typeof result.errorCode === "string" ? result.errorCode : fallbackCode,
    typeof result.error === "string" && result.error ? result.error : fallbackMessage,
    true,
    forceUnknown || result.stateUnknown === true,
  );
}

function normalizePollingError(error: unknown, fallbackCode: string, forceUnknown = false): PollingCaptureError {
  if (error instanceof PollingCaptureError) {
    if (!forceUnknown || error.stateUnknown) return error;
    return new PollingCaptureError(error.code, error.message, error.retryable, true, error.writeIssued);
  }
  const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown; stateUnknown?: unknown; writeIssued?: unknown };
  return new PollingCaptureError(
    typeof candidate?.code === "string" ? candidate.code : fallbackCode,
    error instanceof Error ? error.message : String(error),
    candidate?.retryable === true,
    forceUnknown || candidate?.stateUnknown === true,
    candidate?.writeIssued === true,
  );
}

function pollingControlFiles(sessionDir: string): HssCaptureControlFiles {
  return {
    planPath: join(sessionDir, "polling-plan.json"),
    pidFile: join(sessionDir, "polling.owner.json"),
    readyFile: join(sessionDir, "polling.ready.json"),
    stdoutPath: join(sessionDir, "polling.stdout.ndjson"),
    stderrPath: join(sessionDir, "polling.stderr.log"),
    stopFile: join(sessionDir, "polling.stop.request"),
    requestFile: join(sessionDir, "polling.memory.request.json"),
    claimFile: join(sessionDir, "polling.memory.claimed.json"),
    responseFile: join(sessionDir, "polling.memory.response.json"),
  };
}

function maxRawTick(raw: ReturnType<typeof readJcapV1Raw>): string {
  let tick = 0n;
  for (const sample of raw.samples) if (BigInt(sample.tick) > tick) tick = BigInt(sample.tick);
  for (const event of raw.events) if (BigInt(event.tick) > tick) tick = BigInt(event.tick);
  return tick.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function delayNs(nanoseconds: bigint): Promise<void> {
  const milliseconds = Number(nanoseconds / 1_000_000n);
  return delay(Math.max(0, milliseconds));
}
