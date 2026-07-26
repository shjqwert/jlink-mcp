import type { CommandResult, ProbeBackend, ProbeMemoryTransactionResult, TargetStateObservation } from "../../probe/backend";
import { ProbeErrorCode, decodeFaultRegisters } from "../../probe/backend";
import { chmodSync, copyFileSync, constants, readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { createRepoTempDir } from "../preflight/temp-preflight";
import { parseElfFlashSegments } from "../../gdb/elf-resolver";
import type { QueueMetadata } from "./probe-queue";
import { ProbeQueue, ProbeQueueError } from "./probe-queue";
import { MemorySessionError, MemorySessionManager, persistentMemorySessionEvidence } from "./memory-session";
import {
  createOperationEnvelope,
  executionError,
  failEnvelope,
  finishEnvelope,
  OperationExecutionError,
  type OperationEnvelope,
} from "./operation-envelope";
import {
  assertArtifactBindingsCurrent,
  assertSvdBindingCurrent,
  inspectFlashFile,
  locateMemoryRegion,
  overlappingMemoryRegions,
  TargetStore,
  TargetStoreError,
  type FlashImageBinding,
  type StoredTarget,
  type TargetConfigureInput,
} from "./target-store";
import { decodeHssValue, encodeHssValue, hssTypedByteSize, type HssTargetEndian } from "../hss/hss-typed-value";
import type { HssScalarType } from "../hss/hss-contract";

export interface DirectTargetRuntime {
  probe: ProbeBackend;
}

export type DirectRuntimeProvider = (target: StoredTarget) => Promise<DirectTargetRuntime>;

export interface MemoryReadInput {
  projectRoot: string;
  address: number;
  width: 8 | 16 | 32;
  byteCount: number;
  operationTool?: string;
  expectedTargetGeneration?: string;
  expectedArtifactGeneration?: string;
  expectedSvdSha256?: string;
  allowedArtifactMatch?: Array<"verified" | "unverified" | "mismatch">;
}

export interface MemoryWriteInput extends MemoryReadInput {
  dataHex: string;
  captureOld?: boolean;
  verify?: boolean;
}

export type NonObserveComparator =
  | { mode: "exact"; type?: HssScalarType; endian?: HssTargetEndian }
  | { mode: "tolerance"; expected: number; absTolerance: number; relTolerance: number; type: HssScalarType; endian: HssTargetEndian }
  | { mode: "masked"; maskHex: string; type?: HssScalarType; endian?: HssTargetEndian };

export type ScalarComparator = NonObserveComparator
  | { mode: "observe"; durationMs: number; maxPolls: number; intervalMs: number; comparator: NonObserveComparator };

export interface StructuredMemoryWriteInput extends MemoryReadInput {
  dataHex: string;
  captureOld?: boolean;
  verify?: boolean;
  restore?: boolean;
  verificationConnection?: "same_session" | "independent_session";
  comparator?: ScalarComparator;
  knownRegion: "ram" | "peripheral";
  rmw?: { mask: number; value: number; endian: HssTargetEndian };
  semanticData?: Record<string, unknown>;
}

export interface StructuredMemoryReadRequest {
  address: number;
  width: 8 | 16 | 32;
  byteCount: number;
  semanticData?: Record<string, unknown>;
}

export interface StructuredMemoryReadBatchInput extends Pick<MemoryReadInput, "projectRoot" | "operationTool" | "expectedTargetGeneration" | "expectedArtifactGeneration" | "expectedSvdSha256" | "allowedArtifactMatch"> {
  requests: StructuredMemoryReadRequest[];
}

export interface CoreRegisterWriteInput {
  projectRoot: string;
  name: string;
  value: number;
  verify?: boolean;
}

export interface FlashInput {
  projectRoot: string;
  path: string;
  baseAddress?: number;
  /** Set only after the user explicitly approves this exact destructive operation. */
  userConfirmed?: boolean;
}

export interface EraseInput {
  projectRoot: string;
  verifyBlank?: boolean;
  /** Set only after the user explicitly approves erasing the target flash. */
  userConfirmed?: boolean;
}

export interface ProbeCommandInput {
  projectRoot: string;
  commands: string[];
  /** Set only after the user explicitly approves these exact raw commands. */
  userConfirmed?: boolean;
}

export type FlashSnapshotCleanup = (snapshotRoot: string) => Promise<Error | undefined>;

interface DirectQueueOptions {
  persistentMemorySession?: boolean;
  requirePersistentMemorySession?: boolean;
  verificationConnection?: "same_session" | "independent_session";
  verificationRequested?: boolean;
}

export interface FlashSnapshotCleanupOptions {
  remove?: (snapshotRoot: string) => void;
  retryDelaysMs?: readonly number[];
}

export class DirectMcuService {
  constructor(
    readonly targets: TargetStore,
    readonly queue: ProbeQueue,
    private readonly runtimeFor: DirectRuntimeProvider,
    private readonly cleanupFlashSnapshot: FlashSnapshotCleanup = removeFlashSnapshotDirectory,
    private readonly memorySessions?: MemorySessionManager,
    private readonly requireUserConfirmation = true,
  ) {}

  async configure(input: TargetConfigureInput): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("target_configure");
    let previous: StoredTarget | undefined;
    try {
      const previousTarget = this.targets.get(input.projectRoot);
      previous = previousTarget;
      const localMemoryOwner = previousTarget ? this.memorySessions?.localOwnerForTarget(previousTarget) : undefined;
      const serialized = previousTarget
        ? await this.queue.runExclusive(previousTarget.probeSerial, async () => {
          const currentPrevious = this.targets.require(previousTarget.projectRoot);
          if (currentPrevious.generation !== previousTarget.generation || currentPrevious.probeSerial !== previousTarget.probeSerial) {
            throw new TargetStoreError("TARGET_GENERATION_CHANGED", "Target configuration changed while target_configure waited for the Probe queue; retry against the current generation");
          }
          await this.memorySessions?.closeForTarget(currentPrevious);
          return this.targets.configure(input, previousTarget.generation);
        }, localMemoryOwner ? {
          allowedOwnerKinds: ["memory" as const],
          ownerTarget: { projectRoot: previousTarget.projectRoot, targetGeneration: previousTarget.generation },
          requiredOwner: localMemoryOwner,
        } : {})
        : undefined;
      const target = serialized?.value ?? await this.targets.configure(input, null);
      const configured = createOperationEnvelope("target_configure", target);
      configured.before = { targetGeneration: previous?.generation ?? null, artifactMatch: previous?.liveArtifactMatch ?? null };
      configured.after = { targetGeneration: target.generation, artifactMatch: target.liveArtifactMatch };
      if (serialized) {
        configured.queueSequence = serialized.queueSequence;
        configured.timestamps.queuedAt = serialized.queuedAt;
        configured.timestamps.startedAt = serialized.startedAt;
        configured.timestamps.endedAt = serialized.endedAt;
      }
      const preservedFlashVerification = target.liveArtifactMatch.status === "verified";
      configured.requestedEffects = [
        "persist_target_configuration",
        preservedFlashVerification ? "preserve_live_artifact_verification" : "invalidate_live_artifact_verification",
      ];
      configured.observedEffects = [
        "target_generation_created",
        preservedFlashVerification ? "live_artifact_verification_preserved" : "live_artifact_verification_unverified",
      ];
      configured.data = { target, persistedAt: this.targets.filePath };
      configured.verification = { status: "verified", method: "atomic_persistence_and_content_hashes" };
      return finishEnvelope(configured, true);
    } catch (error) {
      return this.failure(envelope, error, "configuration");
    }
  }

  status(projectRoot: string): OperationEnvelope {
    const empty = createOperationEnvelope("target_status");
    try {
      const target = this.targets.require(projectRoot);
      const envelope = createOperationEnvelope("target_status", target);
      const owner = this.queue.getOwner(target.probeSerial);
      if (envelope.probe) envelope.probe.owner = owner ?? null;
      envelope.before = { persistedTargetGeneration: target.generation };
      envelope.after = { persistedTargetGeneration: target.generation, owner: owner ?? null };
      envelope.data = { target, owner: owner ?? null };
      envelope.verification = { status: "observed", method: "persisted_target_and_machine_owner_state" };
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(empty, error, "target_lookup");
    }
  }

  control(tool: "halt" | "resume" | "reset" | "reset_halt", projectRoot: string): Promise<OperationEnvelope> {
    const finalState = tool === "halt" || tool === "reset_halt" ? "halted" : "running";
    const requestedEffects = tool.startsWith("reset") ? ["reset", finalState === "halted" ? "halt" : "resume"] : [tool];
    return this.queued(tool, projectRoot, requestedEffects, async (envelope, target, runtime) => {
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      const isIdempotent = (tool === "halt" || tool === "resume") && before.state === finalState;
      let result: CommandResult | undefined;
      if (!isIdempotent) {
        try {
          result = tool === "halt" ? await runtime.probe.halt()
            : tool === "resume" ? await runtime.probe.resume()
            : await runtime.probe.reset(tool === "reset_halt");
        } catch (error) {
          envelope.data = { noOp: false, command: null, requestedFinalState: finalState };
          throw unexpectedPostWriteError(error, "execution", `${tool} backend rejected after command dispatch`);
        }
        envelope.data = { noOp: false, command: commandData(result), requestedFinalState: finalState };
        if (!result.success) {
          const issued = result.errorCode !== ProbeErrorCode.PROBE_NOT_FOUND;
          throw commandError(result, "execution", issued, issued);
        }
        envelope.observedEffects.push(...requestedEffects);
      }
      const after = isIdempotent ? before : await observeAfterMutation(runtime.probe, tool);
      envelope.after = observationData(after);
      envelope.data = { noOp: isIdempotent, command: result ? commandData(result) : null, finalState: after.state, requestedFinalState: finalState };
      if (after.state !== finalState) {
        throw executionError("FINAL_STATE_UNCONFIRMED", "final_observation", `requested final state ${finalState}, observed ${after.state}`, { writeIssued: !isIdempotent, stateUnknown: !isIdempotent });
      }
      envelope.data = { noOp: isIdempotent, command: result ? commandData(result) : null, finalState };
      envelope.verification = { status: "verified", method: after.source };
    });
  }

  readMemory(input: MemoryReadInput): Promise<OperationEnvelope> {
    const tool = input.operationTool ?? "read_memory";
    try { validateMemoryRequest(input); } catch (error) { return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "validation")); }
    return this.queued(tool, input.projectRoot, [], async (envelope, target, runtime) => {
      validateExpectedTarget(input, target);
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      if (before.state === "unknown") {
        throw executionError("TARGET_STATE_UNKNOWN", "precondition", "target state is unknown before memory read; no memory read was issued", { stateUnknown: true });
      }
      let result: CommandResult | undefined;
      let bytes: Buffer | undefined;
      let readFailure: OperationExecutionError | undefined;
      try {
        result = await runtime.probe.readMemory(input.address, input.byteCount, input.width / 8 as 1 | 2 | 4);
        if (!result.success) {
          readFailure = memoryReadCommandError(result, "read");
        } else {
          try {
            bytes = memoryBytes(runtime.probe, result, input.address, input.byteCount, input.width / 8 as 1 | 2 | 4);
            if (bytes.length < input.byteCount) throw executionError("READ_LENGTH_MISMATCH", "decode", `requested ${input.byteCount} bytes but decoded ${bytes.length}`);
          } catch (error) {
            readFailure = unexpectedReadError(error, "memory read decode failed");
          }
        }
      } catch (error) {
        readFailure = unexpectedReadError(error, "memory read backend rejected");
      }
      envelope.data = {
        address: input.address,
        width: input.width,
        byteCount: input.byteCount,
        dataHex: bytes?.subarray(0, input.byteCount).toString("hex"),
        command: result ? commandData(result) : null,
      };
      let after: TargetStateObservation;
      try {
        after = await observe(runtime.probe);
      } catch (error) {
        throw readFailure ? readErrorWithUnknownState(readFailure) : unexpectedReadObservationError(error, "memory read");
      }
      envelope.after = observationData(after);
      if (after.state === "unknown") {
        throw readFailure ? readErrorWithUnknownState(readFailure) : executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after memory read", { stateUnknown: true });
      }
      if (after.state !== before.state) {
        throw executionError("HIDDEN_STATE_CHANGE", "final_observation", "memory read changed target run state", { stateUnknown: false });
      }
      if (readFailure) throw readFailure;
      envelope.verification = { status: "observed", method: "probe_read" };
    }, { persistentMemorySession: true });
  }

  structuredReadBatch(input: StructuredMemoryReadBatchInput): Promise<OperationEnvelope> {
    const tool = input.operationTool ?? "read_registers";
    try {
      if (!Array.isArray(input.requests) || input.requests.length < 1 || input.requests.length > 32) throw executionError("READ_BATCH_INVALID", "validation", "structured read batch accepts 1 to 32 requests");
      for (const request of input.requests) validateMemoryRequest({ projectRoot: input.projectRoot, ...request });
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "validation"));
    }
    return this.queued(tool, input.projectRoot, [], async (envelope, target, runtime) => {
      validateExpectedTarget({ ...input, address: input.requests[0].address, width: input.requests[0].width, byteCount: input.requests[0].byteCount }, target);
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      if (before.state === "unknown") throw executionError("TARGET_STATE_UNKNOWN", "precondition", "target state is unknown before structured reads; no read was issued", { stateUnknown: true });
      const results: Array<Record<string, unknown>> = [];
      let readFailure: OperationExecutionError | undefined;
      for (const request of input.requests) {
        let command: CommandResult | undefined;
        let bytes: Buffer | undefined;
        try {
          command = await runtime.probe.readMemory(request.address, request.byteCount, request.width / 8 as 1 | 2 | 4);
          if (!command.success) readFailure = memoryReadCommandError(command, "read");
          else {
            const decoded = memoryBytes(runtime.probe, command, request.address, request.byteCount, request.width / 8 as 1 | 2 | 4);
            if (decoded.length < request.byteCount) readFailure = executionError("READ_LENGTH_MISMATCH", "decode", `requested ${request.byteCount} bytes but decoded ${decoded.length}`);
            else bytes = decoded.subarray(0, request.byteCount);
          }
        } catch (error) {
          readFailure = unexpectedReadError(error, "structured read backend rejected");
        }
        results.push({
          ...(request.semanticData ?? {}),
          address: request.address,
          width: request.width,
          byteCount: request.byteCount,
          dataHex: bytes?.toString("hex"),
          command: command ? commandData(command) : null,
        });
        envelope.data = { results };
        if (readFailure) break;
      }
      let after: TargetStateObservation;
      try { after = await observe(runtime.probe); }
      catch { throw readFailure ? readErrorWithUnknownState(readFailure) : executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after structured reads", { stateUnknown: true }); }
      envelope.after = observationData(after);
      if (after.state === "unknown") throw readFailure ? readErrorWithUnknownState(readFailure) : executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after structured reads", { stateUnknown: true });
      if (after.state !== before.state) throw executionError("HIDDEN_STATE_CHANGE", "final_observation", "structured reads changed target run state", { stateUnknown: false });
      if (readFailure) throw readFailure;
      envelope.verification = { status: "observed", method: "probe_read_batch" };
    }, { persistentMemorySession: true });
  }

  writeMemory(input: MemoryWriteInput): Promise<OperationEnvelope> {
    const tool = input.operationTool ?? "write_memory";
    let bytes: Buffer;
    try {
      validateMemoryRequest(input);
      bytes = parseWriteBytes(input.dataHex, input.byteCount, input.width);
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "validation"));
    }
    return this.queued(tool, input.projectRoot, ["memory_write"], async (envelope, target, runtime) => {
      validateExpectedTarget(input, target);
      const region = locateMemoryRegion(target, input.address, input.byteCount);
      const overlaps = overlappingMemoryRegions(target, input.address, input.byteCount);
      if (!region && overlaps.length > 0) throw executionError("MEMORY_RANGE_CROSSES_REGION", "validation", "write range crosses a configured memory-region boundary");
      if (region && (!region.writable || region.kind === "flash" || region.kind === "rom")) throw executionError("MEMORY_REGION_NOT_WRITABLE", "validation", `configured ${region.kind} region is not writable by raw memory access`);
      const artifactAffecting = !region || region.kind === "unknown";
      if (artifactAffecting) envelope.warnings.push("Memory region is unknown; the write is explicit but Artifact verification will become unverified.");
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      if (before.state === "unknown") {
        throw executionError("TARGET_STATE_UNKNOWN", "precondition", "target state is unknown before memory write; no memory write was issued", { stateUnknown: true });
      }
      let old: Buffer | undefined;
      const accessSize = input.width / 8 as 1 | 2 | 4;
      if (typeof runtime.probe.writeMemoryTransaction === "function") {
        let transaction: ProbeMemoryTransactionResult | undefined;
        try {
          transaction = await runtime.probe.writeMemoryTransaction({
            address: input.address,
            bytes,
            accessSize,
            captureOld: Boolean(input.captureOld),
            verifyReads: input.verify ? 1 : 0,
            verifyIntervalMs: 0,
            verifyDurationMs: 0,
            restore: false,
            expectedTargetState: before.state,
          });
        } catch (error) {
          envelope.data = {
            address: input.address,
            width: input.width,
            byteCount: input.byteCount,
            requestedHex: bytes.toString("hex"),
            regionStatus: region?.kind ?? "unknown",
            command: null,
          };
          if (artifactAffecting) {
            try {
              const updated = await this.transitionArtifact(target, "unverified", "unknown_memory_write_outcome_unknown", true);
              refreshArtifact(envelope, updated);
            } catch { /* preserve the hardware-outcome failure */ }
          }
          throw unexpectedPostWriteError(error, "write", "memory transaction backend rejected after command dispatch");
        }
        if (transaction) {
          const writeIssued = transaction.command.writeIssued ?? transaction.command.success;
          if (artifactAffecting && writeIssued) {
            const source = transaction.command.success ? "unknown_memory_write" : "unknown_memory_write_failed";
            const updated = await this.transitionArtifact(target, "unverified", source, true);
            refreshArtifact(envelope, updated);
          }
          await applyRawMemoryTransaction(envelope, input, bytes, region?.kind ?? "unknown", before, transaction, runtime.probe);
          return;
        }
      }
      if (input.captureOld) old = await readExact(runtime.probe, input.address, input.byteCount, accessSize, "old_value_read", (oldRead) => {
        envelope.data = { ...(envelope.data as Record<string, unknown>), oldReadCommand: commandData(oldRead) };
      });
      let result: CommandResult;
      try {
        result = await runtime.probe.writeMemoryBytes(input.address, bytes, input.width / 8 as 1 | 2 | 4);
      } catch (error) {
        envelope.data = {
          address: input.address,
          width: input.width,
          byteCount: input.byteCount,
          oldHex: old?.toString("hex"),
          requestedHex: bytes.toString("hex"),
          readbackHex: undefined,
          regionStatus: region?.kind ?? "unknown",
          command: null,
        };
        if (artifactAffecting) {
          try {
            const updated = await this.transitionArtifact(target, "unverified", "unknown_memory_write_outcome_unknown", true);
            refreshArtifact(envelope, updated);
          } catch { /* preserve the hardware-outcome failure */ }
        }
        throw unexpectedPostWriteError(error, "write", "memory write backend rejected after command dispatch");
      }
      if (!result.success) {
        const issued = result.writeIssued ?? result.errorCode !== ProbeErrorCode.PROBE_NOT_FOUND;
        envelope.data = { address: input.address, width: input.width, byteCount: input.byteCount, requestedHex: bytes.toString("hex"), command: commandData(result) };
        if (artifactAffecting && issued) {
          const updated = await this.transitionArtifact(target, "unverified", "unknown_memory_write_failed", true);
          refreshArtifact(envelope, updated);
        }
        throw commandError(result, "write", issued, issued);
      }
      envelope.observedEffects.push("memory_write_issued");
      envelope.data = {
        address: input.address,
        width: input.width,
        byteCount: input.byteCount,
        oldHex: old?.toString("hex"),
        requestedHex: bytes.toString("hex"),
        readbackHex: undefined,
        regionStatus: region?.kind ?? "unknown",
        command: commandData(result),
      };
      if (artifactAffecting) {
        const updated = await this.transitionArtifact(target, "unverified", "unknown_memory_write", true);
        refreshArtifact(envelope, updated);
      }
      let readback: Buffer | undefined;
      let readbackCommand: Record<string, unknown> | undefined;
      let verificationError: OperationExecutionError | undefined;
      if (input.verify) {
        try {
          readback = await readExact(runtime.probe, input.address, input.byteCount, accessSize, "readback", (readbackResult) => {
            readbackCommand = commandData(readbackResult);
            envelope.data = { ...(envelope.data as Record<string, unknown>), readbackCommand };
          });
          envelope.data = {
            ...(envelope.data as Record<string, unknown>),
            readbackHex: readback.toString("hex"),
          };
          if (!readback.equals(bytes)) {
            verificationError = executionError("READBACK_MISMATCH", "verification", "memory readback does not match requested bytes", { writeIssued: true });
          }
        } catch (error) {
          verificationError = normalizePostWriteError(error, "READBACK_FAILED", "readback", "memory readback failed after the write", true);
        }
      }
      let after: TargetStateObservation;
      try {
        after = await observe(runtime.probe);
      } catch (error) {
        throw unexpectedPostWriteError(error, "final_observation", "target-state observation failed after memory write");
      }
      envelope.after = observationData(after);
      if (before.state !== after.state) envelope.observedEffects.push(`target_state_changed_during_write:${before.state}->${after.state}`);
      envelope.data = {
        address: input.address,
        width: input.width,
        byteCount: input.byteCount,
        oldHex: old?.toString("hex"),
        requestedHex: bytes.toString("hex"),
        readbackHex: readback?.toString("hex"),
        regionStatus: region?.kind ?? "unknown",
        command: commandData(result),
        readbackCommand,
      };
      envelope.verification = input.verify
        ? verificationError
          ? { status: "failed", method: "exact_readback", details: verificationError.detail }
          : { status: "verified", method: "exact_readback" }
        : { status: "executed_unverified" };
      if (verificationError) {
        if (after.state === "unknown" && !verificationError.detail.stateUnknown) {
          verificationError = normalizePostWriteError(verificationError, verificationError.detail.code, verificationError.detail.stage, verificationError.detail.message, true);
        }
        throw verificationError;
      }
      if (after.state === "unknown") throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after memory write", { writeIssued: true, stateUnknown: true });
      if (before.state !== after.state) {
        throw executionError("HIDDEN_STATE_CHANGE", "final_observation", `memory write changed target state from ${before.state} to ${after.state}`, { writeIssued: true, stateUnknown: false });
      }
    }, { persistentMemorySession: true });
  }

  structuredWrite(input: StructuredMemoryWriteInput): Promise<OperationEnvelope> {
    const tool = input.operationTool ?? "write_variable";
    let requested: Buffer;
    try {
      validateMemoryRequest(input);
      requested = parseWriteBytes(input.dataHex, input.byteCount, input.width);
      validateStructuredComparator(input.comparator ?? { mode: "exact" }, input.byteCount, requested);
      if (input.restore && !input.captureOld) input = { ...input, captureOld: true };
      if (input.verificationConnection === "independent_session" && !input.verify) throw executionError("VERIFICATION_CONNECTION_INVALID", "validation", "independent-session verification requires verify=true");
      if (input.verificationConnection === "independent_session" && input.restore) throw executionError("VERIFICATION_CONNECTION_INVALID", "validation", "independent-session verification cannot be combined with restore");
      if (input.rmw && input.byteCount !== input.width / 8) throw executionError("RMW_WIDTH_INVALID", "validation", "read-modify-write requires exactly one declared-width register");
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "validation"));
    }
    return this.queued(tool, input.projectRoot, ["structured_memory_write"], async (envelope, target, runtime) => {
      validateExpectedTarget(input, target);
      const configured = locateMemoryRegion(target, input.address, input.byteCount);
      const overlaps = overlappingMemoryRegions(target, input.address, input.byteCount);
      if (!configured && overlaps.length > 0) throw executionError("MEMORY_RANGE_CROSSES_REGION", "validation", "structured write crosses a configured memory-region boundary");
      if (configured && (!configured.writable || configured.kind === "flash" || configured.kind === "rom")) {
        throw executionError("MEMORY_REGION_NOT_WRITABLE", "validation", `configured ${configured.kind} region is not writable`);
      }
      if (configured && input.knownRegion === "ram" && configured.kind !== "ram") {
        throw executionError("SYMBOL_REGION_CONFLICT", "validation", `DWARF reports RAM but Target configuration reports ${configured.kind}`);
      }
      if (configured && input.knownRegion === "peripheral" && configured.kind !== "peripheral") {
        throw executionError("SVD_REGION_CONFLICT", "validation", `SVD reports peripheral space but Target configuration reports ${configured.kind}`);
      }

      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      if (before.state === "unknown") throw executionError("TARGET_STATE_UNKNOWN", "precondition", "target state is unknown before structured write; no write was issued", { stateUnknown: true });
      const accessSize = input.width / 8 as 1 | 2 | 4;
      if (!input.rmw && typeof runtime.probe.writeMemoryTransaction === "function") {
        const comparator = input.comparator ?? { mode: "exact" as const };
        const verifyReads = !input.verify ? 0 : comparator.mode === "observe" ? comparator.maxPolls : 1;
        const verifyIntervalMs = input.verify && comparator.mode === "observe" ? comparator.intervalMs : 0;
        let transaction: ProbeMemoryTransactionResult | undefined;
        try {
          transaction = await runtime.probe.writeMemoryTransaction({
            address: input.address,
            bytes: requested,
            accessSize,
            captureOld: Boolean(input.captureOld || input.restore),
            verifyReads,
            verifyIntervalMs,
            verifyDurationMs: input.verify && comparator.mode === "observe" ? comparator.durationMs : 0,
            restore: Boolean(input.restore),
            expectedTargetState: before.state,
          });
        } catch (error) {
          throw unexpectedPostWriteError(error, "write", "structured memory transaction backend rejected after dispatch");
        }
        if (transaction) {
          await applyProbeMemoryTransaction(envelope, input, requested, comparator, before, transaction, runtime.probe);
          return;
        }
      }
      const oldRequired = Boolean(input.captureOld || input.restore || input.rmw);
      let old: Buffer | undefined;
      let oldReadCommand: Record<string, unknown> | undefined;
      envelope.data = {
        ...(input.semanticData ?? {}),
        address: input.address,
        width: input.width,
        byteCount: input.byteCount,
        requestedHex: requested.toString("hex"),
        oldReadCommand: undefined,
      };
      if (oldRequired) {
        let oldError: OperationExecutionError | undefined;
        try {
          old = await readExact(runtime.probe, input.address, input.byteCount, accessSize, "old_value_read", (result) => {
            oldReadCommand = commandData(result);
            envelope.data = { ...(envelope.data as Record<string, unknown>), oldReadCommand };
          });
        } catch (error) {
          oldError = unexpectedReadError(error, "old-value read backend rejected");
        }
        if (oldError) {
          let after: TargetStateObservation;
          try { after = await observe(runtime.probe); }
          catch { throw readErrorWithUnknownState(oldError); }
          envelope.after = observationData(after);
          if (after.state === "unknown") throw readErrorWithUnknownState(oldError);
          if (after.state !== before.state) throw executionError("HIDDEN_STATE_CHANGE", "final_observation", "old-value read changed target run state", { stateUnknown: false });
          throw oldError;
        }
      }
      if (input.rmw) {
        if (!old) throw executionError("OLD_VALUE_REQUIRED", "old_value_read", "read-modify-write requires a successful old-value read");
        requested = applyReadModifyWrite(old, input.rmw);
      }

      let command: Record<string, unknown> | undefined;
      let writeIssued = false;
      let mainError: OperationExecutionError | undefined;
      try {
        const result = await runtime.probe.writeMemoryBytes(input.address, requested, accessSize);
        command = commandData(result);
        if (!result.success) {
          writeIssued = result.writeIssued ?? result.errorCode !== ProbeErrorCode.PROBE_NOT_FOUND;
          mainError = commandError(result, "write", writeIssued, writeIssued);
        } else {
          writeIssued = true;
          envelope.observedEffects.push("structured_memory_write_issued");
        }
      } catch (error) {
        writeIssued = true;
        mainError = unexpectedPostWriteError(error, "write", "structured memory write backend rejected after command dispatch");
      }

      let readback: Buffer | undefined;
      let verificationDetails: Record<string, unknown> | undefined;
      let verificationError: OperationExecutionError | undefined;
      let finalProbe = runtime.probe;
      let memorySessionClose: Record<string, unknown> | undefined;
      if (!mainError && input.verify) {
        try {
          if (input.verificationConnection === "independent_session") {
            const closed = await this.memorySessions?.closeForTarget(target);
            const independentRuntime = await this.runtimeFor(target);
            const targetStateAfterReconnect = await observe(independentRuntime.probe);
            finalProbe = independentRuntime.probe;
            if (closed) {
              memorySessionClose = { targetStateBeforeClose: closed.targetStateBeforeClose, targetStateAfterReconnect: targetStateAfterReconnect.state };
              if (closed.targetStateBeforeClose === "unknown" || targetStateAfterReconnect.state === "unknown") {
                throw executionError("POST_OPERATION_STATE_UNKNOWN", "memory_session_close", "memory-session close could not prove the target state before independent verification", { writeIssued: true, stateUnknown: true });
              }
              if (closed.targetStateBeforeClose !== targetStateAfterReconnect.state) {
                throw executionError("HIDDEN_STATE_CHANGE", "memory_session_close", `memory-session close changed target state from ${closed.targetStateBeforeClose} to ${targetStateAfterReconnect.state}`, { writeIssued: true, stateUnknown: false });
              }
            }
          }
          const result = await verifyStructuredValue(finalProbe, input.address, input.byteCount, accessSize, requested, input.comparator ?? { mode: "exact" });
          readback = result.readback;
          verificationDetails = result.details;
          if (!result.pass) verificationError = executionError("READBACK_MISMATCH", "verification", "structured readback did not satisfy the requested comparator", { writeIssued: true });
        } catch (error) {
          verificationError = normalizePostWriteError(error, "READBACK_FAILED", "readback", "structured readback failed after the write", true);
        }
      }

      let restoreCommand: Record<string, unknown> | undefined;
      let restoreReadCommand: Record<string, unknown> | undefined;
      let restoreReadback: Buffer | undefined;
      let restoreError: OperationExecutionError | undefined;
      if (input.restore && writeIssued) {
        if (!old) throw executionError("OLD_VALUE_REQUIRED", "restore", "restore requires a captured old value", { writeIssued: true, stateUnknown: true });
        try {
          const restored = await runtime.probe.writeMemoryBytes(input.address, old, accessSize);
          restoreCommand = commandData(restored);
          if (!restored.success) throw commandError(restored, "restore_write", true, true);
          envelope.observedEffects.push("structured_restore_write_issued");
          restoreReadback = await readExact(runtime.probe, input.address, input.byteCount, accessSize, "restore_readback", (result) => {
            restoreReadCommand = commandData(result);
          });
          if (!restoreReadback.equals(old)) throw executionError("RESTORE_MISMATCH", "restore_readback", "restore readback does not match the captured old value", { writeIssued: true, stateUnknown: true });
        } catch (error) {
          restoreError = normalizePostWriteError(error, "RESTORE_FAILED", "restore", "restore or restore readback failed", true);
        }
      }

      envelope.data = {
        ...(input.semanticData ?? {}),
        address: input.address,
        width: input.width,
        byteCount: input.byteCount,
        oldHex: old?.toString("hex"),
        requestedHex: requested.toString("hex"),
        readbackHex: readback?.toString("hex"),
        oldReadCommand,
        command,
        comparator: input.verify ? input.comparator ?? { mode: "exact" } : undefined,
        verificationDetails,
        ...(memorySessionClose ? { memorySessionClose } : {}),
        restore: input.restore ? {
          requestedHex: old?.toString("hex"),
          readbackHex: restoreReadback?.toString("hex"),
          command: restoreCommand,
          readbackCommand: restoreReadCommand,
          status: !writeIssued ? "not_needed" : restoreError ? "uncertain" : "verified",
        } : { status: "not_requested" },
      };
      envelope.verification = input.verify
        ? verificationError
          ? { status: "failed", method: comparatorMethod(input.comparator ?? { mode: "exact" }), details: verificationDetails }
          : mainError
            ? { status: "failed", method: "write_command" }
            : { status: "verified", method: comparatorMethod(input.comparator ?? { mode: "exact" }), details: verificationDetails }
        : { status: mainError ? "failed" : "executed_unverified" };

      let after: TargetStateObservation;
      try {
        after = await observe(finalProbe);
      } catch (error) {
        if (!writeIssued) {
          if (error instanceof OperationExecutionError) {
            throw executionError(error.detail.code, error.detail.stage, error.detail.message, {
              retryable: error.detail.retryable,
              writeIssued: false,
              stateUnknown: error.detail.stateUnknown || mainError?.detail.stateUnknown === true,
            });
          }
          throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target-state observation failed after structured write", {
            writeIssued: false,
            stateUnknown: true,
          });
        }
        throw normalizePostWriteError(error, "POST_OPERATION_STATE_UNKNOWN", "final_observation", "target-state observation failed after structured write", writeIssued);
      }
      envelope.after = observationData(after);
      if (before.state !== after.state && after.state !== "unknown") {
        envelope.observedEffects.push(`target_state_changed_during_write:${before.state}->${after.state}`);
        throw executionError("HIDDEN_STATE_CHANGE", "final_observation", `structured write changed target state from ${before.state} to ${after.state}`, {
          writeIssued,
          stateUnknown: Boolean(restoreError?.detail.stateUnknown || mainError?.detail.stateUnknown),
        });
      }
      if (after.state === "unknown") throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after structured write", { writeIssued, stateUnknown: true });
      if (restoreError) throw restoreError;
      if (mainError) throw mainError;
      if (verificationError) throw verificationError;
    }, {
      persistentMemorySession: true,
      requirePersistentMemorySession: tool === "write_variable" && (input.verificationConnection ?? "same_session") === "same_session",
      verificationConnection: input.verificationConnection ?? "same_session",
      verificationRequested: Boolean(input.verify),
    });
  }

  readCoreRegister(projectRoot: string, name: string): Promise<OperationEnvelope> {
    try { validateCoreRegister(name); } catch (error) { return Promise.resolve(this.failure(createOperationEnvelope("read_core_register"), error, "validation")); }
    return this.queued("read_core_register", projectRoot, [], async (envelope, _target, runtime) => {
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      requireHaltedCoreAccess(before, "core-register read");
      let result: CommandResult | undefined;
      let readFailure: OperationExecutionError | undefined;
      try {
        result = await runtime.probe.readRegister(name);
        if (!result.success) readFailure = coreReadError(result);
      } catch (error) {
        readFailure = unexpectedReadError(error, "core-register read backend rejected");
      }
      envelope.data = { name: name.toUpperCase(), command: result ? commandData(result) : null };
      let after: TargetStateObservation;
      try {
        after = await observe(runtime.probe);
      } catch (error) {
        throw readFailure ? readErrorWithUnknownState(readFailure) : unexpectedReadObservationError(error, "core-register read");
      }
      envelope.after = observationData(after);
      if (after.state === "unknown") {
        throw readFailure ? readErrorWithUnknownState(readFailure) : executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after core-register read", { stateUnknown: true });
      }
      if (after.state !== before.state) throw executionError("HIDDEN_STATE_CHANGE", "final_observation", "core-register read changed target run state", { stateUnknown: false });
      if (readFailure) throw readFailure;
      const completed = result!;
      envelope.data = { name: name.toUpperCase(), value: parseRegisterValue(completed, name), command: commandData(completed) };
      envelope.verification = { status: "observed", method: "probe_register_read" };
    });
  }

  readCoreRegisters(projectRoot: string): Promise<OperationEnvelope> {
    return this.queued("read_core_registers", projectRoot, [], async (envelope, _target, runtime) => {
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      requireHaltedCoreAccess(before, "core-register read");
      let result: CommandResult | undefined;
      let readFailure: OperationExecutionError | undefined;
      try {
        result = await runtime.probe.readAllRegisters();
        if (!result.success) readFailure = coreReadError(result);
      } catch (error) {
        readFailure = unexpectedReadError(error, "core-register-list read backend rejected");
      }
      envelope.data = { command: result ? commandData(result) : null };
      let after: TargetStateObservation;
      try {
        after = await observe(runtime.probe);
      } catch (error) {
        throw readFailure ? readErrorWithUnknownState(readFailure) : unexpectedReadObservationError(error, "core-register-list read");
      }
      envelope.after = observationData(after);
      if (after.state === "unknown") {
        throw readFailure ? readErrorWithUnknownState(readFailure) : executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after core-register-list read", { stateUnknown: true });
      }
      if (after.state !== before.state) throw executionError("HIDDEN_STATE_CHANGE", "final_observation", "core-register read changed target run state", { stateUnknown: false });
      if (readFailure) throw readFailure;
      const completed = result!;
      const registers = runtime.probe.parseRegisters(completed.rawOutput || completed.output) ?? {};
      const expected = [...Array.from({ length: 13 }, (_, index) => `R${index}`), "SP", "LR", "PC", "XPSR", "CONTROL", "PRIMASK", "BASEPRI", "FAULTMASK", "MSP", "PSP"];
      envelope.data = { registers, omitted: expected.filter((register) => registers[register] === undefined), command: commandData(completed) };
      envelope.verification = { status: "observed", method: "probe_register_read" };
    });
  }

  diagnoseCrash(projectRoot: string): Promise<OperationEnvelope> {
    return this.queued("diagnose_crash", projectRoot, [], async (envelope, target, runtime) => {
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      if (before.state === "running") {
        envelope.data = {
          targetExecutionState: before.state,
          diagnosis: { status: "partial", architecture: "cortex_m_unconfirmed", frameStatus: "not_collected", backtrace: { status: "unavailable", prerequisite: "target must already be halted" } },
        };
        throw executionError("HALT_REQUIRED", "precondition", "crash diagnosis requires an already halted target");
      }
      if (before.state === "unknown") {
        throw executionError("TARGET_STATE_UNKNOWN", "precondition", "target state is unknown before crash diagnosis; no register or memory read was issued", { stateUnknown: true });
      }

      let registerCommand: CommandResult | undefined;
      try { registerCommand = await runtime.probe.readAllRegisters(); }
      catch (error) { throw unexpectedReadError(error, "core-register collection backend rejected"); }
      if (!registerCommand.success) throw coreReadError(registerCommand);
      const registers = runtime.probe.parseRegisters(registerCommand.rawOutput || registerCommand.output) ?? {};
      const faultBytes = await readExact(runtime.probe, 0xE000ED04, 60, 4, "fault_register_read");
      const fault = cortexMFaultSnapshot(faultBytes);
      const frame = await cortexMExceptionFrame(runtime.probe, target, registers);
      const addresses = distinctNumbers([
        registerNumber(registers.PC),
        registerNumber(registers.LR),
        registerNumber(frame.stacked?.pc),
        registerNumber(fault.raw.MMFAR),
        registerNumber(fault.raw.BFAR),
      ]);
      const artifactMapping = mapArtifactAddresses(target, addresses);

      envelope.data = {
        targetExecutionState: "halted",
        architecture: "cortex_m",
        coreRegisters: { registers, command: commandData(registerCommand) },
        faultRegisters: fault,
        frame,
        artifactMapping,
        backtrace: { status: "unavailable", prerequisite: "open and halt an explicit managed GDB session before requesting its backtrace" },
      };
      let after: TargetStateObservation;
      try { after = await observe(runtime.probe); }
      catch (error) { throw unexpectedReadObservationError(error, "crash diagnosis"); }
      envelope.after = observationData(after);
      if (after.state === "unknown") throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after crash diagnosis", { stateUnknown: true });
      if (after.state !== before.state) throw executionError("HIDDEN_STATE_CHANGE", "final_observation", `crash diagnosis changed target state from ${before.state} to ${after.state}`);
      envelope.verification = { status: "observed", method: "halted_core_fault_stack_and_artifact_evidence" };
    });
  }

  writeCoreRegister(input: CoreRegisterWriteInput): Promise<OperationEnvelope> {
    try {
      validateCoreRegister(input.name);
      validateUint32(input.value, "value");
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope("write_core_register"), error, "validation"));
    }
    return this.queued("write_core_register", input.projectRoot, ["core_register_write"], async (envelope, _target, runtime) => {
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      requireHaltedCoreAccess(before, "core-register write");
      let result: CommandResult;
      try {
        result = await runtime.probe.writeCoreRegister(input.name, input.value);
      } catch (error) {
        envelope.data = { name: input.name.toUpperCase(), requested: input.value, readback: undefined, command: null };
        throw unexpectedPostWriteError(error, "write", "core-register write backend rejected after command dispatch");
      }
      envelope.data = { name: input.name.toUpperCase(), requested: input.value, readback: undefined, command: commandData(result) };
      if (!result.success) {
        const issued = result.errorCode !== ProbeErrorCode.PROBE_NOT_FOUND;
        throw commandError(result, "write", issued, issued);
      }
      envelope.observedEffects.push("core_register_write_issued");
      let readback: number | undefined;
      let readbackCommand: Record<string, unknown> | undefined;
      let verificationError: OperationExecutionError | undefined;
      if (input.verify) {
        try {
          const verify = await runtime.probe.readRegister(input.name);
          readbackCommand = commandData(verify);
          envelope.data = { name: input.name.toUpperCase(), requested: input.value, readback: undefined, command: commandData(result), readbackCommand };
          if (!verify.success) throw commandError(verify, "readback", true, true);
          readback = parseRegisterValue(verify, input.name);
          envelope.data = { name: input.name.toUpperCase(), requested: input.value, readback, command: commandData(result), readbackCommand };
          if (readback !== input.value) {
            verificationError = executionError("READBACK_MISMATCH", "verification", "core-register readback does not match requested value", { writeIssued: true });
          }
        } catch (error) {
          verificationError = normalizePostWriteError(error, "READBACK_FAILED", "readback", "core-register readback failed after the write", true);
        }
      }
      let after: TargetStateObservation;
      try {
        after = await observe(runtime.probe);
      } catch (error) {
        throw unexpectedPostWriteError(error, "final_observation", "target-state observation failed after core-register write");
      }
      envelope.after = observationData(after);
      if (before.state !== after.state) envelope.observedEffects.push(`target_state_changed_during_core_write:${before.state}->${after.state}`);
      envelope.data = { name: input.name.toUpperCase(), requested: input.value, readback, command: commandData(result), readbackCommand };
      envelope.verification = input.verify
        ? verificationError
          ? { status: "failed", method: "exact_readback", details: verificationError.detail }
          : { status: "verified", method: "exact_readback" }
        : { status: "executed_unverified" };
      if (verificationError) {
        if (after.state === "unknown" && !verificationError.detail.stateUnknown) {
          verificationError = normalizePostWriteError(verificationError, verificationError.detail.code, verificationError.detail.stage, verificationError.detail.message, true);
        }
        throw verificationError;
      }
      requireKnownPostWriteState(after, "core-register write");
      if (after.state !== before.state) {
        throw executionError("HIDDEN_STATE_CHANGE", "final_observation", `core-register write changed target state from ${before.state} to ${after.state}`, { writeIssued: true, stateUnknown: false });
      }
    });
  }

  flash(input: FlashInput): Promise<OperationEnvelope> {
    if (this.requireUserConfirmation && input.userConfirmed !== true) return Promise.resolve(userConfirmationRequired("flash"));
    let target: StoredTarget;
    let flashFile: ReturnType<typeof inspectFlashFile>;
    try {
      target = this.targets.require(input.projectRoot);
      flashFile = inspectFlashFile(target.projectRoot, input.path, input.baseAddress);
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope("flash"), error, "validation"));
    }
    return this.queuedWithTarget("flash", target, ["program_flash", "vendor_verify", "preserve_pre_flash_halt_state"], async (envelope, current, runtime) => {
      const liveFlashFile = inspectFlashFile(current.projectRoot, flashFile.path, flashFile.baseAddress);
      if (!sameFlashBinding(liveFlashFile, flashFile)) {
        throw new TargetStoreError("FLASH_INPUT_CHANGED", "flash input changed while the request waited for the Probe queue; no hardware command was issued");
      }
      const snapshotRoot = await createRepoTempDir("flash-");
      const snapshotPath = join(snapshotRoot, `input${extname(liveFlashFile.path).toLowerCase()}`);
      try {
        copyFileSync(liveFlashFile.path, snapshotPath, constants.COPYFILE_EXCL);
        const snapshot = inspectFlashFile(current.projectRoot, snapshotPath, liveFlashFile.baseAddress);
        if (snapshot.sha256 !== liveFlashFile.sha256 || snapshot.size !== liveFlashFile.size || snapshot.format !== liveFlashFile.format) {
          throw new TargetStoreError("FLASH_INPUT_CHANGED", "flash input changed while its immutable execution snapshot was created; no hardware command was issued");
        }
        chmodSync(snapshotPath, 0o400);
        const before = await observe(runtime.probe);
        envelope.before = observationData(before);
        let result: CommandResult;
        try {
          result = await runtime.probe.flash(snapshot.path, snapshot.baseAddress);
        } catch (error) {
          envelope.data = { file: liveFlashFile, executionSnapshot: { sha256: snapshot.sha256, size: snapshot.size }, command: null };
          const updated = await this.transitionArtifact(current, "unverified", "flash_backend_rejected_after_dispatch", true);
          refreshArtifact(envelope, updated);
          throw unexpectedPostWriteError(error, "flash_verify", "flash backend rejected after command dispatch");
        }
        envelope.data = { file: liveFlashFile, executionSnapshot: { sha256: snapshot.sha256, size: snapshot.size }, command: commandData(result) };
        let snapshotAfter: FlashImageBinding;
        try {
          snapshotAfter = inspectFlashFile(current.projectRoot, snapshot.path, snapshot.baseAddress);
        } catch (error) {
          const updated = await this.transitionArtifact(current, "unverified", "flash_snapshot_lost_after_issue", true);
          refreshArtifact(envelope, updated);
          throw executionError("FLASH_SNAPSHOT_CHANGED", "flash_verify", error instanceof Error ? error.message : String(error), { writeIssued: true, stateUnknown: true });
        }
        if (!sameFlashBinding(snapshotAfter, snapshot)) {
          const updated = await this.transitionArtifact(current, "unverified", "flash_snapshot_changed_after_issue", true);
          refreshArtifact(envelope, updated);
          throw executionError("FLASH_SNAPSHOT_CHANGED", "flash_verify", "immutable flash snapshot changed while the vendor tool was reading it", { writeIssued: true, stateUnknown: true });
        }
        if (!result.success) {
          const issued = result.errorCode !== ProbeErrorCode.PROBE_NOT_FOUND;
          if (issued) {
            const updated = await this.transitionArtifact(current, "unverified", "flash_failed_after_issue", true);
            refreshArtifact(envelope, updated);
          }
          throw commandError(result, "flash_verify", issued, issued);
        }
        envelope.observedEffects.push("flash_program_issued", "vendor_verification_succeeded");
        let vendorAfter: TargetStateObservation | undefined;
        let vendorObservationError: unknown;
        try {
          vendorAfter = await observeAfterMutation(runtime.probe, "flash");
          envelope.after = observationData(vendorAfter);
        } catch (error) {
          vendorObservationError = error;
        }
        if (vendorAfter && before.state !== vendorAfter.state) {
          envelope.observedEffects.push(`vendor_target_state_change:${before.state}->${vendorAfter.state}`);
        } else if (!vendorAfter) {
          envelope.observedEffects.push("vendor_target_state_unobserved");
        }
        let finalAfter = vendorAfter;
        let haltResult: CommandResult | undefined;
        let haltError: unknown;
        let finalObservationError: unknown;
        const haltRestoreAttempted = before.state === "halted" && vendorAfter?.state !== "halted";
        if (haltRestoreAttempted) {
          try {
            haltResult = await runtime.probe.halt();
            if (haltResult.success) envelope.observedEffects.push("post_flash_halt_issued");
          } catch (error) {
            haltError = error;
          }
          try {
            finalAfter = await observe(runtime.probe);
            envelope.after = observationData(finalAfter);
            if (haltResult?.success && finalAfter.state === "halted") {
              envelope.observedEffects.push("post_flash_halt_restored");
            }
          } catch (error) {
            finalObservationError = error;
            finalAfter = undefined;
            envelope.after = {
              targetState: "unknown",
              source: "post_flash_state_restore",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
        const associated = current.artifactFlashImages.some((item) => item.sha256 === liveFlashFile.sha256 && item.baseAddress === liveFlashFile.baseAddress);
        const updated = await this.transitionArtifact(
          current,
          associated ? "verified" : "unverified",
          associated ? "associated_flash_vendor_verify" : "unassociated_flash_vendor_verify",
          true,
          associated,
        );
        refreshArtifact(envelope, updated);
        envelope.data = {
          file: liveFlashFile,
          executionSnapshot: { sha256: snapshot.sha256, size: snapshot.size },
          associatedWithArtifact: associated,
          command: commandData(result),
          vendorTargetStateAfter: vendorAfter?.state ?? "unobserved",
          haltRestore: haltRestoreAttempted ? {
            attempted: true,
            command: haltResult ? commandData(haltResult) : null,
            dispatchError: haltError instanceof Error ? haltError.message : haltError ? String(haltError) : null,
            finalObservationError: finalObservationError instanceof Error ? finalObservationError.message : finalObservationError ? String(finalObservationError) : null,
            finalState: finalAfter?.state ?? "unknown",
          } : { attempted: false },
        };
        envelope.verification = { status: "verified", method: "immutable_snapshot_and_vendor_flash_verify" };
        if (!associated) envelope.warnings.push("Flash verified by the vendor, but its hash is not associated with the configured Artifact.");
        if (before.state === "halted" && haltRestoreAttempted) {
          if (vendorObservationError) {
            throw executionError(
              "POST_FLASH_STATE_OBSERVATION_FAILED",
              "post_flash_state_restore",
              "target state could not be observed immediately after flash; a halt was attempted and the final state was recorded",
              { writeIssued: true, stateUnknown: finalAfter?.state === "unknown" || finalAfter === undefined },
            );
          }
          if (haltError || (haltResult && !haltResult.success)) {
            throw executionError(
              "POST_FLASH_HALT_FAILED",
              "post_flash_state_restore",
              haltError instanceof Error ? haltError.message : haltResult?.error || haltResult?.output || "post-Flash halt failed",
              { writeIssued: true, stateUnknown: finalAfter?.state === "unknown" || finalAfter === undefined },
            );
          }
          if (finalObservationError || !finalAfter || finalAfter.state !== "halted") {
            throw executionError(
              "POST_FLASH_FINAL_STATE_UNCONFIRMED",
              "post_flash_state_restore",
              finalObservationError instanceof Error
                ? finalObservationError.message
                : `post-Flash halt did not produce a verified halted state; observed ${finalAfter?.state ?? "unknown"}`,
              { writeIssued: true, stateUnknown: finalAfter?.state === "unknown" || finalAfter === undefined },
            );
          }
        } else if (vendorObservationError) {
          throw vendorObservationError;
        } else if (vendorAfter?.state === "unknown") {
          throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after flash", { writeIssued: true, stateUnknown: true });
        }
      } finally {
        try { chmodSync(snapshotPath, 0o600); } catch { /* snapshot may not have been created */ }
        let cleanupError: Error | undefined;
        try { cleanupError = await this.cleanupFlashSnapshot(snapshotRoot); }
        catch (error) { cleanupError = error instanceof Error ? error : new Error(String(error)); }
        if (cleanupError) {
          envelope.warnings.push(`Temporary flash snapshot cleanup failed; the reported hardware result remains authoritative and local cleanup may be required: ${cleanupError.message}`);
        }
      }
    });
  }

  erase(input: EraseInput): Promise<OperationEnvelope> {
    if (this.requireUserConfirmation && input.userConfirmed !== true) return Promise.resolve(userConfirmationRequired("erase"));
    const { projectRoot, verifyBlank = false } = input;
    return this.queued("erase", projectRoot, ["erase_flash"], async (envelope, target, runtime) => {
      if (verifyBlank && !runtime.probe.supportsBlankVerification()) throw executionError("BLANK_VERIFICATION_UNSUPPORTED", "validation", "this backend has no trustworthy blank verification; erase was not issued");
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      let result: CommandResult;
      try {
        result = await runtime.probe.erase();
      } catch (error) {
        envelope.data = { command: null, verifyBlank };
        const updated = await this.transitionArtifact(target, "mismatch", "erase_backend_rejected_after_dispatch", true);
        refreshArtifact(envelope, updated);
        throw unexpectedPostWriteError(error, "erase", "erase backend rejected after command dispatch");
      }
      envelope.data = { command: commandData(result), verifyBlank };
      if (!result.success) {
        const issued = result.errorCode !== ProbeErrorCode.PROBE_NOT_FOUND;
        if (issued) {
          const updated = await this.transitionArtifact(target, "mismatch", "erase_failed_after_issue", true);
          refreshArtifact(envelope, updated);
        }
        throw commandError(result, "erase", issued, issued);
      }
      envelope.observedEffects.push("erase_issued");
      const after = await observeAfterMutation(runtime.probe, "erase");
      envelope.after = observationData(after);
      const updated = await this.transitionArtifact(target, "mismatch", "erase", true);
      refreshArtifact(envelope, updated);
      envelope.data = { command: commandData(result), verifyBlank };
      envelope.verification = { status: verifyBlank ? "verified" : "executed_unverified", method: verifyBlank ? "backend_blank_check" : undefined };
      requireKnownPostWriteState(after, "erase");
      if (before.state !== after.state) {
        envelope.observedEffects.push(`vendor_target_state_change:${before.state}->${after.state}`);
      }
    });
  }

  probeCommand(input: ProbeCommandInput): Promise<OperationEnvelope> {
    if (this.requireUserConfirmation && input.userConfirmed !== true) return Promise.resolve(userConfirmationRequired("probe_command"));
    const { projectRoot, commands } = input;
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 100 || commands.some((command) => !command || /[\0\r\n]/.test(command))) {
      return Promise.resolve(failEnvelope(createOperationEnvelope("probe_command"), {
        code: "INVALID_COMMAND", stage: "validation", message: "commands must contain 1..100 exact single-line J-Link commands", retryable: false, writeIssued: false, stateUnknown: false,
      }));
    }
    return this.queued("probe_command", projectRoot, ["raw_probe_command", "unknown_side_effects"], async (envelope, target, runtime) => {
      const before = await observe(runtime.probe);
      envelope.before = observationData(before);
      let result: CommandResult;
      try {
        result = await runtime.probe.executeRaw(commands);
      } catch (error) {
        envelope.data = { commands: [...commands], command: null, sideEffects: "unknown" };
        const updated = await this.transitionArtifact(target, "unverified", "probe_command_backend_rejected_after_dispatch", true);
        refreshArtifact(envelope, updated);
        let after: TargetStateObservation | undefined;
        try {
          after = await observe(runtime.probe);
          envelope.after = observationData(after);
          if (before.state !== after.state) envelope.observedEffects.push(`raw_target_state_change:${before.state}->${after.state}`);
        } catch { /* final state remains unknown */ }
        throw executionError("PROBE_COMMAND_REJECTED", "raw_command", error instanceof Error ? error.message : "raw Probe backend rejected after command dispatch", {
          writeIssued: true,
          stateUnknown: !after || after.state === "unknown",
        });
      }
      envelope.data = { commands: [...commands], command: commandData(result), sideEffects: "unknown" };
      const writeIssued = result.errorCode !== ProbeErrorCode.PROBE_NOT_FOUND;
      if (writeIssued) {
        const updated = await this.transitionArtifact(target, "unverified", result.success ? "probe_command" : "probe_command_failed_after_issue", true);
        refreshArtifact(envelope, updated);
      }
      if (!result.success) {
        if (writeIssued) {
          envelope.observedEffects.push("raw_command_issued", "side_effects_unknown");
          let after: TargetStateObservation | undefined;
          try {
            after = await observe(runtime.probe);
            envelope.after = observationData(after);
            if (before.state !== after.state) envelope.observedEffects.push(`raw_target_state_change:${before.state}->${after.state}`);
          } catch { /* final state remains unknown */ }
          throw commandError(result, "raw_command", true, !after || after.state === "unknown");
        }
        throw commandError(result, "raw_command", false, false);
      }
      envelope.observedEffects.push("raw_command_issued", "side_effects_unknown");
      const after = await observeAfterMutation(runtime.probe, "raw Probe command");
      envelope.after = observationData(after);
      const updated = this.targets.require(target.projectRoot);
      refreshArtifact(envelope, updated);
      envelope.data = { commands: [...commands], command: commandData(result), sideEffects: "unknown" };
      envelope.verification = { status: "executed_unverified" };
      envelope.warnings.push("Raw Probe command semantics are not interpreted; side effects are unknown.");
      requireKnownPostWriteState(after, "raw Probe command");
    });
  }

  private queued(
    tool: string,
    projectRoot: string,
    requestedEffects: string[],
    operation: (envelope: OperationEnvelope, target: StoredTarget, runtime: DirectTargetRuntime) => Promise<void>,
    options: DirectQueueOptions = {},
  ): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); } catch (error) { return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "target_lookup")); }
    return this.queuedWithTarget(tool, target, requestedEffects, operation, options);
  }

  private async queuedWithTarget(
    tool: string,
    target: StoredTarget,
    requestedEffects: string[],
    operation: (envelope: OperationEnvelope, target: StoredTarget, runtime: DirectTargetRuntime) => Promise<void>,
    options: DirectQueueOptions = {},
  ): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope(tool, target);
    envelope.requestedEffects = requestedEffects;
    let activeMetadata: QueueMetadata | undefined;
    let activeTarget: StoredTarget | undefined;
    try {
      const localMemoryOwner = this.memorySessions?.localOwnerForTarget(target);
      const execution = await this.queue.runExclusive(target.probeSerial, async (metadata) => {
        activeMetadata = metadata;
        applyQueueMetadata(envelope, metadata);
        const current = this.targets.requireCurrent(target);
        activeTarget = current;
        refreshArtifact(envelope, current);
        const memoryClose = options.persistentMemorySession ? undefined : await this.memorySessions?.closeForTarget(current);
        const persistentProbe = options.persistentMemorySession ? await this.memorySessions?.probeFor(current, metadata) : undefined;
        if (options.requirePersistentMemorySession && this.memorySessions && !persistentProbe) {
          throw new MemorySessionError("SAME_SESSION_UNAVAILABLE", "write_variable requires a validated persistent memory session for same-session verification", true, false);
        }
        const runtime = persistentProbe ? { probe: persistentProbe } : await this.runtimeFor(current);
        let memorySessionClose: Record<string, unknown> | undefined;
        try {
          if (memoryClose) {
            const afterClose = await observe(runtime.probe);
            memorySessionClose = { targetStateBeforeClose: memoryClose.targetStateBeforeClose, targetStateAfterReconnect: afterClose.state };
            if (memoryClose.targetStateBeforeClose === "unknown" || afterClose.state === "unknown") {
              throw executionError("POST_OPERATION_STATE_UNKNOWN", "memory_session_close", "memory-session close could not prove the target state before the competing operation", { stateUnknown: true });
            }
            if (memoryClose.targetStateBeforeClose !== afterClose.state) {
              throw executionError("HIDDEN_STATE_CHANGE", "memory_session_close", `memory-session close changed target state from ${memoryClose.targetStateBeforeClose} to ${afterClose.state}`, { stateUnknown: false });
            }
          }
          await operation(envelope, current, runtime);
        } finally {
          if (memorySessionClose) {
            envelope.data = {
              ...(envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : {}),
              memorySessionClose,
            };
          }
          if (options.persistentMemorySession) this.annotateMemorySession(envelope, tool, persistentProbe, options.verificationConnection, options.verificationRequested);
        }
        const completed = this.targets.requireCurrent(current);
        refreshArtifact(envelope, completed);
        if (observationInvalidatesConnectionEvidence(envelope)) {
          const hardwareEffectIssued = requestedEffects.length > 0 && envelope.observedEffects.length > 0;
          const updated = await this.transitionArtifact(completed, "unverified", "probe_connection_identity_lost", hardwareEffectIssued);
          refreshArtifact(envelope, updated);
          envelope.warnings.push("Live Artifact verification was invalidated because a state observation lost Probe/Target identity.");
        }
      }, localMemoryOwner ? {
        allowedOwnerKinds: ["memory"],
        ownerTarget: { projectRoot: target.projectRoot, targetGeneration: target.generation },
        requiredOwner: localMemoryOwner,
      } : {});
      envelope.timestamps.endedAt = execution.endedAt;
      return finishEnvelope(envelope, true);
    } catch (error) {
      if (activeMetadata) applyQueueMetadata(envelope, activeMetadata);
      const connectionEvidenceLost = invalidatesConnectionEvidence(error, envelope);
      const postOperationObservationFailed = isIssuedPostOperationObservationFailure(error, envelope);
      if (activeTarget && (connectionEvidenceLost || postOperationObservationFailed)) {
        try {
          const source = connectionEvidenceLost ? "probe_connection_identity_lost" : "post_operation_observation_failed";
          const updated = await this.targets.setArtifactMatch(activeTarget.projectRoot, "unverified", source, {
            targetGeneration: activeTarget.generation,
            probeSerial: activeTarget.probeSerial,
            artifactGeneration: activeTarget.artifact?.generation,
          });
          refreshArtifact(envelope, updated);
          envelope.warnings.push(connectionEvidenceLost
            ? "Live Artifact verification was invalidated because Probe/Target connection identity was lost."
            : "Live Artifact verification was invalidated because the final observation failed after a hardware effect was issued.");
        } catch {
          // The original post-write failure is already stateUnknown=true. Do
          // not replace it with a persistence error or imply that verification
          // evidence survived.
          envelope.warnings.push("Artifact invalidation could not be persisted after an uncertain hardware outcome.");
        }
      }
      return this.failure(envelope, error, activeMetadata ? "execution" : "queue");
    }
  }

  private failure(envelope: OperationEnvelope, error: unknown, stage: string): OperationEnvelope {
    if (error instanceof OperationExecutionError) return failEnvelope(envelope, error.detail);
    if (error instanceof TargetStoreError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: false, writeIssued: false, stateUnknown: false });
    if (error instanceof ProbeQueueError) {
      attachQueueOwner(envelope, error);
      const code = queueFailureCode(error);
      return failEnvelope(envelope, { code, stage, message: error.message, retryable: code.endsWith("_ACTIVE") || error.code.includes("BUSY"), writeIssued: false, stateUnknown: false });
    }
    if (error instanceof MemorySessionError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: error.retryable, writeIssued: false, stateUnknown: error.stateUnknown });
    return failEnvelope(envelope, { code: "INTERNAL_ERROR", stage, message: error instanceof Error ? error.message : String(error), retryable: false, writeIssued: false, stateUnknown: false });
  }

  private annotateMemorySession(
    envelope: OperationEnvelope,
    tool: string,
    probe: ProbeBackend | undefined,
    verificationConnection: "same_session" | "independent_session" = "same_session",
    verificationRequested = false,
  ): void {
    const data = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? envelope.data as Record<string, unknown>
      : {};
    const session = probe ? persistentMemorySessionEvidence(probe) : undefined;
    if (session) data.memorySession = session;
    if (tool === "write_variable") {
      const actualConnection = session ? verificationConnection : verificationConnection === "same_session" ? "per_operation_backend" : verificationConnection;
      data.verificationConnection = actualConnection;
      data.verificationSource = verificationRequested
        ? actualConnection === "independent_session" ? "independent_session_readback"
          : actualConnection === "same_session" ? "same_session_readback"
            : "per_operation_backend_readback"
        : "not_requested";
      data.targetConsumption = "not_observed";
    }
    envelope.data = data;
  }

  private async transitionArtifact(
    target: StoredTarget,
    status: "unverified" | "verified" | "mismatch",
    source: string,
    writeIssued: boolean,
    migrateFlashIdentityOnVerified = false,
  ): Promise<StoredTarget> {
    try {
      return await this.targets.setArtifactMatch(target.projectRoot, status, source, {
        targetGeneration: target.generation,
        probeSerial: target.probeSerial,
        artifactGeneration: target.artifact?.generation,
        migrateFlashIdentityOnVerified,
      });
    } catch (error) {
      const code = error instanceof TargetStoreError ? error.code : "ARTIFACT_STATE_PERSIST_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      throw executionError(code, "artifact_state", message, { writeIssued, stateUnknown: writeIssued });
    }
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

async function applyRawMemoryTransaction(
  envelope: OperationEnvelope,
  input: MemoryWriteInput,
  requested: Buffer,
  regionStatus: string,
  before: TargetStateObservation,
  transaction: ProbeMemoryTransactionResult,
  probe: ProbeBackend,
): Promise<void> {
  const command = commandData(transaction.command);
  const writeIssued = transaction.command.writeIssued ?? transaction.command.success;
  if (writeIssued) envelope.observedEffects.push("memory_write_issued");

  let mainError: OperationExecutionError | undefined;
  if (!transaction.command.success) {
    mainError = commandError(transaction.command, "write", writeIssued, transaction.command.stateUnknown ?? writeIssued);
  } else if (!writeIssued) {
    mainError = executionError("WRITE_ISSUE_UNCONFIRMED", "write", "successful memory transaction did not confirm write dispatch", { stateUnknown: true });
  } else if (input.captureOld && !transaction.oldBytes) {
    mainError = executionError("OLD_VALUE_READ_FAILED", "old_value_read", "memory transaction returned no captured old value", { writeIssued: true, stateUnknown: true });
  }

  const transactionReadback = input.verify ? transaction.readbacks[0] : undefined;
  let readback: Buffer | undefined;
  let readbackCommand: Record<string, unknown> | undefined;
  let verificationError: OperationExecutionError | undefined;
  if (input.verify && !mainError) {
    try {
      readback = await readExact(probe, input.address, input.byteCount, input.width / 8 as 1 | 2 | 4, "post_connection_readback", (result) => {
        readbackCommand = commandData(result);
      });
      if (!readback.equals(requested)) {
        verificationError = executionError("READBACK_MISMATCH", "verification", "independent post-connection memory readback does not match requested bytes", { writeIssued: true });
      }
    } catch (error) {
      verificationError = normalizePostWriteError(error, "READBACK_FAILED", "post_connection_readback", "independent memory readback failed after the write transaction", true);
    }
  }
  envelope.data = {
    address: input.address,
    width: input.width,
    byteCount: input.byteCount,
    oldHex: transaction.oldBytes?.toString("hex"),
    requestedHex: requested.toString("hex"),
    readbackHex: readback?.toString("hex"),
    transactionReadbackHex: transactionReadback?.toString("hex"),
    regionStatus,
    oldReadCommand: transaction.oldBytes ? command : undefined,
    command,
    readbackCommand,
  };
  envelope.verification = input.verify
    ? verificationError
      ? { status: "failed", method: "exact_readback", details: verificationError.detail }
      : mainError
        ? { status: "failed", method: "write_command" }
        : { status: "verified", method: "exact_readback" }
    : { status: mainError ? "failed" : "executed_unverified" };

  let after: TargetStateObservation;
  try { after = await observe(probe); }
  catch (error) {
    throw normalizePostWriteError(error, "POST_OPERATION_STATE_UNKNOWN", "final_observation", "target-state observation failed after memory transaction", writeIssued);
  }
  envelope.after = observationData(after);
  const transactionStateChanged = transaction.targetStateBefore !== undefined && transaction.targetStateBefore !== before.state
    || transaction.targetStateAfter !== undefined && transaction.targetStateAfter !== before.state;
  if (transactionStateChanged || (after.state !== "unknown" && after.state !== before.state)) {
    envelope.observedEffects.push(`target_state_changed_during_write:${before.state}->${after.state}`);
    throw executionError("HIDDEN_STATE_CHANGE", "final_observation", "memory transaction changed target state", { writeIssued, stateUnknown: false });
  }
  if (after.state === "unknown") throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after memory transaction", { writeIssued, stateUnknown: writeIssued });
  if (mainError) throw mainError;
  if (verificationError) throw verificationError;
}

async function applyProbeMemoryTransaction(
  envelope: OperationEnvelope,
  input: StructuredMemoryWriteInput,
  requested: Buffer,
  comparator: ScalarComparator,
  before: TargetStateObservation,
  transaction: ProbeMemoryTransactionResult,
  probe: ProbeBackend,
): Promise<void> {
  const command = commandData(transaction.command);
  const writeIssued = transaction.command.writeIssued ?? transaction.command.success;
  if (writeIssued) envelope.observedEffects.push("structured_memory_write_issued");
  if (transaction.restoreIssued) envelope.observedEffects.push("structured_restore_write_issued");

  let mainError: OperationExecutionError | undefined;
  if (!transaction.command.success) {
    mainError = commandError(transaction.command, "write", writeIssued, transaction.command.stateUnknown ?? writeIssued);
  } else if (!writeIssued) {
    mainError = executionError("WRITE_ISSUE_UNCONFIRMED", "write", "successful memory transaction did not confirm write dispatch", { stateUnknown: true });
  }
  const oldRequired = Boolean(input.captureOld || input.restore);
  if (oldRequired && !transaction.oldBytes && !mainError) {
    mainError = executionError("OLD_VALUE_READ_FAILED", "old_value_read", "memory transaction returned no captured old value", { writeIssued, stateUnknown: writeIssued });
  }

  let readback: Buffer | undefined;
  let readbackCommand: Record<string, unknown> | undefined;
  let verificationDetails: Record<string, unknown> | undefined;
  let verificationError: OperationExecutionError | undefined;
  if (input.verify && !mainError) {
    if (comparator.mode !== "observe" && !input.restore) {
      try {
        readback = await readExact(probe, input.address, input.byteCount, input.width / 8 as 1 | 2 | 4, "post_connection_readback", (result) => {
          readbackCommand = commandData(result);
        });
        const compared = compareStructured(readback, requested, comparator);
        verificationDetails = { ...compared.details, observationCount: 1, command: readbackCommand, connection: "independent_post_write" };
        if (!compared.pass) verificationError = executionError("READBACK_MISMATCH", "verification", "independent post-connection readback did not satisfy the requested comparator", { writeIssued: true });
      } catch (error) {
        verificationError = normalizePostWriteError(error, "READBACK_FAILED", "post_connection_readback", "independent structured readback failed after the write transaction", true);
      }
    } else if (transaction.readbacks.length === 0) {
      verificationError = executionError("READBACK_FAILED", "readback", "memory transaction returned no readback samples", { writeIssued: true, stateUnknown: true });
    } else {
      const verified = verifyTransactionReadbacks(transaction.readbacks, requested, comparator, transaction);
      readback = verified.readback;
      readbackCommand = command;
      verificationDetails = { ...verified.details, command };
      if (!verified.pass) verificationError = executionError("READBACK_MISMATCH", "verification", "structured readback did not satisfy the requested comparator", { writeIssued: true });
    }
  }

  let restoreReadback: Buffer | undefined;
  let restoreReadCommand: Record<string, unknown> | undefined;
  let restoreVerified = false;
  let restoreError: OperationExecutionError | undefined;
  if (input.restore && writeIssued) {
    if (!transaction.restoreIssued || !transaction.oldBytes) {
      restoreError = executionError("RESTORE_FAILED", "restore", "memory transaction did not issue a restorable old-value write", { writeIssued: true, stateUnknown: true });
    } else {
      try {
        restoreReadback = await readExact(probe, input.address, input.byteCount, input.width / 8 as 1 | 2 | 4, "post_connection_restore_readback", (result) => {
          restoreReadCommand = commandData(result);
        });
        restoreVerified = restoreReadback.equals(transaction.oldBytes);
        if (!restoreVerified) restoreError = executionError("RESTORE_FAILED", "post_connection_restore_readback", "independent restore readback does not match the captured old value", { writeIssued: true, stateUnknown: true });
      } catch (error) {
        restoreError = normalizePostWriteError(error, "RESTORE_FAILED", "post_connection_restore_readback", "independent restore readback failed", true);
      }
    }
  }
  envelope.data = {
    ...(input.semanticData ?? {}),
    address: input.address,
    width: input.width,
    byteCount: input.byteCount,
    oldHex: transaction.oldBytes?.toString("hex"),
    requestedHex: requested.toString("hex"),
    readbackHex: readback?.toString("hex"),
    transactionReadbackHex: transaction.readbacks.at(-1)?.toString("hex"),
    oldReadCommand: transaction.oldBytes ? command : undefined,
    command,
    comparator: input.verify ? comparator : undefined,
    verificationDetails,
    readbackCommand,
    restore: input.restore ? {
      requestedHex: transaction.oldBytes?.toString("hex"),
      readbackHex: restoreReadback?.toString("hex"),
      transactionReadbackHex: transaction.restoreReadback?.toString("hex"),
      command: transaction.restoreIssued ? command : undefined,
      readbackCommand: restoreReadCommand,
      status: !writeIssued ? "not_needed" : restoreVerified ? "verified" : "uncertain",
    } : { status: "not_requested" },
  };
  envelope.verification = input.verify
    ? verificationError
      ? { status: "failed", method: comparatorMethod(comparator), details: verificationDetails }
      : mainError
        ? { status: "failed", method: "write_command" }
        : { status: "verified", method: comparatorMethod(comparator), details: verificationDetails }
    : { status: mainError ? "failed" : "executed_unverified" };

  let after: TargetStateObservation;
  try { after = await observe(probe); }
  catch (error) {
    throw normalizePostWriteError(error, "POST_OPERATION_STATE_UNKNOWN", "final_observation", "target-state observation failed after structured memory transaction", writeIssued);
  }
  envelope.after = observationData(after);
  const transactionStateChanged = transaction.targetStateBefore !== undefined && transaction.targetStateBefore !== before.state
    || transaction.targetStateAfter !== undefined && transaction.targetStateAfter !== before.state;
  if (transactionStateChanged || (after.state !== "unknown" && after.state !== before.state)) {
    envelope.observedEffects.push(`target_state_changed_during_write:${before.state}->${after.state}`);
    throw executionError("HIDDEN_STATE_CHANGE", "final_observation", "structured memory transaction changed target state", {
      writeIssued,
      stateUnknown: Boolean(restoreError?.detail.stateUnknown || mainError?.detail.stateUnknown),
    });
  }
  if (after.state === "unknown") throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after structured memory transaction", { writeIssued, stateUnknown: writeIssued });
  if (restoreError) throw restoreError;
  if (mainError) throw mainError;
  if (verificationError) throw verificationError;
}

function verifyTransactionReadbacks(
  readbacks: Buffer[],
  expected: Buffer,
  comparator: ScalarComparator,
  transaction: ProbeMemoryTransactionResult,
): { pass: boolean; readback: Buffer; details: Record<string, unknown> } {
  const inner = comparator.mode === "observe" ? comparator.comparator : comparator;
  if (comparator.mode !== "observe") {
    const readback = readbacks[0];
    const compared = compareStructured(readback, expected, inner);
    return { pass: compared.pass, readback, details: { ...compared.details, observationCount: 1 } };
  }
  const fallbackAt = transaction.verificationEndedAt ?? transaction.verificationStartedAt ?? new Date().toISOString();
  const observations: Array<{ at: string; hex: string; numeric?: number }> = [];
  let last = readbacks[0];
  let matchedAt: string | undefined;
  let matchedAtPoll: number | undefined;
  let matchedEvidence: Record<string, unknown> | undefined;
  for (let index = 0; index < readbacks.length; index += 1) {
    last = readbacks[index];
    const at = transaction.readbackObservedAt?.[index] ?? fallbackAt;
    const numeric = observedNumeric(last, inner);
    observations.push({ at, hex: last.toString("hex"), ...(numeric === undefined ? {} : { numeric }) });
    const compared = compareStructured(last, expected, inner);
    if (compared.pass && !matchedAt) {
      matchedAt = at;
      matchedAtPoll = index + 1;
      matchedEvidence = compared.details;
    }
  }
  const values = observations.flatMap((item) => item.numeric === undefined ? [] : [item.numeric]);
  return {
    pass: Boolean(matchedAt),
    readback: last,
    details: {
      observationCount: observations.length,
      startedAt: transaction.verificationStartedAt ?? observations[0]?.at ?? fallbackAt,
      endedAt: transaction.verificationEndedAt ?? observations.at(-1)?.at ?? fallbackAt,
      matchedAt,
      matchedAtPoll,
      matchedEvidence,
      first: observations[0] ?? null,
      last: observations.at(-1) ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      numericSummary: values.length ? "typed" : "not_available",
    },
  };
}

const FLASH_SNAPSHOT_CLEANUP_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64] as const;
const RETRYABLE_FLASH_SNAPSHOT_CLEANUP_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);

