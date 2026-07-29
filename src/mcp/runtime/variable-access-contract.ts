import type { ResolvedSymbol } from "../artifact/symbol-catalog";
import type { ScalarComparator } from "./direct-operations";
import type { OperationEnvelope } from "./operation-envelope";
import type { StoredTarget } from "./target-store";

export interface LegacyVariableRefInput {
  artifactGeneration: string;
  qualifiedName: string;
  memberPath?: string;
  layoutHash: string;
}

/** Public callers use a logical selector. The legacy structured form remains internal/backward-compatible. */
export type VariableRefInput = string | LegacyVariableRefInput;

export type VariableNonObserveComparatorInput =
  | { mode: "exact" }
  | { mode: "tolerance"; absTolerance: number; relTolerance: number }
  | { mode: "range"; min: number; max: number }
  | { mode: "masked"; maskHex: string };

export type VariableComparatorInput = VariableNonObserveComparatorInput
  | { mode: "observe"; durationMs: number; maxPolls: number; intervalMs: number; comparator: VariableNonObserveComparatorInput };

export interface VariableWriteInput {
  projectRoot: string;
  ref: VariableRefInput;
  value: number;
  captureOld?: boolean;
  verify?: boolean;
  restore?: boolean;
  verificationConnection?: "same_session" | "independent_session";
  comparator?: VariableComparatorInput;
}

export interface ResolvedVariableContext {
  target: StoredTarget;
  resolved: ResolvedSymbol;
  cacheRefreshed: boolean;
}

export interface VariableResolver {
  resolveVariable(projectRoot: string, ref: VariableRefInput): Promise<ResolvedVariableContext>;
}

export interface CaptureVariableAccess {
  tryReadVariable(
    target: StoredTarget,
    resolved: ResolvedSymbol,
  ): Promise<OperationEnvelope | undefined>;
  tryWriteVariable(
    input: VariableWriteInput,
    target: StoredTarget,
    resolved: ResolvedSymbol,
    requested: Buffer,
    comparator: ScalarComparator,
  ): Promise<OperationEnvelope | undefined>;
}

export interface VariableAccess extends VariableResolver {
  readVariable(projectRoot: string, ref: VariableRefInput): Promise<OperationEnvelope>;
  writeVariable(input: VariableWriteInput): Promise<OperationEnvelope>;
}

export class VariableResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VariableResolutionError";
  }
}
