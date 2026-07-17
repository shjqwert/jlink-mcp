import { createHash } from "node:crypto";
import { opendir, open, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseElfFlashSegments } from "../../gdb/elf-resolver";

const DEFAULT_MAX_FILES = 4096;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_CANDIDATES = 128;
const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_HASHED_BYTES = 512 * 1024 * 1024;
const MAX_MATCH_BYTES = 64 * 1024 * 1024;
const MAX_MATCH_RANGES = 4096;
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".jlink-mcp"]);

export type ArtifactFormat = "elf" | "intel-hex" | "srec" | "raw-bin";

export interface ArtifactCandidate {
  path: string;
  format: ArtifactFormat;
  sha256: string;
  generation: string;
  size: number;
  supportedOperations: Array<"symbols" | "flash" | "verify">;
}

export interface ArtifactGeneration extends ArtifactCandidate {
  mapPath?: string;
  mapSha256?: string;
}

export interface ArtifactDiscoveryResult {
  projectRoot: string;
  explicit: boolean;
  candidates: ArtifactCandidate[];
  mapCandidates: string[];
  scannedFiles: number;
}

export interface AddressRange {
  start: number;
  end: number;
}

export interface ArtifactMatchManifest {
  schema: "artifact-match-v0";
  historyOnly: false;
  captureId: string;
  targetId: string;
  probeSerial: string;
  runtimeIdentitySha256: string;
  artifactGeneration: string;
  artifactSha256: string;
  connectOrdinal: number;
  totalBytes: number;
  ranges: Array<{ address: string; length: number; dataHex: string }>;
}

export class ArtifactCatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ArtifactCatalogError";
  }
}

export async function discoverArtifacts(input: {
  projectRoot: string;
  explicitArtifact?: string;
  explicitMap?: string;
  configuredCacheDirs?: string[];
  maxFiles?: number;
  maxDepth?: number;
  maxCandidates?: number;
  maxArtifactBytes?: number;
  maxHashedBytes?: number;
}): Promise<ArtifactDiscoveryResult> {
  const projectRoot = await realpath(input.projectRoot);
  const limits = {
    maxFiles: bounded(input.maxFiles, DEFAULT_MAX_FILES, 1, 100_000, "maxFiles"),
    maxDepth: bounded(input.maxDepth, DEFAULT_MAX_DEPTH, 0, 64, "maxDepth"),
    maxCandidates: bounded(input.maxCandidates, DEFAULT_MAX_CANDIDATES, 1, 4096, "maxCandidates"),
    maxArtifactBytes: bounded(input.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES, 4, 1024 * 1024 * 1024, "maxArtifactBytes"),
    maxHashedBytes: bounded(input.maxHashedBytes, DEFAULT_MAX_HASHED_BYTES, 4, 2 * 1024 * 1024 * 1024, "maxHashedBytes"),
  };
  const explicitArtifact = input.explicitArtifact
    ? await existingProjectFile(input.explicitArtifact, projectRoot, limits.maxArtifactBytes)
    : undefined;
  const explicitMap = input.explicitMap
    ? await existingProjectFile(input.explicitMap, projectRoot, limits.maxArtifactBytes)
    : undefined;
  if (explicitMap && extname(explicitMap).toLowerCase() !== ".map") {
    throw new ArtifactCatalogError("ARTIFACT_MAP_INVALID", "explicitMap must select a .map file", { explicitMap });
  }

  if (explicitArtifact) {
    const candidate = await probeCandidate(explicitArtifact, limits.maxArtifactBytes);
    if (!candidate) throw new ArtifactCatalogError("ARTIFACT_UNSUPPORTED", "explicit artifact content is unsupported", { path: explicitArtifact });
    return {
      projectRoot,
      explicit: true,
      candidates: [candidate],
      mapCandidates: explicitMap ? [explicitMap] : [],
      scannedFiles: 1 + (explicitMap ? 1 : 0),
    };
  }

  const configured = (input.configuredCacheDirs ?? []).map((path) => normalized(resolve(projectRoot, path)));
  const candidates: ArtifactCandidate[] = [];
  const mapCandidates: string[] = [];
  let scannedFiles = 0;
  let hashedBytes = 0;

  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw new ArtifactCatalogError("ARTIFACT_SCAN_LIMIT", "artifact scan exceeded maxDepth", { maxDepth: limits.maxDepth });
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED_NAMES.has(entry.name.toLowerCase()) || configured.some((cache) => insideNormalized(path, cache))) continue;
        await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      scannedFiles += 1;
      if (scannedFiles > limits.maxFiles) throw new ArtifactCatalogError("ARTIFACT_SCAN_LIMIT", "artifact scan exceeded maxFiles", { maxFiles: limits.maxFiles });
      if (extname(entry.name).toLowerCase() === ".map") mapCandidates.push(await realpath(path));
      const candidate = await probeCandidate(path, limits.maxArtifactBytes);
      if (!candidate) continue;
      hashedBytes += candidate.size;
      if (hashedBytes > limits.maxHashedBytes) throw new ArtifactCatalogError("ARTIFACT_SCAN_LIMIT", "artifact candidate hashing exceeded maxHashedBytes", { maxHashedBytes: limits.maxHashedBytes });
      candidates.push(candidate);
      if (candidates.length > limits.maxCandidates) throw new ArtifactCatalogError("ARTIFACT_SCAN_LIMIT", "artifact scan exceeded maxCandidates", { maxCandidates: limits.maxCandidates });
    }
  };
  await walk(projectRoot, 0);
  return { projectRoot, explicit: false, candidates: candidates.sort(byPath), mapCandidates: mapCandidates.sort(), scannedFiles };
}

