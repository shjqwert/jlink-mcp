import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import { loadHssPolicy, normalizeHssPolicy, policyEntryForPath, type HssFixedArrayPolicyEntry } from "./hss-policy";

test("policy v2 accepts scalar allowlist entries", () => {
  const policy = normalizeHssPolicy({
    version: 2,
    requireReadback: true,
    allowBurstWrite: false,
    defaultMaxWritesScope: "capture",
    variableWriteAllowlist: [{
      path: "Debug_IqRef",
      kind: "scalar",
      type: "int32",
      min: -200,
      max: 200,
      allowedValues: [-100, 0, 100],
      maxWriteOps: 2,
      maxElementsTotal: 2,
      maxBytesPerWrite: 4,
      risk: "R2",
      captureTimeWrite: true,
    }],
  });
  const entry = policyEntryForPath(policy, "Debug_IqRef", "scalar");
  assert.equal(entry.kind, "scalar");
  assert.equal(entry.executable, true);
  assert.match(policy.policyHash, /^[0-9a-f]{64}$/);
});

test("policy v2 accepts fixed array allowlist entries", () => {
  const policy = normalizeHssPolicy({
    version: 2,
    variableWriteAllowlist: [{
      path: "Debug_ProfileTable",
      kind: "fixed_array",
      elementType: "int16",
      arrayLength: 16,
      allowedIndices: [4, 5, 6, 7],
      allowedIndexRange: { start: 4, end: 7 },
      min: -500,
      max: 500,
      allowArrayElementWrite: true,
      allowArraySliceWrite: true,
      maxWriteOps: 3,
      maxElementsPerWrite: 4,
      maxElementsTotal: 12,
      maxBytesPerWrite: 8,
      risk: "R2",
    }],
  });
  const entry = policyEntryForPath(policy, "Debug_ProfileTable", "fixed_array") as HssFixedArrayPolicyEntry;
  assert.equal(entry.arrayLength, 16);
  assert.deepEqual(entry.allowedIndexRange, { start: 4, end: 7 });
  assert.equal(entry.maxBytesPerWrite, 8);
});

test("policy v2 rejects invalid element type", () => {
  assertPolicyError({
    version: 2,
    variableWriteAllowlist: [{ path: "Debug_Table", kind: "fixed_array", elementType: "int64", arrayLength: 4 }],
  }, HSS_ERROR.POLICY_TYPE_MISMATCH);
});

test("policy v2 rejects missing arrayLength", () => {
  assertPolicyError({
    version: 2,
    variableWriteAllowlist: [{ path: "Debug_Table", kind: "fixed_array", elementType: "int16" }],
  }, HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED);
});

test("policy v2 rejects allowedIndices outside array bounds", () => {
  assertPolicyError({
    version: 2,
    variableWriteAllowlist: [{ path: "Debug_Table", kind: "fixed_array", elementType: "int16", arrayLength: 4, allowedIndices: [4] }],
  }, HSS_ERROR.POLICY_ARRAY_INDEX_OUT_OF_RANGE);
});

test("policy v2 rejects allowedIndexRange outside array bounds", () => {
  assertPolicyError({
    version: 2,
    variableWriteAllowlist: [{ path: "Debug_Table", kind: "fixed_array", elementType: "int16", arrayLength: 4, allowedIndexRange: { start: 1, end: 4 } }],
  }, HSS_ERROR.POLICY_ARRAY_SLICE_OUT_OF_RANGE);
});

test("policy v2 rejects maxBytesPerWrite smaller than slice byte count", () => {
  assertPolicyError({
    version: 2,
    variableWriteAllowlist: [{ path: "Debug_Table", kind: "fixed_array", elementType: "int16", arrayLength: 4, maxElementsPerWrite: 2, maxBytesPerWrite: 2 }],
  }, HSS_ERROR.POLICY_MAX_BYTES_EXCEEDED);
});

test("policy v2 preserves slice disabled and R3 plan-only entries", () => {
  const policy = normalizeHssPolicy({
    version: 2,
    variableWriteAllowlist: [{
      path: "Debug_TargetTable",
      kind: "fixed_array",
      elementType: "uint8",
      arrayLength: 4,
      allowArraySliceWrite: false,
      risk: "R3",
    }],
  });
  const entry = policyEntryForPath(policy, "Debug_TargetTable", "fixed_array") as HssFixedArrayPolicyEntry;
  assert.equal(entry.allowArraySliceWrite, false);
  assert.equal(entry.risk, "R3");
  assert.equal(entry.executable, false);
});

test("policy loader reports malformed JSON and unsupported version", async () => {
  const root = await tempProject();
  try {
    const file = join(root, ".jlink-mcp", "policy.json");
    await mkdir(join(root, ".jlink-mcp"), { recursive: true });
    await writeFile(file, "{", "utf8");
    await assert.rejects(() => loadHssPolicy(root), policyError(HSS_ERROR.POLICY_INVALID_JSON));
    await writeFile(file, JSON.stringify({ version: 1, variableWriteAllowlist: [] }), "utf8");
    await assert.rejects(() => loadHssPolicy(root), policyError(HSS_ERROR.POLICY_UNSUPPORTED_VERSION));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function assertPolicyError(raw: unknown, code: string): void {
  assert.throws(() => normalizeHssPolicy(raw), policyError(code));
}

function policyError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HssError && error.code === code;
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
