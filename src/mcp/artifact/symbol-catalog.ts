import { createHash } from "node:crypto";
import type { ArtifactGeneration } from "./artifact-catalog";
import { parseIarMap, type IarMapSymbol } from "../hss/iar-map-parser";
import type { HssScalarType } from "../hss/hss-contract";

const MAX_SEARCH_RESULTS = 128;
const selectorPattern = /^(?:(?:[A-Za-z]:)?[A-Za-z0-9_./\\ -]+::)?[A-Za-z_]\w*(?:\[\d+\])?(?:\.[A-Za-z_]\w*(?:\[\d+\])?)*$/;

export type SymbolRegion = "ram" | "flash" | "unknown";
export type SymbolSource = "elf-dwarf" | "iar-map";
export type SymbolKind = "global" | "static" | "fixed-member" | "local" | "bitfield" | "pointer" | "dynamic-array" | "unknown";
export type SymbolRejectCode = "symbol_not_found" | "symbol_ambiguous" | "unsupported_symbol" | "unknown_layout" | "hss_ineligible";

export interface SymbolRef {
  artifactGeneration: string;
  qualifiedName: string;
  memberPath?: string;
  layoutHash: string;
}

export interface SymbolCandidate {
  qualifiedName: string;
  memberPath?: string;
  rootAddress: number;
  rootSize?: number;
  memberOffset?: number;
  type?: HssScalarType;
  size?: number;
  region: SymbolRegion;
  source: SymbolSource;
  confidence: "dwarf" | "map";
  kind?: SymbolKind;
  endian?: "little" | "big";
}

export interface ResolvedSymbol {
  ref: SymbolRef;
  rootAddress: number;
  rootSize: number;
  memberOffset: number;
  address: number;
  type: HssScalarType;
  size: number;
  region: SymbolRegion;
  hssEligible: boolean;
  source: SymbolSource;
  confidence: "dwarf" | "map";
  endian: "little" | "big";
}

export type SymbolResolveResult =
  | { ok: true; value: ResolvedSymbol }
  | { ok: false; error: { code: SymbolRejectCode; reason: string; candidates?: SymbolRef[] } };

/** A bounded, in-memory view of already parsed debug symbols. */
export class SymbolCatalog {
  private readonly candidates: SymbolCandidate[];

  constructor(
    readonly artifact: Pick<ArtifactGeneration, "generation">,
    candidates: readonly SymbolCandidate[],
  ) {
    this.candidates = [...candidates];
  }

  search(query: string, limit = MAX_SEARCH_RESULTS): SymbolRef[] {
    if (!query || query.length > 256) return [];
    const bounded = Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS);
    return this.candidates
      .filter((candidate) => candidate.qualifiedName.includes(query) || logicalName(candidate) === query)
      .slice(0, bounded)
      .map((candidate) => this.ref(candidate));
  }

  resolve(selector: string): SymbolResolveResult {
    if (!selectorPattern.test(selector) || /->|\*|&/.test(selector) || (selector.match(/\[\d+\]/g) ?? []).length > 1) {
      return reject("unsupported_symbol", "only fixed global/static scalars, nested members, and one fixed array element are supported");
    }
    const requested = parseSymbolSelector(selector);
    const matches = this.candidates.filter((candidate) => (requested.qualifiedName.includes("::")
      ? candidate.qualifiedName === requested.qualifiedName
      : candidate.qualifiedName === requested.qualifiedName || candidate.qualifiedName.split("::").at(-1) === requested.qualifiedName)
      && (candidate.memberPath ?? "") === (requested.memberPath ?? ""));
    if (matches.length === 0) return reject("symbol_not_found", `symbol not found: ${selector}`);
    if (matches.length > 1) return reject("symbol_ambiguous", `multiple symbols match: ${selector}`, matches.map((candidate) => this.ref(candidate)));
    return resolveCandidate(this.artifact.generation, matches[0]);
  }

  issue(candidate: SymbolCandidate): SymbolResolveResult {
    const index = this.candidates.findIndex((current) => current.qualifiedName === candidate.qualifiedName && (current.memberPath ?? "") === (candidate.memberPath ?? ""));
    if (index < 0) this.candidates.push(candidate);
    else this.candidates[index] = candidate;
    return this.resolve(symbolLogicalIdentity(candidate));
  }

  resolveRef(ref: SymbolRef): SymbolResolveResult {
    if (ref.artifactGeneration !== this.artifact.generation) return reject("unknown_layout", "symbol reference uses a stale Artifact generation");
    const resolved = this.resolve(symbolLogicalIdentity(ref));
    if (!resolved.ok) return resolved;
    return resolved.value.ref.layoutHash === ref.layoutHash ? resolved : reject("unknown_layout", "symbol reference layout hash is stale or forged");
  }

  private ref(candidate: SymbolCandidate): SymbolRef {
    return refFor(this.artifact.generation, candidate);
  }
}