export async function resolveArtifactGeneration(input: Parameters<typeof discoverArtifacts>[0]): Promise<ArtifactGeneration> {
  const discovery = await discoverArtifacts(input);
  if (discovery.candidates.length !== 1) {
    throw new ArtifactCatalogError(
      discovery.candidates.length === 0 ? "ARTIFACT_NOT_FOUND" : "ARTIFACT_SELECTION_REQUIRED",
      discovery.candidates.length === 0 ? "no supported artifact candidate was found" : "multiple artifact candidates require an explicitArtifact",
      { candidates: discovery.candidates.map(({ path, format, sha256 }) => ({ path, format, sha256 })) },
    );
  }
  const artifact = discovery.candidates[0];
  const explicitMap = input.explicitMap ? discovery.mapCandidates[0] : undefined;
  const stem = basename(artifact.path, extname(artifact.path)).toLowerCase();
  const pairedMaps = explicitMap ? [explicitMap] : discovery.mapCandidates.filter((path) => basename(path, extname(path)).toLowerCase() === stem);
  if (pairedMaps.length > 1) {
    throw new ArtifactCatalogError("ARTIFACT_MAP_SELECTION_REQUIRED", "multiple MAP candidates match the selected artifact", { maps: pairedMaps });
  }
  const mapPath = pairedMaps[0];
  const mapSha256 = mapPath ? await sha256Bounded(mapPath, DEFAULT_MAX_ARTIFACT_BYTES) : undefined;
  const generation = generationHash({ path: artifact.path, format: artifact.format, sha256: artifact.sha256, mapPath, mapSha256 });
  return { ...artifact, generation, ...(mapPath && mapSha256 ? { mapPath, mapSha256 } : {}) };
}

