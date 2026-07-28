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

test("write_variable validates RAM regions before capture or direct dispatch", async () => {
  const base = resolver();
  const cases: Array<{ name: string; code: string; memoryRegions: StoredTarget["memoryRegions"] }> = [
    { name: "unconfigured", code: "MEMORY_REGION_NOT_VERIFIED", memoryRegions: [] },
    { name: "unknown", code: "MEMORY_REGION_NOT_VERIFIED", memoryRegions: [{ start: 0x20000000, length: 4, kind: "unknown", writable: true }] },
    {
      name: "cross-region",
      code: "MEMORY_RANGE_CROSSES_REGION",
      memoryRegions: [
        { start: 0x20000000, length: 2, kind: "ram", writable: true },
        { start: 0x20000002, length: 2, kind: "peripheral", writable: true },
      ],
    },
    { name: "RAM/peripheral conflict", code: "SYMBOL_REGION_CONFLICT", memoryRegions: [{ start: 0x20000000, length: 4, kind: "peripheral", writable: true }] },
  ];

  for (const scenario of cases) {
    let captureWrites = 0;
    let directWrites = 0;
    const target = { ...base.target, memoryRegions: scenario.memoryRegions };
    const direct = {
      structuredWrite: async () => {
        directWrites += 1;
        return success("write_variable", {});
      },
    } as unknown as DirectMcuService;
    const capture: CaptureVariableAccess = {
      tryReadVariable: async () => undefined,
      tryWriteVariable: async () => {
        captureWrites += 1;
        return success("write_variable", {});
      },
    };
    const router = new VariableAccessRouter(
      targetLookup(target),
      { resolveVariable: async () => ({ target, resolved: base.resolved, cacheRefreshed: false }) },
      direct,
      capture,
    );

    const result = await router.writeVariable({ projectRoot: target.projectRoot, ref: "counter", value: 1 });

    assert.equal(result.error?.code, scenario.code, scenario.name);
    assert.equal(result.error?.writeIssued, false, scenario.name);
    assert.equal(captureWrites, 0, scenario.name);
    assert.equal(directWrites, 0, scenario.name);
  }
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
): { target: StoredTarget; resolver: VariableResolver; resolved: ResolvedSymbol } {
  const target = {
    projectRoot: "D:\\fixture",
    generation: "target-generation",
    artifact: { generation: "artifact-generation" },
    liveArtifactMatch: { status },
    memoryRegions: [{ start: 0x20000000, length: 0x1000, kind: "ram", writable: true }],
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
    resolved,
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
