import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArtifactCatalogError,
  computeArtifactGeneration,
  discoverArtifacts,
  historicalDiagnosticMatchEvidence,
  resolveArtifactGeneration,
  writeArtifactMatchManifest,
} from "./artifact-catalog";

test("artifact discovery is content-driven, bounded, excluded, and explicit-first", async () => {
  const root = await mkdtemp(join(tmpdir(), "jlink-artifact-"));
  const chosen = join(root, "firmware.out");
  const other = join(root, "other.axf");
  const map = join(root, "firmware.map");
  await writeFile(chosen, elfWithDwarfFixture());
  await writeFile(other, elfFixture(0x08001000));
  await writeFile(map, "map evidence", "utf8");
  await writeFile(join(root, "firmware.bin"), Buffer.from([1, 2, 3]));
  await mkdir(join(root, ".jlink-mcp"));
  await writeFile(join(root, ".jlink-mcp", "hidden.out"), elfFixture());

  const discovered = await discoverArtifacts({ projectRoot: root });
  assert.deepEqual(discovered.candidates.map((candidate) => candidate.format).sort(), ["elf", "elf", "raw-bin"]);
  assert.equal(discovered.candidates.some((candidate) => candidate.path.includes("hidden.out")), false);
  assert.equal(discovered.candidates.find((candidate) => candidate.path === chosen)?.classification, "typed-debug-artifact");
  assert.equal(discovered.candidates.find((candidate) => candidate.path === other)?.classification, "untyped-elf");
  assert.equal(discovered.candidates.find((candidate) => candidate.format === "raw-bin")?.classification, "flash-image");
  assert.deepEqual(discovered.candidates.find((candidate) => candidate.path === chosen)?.pairedMapCandidates, [map]);

  const selected = await resolveArtifactGeneration({ projectRoot: root, explicitArtifact: chosen, explicitMap: map });
  assert.equal(selected.path, chosen);
  assert.equal(selected.mapPath, map);
  assert.match(selected.generation, /^[0-9a-f]{64}$/);
});

test("implicit artifact ambiguity is a structured rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "jlink-artifact-ambiguous-"));
  await writeFile(join(root, "one.out"), elfFixture());
  await writeFile(join(root, "two.out"), elfFixture(0x08001000));
  await assert.rejects(
    resolveArtifactGeneration({ projectRoot: root }),
    (error: unknown) => error instanceof ArtifactCatalogError && error.code === "ARTIFACT_SELECTION_REQUIRED",
  );
});

test("configured Artifacts win first and bounded discovery keeps accumulated priority candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "jlink-artifact-priority-"));
  const debugExe = join(root, "Debug", "Exe");
  await mkdir(debugExe, { recursive: true });
  const configuredPath = join(root, "configured.out");
  const priorityPath = join(debugExe, "priority.out");
  const remainingPath = join(root, "remaining.out");
  await writeFile(configuredPath, elfWithDwarfFixture());
  await writeFile(priorityPath, elfFixture(0x08001000));
  await writeFile(remainingPath, elfFixture(0x08002000));

  const configuredIdentity = await resolveArtifactGeneration({ projectRoot: root, explicitArtifact: configuredPath });
  const configured = await discoverArtifacts({
    projectRoot: root,
    configuredArtifact: configuredPath,
    configuredArtifactSha256: configuredIdentity.sha256,
  });
  assert.equal(configured.configured, true);
  assert.equal(configured.scanTruncated, false);
  assert.deepEqual(configured.candidates.map((candidate) => candidate.path), [configuredPath]);

  const bounded = await discoverArtifacts({ projectRoot: root, maxCandidates: 1 });
  assert.equal(bounded.configured, false);
  assert.equal(bounded.scanTruncated, true);
  assert.equal(bounded.reachedBound, "maxCandidates");
  assert.deepEqual(bounded.candidates.map((candidate) => candidate.path), [priorityPath]);
});

