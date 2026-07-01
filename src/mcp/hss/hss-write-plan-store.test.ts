import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import { normalizeHssPolicy, type HssPolicy } from "./hss-policy";
import { createHssVariableWritePlan, HssWritePlanStore, type HssWritePlanRevalidateContext } from "./hss-write-plan";

test("write plan store validates lookup and invalidates stale plans", async () => {
  const root = await tempProject();
  try {
    const context = await contextFor(root, "0x4");
    const store = new HssWritePlanStore();
    const plan = store.put(createHssVariableWritePlan({ captureId: context.captureId, target: "Debug_IqRef", value: 12 }, { ...context, backend: "jlink-hss" }));
    assert.equal(store.get(plan.writePlanId, context).writePlanId, plan.writePlanId);
    assertStoreError(store, plan.writePlanId, { ...context, captureGeneration: 2 }, HSS_ERROR.WRITE_PLAN_CAPTURE_MISMATCH);
    assertStoreError(store, plan.writePlanId, { ...context, policy: policy("Debug_IqRef", "uint32") }, HSS_ERROR.WRITE_PLAN_POLICY_HASH_MISMATCH);
    assertStoreError(store, plan.writePlanId, { ...context, expectedSymbolLayoutHash: "bad" }, HSS_ERROR.WRITE_PLAN_SYMBOL_HASH_MISMATCH);
    await writeMap(root, "0x8");
    assertStoreError(store, plan.writePlanId, context, HSS_ERROR.WRITE_PLAN_LAYOUT_CHANGED);
    store.invalidateCapture(context.captureId, context.captureGeneration);
    assertStoreError(store, plan.writePlanId, context, HSS_ERROR.WRITE_PLAN_NOT_FOUND);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write plan store rejects expired and already executed plans", async () => {
  const root = await tempProject();
  try {
    const context = await contextFor(root, "0x4");
    const store = new HssWritePlanStore();
    const expired = store.put(createHssVariableWritePlan({ captureId: context.captureId, target: "Debug_IqRef", value: 12, expiresInMs: 1 }, { ...context, backend: "jlink-hss" }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assertStoreError(store, expired.writePlanId, context, HSS_ERROR.WRITE_PLAN_EXPIRED);
    const executed = store.put(createHssVariableWritePlan({ captureId: context.captureId, target: "Debug_IqRef", value: 13 }, { ...context, backend: "jlink-hss" }));
    store.markExecuted(executed.writePlanId);
    assertStoreError(store, executed.writePlanId, context, HSS_ERROR.WRITE_PLAN_ALREADY_EXECUTED);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function contextFor(root: string, size: string): Promise<HssWritePlanRevalidateContext & { backend: "jlink-hss" }> {
  const mapFile = await writeMap(root, size);
  return {
    captureId: "11111111-1111-4111-8111-111111111111",
    captureGeneration: 1,
    backend: "jlink-hss",
    mapFile,
    policy: policy("Debug_IqRef", "int32"),
  };
}

async function writeMap(root: string, size: string): Promise<string> {
  const mapFile = join(root, "FOC_SCM.map");
  await writeFile(mapFile, `Debug_IqRef              0x2000'0000     ${size}  Data  Gb  app.o [1]\n`, "utf8");
  return mapFile;
}

function policy(path: string, type: "int32" | "uint32"): HssPolicy {
  return normalizeHssPolicy({ version: 2, variableWriteAllowlist: [{ path, kind: "scalar", type }] });
}

function assertStoreError(store: HssWritePlanStore, writePlanId: string, context: HssWritePlanRevalidateContext, code: string): void {
  assert.throws(() => store.get(writePlanId, context), (error: unknown) => error instanceof HssError && error.code === code);
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-write-store-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
