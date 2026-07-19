import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ProbeBackend } from "../../probe/backend";
import type { ElfResolvedSymbol } from "../../gdb/elf-resolver";
import { ProbeErrorCode, type CommandResult } from "../../probe/backend";
import { SymbolCatalog, type ResolvedSymbol } from "../artifact/symbol-catalog";
import { ArtifactVariableService, assertMapAgreement, classifyDwarfResolutionError, type TypedSymbolResolver } from "./artifact-operations";
import { DirectMcuService } from "./direct-operations";
import { ProbeQueue } from "./probe-queue";
import { TargetStore, type StoredTarget } from "./target-store";

test("unverified variable reads are warned, typed, and preserve running state", async (context) => {
  const fixture = await createFixture(context, "read-unverified");
  fixture.probe.memory.set(0x20000000, Buffer.from("78563412", "hex"));
  const ref = (await fixture.resolver.resolve(fixture.target, "counter")).ref;
  const result = await fixture.service.readVariable(fixture.projectRoot, ref);
  assert.equal(result.ok, true);
  assert.equal((result.data as { typedValue: number }).typedValue, 0x12345678);
  assert.match(result.warnings.join("\n"), /ARTIFACT_UNVERIFIED/);
  assert.deepEqual(fixture.probe.actions, ["read:20000000:4"]);
  assert.equal(result.before.targetState, "running");
  assert.equal(result.after.targetState, "running");
});

test("queued variable reads report the current downgraded Artifact match", async (context) => {
  const fixture = await createFixture(context, "queued-match-downgrade");
  const ref = (await fixture.resolver.resolve(fixture.target, "counter")).ref;
  await fixture.targets.setArtifactMatch(fixture.projectRoot, "verified", "fixture", {
    targetGeneration: fixture.target.generation,
    probeSerial: fixture.target.probeSerial,
    artifactGeneration: fixture.target.artifact?.generation,
  });
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const acquired = new Promise<void>((resolve) => { started = resolve; });
  const blocker = fixture.queue.runExclusive(fixture.target.probeSerial, async () => { started(); await waiting; });
  await acquired;
  const pending = fixture.service.readVariable(fixture.projectRoot, ref);
  await fixture.targets.setArtifactMatch(fixture.projectRoot, "unverified", "queue-race", {
    targetGeneration: fixture.target.generation,
    probeSerial: fixture.target.probeSerial,
    artifactGeneration: fixture.target.artifact?.generation,
  });
  release();
  await blocker;
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.artifact?.match, "unverified");
  assert.match(result.warnings.join("\n"), /ARTIFACT_UNVERIFIED/);
});

test("variable writes require verified Artifact match and default to no readback", async (context) => {
  const fixture = await createFixture(context, "write-gate");
  const ref = (await fixture.resolver.resolve(fixture.target, "counter")).ref;
  const blocked = await fixture.service.writeVariable({ projectRoot: fixture.projectRoot, ref, value: 9 });
  assert.equal(blocked.error?.code, "ARTIFACT_NOT_VERIFIED");
  assert.deepEqual(fixture.probe.actions, []);

  await fixture.targets.setArtifactMatch(fixture.projectRoot, "verified", "fixture", {
    targetGeneration: fixture.target.generation,
    probeSerial: fixture.target.probeSerial,
    artifactGeneration: fixture.target.artifact?.generation,
  });
  const written = await fixture.service.writeVariable({ projectRoot: fixture.projectRoot, ref, value: 9 });
  assert.equal(written.ok, true);
  assert.equal(written.verification.status, "executed_unverified");
  assert.deepEqual(fixture.probe.actions, ["write:20000000:4"]);
});

test("variable writes map exact, tolerance, masked, and observe comparators", async (context) => {
  const cases = [
    { name: "exact", comparator: { mode: "exact" } as const, method: "exact" },
    { name: "tolerance", comparator: { mode: "tolerance", absTolerance: 0, relTolerance: 0 } as const, method: "tolerance" },
    { name: "masked", comparator: { mode: "masked", maskHex: "ffffffff" } as const, method: "masked" },
    { name: "observe", comparator: { mode: "observe", durationMs: 10, maxPolls: 2, intervalMs: 1, comparator: { mode: "exact" } } as const, method: "observe:exact" },
  ];
  for (const item of cases) {
    const fixture = await createFixture(context, `write-${item.name}`);
    const ref = (await fixture.resolver.resolve(fixture.target, "counter")).ref;
    await fixture.targets.setArtifactMatch(fixture.projectRoot, "verified", "fixture", {
      targetGeneration: fixture.target.generation,
      probeSerial: fixture.target.probeSerial,
      artifactGeneration: fixture.target.artifact?.generation,
    });
    const result = await fixture.service.writeVariable({ projectRoot: fixture.projectRoot, ref, value: 9, verify: true, comparator: item.comparator });
    assert.equal(result.ok, true, item.name);
    assert.equal(result.verification.method, item.method, item.name);
    assert.deepEqual(fixture.probe.actions, ["write:20000000:4", "read:20000000:4"], item.name);
  }
});