test("explicit external inputs are accepted but malformed HEX, SREC, and MAP are rejected", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jlink-artifact-external-project-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "jlink-artifact-external-pack-"));
  const elf = join(externalRoot, "firmware.out");
  const map = join(externalRoot, "firmware.map");
  await writeFile(elf, elfWithDwarfFixture());
  await writeFile(map, "symbol map text", "utf8");
  const selected = await resolveArtifactGeneration({ projectRoot, explicitArtifact: elf, explicitMap: map });
  assert.equal(selected.path, elf);
  assert.equal(selected.mapPath, map);
  assert.equal(selected.generation, computeArtifactGeneration(selected.sha256, selected.mapSha256));
  const localElf = join(projectRoot, "local.out");
  await writeFile(localElf, elfWithDwarfFixture());
  const selectedWithExternalMap = await resolveArtifactGeneration({ projectRoot, explicitMap: map });
  assert.equal(selectedWithExternalMap.path, localElf);
  assert.equal(selectedWithExternalMap.mapPath, map);

  const badHex = join(projectRoot, "bad.hex");
  const badMetadataHex = join(projectRoot, "bad-metadata.hex");
  const badSrec = join(projectRoot, "bad.s19");
  const badMap = join(projectRoot, "bad.map");
  await writeFile(badHex, ":00000001FE\n", "ascii");
  await writeFile(badMetadataHex, ":0100000100FE\n", "ascii");
  await writeFile(badSrec, "S104000001FB\nS9030000FC\n", "ascii");
  await writeFile(badMap, Buffer.from([0, 1, 2]));
  await assert.rejects(() => discoverArtifacts({ projectRoot, explicitArtifact: badHex }), (error: unknown) => error instanceof ArtifactCatalogError && error.code === "FLASH_CHECKSUM_INVALID");
  await assert.rejects(() => discoverArtifacts({ projectRoot, explicitArtifact: badMetadataHex }), (error: unknown) => error instanceof ArtifactCatalogError && error.code === "FLASH_FORMAT_INVALID");
  await assert.rejects(() => discoverArtifacts({ projectRoot, explicitArtifact: badSrec }), (error: unknown) => error instanceof ArtifactCatalogError && error.code === "FLASH_CHECKSUM_INVALID");
  await assert.rejects(() => discoverArtifacts({ projectRoot, explicitArtifact: elf, explicitMap: badMap }), (error: unknown) => error instanceof ArtifactCatalogError && error.code === "ARTIFACT_MAP_INVALID");
});

test("artifact-match-v0 contains only explicit nonvolatile file-backed bytes", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jlink-artifact-project-"));
  const sessionRoot = await mkdtemp(join(tmpdir(), "jlink-artifact-session-"));
  const artifactPath = join(projectRoot, "firmware.out");
  await writeFile(artifactPath, elfFixture());
  const artifact = await resolveArtifactGeneration({ projectRoot, explicitArtifact: artifactPath });
  const result = await writeArtifactMatchManifest({
    projectRoot,
    sessionRoot,
    artifact,
    captureId: "11111111-1111-4111-8111-111111111111",
    targetId: "fixture-target",
    probeSerial: "123456789",
    runtimeIdentitySha256: "a".repeat(64),
    nonvolatileRanges: [{ start: 0x08000000, end: 0x08100000 }],
    ramRanges: [{ start: 0x20000000, end: 0x20010000 }],
  });
  assert.equal(result.manifest.historyOnly, false);
  assert.equal(result.manifest.totalBytes, 4);
  assert.deepEqual(result.manifest.ranges, [{ address: "0x8000000", length: 4, dataHex: "11223344" }]);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("unknown load regions and project-local manifest roots are rejected", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jlink-artifact-region-"));
  const artifactPath = join(projectRoot, "firmware.out");
  await writeFile(artifactPath, elfFixture());
  const artifact = await resolveArtifactGeneration({ projectRoot, explicitArtifact: artifactPath });
  const base = {
    projectRoot,
    artifact,
    captureId: "11111111-1111-4111-8111-111111111111",
    targetId: "fixture-target",
    probeSerial: "123456789",
    runtimeIdentitySha256: "b".repeat(64),
    nonvolatileRanges: [{ start: 0x08000000, end: 0x08100000 }],
    ramRanges: [{ start: 0x20000000, end: 0x20010000 }],
  };
  await assert.rejects(
    writeArtifactMatchManifest({ ...base, sessionRoot: projectRoot }),
    (error: unknown) => error instanceof ArtifactCatalogError && error.code === "ARTIFACT_SESSION_ROOT_INVALID",
  );
  const sessionRoot = await mkdtemp(join(tmpdir(), "jlink-artifact-region-session-"));
  await assert.rejects(
    writeArtifactMatchManifest({ ...base, sessionRoot, nonvolatileRanges: [{ start: 0x09000000, end: 0x09100000 }] }),
    (error: unknown) => error instanceof ArtifactCatalogError && error.code === "ARTIFACT_REGION_UNKNOWN",
  );
});