export async function removeFlashSnapshotDirectory(snapshotRoot: string, options: FlashSnapshotCleanupOptions = {}): Promise<Error | undefined> {
  const remove = options.remove ?? ((root: string) => rmSync(root, { recursive: true, force: true }));
  const retryDelays = options.retryDelaysMs ?? FLASH_SNAPSHOT_CLEANUP_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(snapshotRoot);
      return undefined;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      if (!RETRYABLE_FLASH_SNAPSHOT_CLEANUP_CODES.has(String(code)) || attempt >= retryDelays.length) return normalized;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, retryDelays[attempt])));
    }
  }
}

function applyQueueMetadata(envelope: OperationEnvelope, metadata: QueueMetadata): void {
  envelope.queueSequence = metadata.queueSequence;
  envelope.timestamps.queuedAt = metadata.queuedAt;
  envelope.timestamps.startedAt = metadata.startedAt;
}

async function observe(probe: ProbeBackend): Promise<TargetStateObservation> {
  return probe.observeTargetState();
}

async function observeAfterMutation(probe: ProbeBackend, operation: string): Promise<TargetStateObservation> {
  try {
    return await observe(probe);
  } catch (error) {
    throw unexpectedPostWriteError(error, "final_observation", `target-state observation failed after ${operation}`);
  }
}