export async function writeArtifactMatchManifest(input: {
  projectRoot: string;
  sessionRoot: string;
  artifact: ArtifactGeneration;
  captureId: string;
  targetId: string;
  probeSerial: string;
  runtimeIdentitySha256: string;
  nonvolatileRanges: AddressRange[];
  ramRanges: AddressRange[];
  connectOrdinal?: number;
}): Promise<{ path: string; sha256: string; manifest: ArtifactMatchManifest }> {
  if (input.artifact.format !== "elf") throw new ArtifactCatalogError("ARTIFACT_MATCH_UNSUPPORTED", "artifact match v0 supports ELF content only");
  requireText(input.captureId, "captureId");
  requireText(input.targetId, "targetId");
  requireText(input.probeSerial, "probeSerial");
  requireSha256(input.runtimeIdentitySha256, "runtimeIdentitySha256");
  requireSha256(input.artifact.sha256, "artifact.sha256");
  requireSha256(input.artifact.generation, "artifact.generation");
  const connectOrdinal = bounded(input.connectOrdinal, 1, 1, Number.MAX_SAFE_INTEGER, "connectOrdinal");
  const projectRoot = await realpath(input.projectRoot);
  const sessionRoot = await realpath(input.sessionRoot);
  if (insidePath(sessionRoot, projectRoot)) throw new ArtifactCatalogError("ARTIFACT_SESSION_ROOT_INVALID", "artifact match manifest must be outside projectRoot", { projectRoot, sessionRoot });
  const artifactPath = await realpath(input.artifact.path);
  if (!insidePath(artifactPath, projectRoot)) throw new ArtifactCatalogError("ARTIFACT_PATH_INVALID", "artifact path is outside projectRoot", { artifactPath, projectRoot });
  const data = await readFile(artifactPath);
  const actualSha256 = sha256(data);
  if (actualSha256 !== input.artifact.sha256.toLowerCase()) {
    throw new ArtifactCatalogError("ARTIFACT_GENERATION_STALE", "artifact content changed before manifest generation", { expected: input.artifact.sha256, actual: actualSha256 });
  }
  const ranges = nonvolatileElfRanges(data, normalizeRanges(input.nonvolatileRanges, "nonvolatileRanges"), normalizeRanges(input.ramRanges, "ramRanges"));
  const totalBytes = ranges.reduce((sum, range) => sum + range.length, 0);
  const manifest: ArtifactMatchManifest = {
    schema: "artifact-match-v0",
    historyOnly: false,
    captureId: input.captureId,
    targetId: input.targetId,
    probeSerial: input.probeSerial,
    runtimeIdentitySha256: input.runtimeIdentitySha256.toLowerCase(),
    artifactGeneration: input.artifact.generation.toLowerCase(),
    artifactSha256: input.artifact.sha256.toLowerCase(),
    connectOrdinal,
    totalBytes,
    ranges,
  };
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const path = join(sessionRoot, "artifact-match-v0.json");
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path, sha256: sha256(bytes), manifest };
}

export function historicalDiagnosticMatchEvidence(input: {
  observedStatus: "verified" | "unverified" | "mismatch";
  source: string;
  artifactGeneration?: string;
}): {
  targetArtifactMatch: "unverified";
  historyOnly: true;
  observedStatus: "verified" | "unverified" | "mismatch";
  source: string;
  artifactGeneration?: string;
} {
  return { targetArtifactMatch: "unverified", historyOnly: true, ...input };
}

async function probeCandidate(path: string, maxBytes: number): Promise<ArtifactCandidate | undefined> {
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > maxBytes) return undefined;
  const handle = await open(path, "r");
  let header: Buffer;
  try {
    header = Buffer.alloc(Math.min(info.size, 512));
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const extension = extname(path).toLowerCase();
  let format: ArtifactFormat | undefined;
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) format = "elf";
  else if (/^:[0-9A-Fa-f]{8}/.test(header.toString("ascii"))) format = "intel-hex";
  else if (/^S[0-9][0-9A-Fa-f]{2}/.test(header.toString("ascii"))) format = "srec";
  else if (extension === ".bin") format = "raw-bin";
  if (!format) return undefined;
  const canonical = await realpath(path);
  const digest = await sha256Bounded(canonical, maxBytes);
  const supportedOperations: ArtifactCandidate["supportedOperations"] = format === "elf" ? ["symbols", "flash", "verify"] : ["flash", "verify"];
  return { path: canonical, format, sha256: digest, generation: generationHash({ path: canonical, format, sha256: digest }), size: info.size, supportedOperations };
}

