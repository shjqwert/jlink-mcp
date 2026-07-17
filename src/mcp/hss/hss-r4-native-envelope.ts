import { createHash } from "node:crypto";
import { operationDigest, type R4OperationBinding } from "../approval-broker";
import type { R4ApprovalConsumptionEvidence, R4PlanInput } from "../risk-operations";
import { encodeHssValues, type HssTargetEndian } from "./hss-typed-value";
import type { HssVariableWritePlan } from "./hss-write-plan";

export interface HssR4NativeExceptionEnvelope {
  schema: "jlink-mcp-r4-native-exception";
  version: 1;
  kind: "unverified_variable_write";
  canonicalization: "utf8-sorted-json-v1";
  summaryAlgorithm: "sha256";
  operation: {
    tool: "variable_write_execute";
    writePlanId: string;
    planDigest: string;
    planIssuedAt: string;
    planExpiresAt: string;
    canonicalArgs: Record<string, unknown>;
  };
  approval: R4ApprovalConsumptionEvidence;
  binding: {
    target: { targetId: string; artifactMatch: "unverified" };
    probe: { kind: "jlink"; serial: string; interface: "SWD" | "JTAG"; speedKhz: number };
    runtime: { identitySha256: string; scriptApprovalSha256: string };
    artifact: { generation: string; sha256: string; evidenceGeneration: string };
    layoutSha256: string;
    policy: { sha256: string; rule: string; unverifiedWriteException: true; maxWrites: number; remainingWrites: number; maxElements: number; remainingElements: number };
    session: { id: string; captureId: string; captureGeneration: number };
    physicalConnectionGeneration: number;
  };
  write: {
    canonicalTarget: string;
    address: number;
    accessSize: 1 | 2 | 4;
    byteLength: number;
    bytesHex: string;
    readbackRequired: true;
  };
  summarySha256: string;
}

export function createHssR4NativeExceptionEnvelope(
  plan: HssVariableWritePlan,
  approvalBinding: R4PlanInput,
  approval: R4ApprovalConsumptionEvidence,
  endian: HssTargetEndian,
): HssR4NativeExceptionEnvelope {
  const operation = plan.operationPlan;
  const address = plan.address ?? plan.elementAddress;
  const accessSize = plan.byteSize ?? plan.elementSize;
  if (plan.risk !== "R4" || plan.executable || operation.state !== "consumed" || operation.artifact.match !== "unverified") throw new Error("R4 Native envelope requires a consumed, non-executable unverified write plan");
  if (address === undefined || (accessSize !== 1 && accessSize !== 2 && accessSize !== 4)) throw new Error("R4 Native envelope requires a valid write address and access size");
  if (approval.operationDigest !== operationDigest(approvalBinding)) throw new Error("approval consumption evidence does not match the current R4 binding");
  const serial = approvalBinding.probe.serial;
  const interfaceName = approvalBinding.probe.interface;
  const speedKhz = approvalBinding.probe.speedKhz;
  if (!serial || !interfaceName || !speedKhz) throw new Error("R4 Native envelope requires exact probe serial, interface, and speed");
  const type = (plan.dataType ?? plan.elementType) as Parameters<typeof encodeHssValues>[0];
  const bytes = encodeHssValues(type, plan.newValues ?? [plan.newValue as number], endian);
  const body: Omit<HssR4NativeExceptionEnvelope, "summarySha256"> = {
    schema: "jlink-mcp-r4-native-exception",
    version: 1,
    kind: "unverified_variable_write",
    canonicalization: "utf8-sorted-json-v1",
    summaryAlgorithm: "sha256",
    operation: { tool: "variable_write_execute", writePlanId: plan.writePlanId, planDigest: operation.digest, planIssuedAt: operation.issuedAt, planExpiresAt: operation.expiresAt, canonicalArgs: operation.canonicalArgs },
    approval: { ...approval },
    binding: {
      target: { targetId: operation.target.targetId, artifactMatch: "unverified" },
      probe: { kind: "jlink", serial, interface: interfaceName, speedKhz },
      runtime: { ...operation.runtime },
      artifact: { generation: operation.artifact.generation, sha256: operation.artifact.sha256, evidenceGeneration: operation.artifact.evidenceGeneration },
      layoutSha256: operation.layout.sha256,
      policy: { ...operation.policy, unverifiedWriteException: true },
      session: { id: operation.session.id, captureId: operation.session.captureId ?? "", captureGeneration: operation.session.captureGeneration },
      physicalConnectionGeneration: operation.target.connectionGeneration,
    },
    write: { canonicalTarget: plan.canonicalTarget, address, accessSize, byteLength: bytes.length, bytesHex: bytes.toString("hex"), readbackRequired: true },
  };
  return assertHssR4NativeExceptionEnvelope({ ...body, summarySha256: digest(body) });
}