function observationData(observation: TargetStateObservation): Record<string, unknown> {
  return { targetState: observation.state, source: observation.source, command: commandData(observation.result) };
}

function commandData(result: CommandResult): Record<string, unknown> {
  return { success: result.success, output: result.output, rawOutput: result.rawOutput, stderr: result.stderr, error: result.error, errorCode: result.errorCode, exitCode: result.exitCode, exitSignal: result.exitSignal, writeIssued: result.writeIssued, stateUnknown: result.stateUnknown };
}

function commandError(result: CommandResult, stage: string, writeIssued: boolean, stateUnknown = false): OperationExecutionError {
  return executionError(result.errorCode ?? "PROBE_COMMAND_FAILED", stage, result.error || result.output || "Probe command failed", {
    retryable: result.errorCode === ProbeErrorCode.TIMEOUT || result.errorCode === ProbeErrorCode.TARGET_UNREACHABLE,
    writeIssued,
    stateUnknown: result.stateUnknown ?? stateUnknown,
  });
}

function memoryReadCommandError(result: CommandResult, stage: string): OperationExecutionError {
  if (result.errorCode === ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE) {
    return executionError("HALT_REQUIRED", stage, "the requested memory read is unavailable while the target runs; call halt explicitly if appropriate");
  }
  return commandError(result, stage, false);
}

