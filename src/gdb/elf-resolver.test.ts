import assert from "node:assert/strict";
import test from "node:test";
import { parseGdbSymbolOutput, validateSelector, type ElfSection } from "./elf-resolver";

const ram: ElfSection[] = [{ name: ".data", start: 0x20000000, end: 0x20000100, flags: ["ALLOC", "DATA"] }];

test("ELF selector validation permits one fixed array element and nested members", () => {
  assert.doesNotThrow(() => validateSelector("state.samples[2].value"));
  assert.doesNotThrow(() => validateSelector("source/file.c::state.value"));
  assert.doesNotThrow(() => validateSelector("C:\\src\\module.c::state.value"));
  assert.throws(() => validateSelector("matrix[1][2]"), /Unsafe selector/);
  assert.throws(() => validateSelector("pointer->value"), /Unsafe selector/);
  assert.throws(() => validateSelector("items[index]"), /Unsafe selector/);
});

test("GDB layout parsing returns root size, element offset, type, and RAM region", () => {
  const output = symbolOutput({ selector: "samples[2]", address: 0x20000008, rootAddress: 0x20000000, rootSize: 16, layout: "type = uint32_t [4]\n__JL_ARRAY_TYPE_BEGIN_0__\ntype = uint32_t [4]\n__JL_ARRAY_TYPE_END_0__\n__JL_BOUND_0__=1" });
  const [resolved] = parseGdbSymbolOutput(output, [{ name: "samples[2]" }], ram);
  assert.deepEqual({ rootAddress: resolved.rootAddress, rootSize: resolved.rootSize, memberOffset: resolved.memberOffset, address: resolved.address, type: resolved.type, region: resolved.region }, {
    rootAddress: 0x20000000,
    rootSize: 16,
    memberOffset: 8,
    address: 0x20000008,
    type: "uint32",
    region: "ram",
  });
});

test("GDB layout parsing rejects out-of-range arrays, pointers, unions, and bitfields", () => {
  assert.throws(() => parseGdbSymbolOutput(symbolOutput({ selector: "samples[4]", address: 0x20000010, rootAddress: 0x20000000, rootSize: 16, layout: "type = uint32_t [4]\n__JL_BOUND_0__=0" }), [{ name: "samples[4]" }], ram), /out of bounds/);
  assert.throws(() => parseGdbSymbolOutput(symbolOutput({ selector: "pointer[0]", address: 0x20000000, rootAddress: 0x20000000, rootSize: 4, layout: "__JL_ARRAY_TYPE_BEGIN_0__\ntype = uint32_t *\n__JL_ARRAY_TYPE_END_0__\n__JL_BOUND_0__=1" }), [{ name: "pointer[0]" }], ram), /pointer indexing/);
  assert.throws(() => parseGdbSymbolOutput(symbolOutput({ selector: "state.value", address: 0x20000000, rootAddress: 0x20000000, rootSize: 4, rootLayout: "type = union { uint32_t value; float f; }" }), [{ name: "state.value" }], ram), /union layouts/);
  assert.throws(() => parseGdbSymbolOutput(symbolOutput({ selector: "state.enabled", address: 0x20000000, rootAddress: 0x20000000, rootSize: 4, layout: "type = struct { unsigned enabled : 1; }" }), [{ name: "state.enabled" }], ram), /bitfields/);
});

test("GDB layout parsing permits typed read-only Flash scalars", () => {
  const flash: ElfSection[] = [{ name: ".rodata", start: 0x08000000, end: 0x08000100, flags: ["ALLOC", "READONLY"] }];
  const [resolved] = parseGdbSymbolOutput(symbolOutput({ selector: "version", address: 0x08000000, rootAddress: 0x08000000, rootSize: 4 }), [{ name: "version" }], flash);
  assert.equal(resolved.region, "flash");
});

function symbolOutput(input: { selector: string; address: number; rootAddress: number; rootSize: number; layout?: string; rootLayout?: string }): string {
  return `__JL_BEGIN_0__
__JL_ADDR_0__=0x${input.address.toString(16)}
__JL_SIZE_0__=4
type = uint32_t
__JL_END_0__
__JL_ROOT_BEGIN_0__
__JL_ROOT_ADDR_0__=0x${input.rootAddress.toString(16)}
__JL_ROOT_SIZE_0__=${input.rootSize}
${input.rootLayout ?? "type = struct fixture"}
File fixture.c:
__JL_ROOT_END_0__
__JL_LAYOUT_BEGIN_0__
${input.layout ?? "type = struct fixture"}
__JL_LAYOUT_END_0__`;
}
