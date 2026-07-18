import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { TargetStore, TargetStoreError } from "./target-store";

test("TargetStore persists canonical project configuration and advances generation", async (context) => {
  const root = testDirectory(context, "target-store-generation");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const store = new TargetStore(join(root, "state"));
  const input = { projectRoot, device: "TEST-MCU", probeSerial: "123456", interface: "SWD" as const, speed: 4000 };

  const first = await store.configure(input);
  const second = await store.configure(input);
  const reloaded = new TargetStore(join(root, "state")).require(projectRoot);

  assert.notEqual(first.generation, second.generation);
  assert.equal(first.configurationHash, second.configurationHash);
  assert.equal(reloaded.generation, second.generation);
  assert.equal(reloaded.liveArtifactMatch.status, "unverified");
  assert.equal(reloaded.liveArtifactMatch.source, "target_configure");
  assert.match(readFileSync(store.filePath, "utf8"), /"formatVersion": 1/);
});

test("TargetStore never reuses another project's target", async (context) => {
  const root = testDirectory(context, "target-store-isolation");
  const projectA = join(root, "a");
  const projectB = join(root, "b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  const store = new TargetStore(join(root, "state"));
  await store.configure({ projectRoot: projectA, device: "A", probeSerial: "1", interface: "SWD", speed: 1000 });
  assert.throws(() => store.require(projectB), (error) => error instanceof TargetStoreError && error.code === "TARGET_NOT_CONFIGURED");
});

test("TargetStore validates and hashes explicit external SVD and Artifact files", async (context) => {
  const root = testDirectory(context, "target-store-files");
  const projectRoot = join(root, "project");
  const externalRoot = join(root, "pack");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(externalRoot, { recursive: true });
  const artifactPath = join(projectRoot, "firmware.elf");
  const svdPath = join(externalRoot, "device.svd");
  writeFileSync(artifactPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
  writeFileSync(svdPath, "<?xml version=\"1.0\"?><device><name>T</name></device>");
  const target = await new TargetStore(join(root, "state")).configure({
    projectRoot,
    device: "T",
    probeSerial: "2",
    interface: "JTAG",
    speed: 2000,
    artifactPath,
    svdPath,
  });

  assert.equal(target.artifact?.external, false);
  assert.equal(target.svd?.external, true);
  assert.equal(target.artifact?.generation, target.artifact?.sha256);
  assert.match(target.svd?.sha256 ?? "", /^[0-9a-f]{64}$/);
});

test("TargetStore requires an address for raw BIN flash bindings", async (context) => {
  const root = testDirectory(context, "target-store-bin");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "firmware.elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  writeFileSync(join(projectRoot, "firmware.bin"), Buffer.from([1, 2, 3, 4]));
  await assert.rejects(
    new TargetStore(join(root, "state")).configure({
      projectRoot,
      device: "T",
      probeSerial: "3",
      interface: "SWD",
      speed: 1000,
      artifactPath: "firmware.elf",
      artifactFlashImages: [{ path: "firmware.bin" }],
    }),
    (error) => error instanceof TargetStoreError && error.code === "BASE_ADDRESS_REQUIRED",
  );
});

test("TargetStore refuses stale Artifact-match evidence after reconfiguration", async (context) => {
  const root = testDirectory(context, "target-store-stale-evidence");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const store = new TargetStore(join(root, "state"));
  const input = { projectRoot, device: "T", probeSerial: "4", interface: "SWD" as const, speed: 1000 };
  const first = await store.configure(input);
  await store.configure(input);
  await assert.rejects(
    store.setArtifactMatch(projectRoot, "unverified", "stale_operation", {
      targetGeneration: first.generation,
      probeSerial: first.probeSerial,
    }),
    (error) => error instanceof TargetStoreError && error.code === "TARGET_GENERATION_CHANGED",
  );
});

test("TargetStore rejects ELF content renamed as raw BIN", async (context) => {
  const root = testDirectory(context, "target-store-renamed-elf");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "firmware.elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  writeFileSync(join(projectRoot, "renamed.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]));
  await assert.rejects(
    new TargetStore(join(root, "state")).configure({
      projectRoot,
      device: "T",
      probeSerial: "5",
      interface: "SWD",
      speed: 1000,
      artifactPath: "firmware.elf",
      artifactFlashImages: [{ path: "renamed.bin", baseAddress: 0 }],
    }),
    (error) => error instanceof TargetStoreError && error.code === "FLASH_FORMAT_UNSUPPORTED",
  );
});

