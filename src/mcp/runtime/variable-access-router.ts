import { ArtifactCatalogError } from "../artifact/artifact-catalog";
import type { ResolvedSymbol } from "../artifact/symbol-catalog";
import { decodeHssValue, encodeHssValue } from "../hss/hss-typed-value";
import {
  type NonObserveComparator,
  type ScalarComparator,
  DirectMcuService,
} from "./direct-operations";
import {
  createOperationEnvelope,
  failEnvelope,
  type OperationEnvelope,
} from "./operation-envelope";
import { TargetStore, TargetStoreError, type StoredTarget } from "./target-store";
import {
  VariableResolutionError,
  type CaptureVariableAccess,
  type ResolvedVariableContext,
  type VariableAccess,
  type VariableComparatorInput,
  type VariableRefInput,
  type VariableResolver,
  type VariableWriteInput,
} from "./variable-access-contract";

export class VariableAccessRouter implements VariableAccess {
  constructor(
    private readonly targets: Pick<TargetStore, "require">,
    private readonly resolver: VariableResolver,
    private readonly direct: DirectMcuService,
    private readonly capture: CaptureVariableAccess,
  ) {}

  resolveVariable(projectRoot: string, ref: VariableRefInput): Promise<ResolvedVariableContext> {
    return this.resolver.resolveVariable(projectRoot, ref);
  }

  async readVariable(projectRoot: string, ref: VariableRefInput): Promise<OperationEnvelope> {
    let context: ResolvedVariableContext;
    try {
      context = await this.resolver.resolveVariable(projectRoot, ref);
      if (context.target.liveArtifactMatch.status === "mismatch") {
        throw new VariableResolutionError("ARTIFACT_MISMATCH", "Artifact match is mismatch; symbol read was not issued");
      }
    } catch (error) {
      return this.failure(createOperationEnvelope("read_variable"), error, "symbol_resolution");
    }

    const { target, resolved, cacheRefreshed } = context;
    let envelope: OperationEnvelope | undefined;
    try {
      envelope = await this.capture.tryReadVariable(target, resolved);
    } catch (error) {
      return this.failure(createOperationEnvelope("read_variable", target), error, "capture_read");
    }
    if (envelope === undefined) {
      try {
        envelope = await this.direct.readMemory({
        projectRoot: target.projectRoot,
        address: resolved.address,
        width: resolved.size * 8 as 8 | 16 | 32,
        byteCount: resolved.size,
        operationTool: "read_variable",
        expectedTargetGeneration: target.generation,
        expectedArtifactGeneration: target.artifact!.generation,
        allowedArtifactMatch: ["verified", "unverified"],
        });
      } catch (error) {
        return this.failure(createOperationEnvelope("read_variable", target), error, "direct_read");
      }
    }

    if (envelope.artifact?.match === "unverified") {
      envelope.warnings.push("ARTIFACT_UNVERIFIED: symbol address is layout-valid but not confirmed against the live target.");
    }
    if (envelope.ok) {
      const raw = envelope.data as { dataHex?: string };
      if (!raw.dataHex) {
        return failEnvelope(envelope, operationError("READ_LENGTH_MISMATCH", "decode", "typed variable read returned no bytes"));
      }
      const bytes = Buffer.from(raw.dataHex, "hex");
      envelope.data = { ...raw, resolved, cacheRefreshed, typedValue: decodeHssValue(resolved.type, bytes, resolved.endian) };
    }
    return envelope;
  }