function normalizePostWriteError(
  error: unknown,
  fallbackCode: string,
  fallbackStage: string,
  fallbackMessage: string,
  stateUnknown: boolean,
): OperationExecutionError {
  if (error instanceof OperationExecutionError) {
    return executionError(error.detail.code, error.detail.stage, error.detail.message, {
      retryable: error.detail.retryable,
      writeIssued: true,
      stateUnknown: error.detail.stateUnknown || stateUnknown,
    });
  }
  return executionError(fallbackCode, fallbackStage, error instanceof Error ? error.message : fallbackMessage, {
    writeIssued: true,
    stateUnknown,
  });
}

function unexpectedPostWriteError(error: unknown, stage: string, message: string): OperationExecutionError {
  return normalizePostWriteError(error, "PROBE_COMMAND_REJECTED", stage, message, true);
}

function coreReadError(result: CommandResult): OperationExecutionError {
  const text = `${result.error ?? ""} ${result.output} ${result.rawOutput}`;
  if (/cpu\s+is\s+running|target\s+is\s+running|must\s+be\s+halted|halt\s+required/i.test(text)) {
    return executionError("HALT_REQUIRED", "read", "core-register data is unavailable while the target runs; call halt explicitly if appropriate");
  }
  return commandError(result, "read", false);
}