function nonvolatileElfRanges(data: Buffer, nonvolatile: AddressRange[], ram: AddressRange[]): ArtifactMatchManifest["ranges"] {
  if (nonvolatile.length === 0) throw new ArtifactCatalogError("ARTIFACT_REGION_UNKNOWN", "at least one explicit nonvolatile range is required");
  const parsed = new Map(parseElfFlashSegments(data, ram).map((segment) => [segment.name, segment]));
  const programOffset = data.readUInt32LE(28);
  const entrySize = data.readUInt16LE(42);
  const entryCount = data.readUInt16LE(44);
  const ranges: ArtifactMatchManifest["ranges"] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const offset = programOffset + index * entrySize;
    if (data.readUInt32LE(offset) !== 1) continue;
    const virtualAddress = data.readUInt32LE(offset + 8);
    const physicalAddress = data.readUInt32LE(offset + 12);
    const fileSize = data.readUInt32LE(offset + 16);
    if (fileSize === 0) continue;
    if (insideAny(virtualAddress, fileSize, ram)) continue;
    if (!insideAny(physicalAddress, fileSize, nonvolatile) || !insideAny(virtualAddress, fileSize, nonvolatile)) {
      throw new ArtifactCatalogError("ARTIFACT_REGION_UNKNOWN", "ELF PT_LOAD file bytes are not wholly mapped to an explicit nonvolatile or RAM region", { index, virtualAddress, physicalAddress, fileSize });
    }
    const segment = parsed.get(`PT_LOAD_${index}`);
    if (!segment) throw new ArtifactCatalogError("ARTIFACT_LOAD_IMAGE_INVALID", "ELF load record was not preserved by the shared parser", { index });
    ranges.push({ address: hexAddress(segment.start), length: segment.end - segment.start, dataHex: segment.dataHex });
  }
  if (ranges.length === 0) throw new ArtifactCatalogError("ARTIFACT_REGION_UNKNOWN", "ELF has no unambiguous nonvolatile file-backed load bytes");
  if (ranges.length > MAX_MATCH_RANGES) throw new ArtifactCatalogError("ARTIFACT_MATCH_LIMIT", "artifact match exceeds the range limit", { maxRanges: MAX_MATCH_RANGES });
  const total = ranges.reduce((sum, range) => sum + range.length, 0);
  if (total > MAX_MATCH_BYTES) throw new ArtifactCatalogError("ARTIFACT_MATCH_LIMIT", "artifact match exceeds the byte limit", { maxBytes: MAX_MATCH_BYTES });
  return ranges;
}

function normalizeRanges(ranges: AddressRange[], name: string): AddressRange[] {
  const sorted = ranges.map(({ start, end }) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > 0x1_0000_0000) {
      throw new ArtifactCatalogError("ARTIFACT_REGION_INVALID", `${name} contains an invalid range`, { start, end });
    }
    return { start, end };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) throw new ArtifactCatalogError("ARTIFACT_REGION_INVALID", `${name} contains overlapping ranges`);
  }
  return sorted;
}

function insideAny(address: number, length: number, ranges: AddressRange[]): boolean {
  return ranges.some((range) => address >= range.start && address + length <= range.end);
}

async function existingProjectFile(input: string, projectRoot: string, maxBytes: number): Promise<string> {
  const path = await realpath(isAbsolute(input) ? input : resolve(projectRoot, input));
  if (!insidePath(path, projectRoot)) throw new ArtifactCatalogError("ARTIFACT_PATH_INVALID", "artifact input escapes projectRoot", { path, projectRoot });
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new ArtifactCatalogError("ARTIFACT_PATH_INVALID", "artifact input is not a bounded regular file", { path, size: info.size, maxBytes });
  return path;
}

async function sha256Bounded(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new ArtifactCatalogError("ARTIFACT_HASH_LIMIT", "artifact exceeds the hash byte limit", { path, size: info.size, maxBytes });
  return sha256(await readFile(path));
}

function generationHash(input: { path: string; format: ArtifactFormat; sha256: string; mapPath?: string; mapSha256?: string }): string {
  return sha256(Buffer.from(JSON.stringify(input), "utf8"));
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function insidePath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalized(path: string): string {
  return resolve(path).toLowerCase();
}

function insideNormalized(path: string, root: string): boolean {
  const value = normalized(path);
  return value === root || value.startsWith(root + sep.toLowerCase());
}

function byPath(left: ArtifactCandidate, right: ArtifactCandidate): number {
  return left.path.localeCompare(right.path);
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw new ArtifactCatalogError("ARTIFACT_BOUND_INVALID", `${name} is outside its supported bound`, { value: selected, minimum, maximum });
  return selected;
}

function requireText(value: string, name: string): void {
  if (!value.trim() || value.length > 1024) throw new ArtifactCatalogError("ARTIFACT_BINDING_INVALID", `${name} is required and must be at most 1024 bytes`);
}

function requireSha256(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new ArtifactCatalogError("ARTIFACT_BINDING_INVALID", `${name} must be a SHA-256 hex digest`);
}

function hexAddress(address: number): string {
  return `0x${address.toString(16)}`;
}
