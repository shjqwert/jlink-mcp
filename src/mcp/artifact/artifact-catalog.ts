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
export type ArtifactClassification = "typed-debug-artifact" | "untyped-elf" | "flash-image";
export type DwarfCapability = "present" | "absent" | "unknown";

export interface ArtifactCandidate {
  path: string;
  format: ArtifactFormat;
  sha256: string;
  generation: string;
  size: number;
  classification: ArtifactClassification;
  debugCapabilities: {
    dwarf: DwarfCapability;
    elfClass?: 32 | 64;
    endian?: "little" | "big";
  };
  pairedMapCandidates: string[];
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
  if (explicitMap) {
    const mapBytes = await readFile(explicitMap);
    if (mapBytes.includes(0)) throw new ArtifactCatalogError("ARTIFACT_MAP_INVALID", "explicitMap must contain text linker-map evidence", { explicitMap });
  }

  if (explicitArtifact) {
    const probed = await probeCandidate(explicitArtifact, limits.maxArtifactBytes, true);
    const candidate = probed ? pairMapCandidates(probed, explicitMap ? [explicitMap] : []) : undefined;
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
  const mapCandidates: string[] = explicitMap ? [explicitMap] : [];
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
      if (extname(entry.name).toLowerCase() === ".map") {
        const mapPath = await realpath(path);
        if (!mapCandidates.includes(mapPath)) mapCandidates.push(mapPath);
      }
      const candidate = await probeCandidate(path, limits.maxArtifactBytes);
      if (!candidate) continue;
      hashedBytes += candidate.size;
      if (hashedBytes > limits.maxHashedBytes) throw new ArtifactCatalogError("ARTIFACT_SCAN_LIMIT", "artifact candidate hashing exceeded maxHashedBytes", { maxHashedBytes: limits.maxHashedBytes });
      candidates.push(candidate);
      if (candidates.length > limits.maxCandidates) throw new ArtifactCatalogError("ARTIFACT_SCAN_LIMIT", "artifact scan exceeded maxCandidates", { maxCandidates: limits.maxCandidates });
    }
  };
  await walk(projectRoot, 0);
  mapCandidates.sort();
  return {
    projectRoot,
    explicit: false,
    candidates: candidates.sort(byPath).map((candidate) => pairMapCandidates(candidate, mapCandidates)),
    mapCandidates,
    scannedFiles,
  };
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
  const pairedMaps = explicitMap ? [explicitMap] : artifact.pairedMapCandidates.filter((path) => basename(path, extname(path)).toLowerCase() === stem);
  if (pairedMaps.length > 1) {
    throw new ArtifactCatalogError("ARTIFACT_MAP_SELECTION_REQUIRED", "multiple MAP candidates match the selected artifact", { maps: pairedMaps });
  }
  const mapPath = pairedMaps[0];
  const mapSha256 = mapPath ? await sha256Bounded(mapPath, DEFAULT_MAX_ARTIFACT_BYTES) : undefined;
  const generation = computeArtifactGeneration(artifact.sha256, mapSha256);
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

async function probeCandidate(path: string, maxBytes: number, strict = false): Promise<ArtifactCandidate | undefined> {
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
  const data = await readFile(canonical);
  try {
    if (format === "intel-hex") validateIntelHexBytes(data, canonical);
    if (format === "srec") validateSrecBytes(data, canonical);
  } catch (error) {
    if (strict) throw error;
    return undefined;
  }
  const digest = sha256(data);
  const debugCapabilities = format === "elf" ? inspectElfDebugCapabilities(data) : { dwarf: "absent" as const };
  const classification: ArtifactClassification = format !== "elf"
    ? "flash-image"
    : debugCapabilities.dwarf === "present"
      ? "typed-debug-artifact"
      : "untyped-elf";
  const supportedOperations: ArtifactCandidate["supportedOperations"] = format === "elf"
    ? [...(debugCapabilities.dwarf === "present" ? ["symbols" as const] : []), "verify"]
    : ["flash", "verify"];
  return {
    path: canonical,
    format,
    sha256: digest,
    generation: computeArtifactGeneration(digest),
    size: info.size,
    classification,
    debugCapabilities,
    pairedMapCandidates: [],
    supportedOperations,
  };
}

function pairMapCandidates(candidate: ArtifactCandidate, maps: readonly string[]): ArtifactCandidate {
  if (candidate.format !== "elf") return candidate;
  const stem = basename(candidate.path, extname(candidate.path)).toLowerCase();
  return {
    ...candidate,
    pairedMapCandidates: maps.filter((path) => basename(path, extname(path)).toLowerCase() === stem),
  };
}