test("Artifact mismatch blocks reads before hardware access", async (context) => {
  const fixture = await createFixture(context, "read-mismatch");
  const ref = (await fixture.resolver.resolve(fixture.target, "counter")).ref;
  await fixture.targets.setArtifactMatch(fixture.projectRoot, "mismatch", "fixture", {
    targetGeneration: fixture.target.generation,
    probeSerial: fixture.target.probeSerial,
    artifactGeneration: fixture.target.artifact?.generation,
  });
  const result = await fixture.service.readVariable(fixture.projectRoot, ref);
  assert.equal(result.error?.code, "ARTIFACT_MISMATCH");
  assert.deepEqual(fixture.probe.actions, []);
});

test("stale variable references and same-path Artifact changes issue no hardware access", async (context) => {
  const fixture = await createFixture(context, "stale");
  const resolved = await fixture.resolver.resolve(fixture.target, "counter");
  writeFileSync(fixture.artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 5, 6, 7, 8]));
  const reconfigured = await fixture.targets.configure({
    projectRoot: fixture.projectRoot,
    device: "TEST",
    probeSerial: "123456",
    interface: "SWD",
    speed: 1000,
    artifactPath: fixture.artifactPath,
  });
  const stale = await fixture.service.readVariable(fixture.projectRoot, resolved.ref);
  assert.equal(stale.error?.code, "STALE_ARTIFACT_REFERENCE");
  assert.deepEqual(fixture.probe.actions, []);

  const current = await fixture.resolver.resolve(reconfigured, "counter");
  fixture.resolver.afterResolve = () => writeFileSync(fixture.artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 9, 9, 9, 9]));
  const changed = await fixture.service.readVariable(fixture.projectRoot, current.ref);
  assert.equal(changed.error?.code, "ARTIFACT_GENERATION_STALE");
  assert.deepEqual(fixture.probe.actions, []);
});

test("Hot Variables persist logical references across service restart", async (context) => {
  const fixture = await createFixture(context, "hot-persist");
  const ref = (await fixture.resolver.resolve(fixture.target, "counter")).ref;
  assert.equal((await fixture.service.hotAdd(fixture.projectRoot, ref)).ok, true);
  const restarted = new ArtifactVariableService(fixture.targets, fixture.direct, fixture.stateRoot, fixture.resolver);
  const listed = await restarted.hotList(fixture.projectRoot);
  assert.equal(listed.ok, true);
  const variables = (listed.data as { variables: Array<Record<string, unknown>> }).variables;
  assert.equal(variables.length, 1);
  assert.equal(variables[0].logicalIdentity, "counter");
  assert.equal("address" in variables[0], false);
});

test("non-intrusive variable read failure returns HALT_REQUIRED without halting", async (context) => {
  const fixture = await createFixture(context, "halt-required");
  fixture.probe.readResult = { success: false, rawOutput: "running read unavailable", output: "", error: "running read unavailable", errorCode: ProbeErrorCode.NON_INTRUSIVE_READ_UNAVAILABLE };
  const ref = (await fixture.resolver.resolve(fixture.target, "counter")).ref;
  const result = await fixture.service.readVariable(fixture.projectRoot, ref);
  assert.equal(result.error?.code, "HALT_REQUIRED");
  assert.deepEqual(fixture.probe.actions, ["read:20000000:4"]);
});

test("DWARF and MAP address conflicts are rejected before access", () => {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-map-conflict-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const mapPath = join(root, "firmware.map");
  writeFileSync(mapPath, "counter 0x20000004 0x4 Data Gb\n", "utf8");
  const target = { map: { path: mapPath } } as unknown as StoredTarget;
  const symbol = { name: "counter", rootAddress: 0x20000000, rootSize: 4, memberOffset: 0, address: 0x20000000, size: 4, type: "uint32", region: "ram" } as ElfResolvedSymbol;
  assert.throws(() => assertMapAgreement(target, "counter", symbol), /conflict/);
});

test("DWARF error classification keeps missing members distinct from MAP-only roots", () => {
  assert.equal(classifyDwarfResolutionError("There is no member named missing", true), "SYMBOL_NOT_FOUND");
  assert.equal(classifyDwarfResolutionError("No symbol root in current context", true), "UNKNOWN_LAYOUT");
  assert.equal(classifyDwarfResolutionError("No symbol root in current context", false), "SYMBOL_NOT_FOUND");
});

