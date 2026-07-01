import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import { normalizeHssPolicy, policyEntryForPath } from "./hss-policy";
import { resolveIarMapWriteTargetLayout } from "./hss-write-layout";

test("write layout resolves RAM scalar, static scalar, and struct member scalar", async () => {
  const root = await tempProject();
  try {
    const map = await writeMap(root, [
      "Debug_IqRef              0x2000'0000     0x4  Data  Gb  app.o [1]",
      "StaticLimit              0x2000'0004     0x2  Data  Lc  app.o [1]",
      "DebugConfig.member       0x2000'0008     0x1  Data  Gb  app.o [1]",
    ]);
    const policy = normalizeHssPolicy({
      version: 2,
      variableWriteAllowlist: [
        { path: "Debug_IqRef", kind: "scalar", type: "int32" },
        { path: "StaticLimit", kind: "scalar", type: "uint16" },
        { path: "DebugConfig.member", kind: "scalar", type: "uint8" },
      ],
    });
    assert.equal(resolveIarMapWriteTargetLayout(map, policyEntryForPath(policy, "Debug_IqRef")).kind, "scalar");
    assert.equal(resolveIarMapWriteTargetLayout(map, policyEntryForPath(policy, "StaticLimit")).kind, "scalar");
    assert.equal(resolveIarMapWriteTargetLayout(map, policyEntryForPath(policy, "DebugConfig.member")).kind, "scalar");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write layout resolves global, static, and member fixed arrays", async () => {
  const root = await tempProject();
  try {
    const map = await writeMap(root, [
      "Debug_TargetTable        0x2000'0010     0x8  Data  Gb  app.o [1]",
      "Static_TargetTable       0x2000'0020     0x8  Data  Lc  app.o [1]",
      "DebugConfig.table        0x2000'0030     0x8  Data  Gb  app.o [1]",
    ]);
    const policy = normalizeHssPolicy({
      version: 2,
      variableWriteAllowlist: [
        { path: "Debug_TargetTable", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
        { path: "Static_TargetTable", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
        { path: "DebugConfig.table", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
      ],
    });
    for (const path of ["Debug_TargetTable", "Static_TargetTable", "DebugConfig.table"]) {
      const layout = resolveIarMapWriteTargetLayout(map, policyEntryForPath(policy, path));
      assert.equal(layout.kind, "fixed_array");
      assert.match(layout.symbolLayoutHash, /^[0-9a-f]{64}$/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("write layout rejects pointer, dynamic, incomplete, non-RAM, and size mismatch arrays", async () => {
  const root = await tempProject();
  try {
    const map = await writeMap(root, [
      "Debug_TargetPtr          0x2000'0010     0x4  Data  Gb  app.o [1]",
      "Debug_DynamicTable       0x2000'0020     0x8  Data  Gb  app.o [1]",
      "Debug_IncompleteTable    0x2000'0030     0x0  Data  Gb  app.o [1]",
      "FlashArray               0x0800'0000     0x8  Data  Gb  app.o [1]",
      "PeripheralArray          0x4000'0000     0x10 Data  Gb  app.o [1]",
      "Debug_ShortTable         0x2000'0040     0x4  Data  Gb  app.o [1]",
      "Debug_LongTable          0x2000'0050     0x10 Data  Gb  app.o [1]",
    ]);
    const policy = normalizeHssPolicy({
      version: 2,
      variableWriteAllowlist: [
        { path: "Debug_TargetPtr", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
        { path: "Debug_DynamicTable", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
        { path: "Debug_IncompleteTable", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
        { path: "FlashArray", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
        { path: "PeripheralArray", kind: "fixed_array", elementType: "uint32", arrayLength: 4 },
        { path: "Debug_ShortTable", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
        { path: "Debug_LongTable", kind: "fixed_array", elementType: "int16", arrayLength: 4 },
      ],
    });
    assertLayoutError(map, policy, "Debug_TargetPtr", HSS_ERROR.SYMBOL_POINTER_NOT_ALLOWED);
    assertLayoutError(map, policy, "Debug_DynamicTable", HSS_ERROR.SYMBOL_DYNAMIC_ARRAY_NOT_ALLOWED);
    assertLayoutError(map, policy, "Debug_IncompleteTable", HSS_ERROR.SYMBOL_INCOMPLETE_ARRAY_NOT_ALLOWED);
    assertLayoutError(map, policy, "FlashArray", HSS_ERROR.SYMBOL_NOT_RAM);
    assertLayoutError(map, policy, "PeripheralArray", HSS_ERROR.SYMBOL_NOT_RAM);
    assertLayoutError(map, policy, "Debug_ShortTable", HSS_ERROR.SYMBOL_ARRAY_SIZE_MISMATCH);
    assertLayoutError(map, policy, "Debug_LongTable", HSS_ERROR.SYMBOL_ARRAY_LAYOUT_UNKNOWN);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function assertLayoutError(map: string, policy: ReturnType<typeof normalizeHssPolicy>, path: string, code: string): void {
  assert.throws(() => resolveIarMapWriteTargetLayout(map, policyEntryForPath(policy, path)), (error: unknown) => error instanceof HssError && error.code === code);
}

async function writeMap(root: string, lines: string[]): Promise<string> {
  const file = join(root, "FOC_SCM.map");
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-write-layout-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
