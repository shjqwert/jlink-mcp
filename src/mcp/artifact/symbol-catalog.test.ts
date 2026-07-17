import assert from "node:assert/strict";
import test from "node:test";
import { SymbolCatalog } from "./symbol-catalog";

const artifact = { generation: "a".repeat(64) };

test("search is bounded and unqualified duplicate statics remain ambiguous", () => {
  const catalog = new SymbolCatalog(artifact, [
    candidate("one.c::counter", "static"),
    candidate("two.c::counter", "static"),
    candidate("globalCounter", "global"),
  ]);
  assert.equal(catalog.search("counter", 1).length, 1);
  const result = catalog.resolve("counter");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "symbol_ambiguous");
    assert.equal(result.error.candidates?.length, 2);
  }
  assert.equal(catalog.resolve("one.c::counter").ok, true);
});

test("fixed DWARF member has stable layout identity and final address", () => {
  const catalog = new SymbolCatalog(artifact, [{ ...candidate("motor", "fixed-member"), memberPath: "speed", rootAddress: 0x20000000, memberOffset: 4, source: "elf-dwarf", confidence: "dwarf" }]);
  const first = catalog.resolve("motor.speed");
  const second = catalog.resolve("motor.speed");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.value.address, 0x20000004);
    assert.equal(first.value.ref.layoutHash, second.value.ref.layoutHash);
  }
});

test("unsafe and MAP-unknown layouts are structured rejections", () => {
  const catalog = new SymbolCatalog(artifact, [
    { ...candidate("pointer", "pointer"), type: undefined },
    { ...candidate("mapped", "global"), type: undefined, source: "iar-map", confidence: "map" },
  ]);
  const pointer = catalog.resolve("pointer");
  const map = catalog.resolve("mapped");
  assert.equal(pointer.ok, false);
  assert.equal(map.ok, false);
  if (!pointer.ok) assert.equal(pointer.error.code, "unsupported_symbol");
  if (!map.ok) assert.equal(map.error.code, "hss_ineligible");
  assert.equal(catalog.resolve("pointer->value").ok, false);
});

test("server-issued refs resolve only against the current catalog layout", () => {
  const catalog = new SymbolCatalog(artifact, []);
  const issued = catalog.issue(candidate("counter", "global"));
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(catalog.resolveRef(issued.value.ref).ok, true);
  assert.equal(catalog.resolveRef({ ...issued.value.ref, layoutHash: "f".repeat(64) }).ok, false);
  assert.equal(new SymbolCatalog({ generation: "b".repeat(64) }, []).resolveRef(issued.value.ref).ok, false);
});

function candidate(qualifiedName: string, kind: "global" | "static" | "fixed-member" | "pointer") {
  return { qualifiedName, rootAddress: 0x20000000, type: "uint32" as const, size: 4, region: "ram" as const, source: "elf-dwarf" as const, confidence: "dwarf" as const, kind };
}
