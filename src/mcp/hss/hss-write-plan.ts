import type { HssScalarType } from "./hss-contract";
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
import { claimOperationPlan, createOperationPlan, type TargetArtifactMatch, type VariableWriteOperationPlan } from "../operation-contract";

export type HssWriteTargetRef =
  | { kind: "scalar"; path: string }
  | { kind: "array_element"; path: string; index: number }
  | { kind: "array_slice"; path: string; startIndex: number };

export interface HssVariableWritePlanInput {
  captureId?: string;
  artifactFile?: string;
  mapFile?: string;
  target?: string;
  targetRef?: HssWriteTargetRef;
  type?: HssScalarType;
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
  risk: "R2" | "R4";
  policyMatched: true;
  policyHash: string;
  symbolLayoutHash: string;
  readbackRequired: true;
  maxWriteOpsRemaining: number;
  maxElementsRemaining: number;
  willEnterCaptureQueue: boolean;
  executable: boolean;
  backend: "jlink-hss";
  createdAt: string;
  expiresAt: string;
  operationPlan: VariableWriteOperationPlan;
}

interface StoredWritePlan {
  plan: HssVariableWritePlan;
}

export interface HssWritePlanRevalidateContext {
  captureId: string;
  captureGeneration: number;
  policy: HssPolicy;
  mapFile: string;
  expectedPolicyHash?: string;
  expectedSymbolLayoutHash?: string;
  runtimeIdentitySha256: string;
  scriptApprovalSha256: string;
  targetId: string;
  probeSerial?: string;
  artifactGeneration: string;
  artifactSha256: string;
  targetArtifactMatch: TargetArtifactMatch;
  evidenceGeneration: string;
  connectionGeneration: number;
  sessionId: string;
  writeOpsUsed: number;
  elementsUsed: number;
}

export class HssWritePlanStore {
  private readonly plans = new Map<string, StoredWritePlan>();

  put(plan: HssVariableWritePlan): HssVariableWritePlan {
    this.plans.set(plan.writePlanId, { plan });
    return plan;
  }

