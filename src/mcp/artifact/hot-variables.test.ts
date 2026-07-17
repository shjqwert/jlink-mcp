import assert from "node:assert/strict";
import test from "node:test";
import { HotVariables, type HotVariableContext } from "./hot-variables";
import { SymbolCatalog } from "./symbol-catalog";

const context: HotVariableContext = { artifactGeneration: "a".repeat(64), mapSha256: "m1", policyGeneration: "p1", sessionGeneration: "s1" };
const catalog = new SymbolCatalog({ generation: context.artifactGeneration }, [{ qualifiedName: "counter", rootAddress: 0x20000000, type: "uint32", size: 4, region: "ram", source: "elf-dwarf", confidence: "dwarf", kind: "global" }]);
const resolved = (() => {
  const result = catalog.resolve("counter");
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
})();

test("stale context rejects fast lookup and targeted refresh updates only requested refs", async () => {
  const hot = new HotVariables();
  const cached = hot.add(resolved, context, "2026-01-01T00:00:00.000Z");
  assert.equal(cached.layoutHash, resolved.ref.layoutHash);
  assert.equal(hot.get(resolved.ref, { ...context, artifactGeneration: "b".repeat(64) }).ok, false);
  assert.equal(hot.get(resolved.ref, { ...context, mapSha256: "m2" }).ok, false);
  assert.equal(hot.get(resolved.ref, { ...context, sessionGeneration: "s2" }).ok, false);
  assert.equal(hot.get({ ...resolved.ref, layoutHash: "changed" }, context).ok, false);
  const calls: string[] = [];
  await hot.refresh([resolved.ref, { qualifiedName: "counter" }], { ...context, policyGeneration: "p2" }, async (ref) => {
    calls.push(ref.qualifiedName);
    return resolved;
  });
  assert.deepEqual(calls, ["counter"]);
  assert.equal(hot.get(resolved.ref, { ...context, policyGeneration: "p2" }).ok, true);
});

test("a new process-local store starts empty", () => {
  assert.equal(new HotVariables().size, 0);
});