test("artifact_probe returns a structured selection error with bounded candidates", async (context) => {
  const fixture = await createFixture(context, "artifact-selection");
  writeFileSync(join(fixture.projectRoot, "one.bin"), Buffer.from([1]));
  writeFileSync(join(fixture.projectRoot, "two.bin"), Buffer.from([2]));
  const result = await fixture.service.artifactProbe({ projectRoot: fixture.projectRoot, maxCandidates: 8 });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "ARTIFACT_SELECTION_REQUIRED");
  const candidates = (result.data as { candidates: Array<Record<string, unknown>> }).candidates;
  assert.ok(candidates.length >= 2 && candidates.length <= 8);
  assert.equal(candidates.filter((candidate) => candidate.format === "raw-bin").length, 2);
  assert.equal((result.data as { selectionRequired: boolean }).selectionRequired, true);
  assert.deepEqual(fixture.probe.actions, []);
});

test("MAP-only resolution reports UNKNOWN_LAYOUT without requiring GDB", async (context) => {
  const fixture = await createFixture(context, "map-only");
  const mapPath = join(fixture.projectRoot, "firmware.map");
  writeFileSync(mapPath, "counter 0x20000000 0x4 Data Gb\n", "utf8");
  await fixture.targets.configure({
    projectRoot: fixture.projectRoot,
    device: "TEST",
    probeSerial: "123456",
    interface: "SWD",
    speed: 1000,
    artifactPath: fixture.artifactPath,
    mapPath,
  });
  const service = new ArtifactVariableService(fixture.targets, fixture.direct, fixture.stateRoot);
  const result = await service.symbolResolve(fixture.projectRoot, "counter");
  assert.equal(result.error?.code, "UNKNOWN_LAYOUT");
  assert.deepEqual(fixture.probe.actions, []);
});

async function createFixture(context: TestContext, name: string) {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-artifact-ops-${name}-${process.pid}-${Date.now()}`);
  const projectRoot = join(root, "project");
  const stateRoot = join(root, "state");
  mkdirSync(projectRoot, { recursive: true });
  context.after(() => { /* local temp evidence is intentionally disposable */ });
  const artifactPath = join(projectRoot, "firmware.elf");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]));
  const targets = new TargetStore(stateRoot);
  const target = await targets.configure({ projectRoot, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000, artifactPath });
  const probe = new MemoryProbe();
  const queue = new ProbeQueue(join(root, "queue"));
  const direct = new DirectMcuService(targets, queue, async () => ({ probe: probe as unknown as ProbeBackend }));
  const resolver = new FixtureResolver();
  const service = new ArtifactVariableService(targets, direct, stateRoot, resolver);
  return { projectRoot, stateRoot, artifactPath, targets, target, probe, queue, direct, resolver, service };
}

class FixtureResolver implements TypedSymbolResolver {
  afterResolve?: () => void;

  async resolve(target: StoredTarget, selector: string): Promise<ResolvedSymbol> {
    const result = new SymbolCatalog({ generation: target.artifact!.generation }, [{
      qualifiedName: selector,
      rootAddress: 0x20000000,
      rootSize: 4,
      type: "uint32",
      size: 4,
      region: "ram",
      source: "elf-dwarf",
      confidence: "dwarf",
      kind: "global",
      endian: "little",
    }]).resolve(selector);
    if (!result.ok) throw new Error(result.error.reason);
    this.afterResolve?.();
    this.afterResolve = undefined;
    return result.value;
  }

  async search(): Promise<Array<Record<string, unknown>>> {
    return [{ selector: "counter", source: "elf-dwarf" }];
  }
}

class MemoryProbe {
  actions: string[] = [];
  memory = new Map<number, Buffer>();
  readResult?: CommandResult;

  async observeTargetState() { return { state: "running" as const, source: "fixture", result: ok() }; }
  async readMemory(address: number, length: number) {
    this.actions.push(`read:${address.toString(16)}:${length}`);
    if (this.readResult) return this.readResult;
    const bytes = this.memory.get(address)?.subarray(0, length) ?? Buffer.alloc(length);
    const rawOutput = `${address.toString(16).padStart(8, "0")} = ${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ")}`;
    return { success: true, rawOutput, output: rawOutput };
  }
  async writeMemoryBytes(address: number, bytes: Buffer) {
    this.actions.push(`write:${address.toString(16)}:${bytes.length}`);
    this.memory.set(address, Buffer.from(bytes));
    return ok();
  }
  parseMemoryDump(output: string) {
    const match = output.match(/^([0-9a-fA-F]+)\s*=\s*(.*)$/);
    return match ? [{ address: match[1], hex: match[2] }] : [];
  }
}

function ok(): CommandResult {
  return { success: true, rawOutput: "", output: "ok" };
}