function unexpectedReadError(error: unknown, message: string): OperationExecutionError {
  if (error instanceof OperationExecutionError) return error;
  return executionError("PROBE_COMMAND_REJECTED", "read", error instanceof Error ? error.message : message, { stateUnknown: false });
}

function readErrorWithUnknownState(error: OperationExecutionError): OperationExecutionError {
  return executionError(error.detail.code, error.detail.stage, error.detail.message, {
    retryable: error.detail.retryable,
    writeIssued: false,
    stateUnknown: true,
  });
}

function unexpectedReadObservationError(error: unknown, operation: string): OperationExecutionError {
  return executionError(
    "POST_OPERATION_STATE_UNKNOWN",
    "final_observation",
    error instanceof Error ? error.message : `target-state observation failed after ${operation}`,
    { stateUnknown: true },
  );
}

function memoryBytes(probe: ProbeBackend, result: CommandResult, address: number, byteCount: number, accessSize: 1 | 2 | 4): Buffer {
  const rawDump = probe.parseMemoryDump(result.rawOutput);
  const dump = rawDump.length > 0 ? rawDump : probe.parseMemoryDump(result.output);
  const byAddress = new Map<number, number>();
  for (const line of dump) {
    let cursor = Number.parseInt(line.address, 16);
    for (const token of line.hex.split(/\s+/).filter(Boolean)) {
      let bytes: number[];
      if (/^[0-9a-fA-F]{2}$/.test(token)) {
        bytes = [Number.parseInt(token, 16)];
      } else if (token.length === accessSize * 2 && /^[0-9a-fA-F]+$/.test(token)) {
        const value = Number.parseInt(token, 16);
        bytes = Array.from({ length: accessSize }, (_unused, index) => (value >>> (index * 8)) & 0xff);
      } else {
        continue;
      }
      for (const byte of bytes) byAddress.set(cursor++, byte);
    }
  }
  const values: number[] = [];
  for (let offset = 0; offset < byteCount; offset += 1) {
    const value = byAddress.get(address + offset);
    if (value === undefined) break;
    values.push(value);
  }
  return Buffer.from(values);
}

