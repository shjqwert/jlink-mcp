import assert from "node:assert/strict";
import test from "node:test";
import { claimOperationPlan, createOperationPlan, operationPlanDigest, type VariableWriteOperationPlan } from "./operation-contract";

test("OperationPlan digest binds execution facts and claim is synchronous single-use", () => {
  const plan = createOperationPlan<VariableWriteOperationPlan>({
    kind: "variable_write",
    tool: "variable_write_execute",
    canonicalArgs: { target: "value", value: 1 },
    risk: "R2",
    runtime: { identitySha256: "runtime", scriptApprovalSha256: "script" },
    target: { targetId: "target", probeSerial: "probe", connectionGeneration: 1 },
    artifact: { generation: "generation", sha256: "artifact", match: "verified", evidenceGeneration: "evidence" },
    layout: { sha256: "layout" },
    policy: { sha256: "policy", rule: "value", maxWrites: 2, remainingWrites: 2, maxElements: 4, remainingElements: 4 },
    session: { id: "session", captureId: "capture", captureGeneration: 1 },
    readback: { required: true },
    ttlMs: 60_000,
  });
  assert.equal(plan.digest, operationPlanDigest(plan));
  claimOperationPlan(plan);
  assert.equal(plan.state, "consumed");
  assert.throws(() => claimOperationPlan(plan), /already consumed/);
});

test("OperationPlan rejects stale or changed bindings before consumption", () => {
  const base = createOperationPlan<VariableWriteOperationPlan>({
    kind: "variable_write", tool: "variable_write_execute", canonicalArgs: {}, risk: "R2",
    runtime: { identitySha256: "runtime", scriptApprovalSha256: "script" },
    target: { targetId: "target", connectionGeneration: 1 },
    artifact: { generation: "generation", sha256: "artifact", match: "verified", evidenceGeneration: "evidence" },
    layout: { sha256: "layout" }, policy: { sha256: "policy", rule: "rule", maxWrites: 1, remainingWrites: 1, maxElements: 1, remainingElements: 1 },
    session: { id: "session", captureGeneration: 0 }, readback: { required: true }, ttlMs: 1,
  });
  assert.throws(() => claimOperationPlan(base, Date.parse(base.expiresAt) + 1), /expired/);
  const changed = { ...base, state: "planned" as const, layout: { sha256: "changed" } };
  assert.throws(() => claimOperationPlan(changed), /binding changed/);
});
