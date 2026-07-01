import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import { normalizeHssPolicy, type HssPolicy } from "./hss-policy";
import { createHssVariableWritePlan, type HssVariableWritePlanInput } from "./hss-write-plan";

test("variable_write_plan supports scalar, array element, and array slice", async () => {
  const root = await tempProject();
  try {
    const context = await planContext(root);
    const scalar = createHssVariableWritePlan({ captureId: context.captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 120 }, context);
    assert.equal(scalar.canonicalTarget, "Debug_IqRef");
    assert.equal(scalar.address, 0x20000000);
    assert.equal(scalar.writeByteCount, 4);
    assert.equal(scalar.executable, true);
    assert.equal(scalar.willEnterCaptureQueue, true);

    const element = createHssVariableWritePlan({ captureId: context.captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 2 }, value: 120 }, context);
    assert.equal(element.canonicalTarget, "Debug_TargetTable[2]");
    assert.equal(element.elementAddress, 0x20000010 + 4);
    assert.equal(element.newValue, 120);

    const slice = createHssVariableWritePlan({ captureId: context.captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, values: [100, 120, 140, 160] }, context);
    assert.equal(slice.canonicalTarget, "Debug_ProfileTable[4..7]");
    assert.equal(slice.writeElementCount, 4);
    assert.deepEqual(slice.newValues, [100, 120, 140, 160]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("variable_write_plan rejects unsafe target and policy cases", async () => {
  const root = await tempProject();
  try {
    const context = await planContext(root);
    assertPlanError(context, { captureId: context.captureId, target: "0x20000000", value: 1 }, HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "scalar", path: "Missing" }, value: 1 }, HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: -1 }, value: 1 }, HSS_ERROR.POLICY_ARRAY_INDEX_OUT_OF_RANGE);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 4 }, value: 1 }, HSS_ERROR.POLICY_ARRAY_INDEX_OUT_OF_RANGE);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 14 }, values: [1, 2, 3] }, HSS_ERROR.POLICY_ARRAY_SLICE_OUT_OF_RANGE);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_slice", path: "Debug_TargetTable", startIndex: 0 }, values: [1, 2] }, HSS_ERROR.POLICY_ARRAY_SLICE_NOT_ALLOWED);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, values: [] }, HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 999 }, HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 1 }, value: 1 }, HSS_ERROR.POLICY_ARRAY_INDEX_NOT_ALLOWED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("variable_write_plan enforces counters, bytes, R3 plan-only, and RAM layout", async () => {
  const root = await tempProject();
  try {
    const context = await planContext(root);
    assertPlanError({ ...context, writeOpsUsed: 2 }, { captureId: context.captureId, targetRef: { kind: "scalar", path: "Debug_IqRef" }, value: 1 }, HSS_ERROR.POLICY_MAX_WRITES_EXCEEDED);
    assertPlanError({ ...context, elementsUsed: 1 }, { captureId: context.captureId, targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, values: [1, 2, 3, 4] }, HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "scalar", path: "Debug_TooNarrow" }, value: 1 }, HSS_ERROR.POLICY_MAX_BYTES_EXCEEDED);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_element", path: "FlashArray", index: 0 }, value: 1 }, HSS_ERROR.SYMBOL_NOT_RAM);
    assertPlanError(context, { captureId: context.captureId, targetRef: { kind: "array_element", path: "Debug_TargetPtr", index: 0 }, value: 1 }, HSS_ERROR.SYMBOL_POINTER_NOT_ALLOWED);
    const r3 = createHssVariableWritePlan({ captureId: context.captureId, targetRef: { kind: "scalar", path: "Debug_R3" }, value: 1 }, context);
    assert.equal(r3.risk, "R3");
    assert.equal(r3.executable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type PlanContext = Parameters<typeof createHssVariableWritePlan>[1];

async function planContext(root: string): Promise<PlanContext> {
  const mapFile = join(root, "FOC_SCM.map");
  await writeFile(mapFile, [
    "Debug_IqRef              0x2000'0000     0x4  Data  Gb  app.o [1]",
    "Debug_TooNarrow          0x2000'0004     0x4  Data  Gb  app.o [1]",
    "Debug_R3                 0x2000'0008     0x4  Data  Gb  app.o [1]",
    "Debug_TargetTable        0x2000'0010     0x8  Data  Gb  app.o [1]",
    "Debug_ProfileTable       0x2000'0020     0x20 Data  Gb  app.o [1]",
    "FlashArray               0x0800'0000     0x8  Data  Gb  app.o [1]",
    "Debug_TargetPtr          0x2000'0050     0x8  Data  Gb  app.o [1]",
  ].join("\n"), "utf8");
  return {
    captureId: "11111111-1111-4111-8111-111111111111",
    captureGeneration: 1,
    backend: "jlink-hss",
    mapFile,
    policy: policy(),
  };
}

function policy(): HssPolicy {
  return normalizeHssPolicy({
    version: 2,
    variableWriteAllowlist: [
      { path: "Debug_IqRef", kind: "scalar", type: "int32", min: -200, max: 200, maxWriteOps: 2, maxElementsTotal: 2 },
      { path: "Debug_TooNarrow", kind: "scalar", type: "int32", maxBytesPerWrite: 2 },
      { path: "Debug_R3", kind: "scalar", type: "int32", risk: "R3" },
      { path: "Debug_TargetTable", kind: "fixed_array", elementType: "int16", arrayLength: 4, allowedIndices: [0, 2], allowArraySliceWrite: false },
      { path: "Debug_ProfileTable", kind: "fixed_array", elementType: "int16", arrayLength: 16, allowedIndexRange: { start: 4, end: 7 }, allowArraySliceWrite: true, maxElementsPerWrite: 4, maxElementsTotal: 4 },
      { path: "FlashArray", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
      { path: "Debug_TargetPtr", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
    ],
  });
}

function assertPlanError(context: PlanContext, input: HssVariableWritePlanInput, code: string): void {
  assert.throws(() => createHssVariableWritePlan(input, context), (error: unknown) => error instanceof HssError && error.code === code);
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-write-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