async function readExact(
  probe: ProbeBackend,
  address: number,
  byteCount: number,
  accessSize: 1 | 2 | 4,
  stage: string,
  record?: (result: CommandResult) => void,
): Promise<Buffer> {
  const result = await probe.readMemory(address, byteCount, accessSize);
  record?.(result);
  if (!result.success) throw memoryReadCommandError(result, stage);
  const bytes = memoryBytes(probe, result, address, byteCount, accessSize);
  if (bytes.length < byteCount) {
    const afterWrite = stage !== "old_value_read";
    throw executionError("READ_LENGTH_MISMATCH", stage, `requested ${byteCount} bytes but decoded ${bytes.length}`, { writeIssued: afterWrite, stateUnknown: afterWrite });
  }
  return bytes.subarray(0, byteCount);
}

function validateMemoryRequest(input: MemoryReadInput): void {
  validateUint32(input.address, "address");
  if (input.width !== 8 && input.width !== 16 && input.width !== 32) throw executionError("INVALID_ACCESS_WIDTH", "validation", "width must be 8, 16, or 32 bits");
  if (!Number.isSafeInteger(input.byteCount) || input.byteCount < 1 || input.byteCount > 4096) throw executionError("INVALID_BYTE_COUNT", "validation", "byteCount must be an integer from 1 to 4096");
  const accessSize = input.width / 8;
  if (input.address % accessSize !== 0 || input.byteCount % accessSize !== 0) throw executionError("UNALIGNED_ACCESS", "validation", "address and byteCount must align to width");
  if (input.address + input.byteCount > 0x1_0000_0000) throw executionError("ADDRESS_RANGE_OVERFLOW", "validation", "memory range exceeds the 32-bit address space");
}

