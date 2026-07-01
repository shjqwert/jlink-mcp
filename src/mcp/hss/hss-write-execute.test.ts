import assert from "node:assert/strict";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import type { HssVariableMemoryIo } from "./hss-memory-io";
import { encodeHssValues } from "./hss-typed-value";
import { executeHssVariableWritePlan } from "./hss-write-execute";
import type { HssVariableWritePlan } from "./hss-write-plan";

test("variable_write_execute writes scalar, array element, and array slice with readback", async () => {
  const memory = new FakeMemory();
  memory.set(0x20000000, encodeHssValues("int32", [7], "little"));
  memory.set(0x20000010 + 4, encodeHssValues("int16", [10], "little"));
  memory.set(0x20000020 + 8, encodeHssValues("int16", [1, 2, 3, 4], "little"));
  const scalar = await executeHssVariableWritePlan(plan({ targetRef: { kind: "scalar", path: "Debug_IqRef" }, address: 0x20000000, dataType: "int32", byteSize: 4, newValue: 120, writeByteCount: 4 }), memory, "little");
  assert.equal(scalar.oldValue, 7);
  assert.equal(scalar.readback, 120);
  assert.equal(scalar.readbackOk, true);
  const element = await executeHssVariableWritePlan(plan({ targetRef: { kind: "array_element", path: "Debug_TargetTable", index: 2 }, elementAddress: 0x20000010 + 4, elementType: "int16", elementSize: 2, newValue: 120, writeByteCount: 2 }), memory, "little");
  assert.equal(element.oldValue, 10);
  assert.equal(element.readback, 120);
  const slice = await executeHssVariableWritePlan(plan({ targetRef: { kind: "array_slice", path: "Debug_ProfileTable", startIndex: 4 }, elementAddress: 0x20000020 + 8, elementType: "int16", elementSize: 2, newValues: [100, 120, 140, 160], writeElementCount: 4, writeByteCount: 8 }), memory, "little");
  assert.deepEqual(slice.oldValues, [1, 2, 3, 4]);
  assert.deepEqual(slice.readbackValues, [100, 120, 140, 160]);
});

test("variable_write_execute supports dryRun without memory changes", async () => {
  const memory = new FakeMemory();
  memory.set(0x20000000, encodeHssValues("int32", [7], "little"));
  const result = await executeHssVariableWritePlan(plan({ address: 0x20000000, dataType: "int32", byteSize: 4, newValue: 120, writeByteCount: 4 }), memory, "little", true);
  assert.equal(result.dryRun, true);
  assert.equal(result.consumedWriteOps, 0);
  assert.deepEqual([...memory.get(0x20000000, 4)], [...encodeHssValues("int32", [7], "little")]);
});

test("variable_write_execute reports old read, write, readback, and mismatch failures", async () => {
  await assert.rejects(() => executeHssVariableWritePlan(plan({ address: 0x20000000, dataType: "int32", byteSize: 4, newValue: 1, writeByteCount: 4 }), new FakeMemory({ failRead: true }), "little"), hssError(HSS_ERROR.OLD_VALUE_READ_FAILED));
  await assert.rejects(() => executeHssVariableWritePlan(plan({ address: 0x20000000, dataType: "int32", byteSize: 4, newValue: 1, writeByteCount: 4 }), seeded({ failWrite: true }), "little"), hssError(HSS_ERROR.UNKNOWN_WRITE_STATE));
  await assert.rejects(() => executeHssVariableWritePlan(plan({ address: 0x20000000, dataType: "int32", byteSize: 4, newValue: 1, writeByteCount: 4 }), seeded({ failReadback: true }), "little"), hssError(HSS_ERROR.READBACK_FAILED));
  const mismatch = seeded({ corruptReadback: true });
  await assert.rejects(() => executeHssVariableWritePlan(plan({ address: 0x20000000, dataType: "int32", byteSize: 4, newValue: 1, writeByteCount: 4 }), mismatch, "little"), hssError(HSS_ERROR.READBACK_MISMATCH));
  assert.deepEqual([...mismatch.get(0x20000000, 4)], [...encodeHssValues("int32", [1], "little")]);
});

class FakeMemory implements HssVariableMemoryIo {
  private readonly memory = new Map<number, Buffer>();
  private writes = 0;
  constructor(private readonly options: { failRead?: boolean; failWrite?: boolean; failReadback?: boolean; corruptReadback?: boolean } = {}) {}
  set(address: number, bytes: Buffer): void { this.memory.set(address, Buffer.from(bytes)); }
  get(address: number, length: number): Buffer { return Buffer.from(this.memory.get(address) ?? Buffer.alloc(length)); }
  async read(address: number, length: number): Promise<Buffer> {
    if (this.options.failRead || (this.options.failReadback && this.writes > 0)) throw new Error("read failed");
    const bytes = this.get(address, length);
    if (this.options.corruptReadback && this.writes > 0) bytes[0] ^= 0xff;
    return bytes;
  }
  async write(address: number, bytes: Buffer): Promise<void> {
    this.writes += 1;
    if (this.options.failWrite) throw new Error("write failed");
    this.set(address, bytes);
  }
}

function seeded(options: ConstructorParameters<typeof FakeMemory>[0]): FakeMemory {
  const memory = new FakeMemory(options);
  memory.set(0x20000000, encodeHssValues("int32", [7], "little"));
  return memory;
}

function plan(overrides: Partial<HssVariableWritePlan>): HssVariableWritePlan {
  return {
    writePlanId: "wp_test",
    captureId: "11111111-1111-4111-8111-111111111111",
    captureGeneration: 1,
    targetRef: { kind: "scalar", path: "Debug_IqRef" },
    canonicalTarget: "Debug_IqRef",
    writeElementCount: 1,
    writeByteCount: 4,
    risk: "R2",
    policyMatched: true,
    policyHash: "policy",
    symbolLayoutHash: "layout",
    readbackRequired: true,
    maxWriteOpsRemaining: 1,
    maxElementsRemaining: 1,
    willEnterCaptureQueue: true,
    executable: true,
    backend: "jlink-hss",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    ...overrides,
  };
}

function hssError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HssError && error.code === code;
}