function inspectElfDebugCapabilities(data: Buffer): ArtifactCandidate["debugCapabilities"] {
  if (data.length < 16 || !data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return { dwarf: "absent" };
  const elfClass = data[4] === 1 ? 32 : data[4] === 2 ? 64 : undefined;
  const endian = data[5] === 1 ? "little" : data[5] === 2 ? "big" : undefined;
  if (!elfClass || !endian) return { dwarf: "unknown" };
  const read16 = endian === "little" ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  const read32 = endian === "little" ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  try {
    const sectionOffset = elfClass === 32 ? read32.call(data, 32) : safeUInt64(data, 40, endian);
    const sectionEntrySize = read16.call(data, elfClass === 32 ? 46 : 58);
    const sectionCount = read16.call(data, elfClass === 32 ? 48 : 60);
    const stringTableIndex = read16.call(data, elfClass === 32 ? 50 : 62);
    if (sectionOffset === 0 || sectionCount === 0) return { dwarf: "unknown", elfClass, endian };
    if (sectionEntrySize < (elfClass === 32 ? 40 : 64) || stringTableIndex >= sectionCount || sectionOffset + sectionEntrySize * sectionCount > data.length) {
      return { dwarf: "unknown", elfClass, endian };
    }
    const stringHeader = sectionOffset + sectionEntrySize * stringTableIndex;
    const stringOffset = elfClass === 32 ? read32.call(data, stringHeader + 16) : safeUInt64(data, stringHeader + 24, endian);
    const stringSize = elfClass === 32 ? read32.call(data, stringHeader + 20) : safeUInt64(data, stringHeader + 32, endian);
    if (stringOffset + stringSize > data.length) return { dwarf: "unknown", elfClass, endian };
    let hasInfo = false;
    let hasAbbrev = false;
    for (let index = 0; index < sectionCount; index += 1) {
      const header = sectionOffset + sectionEntrySize * index;
      const nameOffset = read32.call(data, header);
      if (nameOffset >= stringSize) continue;
      const end = data.indexOf(0, stringOffset + nameOffset);
      if (end < 0 || end > stringOffset + stringSize) continue;
      const name = data.toString("utf8", stringOffset + nameOffset, end);
      hasInfo ||= name === ".debug_info" || name === ".zdebug_info";
      hasAbbrev ||= name === ".debug_abbrev" || name === ".zdebug_abbrev";
    }
    return { dwarf: hasInfo && hasAbbrev ? "present" : "absent", elfClass, endian };
  } catch {
    return { dwarf: "unknown", elfClass, endian };
  }
}

function safeUInt64(data: Buffer, offset: number, endian: "little" | "big"): number {
  const value = endian === "little" ? data.readBigUInt64LE(offset) : data.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ELF offset exceeds the safe integer range");
  return Number(value);
}

function validateIntelHexBytes(data: Buffer, path: string): void {
  const lines = data.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let eofSeen = false;
  for (const line of lines) {
    if (eofSeen || !/^:[0-9A-Fa-f]+$/.test(line) || (line.length - 1) % 2 !== 0) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "Intel HEX contains an invalid record", { path });
    const bytes = Buffer.from(line.slice(1), "hex");
    if (bytes.length < 5 || bytes.length !== bytes[0] + 5 || ![0, 1, 2, 3, 4, 5].includes(bytes[3])) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "Intel HEX record length or type is invalid", { path });
    const expectedLengths: Record<number, number | undefined> = { 1: 0, 2: 2, 3: 4, 4: 2, 5: 4 };
    const expectedLength = expectedLengths[bytes[3]];
    if (expectedLength !== undefined && (bytes[0] !== expectedLength || bytes[1] !== 0 || bytes[2] !== 0)) {
      throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "Intel HEX metadata record has an invalid address or length", { path });
    }
    if (bytes.reduce((sum, value) => (sum + value) & 0xff, 0) !== 0) throw new ArtifactCatalogError("FLASH_CHECKSUM_INVALID", "Intel HEX checksum validation failed", { path });
    if (bytes[3] === 1) eofSeen = true;
  }
  if (!eofSeen) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "Intel HEX EOF record is missing", { path });
}

function validateSrecBytes(data: Buffer, path: string): void {
  const lines = data.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let dataSeen = false;
  let terminationSeen = false;
  for (const line of lines) {
    if (terminationSeen) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "SREC contains records after its termination record", { path });
    const match = line.match(/^S([0-9])([0-9A-Fa-f]+)$/);
    if (!match || match[2].length % 2 !== 0) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "SREC contains an invalid record", { path });
    const type = Number(match[1]);
    if (type === 4) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "SREC type S4 is reserved", { path });
    const bytes = Buffer.from(match[2], "hex");
    const addressBytes = [0, 1, 5, 9].includes(type) ? 2 : [2, 6, 8].includes(type) ? 3 : 4;
    if (bytes.length < addressBytes + 2 || bytes[0] !== bytes.length - 1) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "SREC record length is invalid", { path });
    if ((bytes.reduce((sum, value) => sum + value, 0) & 0xff) !== 0xff) throw new ArtifactCatalogError("FLASH_CHECKSUM_INVALID", "SREC checksum validation failed", { path });
    if ([1, 2, 3].includes(type)) dataSeen = true;
    if ([7, 8, 9].includes(type)) terminationSeen = true;
  }
  if (!dataSeen || !terminationSeen) throw new ArtifactCatalogError("FLASH_FORMAT_INVALID", "SREC data or termination record is missing", { path });
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
  if (!isAbsolute(input) && !insidePath(path, projectRoot)) throw new ArtifactCatalogError("ARTIFACT_PATH_INVALID", "relative artifact input escapes projectRoot", { path, projectRoot });
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new ArtifactCatalogError("ARTIFACT_PATH_INVALID", "artifact input is not a bounded regular file", { path, size: info.size, maxBytes });
  return path;
}

async function sha256Bounded(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new ArtifactCatalogError("ARTIFACT_HASH_LIMIT", "artifact exceeds the hash byte limit", { path, size: info.size, maxBytes });
  return sha256(await readFile(path));
}

export function computeArtifactGeneration(artifactSha256: string, mapSha256?: string): string {
  return sha256(Buffer.from(JSON.stringify({ artifactSha256: artifactSha256.toLowerCase(), mapSha256: mapSha256?.toLowerCase() ?? null }), "utf8"));
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