function validateStructuredComparator(comparator: ScalarComparator, byteCount: number, requested: Buffer): void {
  if (comparator.mode !== "observe" && (comparator.type !== undefined || comparator.endian !== undefined)) {
    if (!comparator.type || !comparator.endian || hssTypedByteSize(comparator.type) !== byteCount) {
      throw executionError("COMPARATOR_INVALID", "validation", "typed comparator metadata must match the requested byte width");
    }
  }
  if (comparator.mode === "tolerance") {
    if (!Number.isFinite(comparator.expected) || !Number.isFinite(comparator.absTolerance) || !Number.isFinite(comparator.relTolerance)
      || comparator.absTolerance < 0 || comparator.relTolerance < 0) {
      throw executionError("COMPARATOR_INVALID", "validation", "tolerance values must be finite and non-negative");
    }
    if (!encodeHssValue(comparator.type, comparator.expected, comparator.endian).equals(requested)) {
      throw executionError("COMPARATOR_EXPECTED_MISMATCH", "validation", "tolerance expected value does not encode to the requested write bytes");
    }
  }
  if (comparator.mode === "masked") {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(comparator.maskHex) || comparator.maskHex.length !== byteCount * 2) {
      throw executionError("COMPARATOR_INVALID", "validation", "masked comparator requires one mask byte per requested byte");
    }
    if (Buffer.from(comparator.maskHex, "hex").every((value) => value === 0)) throw executionError("COMPARATOR_INVALID", "validation", "masked comparator must select at least one bit");
  }
  if (comparator.mode === "observe") {
    if (!Number.isSafeInteger(comparator.durationMs) || comparator.durationMs < 1 || comparator.durationMs > 60_000
      || !Number.isSafeInteger(comparator.maxPolls) || comparator.maxPolls < 1 || comparator.maxPolls > 1_000
      || !Number.isSafeInteger(comparator.intervalMs) || comparator.intervalMs < 1 || comparator.intervalMs > 10_000) {
      throw executionError("COMPARATOR_INVALID", "validation", "observe bounds are invalid");
    }
    validateStructuredComparator(comparator.comparator, byteCount, requested);
  }
}

function applyReadModifyWrite(old: Buffer, rmw: NonNullable<StructuredMemoryWriteInput["rmw"]>): Buffer {
  if (![1, 2, 4].includes(old.length)) throw executionError("RMW_WIDTH_INVALID", "validation", "read-modify-write supports 8, 16, or 32 bits");
  const bits = old.length * 8;
  const limit = bits === 32 ? 0xffff_ffff : 2 ** bits - 1;
  if (!Number.isSafeInteger(rmw.mask) || !Number.isSafeInteger(rmw.value) || rmw.mask < 0 || rmw.mask > limit || rmw.value < 0 || rmw.value > limit) {
    throw executionError("RMW_VALUE_INVALID", "validation", "read-modify-write mask and value must fit the declared width");
  }
  const current = readUnsigned(old, rmw.endian);
  const next = ((current & (~rmw.mask >>> 0)) | (rmw.value & rmw.mask)) >>> 0;
  return writeUnsigned(next, old.length, rmw.endian);
}

async function verifyStructuredValue(
  probe: ProbeBackend,
  address: number,
  byteCount: number,
  accessSize: 1 | 2 | 4,
  expected: Buffer,
  comparator: ScalarComparator,
): Promise<{ pass: boolean; readback: Buffer; details: Record<string, unknown> }> {
  if (comparator.mode !== "observe") {
    let command: Record<string, unknown> | undefined;
    const readback = await readExact(probe, address, byteCount, accessSize, "readback", (result) => { command = commandData(result); });
    const comparison = compareStructured(readback, expected, comparator);
    return { pass: comparison.pass, readback, details: { ...comparison.details, observationCount: 1, command } };
  }
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const observations: Array<{ at: string; hex: string; numeric?: number }> = [];
  let readback: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let matchedAt: string | undefined;
  let matchedEvidence: Record<string, unknown> | undefined;
  let lastCommand: Record<string, unknown> | undefined;
  for (let index = 0; index < comparator.maxPolls; index += 1) {
    readback = await readExact(probe, address, byteCount, accessSize, "observe_readback", (result) => { lastCommand = commandData(result); });
    const at = new Date().toISOString();
    const numeric = observedNumeric(readback, comparator.comparator);
    observations.push({ at, hex: readback.toString("hex"), ...(numeric === undefined ? {} : { numeric }) });
    const comparison = compareStructured(readback, expected, comparator.comparator);
    if (comparison.pass) {
      matchedAt = at;
      matchedEvidence = comparison.details;
      break;
    }
    const elapsed = elapsedMilliseconds(started);
    if (elapsed >= comparator.durationMs) break;
    await wait(Math.min(comparator.intervalMs, Math.max(1, comparator.durationMs - elapsed)));
  }
  const values = observations.flatMap((item) => item.numeric === undefined ? [] : [item.numeric]);
  return {
    pass: Boolean(matchedAt),
    readback,
    details: {
      observationCount: observations.length,
      startedAt,
      endedAt: new Date().toISOString(),
      matchedAt,
      matchedEvidence,
      first: observations[0] ?? null,
      last: observations.at(-1) ?? null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      numericSummary: values.length ? "typed" : "not_available",
      command: lastCommand,
    },
  };
}

function compareStructured(actual: Buffer, expected: Buffer, comparator: NonObserveComparator): { pass: boolean; details: Record<string, unknown> } {
  if (comparator.mode === "exact") {
    return { pass: actual.equals(expected), details: { mode: "exact", expectedHex: expected.toString("hex"), actualHex: actual.toString("hex") } };
  }
  if (comparator.mode === "masked") {
    const mask = Buffer.from(comparator.maskHex, "hex");
    const pass = actual.length === expected.length && actual.every((value, index) => (value & mask[index]) === (expected[index] & mask[index]));
    return { pass, details: { mode: "masked", maskHex: mask.toString("hex"), expectedHex: expected.toString("hex"), actualHex: actual.toString("hex") } };
  }
  const actualValue = decodeHssValue(comparator.type, actual, comparator.endian);
  const limit = comparator.absTolerance + comparator.relTolerance * Math.abs(comparator.expected);
  const difference = Math.abs(actualValue - comparator.expected);
  return { pass: difference <= limit, details: { mode: "tolerance", expected: comparator.expected, actual: actualValue, difference, limit, absTolerance: comparator.absTolerance, relTolerance: comparator.relTolerance } };
}

function comparatorMethod(comparator: ScalarComparator): string {
  return comparator.mode === "observe" ? `observe:${comparator.comparator.mode}` : comparator.mode;
}

function observedNumeric(bytes: Buffer, comparator: NonObserveComparator): number | undefined {
  if (comparator.type && comparator.endian) return decodeHssValue(comparator.type, bytes, comparator.endian);
  return undefined;
}

