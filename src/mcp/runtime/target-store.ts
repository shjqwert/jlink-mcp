import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { atomicReplaceSync } from "../../utils/atomic-file";
import { computeArtifactGeneration } from "../artifact/artifact-catalog";
import { canonicalProbeSerial, ProbeIdentityError } from "./probe-identity";

export type TargetInterface = "SWD" | "JTAG";
export type ArtifactMatchStatus = "unverified" | "verified" | "mismatch";
export type MemoryRegionKind = "ram" | "flash" | "rom" | "peripheral" | "unknown";

export interface TargetFileBinding {
  path: string;
  sha256: string;
  size: number;
  external: boolean;
}

export interface ArtifactBinding extends TargetFileBinding {
  generation: string;
}

export interface FlashImageBinding extends TargetFileBinding {
  format: "hex" | "srec" | "bin";
  baseAddress?: number;
}

export interface MemoryRegion {
  start: number;
  length: number;
  kind: MemoryRegionKind;
  writable: boolean;
}

export interface LiveArtifactMatch {
  status: ArtifactMatchStatus;
  source: string;
  timestamp: string;
  binding?: {
    projectRoot: string;
    targetGeneration: string;
    probeSerial: string;
    artifactGeneration: string;
  };
}

export interface ArtifactMatchBindingExpectation {
  targetGeneration: string;
  probeSerial: string;
  artifactGeneration?: string;
}

export interface StoredTarget {
  projectRoot: string;
  generation: string;
  configuredAt: string;
  configurationHash: string;
  device: string;
  probeSerial: string;
  interface: TargetInterface;
  speed: number;
  artifact?: ArtifactBinding;
  map?: TargetFileBinding;
  svd?: TargetFileBinding;
  jlinkPath?: TargetFileBinding;
  gdbServerPath?: TargetFileBinding;
  gdbPath?: TargetFileBinding;
  ports: { gdb: number; rtt: number; swo: number };
  artifactFlashImages: FlashImageBinding[];
  memoryRegions: MemoryRegion[];
  missingOptionalInputs: string[];
  liveArtifactMatch: LiveArtifactMatch;
}

export interface TargetConfigureInput {
  projectRoot: string;
  device: string;
  probeSerial: string;
  interface: TargetInterface;
  speed: number;
  artifactPath?: string;
  mapPath?: string;
  svdPath?: string;
  jlinkPath?: string;
  gdbServerPath?: string;
  gdbPath?: string;
  ports?: Partial<StoredTarget["ports"]>;
  artifactFlashImages?: Array<{ path: string; baseAddress?: number }>;
  memoryRegions?: MemoryRegion[];
}

interface TargetStoreDocument {
  formatVersion: 1;
  targets: Record<string, StoredTarget>;
}

interface TargetLockRecord {
  token: string;
  pid: number;
  processInstanceId: string;
  processStartedAt: string;
  heartbeatAt: string;
}

const targetStoreProcessInstanceId = randomUUID();
const targetStoreProcessStartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

export class TargetStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TargetStoreError";
  }
}

export class TargetStore {
  readonly filePath: string;
  private readonly lockPath: string;
  private readonly dirtyRoot: string;
  private readonly inMemoryDirty = new Set<string>();

  constructor(stateRoot = resolve(".jlink-mcp")) {
    const canonicalStateRoot = resolve(stateRoot);
    mkdirSync(canonicalStateRoot, { recursive: true });
    this.filePath = join(canonicalStateRoot, "targets.json");
    this.lockPath = join(canonicalStateRoot, "targets.lock");
    this.dirtyRoot = join(canonicalStateRoot, "artifact-dirty");
    mkdirSync(this.dirtyRoot, { recursive: true });
  }

  canonicalProjectRoot(projectRoot: string): string {
    if (!projectRoot || !isAbsolute(projectRoot)) {
      throw new TargetStoreError("INVALID_PROJECT_ROOT", "projectRoot must be an existing absolute directory");
    }
    let canonical: string;
    try {
      canonical = normalize(realpathSync.native(projectRoot));
    } catch {
      throw new TargetStoreError("PROJECT_ROOT_NOT_FOUND", `projectRoot does not exist: ${projectRoot}`);
    }
    if (!statSync(canonical).isDirectory()) {
      throw new TargetStoreError("INVALID_PROJECT_ROOT", "projectRoot must identify a directory");
    }
    return canonical;
  }

