import assert from "node:assert/strict";
import test from "node:test";
import { resolveElfSymbols } from "../gdb/elf-resolver";

test("offline Arm GDB resolves fixed scalar and structure-member DWARF", async () => {
  const gdb = process.env.CAPTURE_TEST_GDB;
  const elf = process.env.CAPTURE_TEST_ELF;
  assert.ok(gdb && elf, "test launcher must provide CAPTURE_TEST_GDB and CAPTURE_TEST_ELF");
  const result = await resolveElfSymbols(gdb, elf, [
    { name: "gstMotorDbg.fThetaRad" },
    { name: "capture-symbols.c::localScalar" },
    { name: "gCommand" },
    { name: "gRunEnable" },
  ]);
  assert.deepEqual(result.symbols.map((symbol) => symbol.type), ["float32", "int16", "uint32", "int8"]);
  assert.ok(result.symbols.every((symbol) => symbol.address >= 0x20000000));
  assert.ok(result.flashSections.length > 0);
  assert.ok(result.flashSections.some((section) => section.flags.includes("WRITE")), "Flash load image for writable .data must be included");
  assert.match(result.elfSha256, /^[0-9a-f]{64}$/);

  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "gArray" }]), /unsupported final scalar type/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "gBits.enabled" }]), /could not resolve|Attempt to take address|validation failed/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "localScalar" }]), /ambiguous|validation failed|could not resolve/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "gstMotorDbg" }]), /unsupported final scalar type/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "gPointer" }]), /unsupported final scalar type/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "gPacked.value" }]), /not naturally aligned/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "gReadOnly" }]), /not in an ELF writable RAM section/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "missingSymbol" }]), /validation failed/);
  await assert.rejects(() => resolveElfSymbols(gdb, elf, [{ name: "gCommand+4" }]), /Unsafe selector/);
});
