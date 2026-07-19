import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HotVariables, type HotVariableContext } from "./hot-variables";
import { SymbolCatalog } from "./symbol-catalog";

const context: HotVariableContext = { projectRoot: "C:\\fixture", artifactGeneration: "a".repeat(64), mapSha256: "m1", targetGeneration: "t1" };
const catalog = new SymbolCatalog({ generation: context.artifactGeneration }, [{ qualifiedName: "counter", rootAddress: 0x20000000, type: "uint32", size: 4, region: "ram", source: "elf-dwarf", confidence: "dwarf", kind: "global" }]);
const resolved = (() => {
  const result = catalog.resolve("counter");
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
})();

test("stale context rejects fast lookup and targeted refresh updates only requested refs", async () => {
  const hot = new HotVariables();
  const cached = hot.add(resolved, context, resolved.type, "2026-01-01T00:00:00.000Z");
  assert.equal(cached.layoutHash, resolved.ref.layoutHash);
  assert.equal(hot.get(resolved.ref, { ...context, artifactGeneration: "b".repeat(64) }).ok, false);
  assert.equal(hot.get(resolved.ref, { ...context, mapSha256: "m2" }).ok, false);
  assert.equal(hot.get(resolved.ref, { ...context, targetGeneration: "t2" }).ok, false);
  assert.equal(hot.get({ ...resolved.ref, layoutHash: "changed" }, context).ok, false);
  const calls: string[] = [];
  await hot.refresh([resolved.ref, { qualifiedName: "counter" }], { ...context, targetGeneration: "t2" }, async (ref) => {
    calls.push(ref.qualifiedName);
    return resolved;
  });
  assert.deepEqual(calls, ["counter"]);
  assert.equal(hot.get(resolved.ref, { ...context, targetGeneration: "t2" }).ok, true);
});

test("a new process-local store starts empty", () => {
  assert.equal(new HotVariables().size, 0);
});

test("persistent hot variables survive restart without serializing resolved addresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "jlink-hot-vars-"));
  const file = join(root, "hot-variables.json");
  const persistedContext = { ...context, projectRoot: root };
  new HotVariables(file).add(resolved, persistedContext);
  const restarted = new HotVariables(file);
  assert.equal(restarted.get(resolved.ref, persistedContext).ok, true);
  const stored = JSON.stringify(restarted.list(persistedContext));
  assert.doesNotMatch(stored, /rootAddress|memberOffset|\"address\"/);
});

test("targeted refresh preserves stale entries and reports failures individually", async () => {
  const hot = new HotVariables();
  hot.add(resolved, context);
  const resolvedNames: string[] = [];
  const results = await hot.refresh(
    [resolved.ref, { qualifiedName: "missing" }],
    { ...context, targetGeneration: "t2" },
    async (ref) => {
      resolvedNames.push(ref.qualifiedName);
      if (ref.qualifiedName === "missing") throw Object.assign(new Error("not found"), { code: "SYMBOL_NOT_FOUND" });
      return resolved;
    },
  );
  assert.deepEqual(results.map((result) => result.ok), [true, false]);
  assert.deepEqual(resolvedNames, ["counter"]);
  assert.equal(results[1].ok ? undefined : results[1].error.code, "hot_variable_not_found");
  assert.equal(hot.list({ ...context, targetGeneration: "t2" }).some((value) => value.logicalIdentity === "missing"), false);
  assert.equal(hot.list({ ...context, targetGeneration: "t2" }).find((value) => value.logicalIdentity === "counter")?.stale, false);
});