/** MAP entries intentionally remain type-unknown until a trusted caller supplies their scalar type. */
export function catalogFromIarMap(artifact: Pick<ArtifactGeneration, "generation">, mapFile: string): SymbolCatalog {
  return new SymbolCatalog(artifact, [...parseIarMap(mapFile).values()].flat().map(mapCandidate));
}

export function catalogCandidateFromIarMap(symbol: IarMapSymbol): SymbolCandidate {
  return { qualifiedName: symbol.name, rootAddress: symbol.address, size: symbol.size, region: isRam(symbol.address) ? "ram" : "unknown", source: "iar-map", confidence: "map", kind: "global" };
}

export function symbolLogicalIdentity(ref: Pick<SymbolRef, "qualifiedName" | "memberPath">): string {
  return `${ref.qualifiedName}${ref.memberPath ? `${ref.memberPath.startsWith("[") ? "" : "."}${ref.memberPath}` : ""}`;
}

function mapCandidate(symbol: IarMapSymbol): SymbolCandidate {
  return catalogCandidateFromIarMap(symbol);
}

export function parseSymbolSelector(selector: string): Pick<SymbolCandidate, "qualifiedName" | "memberPath"> {
  const separator = selector.indexOf("::");
  const prefix = separator < 0 ? "" : selector.slice(0, separator + 2);
  const body = separator < 0 ? selector : selector.slice(separator + 2);
  const root = body.match(/^([A-Za-z_]\w*)/)?.[1];
  if (!root) return { qualifiedName: `${prefix}${body}` };
  const suffix = body.slice(root.length).replace(/^\./, "");
  return { qualifiedName: `${prefix}${root}`, ...(suffix ? { memberPath: suffix } : {}) };
}

function logicalName(candidate: SymbolCandidate): string {
  return symbolLogicalIdentity(candidate);
}

function resolveCandidate(artifactGeneration: string, candidate: SymbolCandidate): SymbolResolveResult {
  if (candidate.kind && !["global", "static", "fixed-member"].includes(candidate.kind)) {
    return reject("unsupported_symbol", `unsupported symbol kind: ${candidate.kind}`);
  }
  if (!Number.isSafeInteger(candidate.rootAddress) || candidate.rootAddress < 0 || candidate.rootAddress > 0xffff_ffff || !Number.isSafeInteger(candidate.memberOffset ?? 0)) {
    return reject("unknown_layout", "root address or member offset is unknown");
  }
  if (candidate.source !== "elf-dwarf" || candidate.confidence !== "dwarf" || !candidate.type || !candidate.size) {
    return reject("unknown_layout", "typed resolution requires ELF/DWARF type and size evidence");
  }
  const expectedSize = scalarSize(candidate.type);
  if (candidate.size !== expectedSize) return reject("unknown_layout", "DWARF type and size are incompatible");
  const memberOffset = candidate.memberOffset ?? 0;
  const address = candidate.rootAddress + memberOffset;
  if (!Number.isSafeInteger(address) || address < 0 || address + candidate.size > 0x1_0000_0000 || address % candidate.size !== 0) return reject("unknown_layout", "final symbol address is invalid or unaligned");
  const ref = refFor(artifactGeneration, candidate);
  const rootSize = candidate.rootSize ?? candidate.size;
  if (!Number.isSafeInteger(rootSize) || rootSize < candidate.size || memberOffset + candidate.size > rootSize) return reject("unknown_layout", "terminal selector lies outside the fixed root layout");
  const endian = candidate.endian ?? "little";
  return { ok: true, value: { ref, rootAddress: candidate.rootAddress, rootSize, memberOffset, address, type: candidate.type, size: candidate.size, region: candidate.region, hssEligible: candidate.region === "ram", source: candidate.source, confidence: candidate.confidence, endian } };
}

function refFor(artifactGeneration: string, candidate: SymbolCandidate): SymbolRef {
  const layout = {
    qualifiedName: candidate.qualifiedName,
    memberPath: candidate.memberPath,
    rootAddress: candidate.rootAddress,
    rootSize: candidate.rootSize ?? candidate.size,
    memberOffset: candidate.memberOffset ?? 0,
    type: candidate.type,
    size: candidate.size,
    region: candidate.region,
    source: candidate.source,
    endian: candidate.endian ?? "little",
  };
  return { artifactGeneration, qualifiedName: candidate.qualifiedName, ...(candidate.memberPath ? { memberPath: candidate.memberPath } : {}), layoutHash: createHash("sha256").update(stableStringify(layout)).digest("hex") };
}

function scalarSize(type: HssScalarType): number {
  return type === "uint8" || type === "int8" ? 1 : type === "uint16" || type === "int16" ? 2 : 4;
}

function isRam(address: number): boolean {
  return address >= 0x20000000 && address < 0x40000000;
}

function reject(code: SymbolRejectCode, reason: string, candidates?: SymbolRef[]): SymbolResolveResult {
  return { ok: false, error: { code, reason, ...(candidates?.length ? { candidates } : {}) } };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
