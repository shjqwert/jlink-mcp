import { createHash, randomUUID } from "node:crypto";

export type OperationPlanState = "planned" | "consumed";
export type TargetArtifactMatch = "verified" | "unverified" | "mismatch";

interface OperationPlanBase {
  planId: string;
  tool: "variable_write_execute" | "halt" | "resume" | "reset";
  canonicalArgs: Record<string, unknown>;
  risk: "R2" | "R3" | "R4";
  runtime: { identitySha256: string; scriptApprovalSha256: string };
  target: { targetId: string; probeSerial?: string; connectionGeneration: number };
  artifact: { generation: string; sha256: string; match: TargetArtifactMatch; evidenceGeneration: string };
  layout: { sha256: string };
  policy: { sha256: string; rule: string; maxWrites: number; remainingWrites: number; maxElements: number; remainingElements: number };
  session: { id: string; captureId?: string; captureGeneration: number };
  readback: { required: boolean };
  issuedAt: string;
  expiresAt: string;
  ttlMs: number;
  digest: string;
  auditId: string;
  state: OperationPlanState;
}

export interface VariableWriteOperationPlan extends OperationPlanBase {
  kind: "variable_write";
  tool: "variable_write_execute";
  risk: "R2" | "R4";
  readback: { required: true };
}

export interface CpuControlOperationPlan extends OperationPlanBase {
  kind: "cpu_control";
  tool: "halt" | "resume" | "reset";
  risk: "R3";
}

export type OperationPlan = VariableWriteOperationPlan | CpuControlOperationPlan;

export function createOperationPlan<T extends OperationPlan>(input: Omit<T, "planId" | "issuedAt" | "expiresAt" | "digest" | "auditId" | "state"> & { ttlMs: number }): T {
  const issuedAt = new Date();
  const plan = {
    ...input,
    planId: `op_${randomUUID()}`,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + input.ttlMs).toISOString(),
    digest: "",
    auditId: `audit_${randomUUID()}`,
    state: "planned" as const,
  } as unknown as T;
  plan.digest = operationPlanDigest(plan);
  return plan;
}

export function operationPlanDigest(plan: OperationPlan): string {
  return createHash("sha256").update(stableStringify({ ...plan, digest: undefined, state: undefined })).digest("hex");
}

export function claimOperationPlan(plan: OperationPlan, now = Date.now()): void {
  if (plan.state !== "planned") throw new Error("operation plan was already consumed");
  if (now > Date.parse(plan.expiresAt)) throw new Error("operation plan expired");
  if (plan.digest !== operationPlanDigest(plan)) throw new Error("operation plan binding changed");
  plan.state = "consumed";
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