test("TargetStore validates structured flash content and forbids relocation", async (context) => {
  const root = testDirectory(context, "target-store-structured-flash");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "firmware.elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const validHex = ":0400000001020304F2\n:00000001FF\n";
  writeFileSync(join(projectRoot, "firmware.hex"), validHex);
  writeFileSync(join(projectRoot, "renamed.bin"), validHex);
  writeFileSync(join(projectRoot, "bad.hex"), ":0400000001020304F3\n:00000001FF\n");
  const store = new TargetStore(join(root, "state"));
  const base = { projectRoot, device: "T", probeSerial: "6", interface: "SWD" as const, speed: 1000, artifactPath: "firmware.elf" };

  await assert.rejects(store.configure({ ...base, artifactFlashImages: [{ path: "firmware.hex", baseAddress: 0 }] }),
    (error) => error instanceof TargetStoreError && error.code === "BASE_ADDRESS_NOT_ALLOWED");
  await assert.rejects(store.configure({ ...base, artifactFlashImages: [{ path: "renamed.bin", baseAddress: 0 }] }),
    (error) => error instanceof TargetStoreError && error.code === "FLASH_FORMAT_MISMATCH");
  await assert.rejects(store.configure({ ...base, artifactFlashImages: [{ path: "bad.hex" }] }),
    (error) => error instanceof TargetStoreError && error.code === "FLASH_CHECKSUM_INVALID");
});

test("TargetStore refuses writable Flash and ROM raw-memory regions", async (context) => {
  const root = testDirectory(context, "target-store-memory-policy");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  await assert.rejects(new TargetStore(join(root, "state")).configure({
    projectRoot,
    device: "T",
    probeSerial: "7",
    interface: "SWD",
    speed: 1000,
    memoryRegions: [{ start: 0, length: 0x1000, kind: "flash", writable: true }],
  }), (error) => error instanceof TargetStoreError && error.code === "INVALID_MEMORY_REGION");
});

test("TargetStore keeps a durable unverified overlay when Artifact persistence fails", async (context) => {
  const root = testDirectory(context, "target-store-dirty-marker");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "firmware.elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const stateRoot = join(root, "state");
  const store = new TargetStore(stateRoot);
  const target = await store.configure({ projectRoot, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000, artifactPath: "firmware.elf" });
  await store.setArtifactMatch(projectRoot, "verified", "fixture", {
    targetGeneration: target.generation,
    probeSerial: target.probeSerial,
    artifactGeneration: target.artifact?.generation,
  });
  const writable = store as unknown as { writeDocument(document: unknown): void };
  writable.writeDocument = () => { throw new Error("simulated targets.json publication failure"); };
  await assert.rejects(
    store.setArtifactMatch(projectRoot, "unverified", "simulated_failure", {
      targetGeneration: target.generation,
      probeSerial: target.probeSerial,
      artifactGeneration: target.artifact?.generation,
    }),
    /simulated targets\.json publication failure/,
  );
  const reloaded = new TargetStore(stateRoot).require(projectRoot);
  assert.equal(reloaded.liveArtifactMatch.status, "unverified");
  assert.equal(reloaded.liveArtifactMatch.source, "artifact_state_persistence_incomplete");
});

function testDirectory(context: TestContext, name: string): string {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-mcp-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  context.after(() => { /* ignored test-output is retained for inspection */ });
  return root;
}
