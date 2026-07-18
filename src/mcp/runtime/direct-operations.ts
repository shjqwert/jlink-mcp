import type { CommandResult, ProbeBackend, TargetStateObservation } from "../../probe/backend";
import { ProbeErrorCode } from "../../probe/backend";
import { chmodSync, copyFileSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { QueueMetadata } from "./probe-queue";
import { ProbeQueue, ProbeQueueError } from "./probe-queue";
import {
  createOperationEnvelope,
  executionError,
  failEnvelope,
  finishEnvelope,
  OperationExecutionError,
  type OperationEnvelope,
} from "./operation-envelope";
import {
  inspectFlashFile,
  locateMemoryRegion,
  overlappingMemoryRegions,
  TargetStore,
  TargetStoreError,
  type FlashImageBinding,
  type StoredTarget,
  type TargetConfigureInput,
} from "./target-store";

export interface DirectTargetRuntime {
  probe: ProbeBackend;
}

export type DirectRuntimeProvider = (target: StoredTarget) => Promise<DirectTargetRuntime>;

export interface MemoryReadInput {
  projectRoot: string;
  address: number;
  width: 8 | 16 | 32;
  byteCount: number;
}

export interface MemoryWriteInput extends MemoryReadInput {
  dataHex: string;
  captureOld?: boolean;
  verify?: boolean;
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
}

export class DirectMcuService {
  constructor(
    readonly targets: TargetStore,
    readonly queue: ProbeQueue,
    private readonly runtimeFor: DirectRuntimeProvider,
  ) {}

  async configure(input: TargetConfigureInput): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("target_configure");
    try {
      const previous = this.targets.get(input.projectRoot);
      const serialized = previous
        ? await this.queue.runExclusive(previous.probeSerial, async () => {
          const currentPrevious = this.targets.require(previous.projectRoot);
          if (currentPrevious.generation !== previous.generation || currentPrevious.probeSerial !== previous.probeSerial) {
            throw new TargetStoreError("TARGET_GENERATION_CHANGED", "Target configuration changed while target_configure waited for the Probe queue; retry against the current generation");
          }
          return this.targets.configure(input, previous.generation);
        })
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
      configured.requestedEffects = ["persist_target_configuration", "invalidate_live_artifact_verification"];
      configured.observedEffects = ["target_generation_created", "live_artifact_verification_unverified"];
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
    try { validateMemoryRequest(input); } catch (error) { return Promise.resolve(this.failure(createOperationEnvelope("read_memory"), error, "validation")); }
    return this.queued("read_memory", input.projectRoot, [], async (envelope, _target, runtime) => {
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
          readFailure = commandError(result, "read", false);
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
    });
  }

  writeMemory(input: MemoryWriteInput): Promise<OperationEnvelope> {
    let bytes: Buffer;
    try {
      validateMemoryRequest(input);
      bytes = parseWriteBytes(input.dataHex, input.byteCount, input.width);
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope("write_memory"), error, "validation"));
    }
    return this.queued("write_memory", input.projectRoot, ["memory_write"], async (envelope, target, runtime) => {
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
    let target: StoredTarget;
    let flashFile: ReturnType<typeof inspectFlashFile>;
    try {
      target = this.targets.require(input.projectRoot);
      flashFile = inspectFlashFile(target.projectRoot, input.path, input.baseAddress);
    } catch (error) {
      return Promise.resolve(this.failure(createOperationEnvelope("flash"), error, "validation"));
    }
    return this.queuedWithTarget("flash", target, ["program_flash", "vendor_verify"], async (envelope, current, runtime) => {
      const liveFlashFile = inspectFlashFile(current.projectRoot, flashFile.path, flashFile.baseAddress);
      if (!sameFlashBinding(liveFlashFile, flashFile)) {
        throw new TargetStoreError("FLASH_INPUT_CHANGED", "flash input changed while the request waited for the Probe queue; no hardware command was issued");
      }
      const snapshotRoot = mkdtempSync(join(tmpdir(), "jlink-mcp-flash-"));
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
        const after = await observeAfterMutation(runtime.probe, "flash");
        envelope.after = observationData(after);
        const associated = current.artifactFlashImages.some((item) => item.sha256 === liveFlashFile.sha256 && item.baseAddress === liveFlashFile.baseAddress);
        const updated = await this.transitionArtifact(current, associated ? "verified" : "unverified", associated ? "associated_flash_vendor_verify" : "unassociated_flash_vendor_verify", true);
        refreshArtifact(envelope, updated);
        envelope.data = { file: liveFlashFile, executionSnapshot: { sha256: snapshot.sha256, size: snapshot.size }, associatedWithArtifact: associated, command: commandData(result) };
        envelope.verification = { status: "verified", method: "immutable_snapshot_and_vendor_flash_verify" };
        if (!associated) envelope.warnings.push("Flash verified by the vendor, but its hash is not associated with the configured Artifact.");
        if (after.state === "unknown") {
          throw executionError("POST_OPERATION_STATE_UNKNOWN", "final_observation", "target state could not be observed after flash", { writeIssued: true, stateUnknown: true });
        }
        if (before.state !== after.state) {
          envelope.observedEffects.push(`vendor_target_state_change:${before.state}->${after.state}`);
        }
      } finally {
        try { chmodSync(snapshotPath, 0o600); } catch { /* snapshot may not have been created */ }
        rmSync(snapshotRoot, { recursive: true, force: true });
      }
    });
  }

  erase(projectRoot: string, verifyBlank = false): Promise<OperationEnvelope> {
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

  probeCommand(projectRoot: string, commands: string[]): Promise<OperationEnvelope> {
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
  ): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); } catch (error) { return Promise.resolve(this.failure(createOperationEnvelope(tool), error, "target_lookup")); }
    return this.queuedWithTarget(tool, target, requestedEffects, operation);
  }

  private async queuedWithTarget(
    tool: string,
    target: StoredTarget,
    requestedEffects: string[],
    operation: (envelope: OperationEnvelope, target: StoredTarget, runtime: DirectTargetRuntime) => Promise<void>,
  ): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope(tool, target);
    envelope.requestedEffects = requestedEffects;
    let activeMetadata: QueueMetadata | undefined;
    let activeTarget: StoredTarget | undefined;
    try {
      const execution = await this.queue.runExclusive(target.probeSerial, async (metadata) => {
        activeMetadata = metadata;
        applyQueueMetadata(envelope, metadata);
        const current = this.targets.requireCurrent(target);
        activeTarget = current;
        await operation(envelope, current, await this.runtimeFor(current));
        if (observationInvalidatesConnectionEvidence(envelope)) {
          const hardwareEffectIssued = requestedEffects.length > 0 && envelope.observedEffects.length > 0;
          const updated = await this.transitionArtifact(current, "unverified", "probe_connection_identity_lost", hardwareEffectIssued);
          refreshArtifact(envelope, updated);
          envelope.warnings.push("Live Artifact verification was invalidated because a state observation lost Probe/Target identity.");
        }
      });
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
    if (error instanceof ProbeQueueError) return failEnvelope(envelope, { code: error.code, stage, message: error.message, retryable: error.code.endsWith("_ACTIVE") || error.code.includes("BUSY"), writeIssued: false, stateUnknown: false });
    return failEnvelope(envelope, { code: "INTERNAL_ERROR", stage, message: error instanceof Error ? error.message : String(error), retryable: false, writeIssued: false, stateUnknown: false });
  }

  private async transitionArtifact(target: StoredTarget, status: "unverified" | "verified" | "mismatch", source: string, writeIssued: boolean): Promise<StoredTarget> {
    try {
      return await this.targets.setArtifactMatch(target.projectRoot, status, source, {
        targetGeneration: target.generation,
        probeSerial: target.probeSerial,
        artifactGeneration: target.artifact?.generation,
      });
    } catch (error) {
      const code = error instanceof TargetStoreError ? error.code : "ARTIFACT_STATE_PERSIST_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      throw executionError(code, "artifact_state", message, { writeIssued, stateUnknown: writeIssued });
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
  if (!result.success) throw commandError(result, stage, stage !== "old_value_read", stage !== "old_value_read");
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