  async writeVariable(input: VariableWriteInput): Promise<OperationEnvelope> {
    const normalizedInput: VariableWriteInput = {
      ...input,
      captureOld: input.captureOld ?? true,
      verify: input.verify ?? true,
      restore: input.restore ?? false,
      verificationConnection: input.verificationConnection ?? "same_session",
    };

    let context: ResolvedVariableContext;
    let requested: Buffer;
    let comparator: ScalarComparator;
    try {
      const target = this.targets.require(normalizedInput.projectRoot);
      if (target.liveArtifactMatch.status !== "verified") {
        throw new VariableResolutionError(
          target.liveArtifactMatch.status === "mismatch" ? "ARTIFACT_MISMATCH" : "ARTIFACT_NOT_VERIFIED",
          "write_variable requires a verified live Artifact match",
        );
      }
      context = await this.resolver.resolveVariable(normalizedInput.projectRoot, normalizedInput.ref);
      const { resolved } = context;
      if (resolved.region !== "ram") {
        throw new VariableResolutionError("VARIABLE_NOT_WRITABLE", "typed variable writes require a DWARF RAM symbol");
      }
      requested = encodeHssValue(resolved.type, normalizedInput.value, resolved.endian);
      comparator = variableComparator(normalizedInput.comparator ?? { mode: "exact" }, resolved, normalizedInput.value);
    } catch (error) {
      return this.failure(createOperationEnvelope("write_variable"), error, "symbol_resolution");
    }

    const { target, resolved, cacheRefreshed } = context;
    try {
      const captureEnvelope = await this.capture.tryWriteVariable(normalizedInput, target, resolved, requested, comparator);
      if (captureEnvelope !== undefined) {
        decorateTypedWrite(captureEnvelope, resolved);
        appendCacheState(captureEnvelope, cacheRefreshed);
        return captureEnvelope;
      }
    } catch (error) {
      return this.failure(createOperationEnvelope("write_variable", target), error, "capture_write");
    }

    const envelope = await this.direct.structuredWrite({
      projectRoot: target.projectRoot,
      address: resolved.address,
      width: resolved.size * 8 as 8 | 16 | 32,
      byteCount: resolved.size,
      dataHex: requested.toString("hex"),
      captureOld: normalizedInput.captureOld,
      verify: normalizedInput.verify,
      restore: normalizedInput.restore,
      verificationConnection: normalizedInput.verificationConnection,
      comparator,
      knownRegion: "ram",
      operationTool: "write_variable",
      expectedTargetGeneration: target.generation,
      expectedArtifactGeneration: target.artifact!.generation,
      allowedArtifactMatch: ["verified"],
      semanticData: { resolved, requestedValue: normalizedInput.value },
    });
    decorateTypedWrite(envelope, resolved);
    appendCacheState(envelope, cacheRefreshed);
    return envelope;
  }

  private failure(envelope: OperationEnvelope, error: unknown, stage: string): OperationEnvelope {
    if (error instanceof VariableResolutionError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    if (error instanceof TargetStoreError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    if (error instanceof ArtifactCatalogError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    return failEnvelope(envelope, operationError("SYMBOL_OPERATION_FAILED", stage, error instanceof Error ? error.message : String(error)));
  }
}

function variableComparator(input: VariableComparatorInput, resolved: ResolvedSymbol, requestedValue: number): ScalarComparator {
  const typed = { type: resolved.type, endian: resolved.endian };
  if (input.mode === "exact") return { mode: "exact", ...typed };
  if (input.mode === "tolerance") return { mode: "tolerance", expected: requestedValue, absTolerance: input.absTolerance, relTolerance: input.relTolerance, ...typed };
  if (input.mode === "masked") return { mode: "masked", maskHex: input.maskHex, ...typed };
  return {
    mode: "observe",
    durationMs: input.durationMs,
    maxPolls: input.maxPolls,
    intervalMs: input.intervalMs,
    comparator: variableComparator(input.comparator, resolved, requestedValue) as NonObserveComparator,
  };
}

function decorateTypedWrite(envelope: OperationEnvelope, resolved: ResolvedSymbol): void {
  if (!envelope.data || typeof envelope.data !== "object") return;
  const data = envelope.data as Record<string, unknown>;
  for (const [hexKey, valueKey] of [["oldHex", "old"], ["readbackHex", "readback"]] as const) {
    const value = data[hexKey];
    if (typeof value === "string") data[valueKey] = decodeHssValue(resolved.type, Buffer.from(value, "hex"), resolved.endian);
  }
  const restore = data.restore;
  if (restore && typeof restore === "object") {
    const record = restore as Record<string, unknown>;
    if (typeof record.readbackHex === "string") {
      record.readback = decodeHssValue(resolved.type, Buffer.from(record.readbackHex, "hex"), resolved.endian);
    }
  }
}

function appendCacheState(envelope: OperationEnvelope, cacheRefreshed: boolean): void {
  if (envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)) {
    envelope.data = { ...envelope.data as Record<string, unknown>, cacheRefreshed };
  }
}

function operationError(code: string, stage: string, message: string) {
  return { code, stage, message, retryable: false, writeIssued: false, stateUnknown: false };
}
