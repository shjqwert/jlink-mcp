import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { operationDigest } from "../approval-broker";
import { claimOperationPlan, createOperationPlan, type VariableWriteOperationPlan } from "../operation-contract";
import type { R4ApprovalConsumptionEvidence, R4PlanInput } from "../risk-operations";
import { assertHssR4NativeExceptionEnvelope, canonicalHssR4NativeExceptionSummary, createHssR4NativeExceptionEnvelope } from "./hss-r4-native-envelope";
import type { HssVariableWritePlan } from "./hss-write-plan";

test("R4 Native exception envelope is canonical, complete, and contains only consumed approval evidence", () => {
  const fixture = envelopeFixture();
  const envelope = createHssR4NativeExceptionEnvelope(fixture.plan, fixture.binding, fixture.approval, "little");
  assert.equal(envelope.summarySha256, createHash("sha256").update(canonicalHssR4NativeExceptionSummary({ ...envelope, summarySha256: undefined } as never)).digest("hex"));
  assert.equal(envelope.binding.target.artifactMatch, "unverified");
  assert.equal(envelope.binding.policy.unverifiedWriteException, true);
  assert.equal(envelope.binding.physicalConnectionGeneration, 7);
  assert.equal(envelope.write.bytesHex, "2a000000");
  const persisted = JSON.stringify(envelope);
  for (const forbidden of ["approvalToken", "secret", "signature", '"nonce"']) assert.equal(persisted.includes(forbidden), false);
});

test("R4 Native exception envelope rejects missing, tampered, verified, and non-exception inputs", () => {
  const fixture = envelopeFixture();
  const envelope = createHssR4NativeExceptionEnvelope(fixture.plan, fixture.binding, fixture.approval, "little");
  const cases: unknown[] = [
    { ...envelope, approval: undefined },
    { ...envelope, write: { ...envelope.write, bytesHex: "00000000" } },
    { ...envelope, binding: { ...envelope.binding, target: { ...envelope.binding.target, artifactMatch: "verified" } } },
    { ...envelope, binding: { ...envelope.binding, target: { ...envelope.binding.target, artifactMatch: "mismatch" } } },
    { ...envelope, binding: { ...envelope.binding, policy: { ...envelope.binding.policy, unverifiedWriteException: false } } },
    { ...envelope, summarySha256: envelope.summarySha256.toUpperCase() },
    { ...envelope, callerAuthorization: true },
  ];
  for (const value of cases) assert.throws(() => assertHssR4NativeExceptionEnvelope(value));
  assert.throws(() => assertHssR4NativeExceptionEnvelope(envelope, "f".repeat(64)), /summary digest/);
});

function envelopeFixture(): { plan: HssVariableWritePlan; binding: R4PlanInput; approval: R4ApprovalConsumptionEvidence } {
  const operationPlan = createOperationPlan<VariableWriteOperationPlan>({
    kind: "variable_write", tool: "variable_write_execute", canonicalArgs: { targetRef: { kind: "scalar", path: "Debug_R4" }, canonicalTarget: "Debug_R4", values: [42] }, risk: "R4",
    runtime: { identitySha256: "1".repeat(64), scriptApprovalSha256: "2".repeat(64) },
    target: { targetId: "MCU", probeSerial: "123", connectionGeneration: 7 },
    artifact: { generation: "3".repeat(64), sha256: "4".repeat(64), match: "unverified", evidenceGeneration: "5".repeat(64) },
    layout: { sha256: "6".repeat(64) },
    policy: { sha256: "7".repeat(64), rule: "Debug_R4", maxWrites: 1, remainingWrites: 1, maxElements: 1, remainingElements: 1 },
    session: { id: "session", captureId: "outside-capture", captureGeneration: 0 }, readback: { required: true }, ttlMs: 60000,
  });
  const plan: HssVariableWritePlan = {
    writePlanId: operationPlan.planId, captureId: "outside-capture", captureGeneration: 0, targetRef: { kind: "scalar", path: "Debug_R4" }, canonicalTarget: "Debug_R4",
    address: 0x20000000, dataType: "int32", byteSize: 4, writeElementCount: 1, writeByteCount: 4, newValue: 42,
    risk: "R4", policyMatched: true, policyHash: "7".repeat(64), symbolLayoutHash: "6".repeat(64), readbackRequired: true,
    maxWriteOpsRemaining: 1, maxElementsRemaining: 1, willEnterCaptureQueue: false, executable: false, backend: "jlink-hss",
    createdAt: operationPlan.issuedAt, expiresAt: operationPlan.expiresAt, operationPlan,
  };
  const binding: R4PlanInput = {
    tool: "variable_write_execute", canonicalArgs: { writePlanId: plan.writePlanId }, target: { targetId: "MCU", artifactMatch: "unverified" },
    probe: { kind: "jlink", serial: "123", interface: "SWD", speedKhz: 4000 }, artifact: { generation: "3".repeat(64), sha256: "4".repeat(64) },
    layoutHash: "6".repeat(64), policy: { sha256: "7".repeat(64), unverifiedWriteException: true }, session: { id: "session", captureId: "outside-capture" }, connectionGeneration: 7,
  };
  claimOperationPlan(operationPlan);
  const approval: R4ApprovalConsumptionEvidence = { state: "consumed", challengeId: randomUUID(), operationDigest: operationDigest(binding), nonceSha256: "8".repeat(64), consumedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() };
  return { plan, binding, approval };
}
