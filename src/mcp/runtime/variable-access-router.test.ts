import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedSymbol } from "../artifact/symbol-catalog";
import type { DirectMcuService } from "./direct-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope } from "./operation-envelope";
import type { StoredTarget, TargetStore } from "./target-store";
import type { CaptureVariableAccess, VariableResolver } from "./variable-access-contract";
import { VariableAccessRouter } from "./variable-access-router";

test("variable access falls back to direct access only when capture declines the read", async () => {
  let directReads = 0;
  const direct = {
    readMemory: async () => {
      directReads += 1;
      return success("read_variable", { dataHex: "01000000" });
    },
  } as unknown as DirectMcuService;
  const capture: CaptureVariableAccess = {
    tryReadVariable: async () => undefined,
    tryWriteVariable: async () => undefined,
  };
  const resolved = resolver();
  const router = new VariableAccessRouter(targetLookup(resolved.target), resolved.resolver, direct, capture);

  const result = await router.readVariable("D:\\fixture", "counter");

  assert.equal(result.ok, true);
  assert.equal((result.data as { typedValue: number }).typedValue, 1);
  assert.equal(directReads, 1);
});

test("failed capture reads do not fall back to direct access", async () => {
  let directReads = 0;
  const direct = {
    readMemory: async () => {
      directReads += 1;
      return success("read_variable", { dataHex: "01000000" });
    },
  } as unknown as DirectMcuService;
  const capture: CaptureVariableAccess = {
    tryReadVariable: async () => failEnvelope(createOperationEnvelope("read_variable"), {
      code: "CAPTURE_READ_FAILED",
      stage: "capture_read",
      message: "fixture capture failure",
      retryable: false,
      writeIssued: false,
      stateUnknown: false,
    }),
    tryWriteVariable: async () => undefined,
  };
  const resolved = resolver();
  const router = new VariableAccessRouter(targetLookup(resolved.target), resolved.resolver, direct, capture);

  const result = await router.readVariable("D:\\fixture", "counter");

  assert.equal(result.error?.code, "CAPTURE_READ_FAILED");
  assert.equal(directReads, 0);
});

test("capture write exceptions fail without issuing a direct write", async () => {
  let directWrites = 0;
  const direct = {
    structuredWrite: async () => {
      directWrites += 1;
      return success("write_variable", {});
    },
  } as unknown as DirectMcuService;
  const capture: CaptureVariableAccess = {
    tryReadVariable: async () => undefined,
    tryWriteVariable: async () => { throw new Error("fixture capture exception"); },
  };
  const resolved = resolver();
  const router = new VariableAccessRouter(targetLookup(resolved.target), resolved.resolver, direct, capture);

  const result = await router.writeVariable({ projectRoot: "D:\\fixture", ref: "counter", value: 1 });

  assert.equal(result.error?.code, "SYMBOL_OPERATION_FAILED");
  assert.equal(result.error?.stage, "capture_write");
  assert.equal(directWrites, 0);
});

test("unverified writes are rejected before symbol resolution", async () => {
  let resolutions = 0;
  const resolved = resolver("unverified", async () => {
    resolutions += 1;
    throw new Error("resolver must not run");
  });
  const router = new VariableAccessRouter(
    targetLookup(resolved.target),
    resolved.resolver,
    {} as DirectMcuService,
    {
      tryReadVariable: async () => undefined,
      tryWriteVariable: async () => undefined,
    },
  );

  const result = await router.writeVariable({ projectRoot: "D:\\fixture", ref: "counter", value: 1 });

  assert.equal(result.error?.code, "ARTIFACT_NOT_VERIFIED");
  assert.equal(resolutions, 0);
});

function resolver(
  status: "verified" | "unverified" | "mismatch" = "verified",
  resolveOverride?: VariableResolver["resolveVariable"],
): { target: StoredTarget; resolver: VariableResolver } {
  const target = {
    projectRoot: "D:\\fixture",
    generation: "target-generation",
    artifact: { generation: "artifact-generation" },
    liveArtifactMatch: { status },
  } as unknown as StoredTarget;
  const resolved = {
    address: 0x20000000,
    size: 4,
    type: "uint32",
    endian: "little",
    region: "ram",
    ref: {
      artifactGeneration: "artifact-generation",
      qualifiedName: "counter",
      layoutHash: "layout",
    },
  } as ResolvedSymbol;
  return {
    target,
    resolver: {
      resolveVariable: resolveOverride ?? (async () => ({ target, resolved, cacheRefreshed: false })),
    },
  };
}

function targetLookup(target: StoredTarget): Pick<TargetStore, "require"> {
  return { require: () => target };
}

function success(tool: string, data: Record<string, unknown>) {
  const envelope = createOperationEnvelope(tool);
  envelope.data = data;
  return finishEnvelope(envelope, true);
}