function elapsedMilliseconds(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function readUnsigned(bytes: Buffer, endian: HssTargetEndian): number {
  if (![1, 2, 4].includes(bytes.length)) throw executionError("VALUE_WIDTH_INVALID", "decode", "numeric value width must be 8, 16, or 32 bits");
  return endian === "little" ? bytes.readUIntLE(0, bytes.length) : bytes.readUIntBE(0, bytes.length);
}

function writeUnsigned(value: number, byteCount: number, endian: HssTargetEndian): Buffer {
  const bytes = Buffer.alloc(byteCount);
  if (endian === "little") bytes.writeUIntLE(value, 0, byteCount);
  else bytes.writeUIntBE(value, 0, byteCount);
  return bytes;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function validateExpectedTarget(input: MemoryReadInput, target: StoredTarget): void {
  if (input.expectedTargetGeneration && target.generation !== input.expectedTargetGeneration) {
    throw executionError("STALE_TARGET_REFERENCE", "precondition", "resolved access belongs to a stale Target generation");
  }
  if (input.expectedArtifactGeneration && target.artifact?.generation !== input.expectedArtifactGeneration) {
    throw executionError("STALE_ARTIFACT_REFERENCE", "precondition", "resolved access belongs to a stale Artifact generation");
  }
  if (input.expectedArtifactGeneration) assertArtifactBindingsCurrent(target);
  if (input.expectedSvdSha256) {
    const svd = assertSvdBindingCurrent(target);
    if (svd.sha256 !== input.expectedSvdSha256) throw executionError("STALE_SVD_REFERENCE", "precondition", "register access belongs to a stale SVD generation");
  }
  if (input.allowedArtifactMatch && !input.allowedArtifactMatch.includes(target.liveArtifactMatch.status)) {
    const code = target.liveArtifactMatch.status === "mismatch" ? "ARTIFACT_MISMATCH" : "ARTIFACT_NOT_VERIFIED";
    throw executionError(code, "precondition", `Artifact match is ${target.liveArtifactMatch.status}; structured access was not issued`);
  }
}

function parseWriteBytes(dataHex: string, byteCount: number, width: number): Buffer {
  if (typeof dataHex !== "string" || !/^(?:[0-9a-fA-F]{2}|\s)+$/.test(dataHex)) throw executionError("INVALID_DATA", "validation", "dataHex must contain hexadecimal bytes");
  const compact = dataHex.replace(/\s+/g, "");
  if (compact.length !== byteCount * 2) throw executionError("DATA_LENGTH_MISMATCH", "validation", "dataHex length must equal byteCount");
  const bytes = Buffer.from(compact, "hex");
  if (bytes.length % (width / 8) !== 0) throw executionError("UNALIGNED_ACCESS", "validation", "dataHex length must align to width");
  return bytes;
}

function validateCoreRegister(name: string): void {
  if (!/^(?:r(?:1[0-5]|[0-9])|pc|sp|lr|xpsr|control|primask|basepri|faultmask|msp|psp|msplim|psplim)$/i.test(name)) {
    throw executionError("INVALID_CORE_REGISTER", "validation", "name must identify a supported CPU-core register, not an SVD peripheral register");
  }
}

function cortexMFaultSnapshot(bytes: Buffer): {
  raw: Record<string, string>;
  decoded: Record<string, unknown>;
} {
  if (bytes.length < 60) throw executionError("READ_LENGTH_MISMATCH", "fault_register_read", "Cortex-M fault register block is incomplete");
  const rawValues = {
    icsr: bytes.readUInt32LE(0),
    shcsr: bytes.readUInt32LE(32),
    cfsr: bytes.readUInt32LE(36),
    hfsr: bytes.readUInt32LE(40),
    dfsr: bytes.readUInt32LE(44),
    mmfar: bytes.readUInt32LE(48),
    bfar: bytes.readUInt32LE(52),
    afsr: bytes.readUInt32LE(56),
  };
  return {
    raw: Object.fromEntries(Object.entries(rawValues).map(([name, value]) => [name.toUpperCase(), hex32(value)])),
    decoded: {
      cfsrHfsr: decodeFaultRegisters(rawValues.cfsr, rawValues.hfsr, rawValues.mmfar, rawValues.bfar),
      dfsr: namedBits(rawValues.dfsr, {
        HALTED: 1 << 0,
        BKPT: 1 << 1,
        DWTTRAP: 1 << 2,
        VCATCH: 1 << 3,
        EXTERNAL: 1 << 4,
      }),
      shcsr: namedBits(rawValues.shcsr, {
        MEMFAULTACT: 1 << 0,
        BUSFAULTACT: 1 << 1,
        USGFAULTACT: 1 << 3,
        SVCALLACT: 1 << 7,
        MONITORACT: 1 << 8,
        PENDSVACT: 1 << 10,
        SYSTICKACT: 1 << 11,
        USGFAULTENA: 1 << 18,
        BUSFAULTENA: 1 << 17,
        MEMFAULTENA: 1 << 16,
      }),
      icsr: {
        vectActive: rawValues.icsr & 0x1ff,
        vectPending: (rawValues.icsr >>> 12) & 0x1ff,
        retToBase: (rawValues.icsr & (1 << 11)) !== 0,
        isrPending: (rawValues.icsr & (1 << 22)) !== 0,
        pendstSet: (rawValues.icsr & (1 << 26)) !== 0,
        pendsvSet: (rawValues.icsr & (1 << 28)) !== 0,
        nmipendSet: (rawValues.icsr & (1 << 31)) !== 0,
      },
      afsr: rawValues.afsr === 0 ? [] : ["implementation_defined_auxiliary_fault"],
    },
  };
}

async function cortexMExceptionFrame(
  probe: ProbeBackend,
  target: StoredTarget,
  registers: Record<string, string>,
): Promise<{
  status: "verified" | "unverified";
  excReturn?: string;
  stackPointer?: { register: "MSP" | "PSP"; value: string };
  stacked?: Record<string, string>;
  reason?: string;
}> {
  const lr = registerNumber(registers.LR);
  if (lr === undefined || (lr >>> 8) !== 0x00ffffff || (lr & 1) === 0) {
    return { status: "unverified", reason: "LR does not provide a provable Cortex-M EXC_RETURN value" };
  }
  const register = (lr & 4) === 0 ? "MSP" : "PSP";
  const stackPointer = registerNumber(registers[register]);
  if (stackPointer === undefined || stackPointer % 4 !== 0) {
    return { status: "unverified", excReturn: hex32(lr), reason: `${register} is unavailable or not word aligned` };
  }
  const ram = target.memoryRegions.filter((region) => region.kind === "ram");
  if (!ram.some((region) => stackPointer >= region.start && stackPointer + 32 <= region.start + region.length)) {
    return {
      status: "unverified",
      excReturn: hex32(lr),
      stackPointer: { register, value: hex32(stackPointer) },
      reason: "exception frame is outside configured RAM bounds",
    };
  }
  const bytes = await readExact(probe, stackPointer, 32, 4, "exception_frame_read");
  const stackedValues = ["r0", "r1", "r2", "r3", "r12", "lr", "pc", "xpsr"].map((name, index) => [name, bytes.readUInt32LE(index * 4)] as const);
  const xpsr = stackedValues[7][1];
  const stacked = Object.fromEntries(stackedValues.map(([name, value]) => [name, hex32(value)]));
  if ((xpsr & (1 << 24)) === 0) {
    return {
      status: "unverified",
      excReturn: hex32(lr),
      stackPointer: { register, value: hex32(stackPointer) },
      stacked,
      reason: "stacked xPSR does not prove Thumb-state exception-frame layout",
    };
  }
  return { status: "verified", excReturn: hex32(lr), stackPointer: { register, value: hex32(stackPointer) }, stacked };
}

function mapArtifactAddresses(target: StoredTarget, addresses: number[]): { status: "mapped" | "unavailable"; addresses: Array<Record<string, unknown>>; reason?: string } {
  if (!target.artifact) return { status: "unavailable", addresses: [], reason: "no configured Artifact" };
  try {
    const ramRanges = target.memoryRegions.filter((region) => region.kind === "ram").map((region) => ({ start: region.start, end: region.start + region.length }));
    const segments = parseElfFlashSegments(readFileSync(target.artifact.path), ramRanges);
    return {
      status: "mapped",
      addresses: addresses.map((address) => {
        const normalized = address & 0xffff_fffe;
        const segment = segments.find((candidate) => normalized >= candidate.start && normalized < candidate.end);
        return {
          address: hex32(address),
          artifactSegment: segment ? { name: segment.name, offset: normalized - segment.start, flags: segment.flags } : null,
        };
      }),
    };
  } catch (error) {
    return { status: "unavailable", addresses: addresses.map((address) => ({ address: hex32(address), artifactSegment: null })), reason: error instanceof Error ? error.message : String(error) };
  }
}

function registerNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  const parsed = /^0x[0-9a-f]+$/i.test(normalized)
    ? Number.parseInt(normalized.slice(2), 16)
    : /^[0-9a-f]+$/i.test(normalized)
      ? Number.parseInt(normalized, 16)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffff_ffff ? parsed >>> 0 : undefined;
}

function namedBits(value: number, names: Record<string, number>): string[] {
  return Object.entries(names).filter(([, mask]) => (value & mask) !== 0).map(([name]) => name);
}

function distinctNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined))];
}

function hex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function parseRegisterValue(result: CommandResult, name: string): number {
  const text = `${result.rawOutput}\n${result.output}`;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:${escaped})\\s*=\\s*(?:0x)?([0-9a-fA-F]{1,8})`, "i")) ?? text.match(/(?:0x)?([0-9a-fA-F]{8})/);
  if (!match) throw executionError("REGISTER_DECODE_FAILED", "decode", `could not decode ${name} from Probe output`);
  return Number.parseInt(match[1], 16) >>> 0;
}

function validateUint32(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw executionError("INVALID_ARGUMENT", "validation", `${name} must be an unsigned 32-bit integer`);
}

function refreshArtifact(envelope: OperationEnvelope, target: StoredTarget): void {
  envelope.artifact = target.artifact ? {
    generation: target.artifact.generation,
    path: target.artifact.path,
    match: target.liveArtifactMatch.status,
    evidenceSource: target.liveArtifactMatch.source,
    evidenceTimestamp: target.liveArtifactMatch.timestamp,
  } : null;
}

function sameFlashBinding(left: FlashImageBinding, right: FlashImageBinding): boolean {
  return left.path === right.path
    && left.sha256 === right.sha256
    && left.size === right.size
    && left.format === right.format
    && left.baseAddress === right.baseAddress;
}

function requireKnownPostWriteState(observation: TargetStateObservation, operation: string): void {
  if (observation.state === "unknown") {
    throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", `target state could not be observed after ${operation}`, { writeIssued: true, stateUnknown: true });
  }
}

function userConfirmationRequired(tool: string): OperationEnvelope {
  return failEnvelope(createOperationEnvelope(tool), {
    code: "USER_CONFIRMATION_REQUIRED",
    stage: "confirmation",
    message: `${tool} can have destructive or unknown side effects. Obtain explicit user approval for this exact operation, then retry with userConfirmed=true.`,
    retryable: true,
    writeIssued: false,
    stateUnknown: false,
  });
}

function requireHaltedCoreAccess(observation: TargetStateObservation, operation: string): void {
  if (observation.state === "halted") return;
  if (observation.state === "running") {
    throw executionError("HALT_REQUIRED", "precondition", `${operation} requires a halted target; call halt explicitly if appropriate`);
  }
  throw executionError("TARGET_STATE_UNKNOWN", "precondition", `target state is unknown before ${operation}; no core-register command was issued`, { stateUnknown: true });
}

const CONNECTION_EVIDENCE_ERROR_CODES = new Set<string>([
    ProbeErrorCode.PROBE_NOT_FOUND,
    ProbeErrorCode.TARGET_UNREACHABLE,
    ProbeErrorCode.ATTACH_FAILED,
    ProbeErrorCode.ATTACH_UNDER_RESET_FAILED,
    ProbeErrorCode.STATE_DESYNC,
    ProbeErrorCode.DEVICE_NOT_CONFIGURED,
    ProbeErrorCode.TIMEOUT,
    ProbeErrorCode.PROBE_IDENTITY_MISMATCH,
]);

function invalidatesConnectionEvidence(error: unknown, envelope: OperationEnvelope): boolean {
  if (error instanceof OperationExecutionError && CONNECTION_EVIDENCE_ERROR_CODES.has(error.detail.code)) return true;
  return observationInvalidatesConnectionEvidence(envelope);
}

function isIssuedPostOperationObservationFailure(error: unknown, envelope: OperationEnvelope): boolean {
  return error instanceof OperationExecutionError
    && error.detail.stage === "final_observation"
    && error.detail.writeIssued
    && envelope.observedEffects.length > 0;
}

function observationInvalidatesConnectionEvidence(envelope: OperationEnvelope): boolean {
  for (const observation of [envelope.before, envelope.after]) {
    if (!observation || typeof observation !== "object") continue;
    const command = (observation as { command?: { errorCode?: unknown } }).command;
    if (typeof command?.errorCode === "string" && CONNECTION_EVIDENCE_ERROR_CODES.has(command.errorCode)) return true;
  }
  return false;
}