  peek(writePlanId: string): HssVariableWritePlan {
    const stored = this.plans.get(writePlanId);
    if (!stored) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "write plan was not found", { writePlanId });
    return stored.plan;
  }

  get(writePlanId: string, context: HssWritePlanRevalidateContext): HssVariableWritePlan {
    const stored = this.plans.get(writePlanId);
    if (!stored) throw new HssError(HSS_ERROR.WRITE_PLAN_NOT_FOUND, "write plan was not found", { writePlanId });
    const plan = stored.plan;
    if (plan.operationPlan.state !== "planned") throw new HssError(HSS_ERROR.WRITE_PLAN_ALREADY_EXECUTED, "write plan was already consumed", { writePlanId });
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
    const operation = plan.operationPlan;
    if (operation.runtime.identitySha256 !== context.runtimeIdentitySha256
        || operation.runtime.scriptApprovalSha256 !== context.scriptApprovalSha256
        || operation.target.targetId !== context.targetId
        || operation.target.probeSerial !== context.probeSerial
        || operation.target.connectionGeneration !== context.connectionGeneration
        || operation.artifact.generation !== context.artifactGeneration
        || operation.artifact.sha256 !== context.artifactSha256
        || operation.artifact.match !== context.targetArtifactMatch
        || operation.artifact.evidenceGeneration !== context.evidenceGeneration
        || operation.session.id !== context.sessionId
        || operation.session.captureId !== context.captureId
        || operation.session.captureGeneration !== context.captureGeneration) {
      throw new HssError(HSS_ERROR.WRITE_PLAN_CAPTURE_MISMATCH, "write plan operation binding is stale", { writePlanId });
    }
    if (operation.policy.remainingWrites !== operation.policy.maxWrites - context.writeOpsUsed
        || operation.policy.remainingElements !== operation.policy.maxElements - context.elementsUsed) {
      throw new HssError(HSS_ERROR.POLICY_MAX_WRITES_EXCEEDED, "write plan budget changed before execution", { writePlanId });
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

  claim(writePlanId: string, context: HssWritePlanRevalidateContext): HssVariableWritePlan {
    const plan = this.get(writePlanId, context);
    try {
      claimOperationPlan(plan.operationPlan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /expired/.test(message) ? HSS_ERROR.WRITE_PLAN_EXPIRED
        : /already consumed/.test(message) ? HSS_ERROR.WRITE_PLAN_ALREADY_EXECUTED
          : HSS_ERROR.WRITE_PLAN_LAYOUT_CHANGED;
      throw new HssError(code, message, { writePlanId });
    }
    return plan;
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
  willEnterCaptureQueue?: boolean;
  runtimeIdentitySha256: string;
  scriptApprovalSha256: string;
  targetId: string;
  probeSerial?: string;
  artifactGeneration: string;
  artifactSha256: string;
  targetArtifactMatch: TargetArtifactMatch;
  evidenceGeneration: string;
  connectionGeneration: number;
  sessionId: string;
}): HssVariableWritePlan {
  if (input.captureId !== undefined && input.captureId !== context.captureId) throw new HssError(HSS_ERROR.HSS_CAPTURE_NOT_FOUND, "captureId is not active", { captureId: input.captureId });
  const targetRef = canonicalTargetRef(input);
  const entry = policyEntryForPath(context.policy, targetRef.path, targetRef.kind === "scalar" ? "scalar" : "fixed_array");
  if (input.type && ((entry.kind === "scalar" && input.type !== entry.type) || (entry.kind === "fixed_array" && input.type !== entry.elementType))) {
    throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "requested type does not match policy", { path: entry.path, requestedType: input.type });
  }
  if (!entry.captureTimeWrite) throw new HssError(HSS_ERROR.POLICY_CAPTURE_TIME_WRITE_DISABLED, "capture-time writes are disabled by policy", { path: entry.path });
  if (!entry.requireReadback) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "variable writes require readback", { path: entry.path });
  if (context.targetArtifactMatch === "mismatch") throw new HssError(HSS_ERROR.ARTIFACT_MATCH_MISMATCH, "target Artifact mismatch is never writable", { targetArtifactMatch: context.targetArtifactMatch });
  const r4Exception = context.targetArtifactMatch === "unverified" && entry.risk === "R4" && entry.unverifiedTargetWriteException;
  if (context.targetArtifactMatch === "verified" && (entry.risk !== "R2" || !entry.executable)) throw new HssError(HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE, "verified variable writes require an executable R2 policy entry", { path: entry.path, risk: entry.risk });
  if (context.targetArtifactMatch === "unverified" && !r4Exception) throw new HssError(HSS_ERROR.ARTIFACT_MATCH_UNVERIFIED, "unverified variable writes require an explicit R4 policy exception", { targetArtifactMatch: context.targetArtifactMatch, policyRisk: entry.risk, unverifiedTargetWriteException: entry.unverifiedTargetWriteException });
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
  const ttlMs = input.expiresInMs ?? 300000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000) throw new HssError(HSS_ERROR.WRITE_PLAN_EXPIRED, "write plan TTL must be 1..300000ms", { ttlMs });
  const base = {
    captureId: context.captureId,
    captureGeneration: context.captureGeneration,
    targetRef,
    canonicalTarget: canonicalTarget(targetRef, writeElementCount),
    writeElementCount,
    writeByteCount,
    risk: r4Exception ? "R4" as const : "R2" as const,
    policyMatched: true as const,
    policyHash: context.policy.policyHash,
    symbolLayoutHash: layout.symbolLayoutHash,
    readbackRequired: true as const,
    maxWriteOpsRemaining,
    maxElementsRemaining,
    willEnterCaptureQueue: context.willEnterCaptureQueue ?? true,
    executable: !r4Exception,
    backend: context.backend,
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
  const operationPlan = createOperationPlan<VariableWriteOperationPlan>({
    kind: "variable_write",
    tool: "variable_write_execute",
    canonicalArgs: { targetRef, canonicalTarget: base.canonicalTarget, values },
    risk: base.risk,
    runtime: { identitySha256: context.runtimeIdentitySha256, scriptApprovalSha256: context.scriptApprovalSha256 },
    target: { targetId: context.targetId, ...(context.probeSerial ? { probeSerial: context.probeSerial } : {}), connectionGeneration: context.connectionGeneration },
    artifact: { generation: context.artifactGeneration, sha256: context.artifactSha256, match: context.targetArtifactMatch, evidenceGeneration: context.evidenceGeneration },
    layout: { sha256: layout.symbolLayoutHash },
    policy: { sha256: context.policy.policyHash, rule: entry.path, maxWrites: entry.maxWriteOps, remainingWrites: maxWriteOpsRemaining, maxElements: entry.maxElementsTotal, remainingElements: maxElementsRemaining },
    session: { id: context.sessionId, captureId: context.captureId, captureGeneration: context.captureGeneration },
    readback: { required: true },
    ttlMs,
  });
  return { ...plan, writePlanId: operationPlan.planId, createdAt: operationPlan.issuedAt, expiresAt: operationPlan.expiresAt, operationPlan };
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