export function assertHssR4NativeExceptionEnvelope(value: unknown, expectedSummarySha256?: string): HssR4NativeExceptionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("R4 Native exception envelope must be an object");
  const envelope = value as HssR4NativeExceptionEnvelope;
  if (envelope.schema !== "jlink-mcp-r4-native-exception" || envelope.version !== 1 || envelope.kind !== "unverified_variable_write"
      || envelope.canonicalization !== "utf8-sorted-json-v1" || envelope.summaryAlgorithm !== "sha256") throw new Error("R4 Native exception envelope discriminator is invalid");
  requireKeys(envelope, ["approval", "binding", "canonicalization", "kind", "operation", "schema", "summaryAlgorithm", "summarySha256", "version", "write"]);
  requireKeys(envelope.operation, ["canonicalArgs", "planDigest", "planExpiresAt", "planIssuedAt", "tool", "writePlanId"]);
  requireKeys(envelope.approval, ["challengeId", "consumedAt", "expiresAt", "nonceSha256", "operationDigest", "state"]);
  requireKeys(envelope.binding, ["artifact", "layoutSha256", "physicalConnectionGeneration", "policy", "probe", "runtime", "session", "target"]);
  requireKeys(envelope.binding.target, ["artifactMatch", "targetId"]);
  requireKeys(envelope.binding.probe, ["interface", "kind", "serial", "speedKhz"]);
  requireKeys(envelope.binding.runtime, ["identitySha256", "scriptApprovalSha256"]);
  requireKeys(envelope.binding.artifact, ["evidenceGeneration", "generation", "sha256"]);
  requireKeys(envelope.binding.policy, ["maxElements", "maxWrites", "remainingElements", "remainingWrites", "rule", "sha256", "unverifiedWriteException"]);
  requireKeys(envelope.binding.session, ["captureGeneration", "captureId", "id"]);
  requireKeys(envelope.write, ["accessSize", "address", "byteLength", "bytesHex", "canonicalTarget", "readbackRequired"]);
  if (envelope.operation?.tool !== "variable_write_execute" || !/^op_[0-9a-f-]{36}$/i.test(envelope.operation.writePlanId)) throw new Error("R4 Native exception operation identity is invalid");
  for (const hash of [envelope.operation.planDigest, envelope.approval?.operationDigest, envelope.approval?.nonceSha256, envelope.binding?.runtime?.identitySha256, envelope.binding?.runtime?.scriptApprovalSha256, envelope.binding?.artifact?.generation, envelope.binding?.artifact?.sha256, envelope.binding?.artifact?.evidenceGeneration, envelope.binding?.layoutSha256, envelope.binding?.policy?.sha256, envelope.summarySha256]) requireHash(hash);
  if (envelope.approval?.state !== "consumed" || !isUuid(envelope.approval.challengeId) || !isIso(envelope.approval.consumedAt) || !isIso(envelope.approval.expiresAt) || Date.parse(envelope.approval.consumedAt) > Date.parse(envelope.approval.expiresAt)) throw new Error("R4 Native exception approval evidence is invalid");
  if (envelope.binding?.target?.artifactMatch !== "unverified" || envelope.binding?.policy?.unverifiedWriteException !== true) throw new Error("R4 Native exception requires unverified state and an explicit policy exception");
  if (!text(envelope.binding.target.targetId) || envelope.binding.probe?.kind !== "jlink" || !text(envelope.binding.probe.serial) || !["SWD", "JTAG"].includes(envelope.binding.probe.interface) || !positiveInteger(envelope.binding.probe.speedKhz) || !positiveInteger(envelope.binding.physicalConnectionGeneration)) throw new Error("R4 Native exception target or probe binding is invalid");
  if (!text(envelope.binding.policy.rule) || !positiveInteger(envelope.binding.policy.maxWrites) || !nonNegativeInteger(envelope.binding.policy.remainingWrites) || envelope.binding.policy.remainingWrites > envelope.binding.policy.maxWrites || !positiveInteger(envelope.binding.policy.maxElements) || !nonNegativeInteger(envelope.binding.policy.remainingElements) || envelope.binding.policy.remainingElements > envelope.binding.policy.maxElements || !text(envelope.binding.session.id) || !text(envelope.binding.session.captureId) || !nonNegativeInteger(envelope.binding.session.captureGeneration)) throw new Error("R4 Native exception policy or session binding is invalid");
  if (!isIso(envelope.operation.planIssuedAt) || !isIso(envelope.operation.planExpiresAt) || Date.parse(envelope.operation.planIssuedAt) > Date.parse(envelope.operation.planExpiresAt)) throw new Error("R4 Native exception plan lifetime is invalid");
  if (!text(envelope.write?.canonicalTarget) || !nonNegativeInteger(envelope.write?.address) || ![1, 2, 4].includes(envelope.write?.accessSize) || !positiveInteger(envelope.write?.byteLength) || typeof envelope.write?.bytesHex !== "string" || !/^[0-9a-f]+$/.test(envelope.write.bytesHex) || envelope.write.bytesHex.length !== envelope.write.byteLength * 2 || envelope.write.byteLength % envelope.write.accessSize !== 0 || envelope.write.readbackRequired !== true) throw new Error("R4 Native exception write binding is invalid");
  const expectedApprovalBinding: R4OperationBinding = {
    tool: "variable_write_execute", canonicalArgs: { writePlanId: envelope.operation.writePlanId },
    target: envelope.binding.target, probe: envelope.binding.probe,
    artifact: { generation: envelope.binding.artifact.generation, sha256: envelope.binding.artifact.sha256 },
    layoutHash: envelope.binding.layoutSha256,
    policy: { sha256: envelope.binding.policy.sha256, unverifiedWriteException: true },
    session: { id: envelope.binding.session.id, captureId: envelope.binding.session.captureId },
    connectionGeneration: envelope.binding.physicalConnectionGeneration,
  };
  if (operationDigest(expectedApprovalBinding) !== envelope.approval.operationDigest) throw new Error("R4 Native exception approval digest is inconsistent");
  const actual = digest({ ...envelope, summarySha256: undefined });
  if (envelope.summarySha256 !== actual || (expectedSummarySha256 && expectedSummarySha256 !== actual)) throw new Error("R4 Native exception summary digest is inconsistent");
  return envelope;
}

export function canonicalHssR4NativeExceptionSummary(value: Omit<HssR4NativeExceptionEnvelope, "summarySha256">): string { return stableJson(value); }

function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function requireHash(value: unknown): void { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("R4 Native exception hashes must be canonical lowercase SHA-256"); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function nonNegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function isIso(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function isUuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function requireKeys(value: unknown, expected: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("R4 Native exception envelope field must be an object");
  const actual = Object.keys(value).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`R4 Native exception envelope contains missing or unknown fields: ${actual.join(",")}`);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("R4 Native exception canonical input contains a non-finite number");
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("R4 Native exception canonical input contains an unsupported value");
  return encoded;
}