test("historical diagnostics can never become verified gate evidence", () => {
  assert.deepEqual(historicalDiagnosticMatchEvidence({ observedStatus: "verified", source: "legacy-compare" }), {
    targetArtifactMatch: "unverified",
    historyOnly: true,
    observedStatus: "verified",
    source: "legacy-compare",
  });
});

function elfFixture(codeAddress = 0x08000000): Buffer {
  const programCount = 3;
  const headerBytes = 52 + programCount * 32;
  const data = Buffer.alloc(0x120);
  data.set(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0);
  data[4] = 1;
  data[5] = 1;
  data.writeUInt32LE(52, 28);
  data.writeUInt16LE(52, 40);
  data.writeUInt16LE(32, 42);
  data.writeUInt16LE(programCount, 44);
  writeProgramHeader(data, 52, 0x100, codeAddress, codeAddress, 4, 8, 5);
  writeProgramHeader(data, 84, 0x104, 0x20000000, 0x08000100, 4, 4, 6);
  writeProgramHeader(data, 116, 0x108, 0x20000010, 0x20000010, 0, 16, 6);
  data.set(Buffer.from([0x11, 0x22, 0x33, 0x44]), 0x100);
  data.set(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]), 0x104);
  return data.subarray(0, Math.max(headerBytes, 0x108));
}

function elfWithDwarfFixture(): Buffer {
  const base = elfFixture();
  const sectionOffset = 0x120;
  const sectionEntrySize = 40;
  const sectionCount = 4;
  const strings = Buffer.from("\0.shstrtab\0.debug_info\0.debug_abbrev\0", "utf8");
  const stringsOffset = sectionOffset + sectionEntrySize * sectionCount;
  const data = Buffer.alloc(stringsOffset + strings.length + 2);
  base.copy(data);
  data.writeUInt32LE(sectionOffset, 32);
  data.writeUInt16LE(sectionEntrySize, 46);
  data.writeUInt16LE(sectionCount, 48);
  data.writeUInt16LE(1, 50);
  writeSectionHeader(data, sectionOffset + sectionEntrySize, 1, 3, stringsOffset, strings.length);
  writeSectionHeader(data, sectionOffset + sectionEntrySize * 2, 11, 1, stringsOffset + strings.length, 1);
  writeSectionHeader(data, sectionOffset + sectionEntrySize * 3, 23, 1, stringsOffset + strings.length + 1, 1);
  strings.copy(data, stringsOffset);
  return data;
}

function writeSectionHeader(buffer: Buffer, offset: number, nameOffset: number, type: number, fileOffset: number, size: number): void {
  buffer.writeUInt32LE(nameOffset, offset);
  buffer.writeUInt32LE(type, offset + 4);
  buffer.writeUInt32LE(fileOffset, offset + 16);
  buffer.writeUInt32LE(size, offset + 20);
}

function writeProgramHeader(buffer: Buffer, offset: number, fileOffset: number, virtualAddress: number, physicalAddress: number, fileSize: number, memorySize: number, flags: number): void {
  buffer.writeUInt32LE(1, offset);
  buffer.writeUInt32LE(fileOffset, offset + 4);
  buffer.writeUInt32LE(virtualAddress, offset + 8);
  buffer.writeUInt32LE(physicalAddress, offset + 12);
  buffer.writeUInt32LE(fileSize, offset + 16);
  buffer.writeUInt32LE(memorySize, offset + 20);
  buffer.writeUInt32LE(flags, offset + 24);
  buffer.writeUInt32LE(4, offset + 28);
}
