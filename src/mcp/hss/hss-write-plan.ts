import { createHash } from "node:crypto";
import { HSS_ERROR, HssError } from "./hss-errors";
import {
  assertHssPolicyArrayElement,
  assertHssPolicyArraySlice,
  assertHssPolicyValues,
  hssPolicyElementSize,
  policyEntryForPath,
  type HssFixedArrayPolicyEntry,
  type HssPolicy,
  type HssPolicyEntry,
} from "./hss-policy";
import { resolveIarMapWriteTargetLayout } from "./hss-write-layout";

export type HssWriteTargetRef =
  | { kind: "scalar"; path: string }
  | { kind: "array_element"; path: string; index: number }
  | { kind: "array_slice"; path: string; startIndex: number };

export interface HssVariableWritePlanInput {
  captureId: string;
  target?: string;
  targetRef?: HssWriteTargetRef;
  value?: number;
  values?: number[];
  expiresInMs?: number;
}

export interface HssVariableWritePlan {
  writePlanId: string;
  captureId: string;
  captureGeneration: number;
  targetRef: HssWriteTargetRef;
  canonicalTarget: string;
  address?: number;
  baseAddress?: number;
  elementAddress?: number;
  dataType?: string;
  elementType?: string;
  byteSize?: number;
  elementSize?: number;
  arrayLength?: number;
  writeElementCount: number;
  writeByteCount: number;
  newValue?: number;
  newValues?: number[];
  risk: "R2" | "R3";
  policyMatched: true;
  policyHash: string;
  symbolLayoutHash: string;
  readbackRequired: true;
  maxWriteOpsRemaining: number;
  maxElementsRemaining: number;
  willEnterCaptureQueue: true;
  executable: boolean;
  backend: "jlink-hss";
  createdAt: string;
  expiresAt: string;
}

interface StoredWritePlan {
  plan: HssVariableWritePlan;
  executed: boolean;
}

export interface HssWritePlanRevalidateContext {
  captureId: string;
  captureGeneration: number;
  policy: HssPolicy;
  mapFile: string;
  expectedPolicyHash?: string;
  expectedSymbolLayoutHash?: string;
}

export class HssWritePlanStore {
  private readonly plans = new Map<string, StoredWritePlan>();

  put(plan: HssVariableWritePlan): HssVariableWritePlan {
    this.plans.set(plan.writePlanId, { plan, executed: false });
    return plan;
  }

  get(writePlanId: string, context: HssWritePlanRevalidateContext): HssVariableWritePlan {
    const stored = this.plans.get(writePlanId);
    if (!stored) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "write plan was not found", { writePlanId });
    const plan = stored.plan;
    if (stored.executed) throw new HssError(HSS_ERROR.WRITE_PLAN_ALREADY_EXECUTED, "write plan was already executed", { writePlanId });
    if (Date.now() > Date.parse(plan.expiresAt)) throw new HssError(HSS_ERROR.WRITE_PLAN_EXPIRED, "write plan expired", { writePlanId, expiresAt: plan.expiresAt });
    if (plan.captureId !== context.captureId || plan.captureGeneration !== context.captureGeneration) {
      throw new HssError(HSS_ERROR.WRITE_PLAN_CAPTURE_MISMATCH, "write plan does not match active capture", { writePlanId, captureId: context.captureId });
    }
    if (plan.policyHash !== context.policy.policyHash || (context.expectedPolicyHash && context.expectedPolicyHash !== plan.policyHash)) {
      throw new HssError(HSS_ERROR.WRITE_PLAN_POLICY_HASH_MISMATCH, "write plan policy hash is stale", { writePlanId });
    }
    if (context.expectedSymbolLayoutHash && context.expectedSymbolLayoutHash !== plan.symbolLayoutHash) {
      throw new HssError(HSS_ERROR.WRITE_PLAN_SYMBOL_HASH_MISMATCH, "write plan symbol layout hash is stale", { writePlanId });
    }
    const entry = policyEntryForPath(context.policy, plan.targetRef.path, plan.targetRef.kind === "scalar" ? "scalar" : "fixed_array");
    let layout: ReturnType<typeof resolveIarMapWriteTargetLayout>;
    try {
      layout = resolveIarMapWriteTargetLayout(context.mapFile, entry);
    } catch (error) {
      throw new HssError(HSS_ERROR.WRITE_PLAN_LAYOUT_CHANGED, "write plan target layout changed", { writePlanId, reason: error instanceof Error ? error.message : String(error) });
    }
    if (layout.symbolLayoutHash !== plan.symbolLayoutHash) throw new HssError(HSS_ERROR.WRITE_PLAN_LAYOUT_CHANGED, "write plan target layout changed", { writePlanId });
    return plan;
  }

  markExecuted(writePlanId: string): void {
    const stored = this.plans.get(writePlanId);
    if (!stored) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "write plan was not found", { writePlanId });
    stored.executed = true;
  }

  invalidateCapture(captureId: string, captureGeneration?: number): void {
    for (const [writePlanId, stored] of this.plans) {
      if (stored.plan.captureId === captureId && (captureGeneration === undefined || stored.plan.captureGeneration === captureGeneration)) {
        this.plans.delete(writePlanId);
      }
    }
  }
}

