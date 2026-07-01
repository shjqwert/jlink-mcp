import { createHash } from "node:crypto";
import { latestNamedFile, assertSupportedArtifactByContent } from "./debug-artifact";
import { HSS_ERROR, HssError } from "./hss-errors";
import { parseIarMap } from "./iar-map-parser";
import { existingInsideProject } from "./project-paths";
import type { HssScalarType } from "./hss-contract";
import { hssPolicyElementSize, type HssPolicyEntry, type HssFixedArrayPolicyEntry } from "./hss-policy";

export interface HssWriteScalarLayout {
  path: string;
  kind: "scalar";
  address: number;
  memoryRegion: "ram";
  type: HssScalarType;
  byteSize: number;
  symbolLayoutHash: string;
  source: "iar-map";
}

export interface HssWriteArrayLayout {
  path: string;
  kind: "fixed_array";
  baseAddress: number;
  memoryRegion: "ram";
  elementType: HssScalarType;
  elementSize: number;
  arrayLength: number;
  totalByteSize: number;
  dimensions: number[];
  symbolLayoutHash: string;
  source: "iar-map";
}

export type HssWriteTargetLayout = HssWriteScalarLayout | HssWriteArrayLayout;

export async function resolveHssWriteTargetLayout(input: {
  cwd?: string;
  artifactFile?: string;
  mapFile?: string;
  entry: HssPolicyEntry;
}): Promise<HssWriteTargetLayout> {
  const cwd = input.cwd ?? process.cwd();
  const artifactFile = input.artifactFile
    ? await existingInsideProject(input.artifactFile, cwd)
    : latestNamedFile(cwd, "FOC_SCM.out");
  if (!artifactFile) throw new HssError(HSS_ERROR.ARTIFACT_NOT_FOUND, "FOC_SCM.out was not found under cwd");
  assertSupportedArtifactByContent(artifactFile);
  const mapFile = input.mapFile
    ? await existingInsideProject(input.mapFile, cwd)
    : latestNamedFile(cwd, "FOC_SCM.map");
  if (!mapFile) throw new HssError(HSS_ERROR.MAP_NOT_FOUND, "FOC_SCM.map fallback was not found");
  return resolveIarMapWriteTargetLayout(mapFile, input.entry);
}

export function resolveIarMapWriteTargetLayout(mapFile: string, entry: HssPolicyEntry): HssWriteTargetLayout {
  const matches = parseIarMap(mapFile).get(entry.path) ?? [];
  if (matches.length === 0) throw new HssError(HSS_ERROR.SYMBOL_NOT_FOUND, `symbol not found in IAR map: ${entry.path}`);
  if (matches.length > 1) throw new HssError(HSS_ERROR.SYMBOL_DUPLICATE, `duplicate symbol in IAR map: ${entry.path}`);
  const symbol = matches[0];
  rejectPointerLike(entry.path);
  if (!isRam(symbol.address)) throw new HssError(HSS_ERROR.SYMBOL_NOT_RAM, "symbol is not in RAM", { path: entry.path, address: hex(symbol.address) });
  if (entry.kind === "scalar") {
    const byteSize = hssPolicyElementSize(entry.type);
    if (symbol.size !== byteSize) throw new HssError(HSS_ERROR.SYMBOL_KIND_UNSUPPORTED, "scalar symbol size does not match policy type", { path: entry.path, symbolSize: symbol.size, byteSize });
    if (symbol.address % byteSize !== 0) throw new HssError(HSS_ERROR.SYMBOL_KIND_UNSUPPORTED, "scalar symbol address is unaligned", { path: entry.path });
    const layout: Omit<HssWriteScalarLayout, "symbolLayoutHash"> = {
      path: entry.path,
      kind: "scalar",
      address: symbol.address,
      memoryRegion: "ram",
      type: entry.type,
      byteSize,
      source: "iar-map",
    };
    return { ...layout, symbolLayoutHash: hashStable(layout) };
  }
  if (entry.kind === "fixed_array") return resolveArray(entry, symbol.address, symbol.size);
  throw new HssError(HSS_ERROR.SYMBOL_KIND_UNSUPPORTED, "unsupported write target kind", { kind: (entry as { kind?: unknown }).kind });
}

function resolveArray(entry: HssFixedArrayPolicyEntry, baseAddress: number, symbolSize: number): HssWriteArrayLayout {
  if (symbolSize === 0) throw new HssError(HSS_ERROR.SYMBOL_INCOMPLETE_ARRAY_NOT_ALLOWED, "fixed array symbol size is zero", { path: entry.path });
  const elementSize = hssPolicyElementSize(entry.elementType);
  const totalByteSize = entry.arrayLength * elementSize;
  if (!Number.isInteger(entry.arrayLength) || entry.arrayLength <= 0) throw new HssError(HSS_ERROR.SYMBOL_ARRAY_LENGTH_UNKNOWN, "fixed array length is unknown", { path: entry.path });
  if (symbolSize < totalByteSize) throw new HssError(HSS_ERROR.SYMBOL_ARRAY_SIZE_MISMATCH, "map symbol is smaller than policy fixed array", { path: entry.path, symbolSize, totalByteSize });
  if (symbolSize > totalByteSize) throw new HssError(HSS_ERROR.SYMBOL_ARRAY_LAYOUT_UNKNOWN, "map symbol is larger than policy fixed array", { path: entry.path, symbolSize, totalByteSize });
  if (baseAddress % elementSize !== 0) throw new HssError(HSS_ERROR.SYMBOL_ARRAY_LAYOUT_UNKNOWN, "fixed array base address is unaligned", { path: entry.path });
  const layout: Omit<HssWriteArrayLayout, "symbolLayoutHash"> = {
    path: entry.path,
    kind: "fixed_array",
    baseAddress,
    memoryRegion: "ram",
    elementType: entry.elementType,
    elementSize,
    arrayLength: entry.arrayLength,
    totalByteSize,
    dimensions: [entry.arrayLength],
    source: "iar-map",
  };
  return { ...layout, symbolLayoutHash: hashStable(layout) };
}

function isRam(address: number): boolean {
  return address >= 0x20000000 && address < 0x40000000;
}

function rejectPointerLike(path: string): void {
  // ponytail: map-only has no C type; DWARF can replace this name/size guard.
  if (/(?:ptr|pointer)$/i.test(path)) throw new HssError(HSS_ERROR.SYMBOL_POINTER_NOT_ALLOWED, "pointer-like symbol names are not write targets", { path });
  if (/(?:dynamic|malloc)/i.test(path)) throw new HssError(HSS_ERROR.SYMBOL_DYNAMIC_ARRAY_NOT_ALLOWED, "dynamic array-like symbol names are not write targets", { path });
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