  get(projectRoot: string): StoredTarget | undefined {
    const canonical = this.canonicalProjectRoot(projectRoot);
    const target = this.readDocument().targets[targetKey(canonical)];
    return target ? this.applyDirtyArtifactOverlay(target) : undefined;
  }

  require(projectRoot: string): StoredTarget {
    const target = this.get(projectRoot);
    if (!target) throw new TargetStoreError("TARGET_NOT_CONFIGURED", "target_configure must be called for this projectRoot first");
    return target;
  }

  requireCurrent(expected: StoredTarget): StoredTarget {
    const current = this.require(expected.projectRoot);
    if (current.generation !== expected.generation || current.probeSerial !== expected.probeSerial) {
      throw new TargetStoreError("TARGET_GENERATION_CHANGED", "Target generation changed while the request waited for the Probe queue");
    }
    return current;
  }

  async configure(input: TargetConfigureInput, expectedGeneration?: string | null): Promise<StoredTarget> {
    validateConfigureInput(input);
    const projectRoot = this.canonicalProjectRoot(input.projectRoot);
    const inspectedArtifact = input.artifactPath ? inspectArtifactFile(projectRoot, input.artifactPath) : undefined;
    const map = input.mapPath ? resolveBoundFile(projectRoot, input.mapPath, validateMap) : undefined;
    const artifact = inspectedArtifact ? {
      ...inspectedArtifact,
      generation: computeArtifactGeneration(inspectedArtifact.sha256, map?.sha256),
    } : undefined;
    const svd = input.svdPath ? resolveBoundFile(projectRoot, input.svdPath, validateSvd) : undefined;
    const jlinkPath = input.jlinkPath ? resolveBoundFile(projectRoot, input.jlinkPath, validateExecutableFile) : undefined;
    const gdbServerPath = input.gdbServerPath ? resolveBoundFile(projectRoot, input.gdbServerPath, validateExecutableFile) : undefined;
    const gdbPath = input.gdbPath ? resolveBoundFile(projectRoot, input.gdbPath, validateExecutableFile) : undefined;
    if ((input.artifactFlashImages?.length ?? 0) > 0 && !artifact) {
      throw new TargetStoreError("ARTIFACT_REQUIRED", "artifactFlashImages require an artifactPath binding");
    }
    const artifactFlashImages = (input.artifactFlashImages ?? []).map((item) => inspectFlashFile(projectRoot, item.path, item.baseAddress));
    const memoryRegions = normalizeMemoryRegions(input.memoryRegions ?? []);
    const ports = {
      gdb: input.ports?.gdb ?? 2331,
      rtt: input.ports?.rtt ?? 19021,
      swo: input.ports?.swo ?? 2332,
    };
    validatePorts(ports);
    const probeSerial = canonicalProbeSerial(input.probeSerial);
    const configuredAt = new Date().toISOString();
    const generation = randomUUID();
    const hashMaterial = {
      projectRoot,
      device: input.device,
      probeSerial,
      interface: input.interface,
      speed: input.speed,
      artifact,
      map,
      svd,
      jlinkPath,
      gdbServerPath,
      gdbPath,
      ports,
      artifactFlashImages,
      memoryRegions,
    };
    const target: StoredTarget = {
      ...hashMaterial,
      generation,
      configuredAt,
      configurationHash: sha256Json(hashMaterial),
      missingOptionalInputs: [
        !artifact && "artifact",
        !map && "map",
        !svd && "svd",
        !jlinkPath && "jlinkPath",
        !gdbServerPath && "gdbServerPath",
        !gdbPath && "gdbPath",
      ].filter((value): value is string => Boolean(value)),
      liveArtifactMatch: { status: "unverified", source: "target_configure", timestamp: configuredAt },
    };
    await this.withLock(async () => {
      const document = this.readDocument();
      const key = targetKey(projectRoot);
      const currentGeneration = document.targets[key]?.generation ?? null;
      if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) {
        throw new TargetStoreError("TARGET_GENERATION_CHANGED", "Target configuration changed before target_configure could be committed; retry against the current generation");
      }
      document.targets[key] = target;
      this.writeDocument(document);
    });
    return target;
  }

  async setArtifactMatch(
    projectRoot: string,
    status: ArtifactMatchStatus,
    source: string,
    expected?: ArtifactMatchBindingExpectation,
  ): Promise<StoredTarget> {
    return this.withLock(async () => {
      const canonical = this.canonicalProjectRoot(projectRoot);
      const document = this.readDocument();
      const key = targetKey(canonical);
      const target = document.targets[key];
      if (!target) throw new TargetStoreError("TARGET_NOT_CONFIGURED", "target_configure must be called for this projectRoot first");
      if (expected && (
        target.generation !== expected.targetGeneration
        || target.probeSerial !== expected.probeSerial
        || (expected.artifactGeneration !== undefined && target.artifact?.generation !== expected.artifactGeneration)
      )) {
        throw new TargetStoreError("TARGET_GENERATION_CHANGED", "Target or Artifact generation changed while the operation was executing");
      }
      const timestamp = new Date().toISOString();
      const dirtyPath = this.persistArtifactDirtyMarker(target, status, source, timestamp);
      target.liveArtifactMatch = {
        status,
        source,
        timestamp,
        binding: status === "verified" && target.artifact ? {
          projectRoot: target.projectRoot,
          targetGeneration: target.generation,
          probeSerial: target.probeSerial,
          artifactGeneration: target.artifact.generation,
        } : undefined,
      };
      this.writeDocument(document);
      this.clearArtifactDirtyMarker(dirtyPath);
      return target;
    });
  }

  private persistArtifactDirtyMarker(target: StoredTarget, status: ArtifactMatchStatus, source: string, timestamp: string): string {
    const markerPath = this.artifactDirtyPath(target);
    this.inMemoryDirty.add(markerPath);
    if (existsSync(markerPath)) return markerPath;
    const temporary = `${markerPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({
        formatVersion: 1,
        projectKey: createHash("sha256").update(targetKey(target.projectRoot)).digest("hex"),
        targetGeneration: target.generation,
        artifactGeneration: target.artifact?.generation ?? null,
        requestedStatus: status,
        source,
        timestamp,
      })}\n`, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, markerPath);
      return markerPath;
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new TargetStoreError("ARTIFACT_DIRTY_MARKER_FAILED", `cannot persist fail-closed Artifact marker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private clearArtifactDirtyMarker(markerPath: string): void {
    try {
      rmSync(markerPath, { force: true });
      this.inMemoryDirty.delete(markerPath);
    } catch (error) {
      throw new TargetStoreError("ARTIFACT_DIRTY_CLEAR_FAILED", `Artifact state was persisted but its fail-closed marker could not be cleared: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applyDirtyArtifactOverlay(target: StoredTarget): StoredTarget {
    const markerPath = this.artifactDirtyPath(target);
    if (!this.inMemoryDirty.has(markerPath) && !existsSync(markerPath)) return target;
    let timestamp = target.liveArtifactMatch.timestamp;
    try { timestamp = statSync(markerPath).mtime.toISOString(); } catch { /* in-memory poison remains authoritative */ }
    return {
      ...target,
      liveArtifactMatch: {
        status: "unverified",
        source: "artifact_state_persistence_incomplete",
        timestamp,
      },
    };
  }

  private artifactDirtyPath(target: Pick<StoredTarget, "projectRoot" | "generation">): string {
    const project = createHash("sha256").update(targetKey(target.projectRoot)).digest("hex");
    return join(this.dirtyRoot, `${project}-${target.generation}.json`);
  }

  private readDocument(): TargetStoreDocument {
    if (!existsSync(this.filePath)) return { formatVersion: 1, targets: {} };
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch (error) {
      throw new TargetStoreError("TARGET_STORE_INVALID", `cannot read targets.json: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!value || typeof value !== "object" || (value as TargetStoreDocument).formatVersion !== 1 || !(value as TargetStoreDocument).targets) {
      throw new TargetStoreError("TARGET_STORE_INVALID", "targets.json has an unsupported structure");
    }
    return value as TargetStoreDocument;
  }

  private writeDocument(document: TargetStoreDocument): void {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      atomicReplaceSync(temporary, this.filePath);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000;
    const token = randomUUID();
    for (;;) {
      try {
        if (!tryCreateTargetLock(this.lockPath, targetLockRecord(token))) throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        recoverStaleDirectoryLock(this.lockPath);
        if (Date.now() >= deadline) throw new TargetStoreError("TARGET_STORE_BUSY", "timed out waiting for targets.json lock");
        await delay(10);
      }
    }
    const heartbeat = setInterval(() => refreshTargetLock(this.lockPath, token), 1_000);
    heartbeat.unref();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      removeTargetLockIfTokenMatches(this.lockPath, token);
    }
  }
}

export function inspectFlashFile(projectRoot: string, filePath: string, baseAddress?: number): FlashImageBinding {
  const lower = filePath.toLowerCase();
  if (/\.(?:elf|out|axf)$/.test(lower)) {
    throw new TargetStoreError("FLASH_FORMAT_UNSUPPORTED", "ELF/OUT/AXF files are symbol Artifacts, not flash inputs");
  }
  let extensionFormat: FlashImageBinding["format"];
  if (/\.(?:hex|ihex)$/.test(lower)) extensionFormat = "hex";
  else if (/\.(?:srec|s19|s28|s37|mot)$/.test(lower)) extensionFormat = "srec";
  else if (/\.bin$/.test(lower)) extensionFormat = "bin";
  else throw new TargetStoreError("FLASH_FORMAT_UNSUPPORTED", "flash accepts Intel HEX, SREC, or raw BIN only");
  const binding = resolveBoundFile(projectRoot, filePath, () => undefined);
  const format = detectFlashFormat(binding.path);
  if (format !== extensionFormat) {
    throw new TargetStoreError("FLASH_FORMAT_MISMATCH", `flash content is ${format}, but the file extension declares ${extensionFormat}`);
  }
  if (format === "bin" && baseAddress === undefined) {
    throw new TargetStoreError("BASE_ADDRESS_REQUIRED", "raw BIN flash input requires baseAddress");
  }
  if (format !== "bin" && baseAddress !== undefined) {
    throw new TargetStoreError("BASE_ADDRESS_NOT_ALLOWED", "Intel HEX and SREC contain addresses and must not be relocated with baseAddress");
  }
  if (baseAddress !== undefined && (!Number.isSafeInteger(baseAddress) || baseAddress < 0 || baseAddress > 0xffff_ffff)) {
    throw new TargetStoreError("INVALID_BASE_ADDRESS", "baseAddress must be an unsigned 32-bit integer");
  }
  return { ...binding, format, baseAddress };
}

export function inspectArtifactFile(projectRoot: string, filePath: string): ArtifactBinding {
  const binding = resolveBoundFile(projectRoot, filePath, validateElf);
  return { ...binding, generation: binding.sha256 };
}

export function assertArtifactBindingsCurrent(target: StoredTarget): void {
  if (!target.artifact) throw new TargetStoreError("ARTIFACT_NOT_CONFIGURED", "target_configure must bind an ELF Artifact before symbol access");
  assertFileBindingCurrent(target.artifact, "ARTIFACT_GENERATION_STALE", "Artifact");
  if (target.map) assertFileBindingCurrent(target.map, "MAP_GENERATION_STALE", "MAP");
  const generation = computeArtifactGeneration(target.artifact.sha256, target.map?.sha256);
  if (generation !== target.artifact.generation) {
    throw new TargetStoreError("ARTIFACT_GENERATION_STALE", "Artifact generation does not match its configured Artifact/MAP content; call target_configure again");
  }
}

export function assertSvdBindingCurrent(target: StoredTarget): TargetFileBinding {
  if (!target.svd) throw new TargetStoreError("SVD_NOT_CONFIGURED", "target_configure must bind an explicit SVD before peripheral register access");
  assertFileBindingCurrent(target.svd, "SVD_GENERATION_STALE", "SVD");
  return target.svd;
}

function assertFileBindingCurrent(binding: TargetFileBinding, code: string, label: string): void {
  let canonical: string;
  try {
    canonical = normalize(realpathSync.native(binding.path));
  } catch {
    throw new TargetStoreError(code, `${label} no longer exists at its configured path; call target_configure again`);
  }
  const current = statSync(canonical);
  if (!current.isFile() || canonical !== normalize(binding.path) || current.size !== binding.size || sha256File(canonical) !== binding.sha256) {
    throw new TargetStoreError(code, `${label} content or identity changed after target_configure; call target_configure again`);
  }
}

export function locateMemoryRegion(target: StoredTarget, address: number, byteCount: number): MemoryRegion | undefined {
  const end = address + byteCount;
  return target.memoryRegions.find((region) => address >= region.start && end <= region.start + region.length);
}

export function overlappingMemoryRegions(target: StoredTarget, address: number, byteCount: number): MemoryRegion[] {
  const end = address + byteCount;
  return target.memoryRegions.filter((region) => address < region.start + region.length && end > region.start);
}

function resolveBoundFile(projectRoot: string, filePath: string, validate: (canonical: string) => void): TargetFileBinding {
  if (!filePath || /[\0\r\n]/.test(filePath)) throw new TargetStoreError("INVALID_FILE_PATH", "file path is empty or contains control characters");
  const candidate = isAbsolute(filePath) ? filePath : resolve(projectRoot, filePath);
  let canonical: string;
  try {
    canonical = normalize(realpathSync.native(candidate));
  } catch {
    throw new TargetStoreError("FILE_NOT_FOUND", `configured file does not exist: ${filePath}`);
  }
  if (!statSync(canonical).isFile()) throw new TargetStoreError("INVALID_FILE", `configured path is not a file: ${filePath}`);
  if (!isAbsolute(filePath) && isOutside(projectRoot, canonical)) {
    throw new TargetStoreError("RELATIVE_PATH_ESCAPES_PROJECT", "relative input files must remain inside projectRoot");
  }
  validate(canonical);
  const stat = statSync(canonical);
  return { path: canonical, sha256: sha256File(canonical), size: stat.size, external: isOutside(projectRoot, canonical) };
}

function validateElf(filePath: string): void {
  const bytes = readPrefix(filePath, 4);
  if (bytes.length !== 4 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new TargetStoreError("ARTIFACT_FORMAT_INVALID", "artifactPath is not an ELF file");
  }
}

function validateMap(filePath: string): void {
  const bytes = readPrefix(filePath, 4096);
  if (bytes.includes(0)) throw new TargetStoreError("MAP_FORMAT_INVALID", "mapPath must be a text linker MAP file");
}

function validateSvd(filePath: string): void {
  const text = readPrefix(filePath, 64 * 1024).toString("utf8").replace(/^\uFEFF/, "");
  if (!/<device(?:\s|>)/i.test(text)) throw new TargetStoreError("SVD_FORMAT_INVALID", "svdPath does not contain an SVD <device> root");
}

function validateExecutableFile(filePath: string): void {
  if (statSync(filePath).size < 1) throw new TargetStoreError("TOOL_PATH_INVALID", "configured tool path is empty");
}

function detectFlashFormat(filePath: string): FlashImageBinding["format"] {
  const prefix = readPrefix(filePath, 64 * 1024);
  if (prefix.length === 0) throw new TargetStoreError("FLASH_FILE_EMPTY", "flash input is empty");
  if (prefix.length >= 4 && prefix[0] === 0x7f && prefix[1] === 0x45 && prefix[2] === 0x4c && prefix[3] === 0x46) {
    throw new TargetStoreError("FLASH_FORMAT_UNSUPPORTED", "ELF content is not accepted as a flash image");
  }
  const first = prefix.toString("ascii").replace(/^\uFEFF/, "").trimStart();
  if (first.startsWith(":")) {
    validateIntelHex(filePath);
    return "hex";
  }
  if (/^S[0-9]/i.test(first)) {
    validateSrec(filePath);
    return "srec";
  }
  return "bin";
}

function validateIntelHex(filePath: string): void {
  const lines = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let eofSeen = false;
  for (const line of lines) {
    if (eofSeen || !/^:[0-9A-Fa-f]+$/.test(line) || (line.length - 1) % 2 !== 0) throw new TargetStoreError("FLASH_FORMAT_INVALID", "Intel HEX contains an invalid record");
    const bytes = Buffer.from(line.slice(1), "hex");
    if (bytes.length < 5 || bytes.length !== bytes[0] + 5 || ![0, 1, 2, 3, 4, 5].includes(bytes[3])) {
      throw new TargetStoreError("FLASH_FORMAT_INVALID", "Intel HEX record length or type is invalid");
    }
    const expectedLengths: Record<number, number | undefined> = { 1: 0, 2: 2, 3: 4, 4: 2, 5: 4 };
    const expectedLength = expectedLengths[bytes[3]];
    if (expectedLength !== undefined && (bytes[0] !== expectedLength || bytes[1] !== 0 || bytes[2] !== 0)) {
      throw new TargetStoreError("FLASH_FORMAT_INVALID", "Intel HEX metadata record has an invalid address or length");
    }
    if (bytes.reduce((sum, value) => (sum + value) & 0xff, 0) !== 0) throw new TargetStoreError("FLASH_CHECKSUM_INVALID", "Intel HEX checksum validation failed");
    if (bytes[3] === 1) {
      if (bytes[0] !== 0) throw new TargetStoreError("FLASH_FORMAT_INVALID", "Intel HEX EOF record has data");
      eofSeen = true;
    }
  }
  if (!eofSeen) throw new TargetStoreError("FLASH_FORMAT_INVALID", "Intel HEX EOF record is missing");
}

function validateSrec(filePath: string): void {
  const lines = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let dataSeen = false;
  let terminationSeen = false;
  for (const line of lines) {
    if (terminationSeen) throw new TargetStoreError("FLASH_FORMAT_INVALID", "SREC contains records after its termination record");
    const match = line.match(/^S([0-9])([0-9A-Fa-f]+)$/);
    if (!match || match[2].length % 2 !== 0) throw new TargetStoreError("FLASH_FORMAT_INVALID", "SREC contains an invalid record");
    const type = Number(match[1]);
    if (type === 4) throw new TargetStoreError("FLASH_FORMAT_INVALID", "SREC record type S4 is reserved");
    const bytes = Buffer.from(match[2], "hex");
    const addressBytes = [0, 1, 5, 9].includes(type) ? 2 : [2, 6, 8].includes(type) ? 3 : 4;
    if (bytes.length < addressBytes + 2 || bytes[0] !== bytes.length - 1) throw new TargetStoreError("FLASH_FORMAT_INVALID", "SREC record length is invalid");
    if ((bytes.reduce((sum, value) => sum + value, 0) & 0xff) !== 0xff) throw new TargetStoreError("FLASH_CHECKSUM_INVALID", "SREC checksum validation failed");
    if ([1, 2, 3].includes(type)) dataSeen = true;
    if ([7, 8, 9].includes(type)) terminationSeen = true;
  }
  if (!dataSeen || !terminationSeen) throw new TargetStoreError("FLASH_FORMAT_INVALID", "SREC data or termination record is missing");
}

function validateConfigureInput(input: TargetConfigureInput): void {
  if (!input.device?.trim() || /[\0\r\n]/.test(input.device)) throw new TargetStoreError("INVALID_DEVICE", "device is required");
  try { canonicalProbeSerial(input.probeSerial); }
  catch (error) { throw new TargetStoreError("PROBE_SELECTION_REQUIRED", error instanceof ProbeIdentityError ? error.message : "an unambiguous Probe serial is required"); }
  if (input.interface !== "SWD" && input.interface !== "JTAG") throw new TargetStoreError("INVALID_INTERFACE", "interface must be SWD or JTAG");
  if (!Number.isSafeInteger(input.speed) || input.speed < 1 || input.speed > 50_000) throw new TargetStoreError("INVALID_SPEED", "speed must be an integer from 1 to 50000 kHz");
}

function validatePorts(ports: StoredTarget["ports"]): void {
  for (const [name, value] of Object.entries(ports)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new TargetStoreError("INVALID_PORT", `${name} port must be 1..65535`);
  }
}

function normalizeMemoryRegions(regions: MemoryRegion[]): MemoryRegion[] {
  const normalized = regions.map((region) => {
    if (!Number.isSafeInteger(region.start) || region.start < 0 || region.start > 0xffff_ffff) throw new TargetStoreError("INVALID_MEMORY_REGION", "memory region start is invalid");
    if (!Number.isSafeInteger(region.length) || region.length < 1 || region.start + region.length > 0x1_0000_0000) throw new TargetStoreError("INVALID_MEMORY_REGION", "memory region length is invalid");
    if (!["ram", "flash", "rom", "peripheral", "unknown"].includes(region.kind)) throw new TargetStoreError("INVALID_MEMORY_REGION", "memory region kind is invalid");
    if ((region.kind === "flash" || region.kind === "rom") && region.writable) throw new TargetStoreError("INVALID_MEMORY_REGION", "Flash and ROM regions cannot be configured as writable raw-memory ranges");
    return { ...region };
  }).sort((left, right) => left.start - right.start);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].start < normalized[index - 1].start + normalized[index - 1].length) {
      throw new TargetStoreError("MEMORY_REGION_OVERLAP", "configured memory regions overlap");
    }
  }
  return normalized;
}

function readPrefix(filePath: string, length: number): Buffer {
  const handle = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const count = readSync(handle, buffer, 0, length, 0);
    return buffer.subarray(0, count);
  } finally {
    closeSync(handle);
  }
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  const handle = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function targetKey(projectRoot: string): string {
  return process.platform === "win32" ? projectRoot.toLocaleLowerCase("en-US") : projectRoot;
}

function isOutside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function recoverStaleDirectoryLock(lockPath: string): void {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as TargetLockRecord;
    if (!targetLockRecordLive(owner)) removeTargetLockIfTokenMatches(lockPath, owner.token);
  } catch { /* malformed locks are never deleted without a matching identity token */ }
}

function targetLockRecord(token: string): TargetLockRecord {
  return {
    token,
    pid: process.pid,
    processInstanceId: targetStoreProcessInstanceId,
    processStartedAt: targetStoreProcessStartedAt,
    heartbeatAt: new Date().toISOString(),
  };
}

function targetLockRecordLive(record: TargetLockRecord): boolean {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.token !== "string" || typeof record.processInstanceId !== "string") return false;
  if (record.pid === process.pid) {
    return record.processInstanceId === targetStoreProcessInstanceId && record.processStartedAt === targetStoreProcessStartedAt;
  }
  // Never steal a lock from a live process solely because its event loop paused.
  return processAlive(record.pid);
}

function tryCreateTargetLock(lockPath: string, record: TargetLockRecord): boolean {
  const prepared = `${lockPath}.${process.pid}.${record.token}.tmp`;
  try {
    mkdirSync(prepared);
    writeFileSync(join(prepared, "owner.json"), JSON.stringify(record), { encoding: "utf8", flag: "wx" });
    renameSync(prepared, lockPath);
    return true;
  } catch (error) {
    rmSync(prepared, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") return false;
    throw error;
  }
}

function refreshTargetLock(lockPath: string, token: string): void {
  const ownerPath = join(lockPath, "owner.json");
  try {
    const current = JSON.parse(readFileSync(ownerPath, "utf8")) as TargetLockRecord;
    if (current.token !== token) return;
    const temporary = `${ownerPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...current, heartbeatAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, ownerPath);
  } catch { /* the lock was released or replaced */ }
}

function removeTargetLockIfTokenMatches(lockPath: string, token: string): boolean {
  try {
    const current = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as TargetLockRecord;
    if (current.token !== token) return false;
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