export function createHssVariableWritePlan(input: HssVariableWritePlanInput, context: {
  captureId: string;
  captureGeneration: number;
  backend: "jlink-hss";
  mapFile: string;
  policy: HssPolicy;
  writeOpsUsed?: number;
  elementsUsed?: number;
}): HssVariableWritePlan {
  if (input.captureId !== context.captureId) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "captureId is not active", { captureId: input.captureId });
  const targetRef = canonicalTargetRef(input);
  const entry = policyEntryForPath(context.policy, targetRef.path, targetRef.kind === "scalar" ? "scalar" : "fixed_array");
  if (!entry.captureTimeWrite) throw new HssError(HSS_ERROR.POLICY_CAPTURE_TIME_WRITE_DISABLED, "capture-time writes are disabled by policy", { path: entry.path });
  if (!entry.requireReadback) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "variable writes require readback", { path: entry.path });
  const layout = resolveIarMapWriteTargetLayout(context.mapFile, entry);
  const values = valuesForTarget(input, targetRef);
  assertTargetAccess(entry, targetRef, values.length);
  assertHssPolicyValues(entry, values);
  const writeElementCount = values.length;
  const writeByteCount = writeElementCount * (entry.kind === "scalar" ? hssPolicyElementSize(entry.type) : hssPolicyElementSize(entry.elementType));
  const maxWriteOpsRemaining = entry.maxWriteOps - (context.writeOpsUsed ?? 0);
  const maxElementsRemaining = entry.maxElementsTotal - (context.elementsUsed ?? 0);
  if (maxWriteOpsRemaining <= 0) throw new HssError(HSS_ERROR.POLICY_MAX_WRITES_EXCEEDED, "policy maxWriteOps exceeded", { path: entry.path });
  if (maxElementsRemaining < writeElementCount) throw new HssError(HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED, "policy maxElementsTotal exceeded", { path: entry.path });
  if (writeByteCount > entry.maxBytesPerWrite) throw new HssError(HSS_ERROR.POLICY_MAX_BYTES_EXCEEDED, "write exceeds policy maxBytesPerWrite", { path: entry.path, writeByteCount, maxBytesPerWrite: entry.maxBytesPerWrite });
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + (input.expiresInMs ?? 300000)).toISOString();
  const base = {
    captureId: context.captureId,
    captureGeneration: context.captureGeneration,
    targetRef,
    canonicalTarget: canonicalTarget(targetRef, writeElementCount),
    writeElementCount,
    writeByteCount,
    risk: entry.risk,
    policyMatched: true as const,
    policyHash: context.policy.policyHash,
    symbolLayoutHash: layout.symbolLayoutHash,
    readbackRequired: true as const,
    maxWriteOpsRemaining,
    maxElementsRemaining,
    willEnterCaptureQueue: true as const,
    executable: entry.risk === "R2",
    backend: context.backend,
    createdAt,
    expiresAt,
  };
  const plan = layout.kind === "scalar"
    ? {
      ...base,
      address: layout.address,
      dataType: layout.type,
      byteSize: layout.byteSize,
      newValue: values[0],
    }
    : {
      ...base,
      baseAddress: layout.baseAddress,
      elementAddress: elementAddress(layout.baseAddress, layout.elementSize, targetRef),
      elementType: layout.elementType,
      elementSize: layout.elementSize,
      arrayLength: layout.arrayLength,
      newValue: targetRef.kind === "array_element" ? values[0] : undefined,
      newValues: targetRef.kind === "array_slice" ? values : undefined,
    };
  return { ...plan, writePlanId: `wp_${hashStable(plan).slice(0, 32)}` };
}

function canonicalTargetRef(input: HssVariableWritePlanInput): HssWriteTargetRef {
  if (input.targetRef) return input.targetRef;
  if (!input.target) throw new HssError(HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED, "targetRef is required");
  if (/^0x[0-9a-f]+$/i.test(input.target)) throw new HssError(HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED, "raw address targets are not allowed", { target: input.target });
  const element = input.target.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\[(\d+)\]$/);
  if (element) return { kind: "array_element", path: element[1], index: Number(element[2]) };
  const slice = input.target.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\[(\d+)\.\.(\d+)\]$/);
  if (slice) return { kind: "array_slice", path: slice[1], startIndex: Number(slice[2]) };
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(input.target)) throw new HssError(HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED, "target is not a variable path", { target: input.target });
  return { kind: "scalar", path: input.target };
}

function valuesForTarget(input: HssVariableWritePlanInput, targetRef: HssWriteTargetRef): number[] {
  if (targetRef.kind === "array_slice") return input.values ?? [];
  if (typeof input.value !== "number") throw new HssError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE, "value must be a number");
  return [input.value];
}

function assertTargetAccess(entry: HssPolicyEntry, targetRef: HssWriteTargetRef, elementCount: number): void {
  if (targetRef.kind === "scalar") return;
  const arrayEntry = entry as HssFixedArrayPolicyEntry;
  if (targetRef.kind === "array_element") assertHssPolicyArrayElement(arrayEntry, targetRef.index);
  else assertHssPolicyArraySlice(arrayEntry, targetRef.startIndex, elementCount);
}

function canonicalTarget(targetRef: HssWriteTargetRef, elementCount: number): string {
  if (targetRef.kind === "scalar") return targetRef.path;
  if (targetRef.kind === "array_element") return `${targetRef.path}[${targetRef.index}]`;
  return `${targetRef.path}[${targetRef.startIndex}..${targetRef.startIndex + elementCount - 1}]`;
}

function elementAddress(baseAddress: number, elementSize: number, targetRef: HssWriteTargetRef): number {
  if (targetRef.kind === "scalar") return baseAddress;
  return baseAddress + (targetRef.kind === "array_element" ? targetRef.index : targetRef.startIndex) * elementSize;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
