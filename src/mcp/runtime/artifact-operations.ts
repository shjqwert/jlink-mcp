import { join } from "node:path";
import { discoverArtifacts, ArtifactCatalogError } from "../artifact/artifact-catalog";
import { HotVariables, type HotVariableContext } from "../artifact/hot-variables";
import {
  parseSymbolSelector,
  SymbolCatalog,
  symbolLogicalIdentity,
  type ResolvedSymbol,
  type SymbolCandidate,
  type SymbolRef,
} from "../artifact/symbol-catalog";
import { parseIarMap } from "../hss/iar-map-parser";
import { decodeHssValue, encodeHssValue } from "../hss/hss-typed-value";
import type { HssScalarType } from "../hss/hss-contract";
import { resolveElfSymbols, searchElfVariableNames, validateSelector, type ElfResolvedSymbol } from "../../gdb/elf-resolver";
import {
  createOperationEnvelope,
  failEnvelope,
  finishEnvelope,
  type OperationEnvelope,
} from "./operation-envelope";
import {
  assertArtifactBindingsCurrent,
  TargetStore,
  TargetStoreError,
  type StoredTarget,
} from "./target-store";
import {
  DirectMcuService,
  type NonObserveComparator,
  type ScalarComparator,
} from "./direct-operations";

export interface VariableRefInput {
  artifactGeneration: string;
  qualifiedName: string;
  memberPath?: string;
  layoutHash: string;
}

export type VariableNonObserveComparatorInput =
  | { mode: "exact" }
  | { mode: "tolerance"; absTolerance: number; relTolerance: number }
  | { mode: "masked"; maskHex: string };

export type VariableComparatorInput = VariableNonObserveComparatorInput
  | { mode: "observe"; durationMs: number; maxPolls: number; intervalMs: number; comparator: VariableNonObserveComparatorInput };

export interface VariableWriteInput {
  projectRoot: string;
  ref: VariableRefInput;
  value: number;
  captureOld?: boolean;
  verify?: boolean;
  restore?: boolean;
  comparator?: VariableComparatorInput;
}

export interface TypedSymbolResolver {
  resolve(target: StoredTarget, selector: string): Promise<ResolvedSymbol>;
  search(target: StoredTarget, query: string, limit: number): Promise<Array<Record<string, unknown>>>;
}

export class ArtifactVariableService {
  private readonly hot: HotVariables;

  constructor(
    private readonly targets: TargetStore,
    private readonly direct: DirectMcuService,
    storageRoot: string,
    private readonly symbols: TypedSymbolResolver = new GdbTypedSymbolResolver(),
  ) {
    this.hot = new HotVariables(join(storageRoot, "hot-variables.json"));
  }

  async artifactProbe(input: {
    projectRoot: string;
    explicitArtifact?: string;
    explicitMap?: string;
    maxFiles?: number;
    maxDepth?: number;
    maxCandidates?: number;
  }): Promise<OperationEnvelope> {
    return this.offline("artifact_probe", input.projectRoot, async (envelope, target) => {
      const result = await discoverArtifacts({
        projectRoot: target.projectRoot,
        explicitArtifact: input.explicitArtifact,
        explicitMap: input.explicitMap,
        maxFiles: input.maxFiles,
        maxDepth: input.maxDepth,
        maxCandidates: input.maxCandidates,
      });
      envelope.data = {
        ...result,
        selectionRequired: !result.explicit && result.candidates.length > 1,
      };
      if (!result.explicit && result.candidates.length !== 1) {
        throw new ArtifactCatalogError(
          result.candidates.length === 0 ? "ARTIFACT_NOT_FOUND" : "ARTIFACT_SELECTION_REQUIRED",
          result.candidates.length === 0 ? "no supported Artifact candidate was found" : "multiple Artifact candidates require explicitArtifact",
          { candidates: result.candidates },
        );
      }
      envelope.verification = { status: "observed", method: "bounded_content_probe" };
    });
  }

  async symbolSearch(projectRoot: string, query: string, limit: number): Promise<OperationEnvelope> {
    return this.offline("symbol_search", projectRoot, async (envelope, target) => {
      this.requireCurrentArtifact(target);
      envelope.data = { query, limit, candidates: await this.symbols.search(target, query, limit) };
      envelope.verification = { status: "observed", method: "configured_artifact_search" };
    });
  }

  async symbolResolve(projectRoot: string, selector: string): Promise<OperationEnvelope> {
    return this.offline("symbol_resolve", projectRoot, async (envelope, target) => {
      const resolved = await this.resolveCurrent(target, selector);
      envelope.data = resolved;
      envelope.verification = { status: "verified", method: "elf_dwarf_layout" };
    });
  }

  async hotAdd(projectRoot: string, ref: VariableRefInput, requestedType?: HssScalarType): Promise<OperationEnvelope> {
    return this.offline("hot_variable_add", projectRoot, async (envelope, target) => {
      const resolved = await this.resolveReference(target, ref);
      envelope.data = this.hot.add(resolved, hotContext(target), requestedType ?? resolved.type);
      envelope.verification = { status: "verified", method: "logical_reference_persisted" };
    });
  }

  async hotList(projectRoot: string): Promise<OperationEnvelope> {
    return this.offline("hot_variable_list", projectRoot, async (envelope, target) => {
      this.requireCurrentArtifact(target);
      envelope.data = { variables: this.hot.list(hotContext(target)) };
      envelope.verification = { status: "observed", method: "persistent_logical_catalog" };
    });
  }

  async hotRefresh(projectRoot: string, selectors: string[]): Promise<OperationEnvelope> {
    return this.offline("hot_variable_refresh", projectRoot, async (envelope, target) => {
      this.requireCurrentArtifact(target);
      const refs = selectors.map((selector) => parseSymbolSelector(selector));
      envelope.data = {
        results: await this.hot.refresh(refs, hotContext(target), async (ref) => this.resolveCurrent(target, symbolLogicalIdentity(ref))),
      };
      envelope.verification = { status: "observed", method: "targeted_refresh" };
    });
  }

  async readVariable(projectRoot: string, ref: VariableRefInput): Promise<OperationEnvelope> {
    let target: StoredTarget;
    let resolved: ResolvedSymbol;
    try {
      target = this.targets.require(projectRoot);
      resolved = await this.resolveReference(target, ref);
      if (target.liveArtifactMatch.status === "mismatch") throw new TypedAccessError("ARTIFACT_MISMATCH", "Artifact match is mismatch; symbol read was not issued");
    } catch (error) {
      return this.failure(createOperationEnvelope("read_variable"), error, "symbol_resolution");
    }
    const envelope = await this.direct.readMemory({
      projectRoot: target.projectRoot,
      address: resolved.address,
      width: resolved.size * 8 as 8 | 16 | 32,
      byteCount: resolved.size,
      operationTool: "read_variable",
      expectedTargetGeneration: target.generation,
      expectedArtifactGeneration: target.artifact!.generation,
      allowedArtifactMatch: ["verified", "unverified"],
    });
    if (envelope.artifact?.match === "unverified") envelope.warnings.push("ARTIFACT_UNVERIFIED: symbol address is layout-valid but not confirmed against the live target.");
    if (envelope.ok) {
      const raw = envelope.data as { dataHex?: string };
      if (!raw.dataHex) return failEnvelope(envelope, operationError("READ_LENGTH_MISMATCH", "decode", "typed variable read returned no bytes"));
      const bytes = Buffer.from(raw.dataHex, "hex");
      envelope.data = { ...raw, resolved, typedValue: decodeHssValue(resolved.type, bytes, resolved.endian) };
    }
    return envelope;
  }

  async writeVariable(input: VariableWriteInput): Promise<OperationEnvelope> {
    let target: StoredTarget;
    let resolved: ResolvedSymbol;
    let requested: Buffer;
    let comparator: ScalarComparator;
    try {
      target = this.targets.require(input.projectRoot);
      if (target.liveArtifactMatch.status !== "verified") throw new TypedAccessError(target.liveArtifactMatch.status === "mismatch" ? "ARTIFACT_MISMATCH" : "ARTIFACT_NOT_VERIFIED", "write_variable requires a verified live Artifact match");
      resolved = await this.resolveReference(target, input.ref);
      if (resolved.region !== "ram") throw new TypedAccessError("VARIABLE_NOT_WRITABLE", "typed variable writes require a DWARF RAM symbol");
      requested = encodeHssValue(resolved.type, input.value, resolved.endian);
      comparator = variableComparator(input.comparator ?? { mode: "exact" }, resolved, input.value);
    } catch (error) {
      return this.failure(createOperationEnvelope("write_variable"), error, "symbol_resolution");
    }
    const envelope = await this.direct.structuredWrite({
      projectRoot: target.projectRoot,
      address: resolved.address,
      width: resolved.size * 8 as 8 | 16 | 32,
      byteCount: resolved.size,
      dataHex: requested.toString("hex"),
      captureOld: input.captureOld ?? false,
      verify: input.verify ?? false,
      restore: input.restore ?? false,
      comparator,
      knownRegion: "ram",
      operationTool: "write_variable",
      expectedTargetGeneration: target.generation,
      expectedArtifactGeneration: target.artifact!.generation,
      allowedArtifactMatch: ["verified"],
      semanticData: { resolved, requestedValue: input.value },
    });
    decorateTypedWrite(envelope, resolved);
    return envelope;
  }

  private requireCurrentArtifact(target: StoredTarget): void {
    assertArtifactBindingsCurrent(target);
  }

  private async resolveCurrent(target: StoredTarget, selector: string): Promise<ResolvedSymbol> {
    this.requireCurrentArtifact(target);
    return this.symbols.resolve(target, selector);
  }

  private async resolveReference(target: StoredTarget, ref: VariableRefInput): Promise<ResolvedSymbol> {
    this.requireCurrentArtifact(target);
    if (target.artifact!.generation !== ref.artifactGeneration) throw new TypedAccessError("STALE_ARTIFACT_REFERENCE", "variable reference belongs to a stale Artifact generation");
    const resolved = await this.symbols.resolve(target, symbolLogicalIdentity(ref));
    if (resolved.ref.layoutHash !== ref.layoutHash) throw new TypedAccessError("STALE_ARTIFACT_REFERENCE", "variable layout hash changed; resolve the selector again");
    return resolved;
  }

  private async offline(
    tool: string,
    projectRoot: string,
    operation: (envelope: OperationEnvelope, target: StoredTarget) => Promise<void>,
  ): Promise<OperationEnvelope> {
    let target: StoredTarget;
    try { target = this.targets.require(projectRoot); }
    catch (error) { return this.failure(createOperationEnvelope(tool), error, "target_lookup"); }
    const envelope = createOperationEnvelope(tool, target);
    try {
      await operation(envelope, target);
      return finishEnvelope(envelope, true);
    } catch (error) {
      return this.failure(envelope, error, "offline_resolution");
    }
  }

  private failure(envelope: OperationEnvelope, error: unknown, stage: string): OperationEnvelope {
    if (error instanceof TypedAccessError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    if (error instanceof TargetStoreError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    if (error instanceof ArtifactCatalogError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    return failEnvelope(envelope, operationError("SYMBOL_OPERATION_FAILED", stage, error instanceof Error ? error.message : String(error)));
  }
}

class GdbTypedSymbolResolver implements TypedSymbolResolver {
  async resolve(target: StoredTarget, selector: string): Promise<ResolvedSymbol> {
    if (!target.artifact) throw new TypedAccessError("ARTIFACT_NOT_CONFIGURED", "an ELF Artifact is required");
    try { validateSelector(selector); }
    catch (error) { throw new TypedAccessError("UNSUPPORTED_SYMBOL", error instanceof Error ? error.message : "unsupported selector"); }
    const root = parseSymbolSelector(selector).qualifiedName.split("::").at(-1)!;
    const mapHasRoot = Boolean(target.map && (parseIarMap(target.map.path).get(root)?.length ?? 0) > 0);
    if (!target.gdbPath) {
      if (mapHasRoot) throw new TypedAccessError("UNKNOWN_LAYOUT", `${selector} has MAP address evidence but no trustworthy DWARF layout`);
      throw new TypedAccessError("GDB_NOT_CONFIGURED", "typed DWARF resolution requires an explicit gdbPath in target_configure");
    }
    let resolution: Awaited<ReturnType<typeof resolveElfSymbols>>;
    try {
      resolution = await resolveElfSymbols(target.gdbPath.path, target.artifact.path, [{ name: selector }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = classifyDwarfResolutionError(message, mapHasRoot);
      throw new TypedAccessError(code, code === "UNKNOWN_LAYOUT" ? `${selector} has MAP address evidence but no trustworthy DWARF layout` : message);
    }
    if (resolution.elfSha256 !== target.artifact.sha256) throw new TypedAccessError("ARTIFACT_GENERATION_STALE", "Artifact content changed during DWARF resolution; call target_configure again");
    const [symbol] = resolution.symbols;
    if (!symbol) throw new TypedAccessError("SYMBOL_NOT_FOUND", `symbol not found: ${selector}`);
    assertMapAgreement(target, selector, symbol);
    const parts = parseSymbolSelector(selector);
    const candidate: SymbolCandidate = {
      ...parts,
      rootAddress: symbol.rootAddress,
      rootSize: symbol.rootSize,
      memberOffset: symbol.memberOffset,
      type: symbol.type,
      size: symbol.size,
      region: symbol.region,
      source: "elf-dwarf",
      confidence: "dwarf",
      kind: parts.memberPath ? "fixed-member" : "global",
      endian: "little",
    };
    const issued = new SymbolCatalog({ generation: target.artifact.generation }, [candidate]).resolve(selector);
    if (!issued.ok) throw new TypedAccessError(symbolErrorCode(issued.error.code), issued.error.reason);
    return issued.value;
  }

  async search(target: StoredTarget, query: string, limit: number): Promise<Array<Record<string, unknown>>> {
    if (!query.trim() || query.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TypedAccessError("SYMBOL_QUERY_INVALID", "query and limit are outside their bounds");
    const candidates: Array<Record<string, unknown>> = [];
    if (target.gdbPath && target.artifact) {
      for (const selector of await searchElfVariableNames(target.gdbPath.path, target.artifact.path, query, limit)) {
        candidates.push({ selector, source: "elf-dwarf", layout: "requires_resolution" });
      }
    }
    if (target.map && candidates.length < limit) {
      for (const [name, entries] of parseIarMap(target.map.path)) {
        if (!name.includes(query)) continue;
        candidates.push({ selector: name, source: "iar-map", layout: "unknown", occurrences: entries.length });
        if (candidates.length >= limit) break;
      }
    }
    return candidates;
  }
}

class TypedAccessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "TypedAccessError";
  }
}

export function assertMapAgreement(target: StoredTarget, selector: string, symbol: ElfResolvedSymbol): void {
  if (!target.map) return;
  const parsed = parseSymbolSelector(selector);
  const root = parsed.qualifiedName.split("::").at(-1)!;
  const logical = `${root}${parsed.memberPath ? `${parsed.memberPath.startsWith("[") ? "" : "."}${parsed.memberPath}` : ""}`;
  const map = parseIarMap(target.map.path);
  const rootEntries = map.get(root) ?? [];
  const exactEntries = map.get(logical) ?? [];
  if (rootEntries.some((entry) => entry.address !== symbol.rootAddress || entry.size !== symbol.rootSize)
    || exactEntries.some((entry) => entry.address !== symbol.address || entry.size !== symbol.size)) {
    throw new TypedAccessError("SYMBOL_ADDRESS_CONFLICT", `DWARF and MAP evidence conflict for ${logical}`);
  }
}

function hotContext(target: StoredTarget): HotVariableContext {
  return {
    projectRoot: target.projectRoot,
    targetGeneration: target.generation,
    artifactGeneration: target.artifact!.generation,
    ...(target.map ? { mapSha256: target.map.sha256 } : {}),
  };
}

function variableComparator(input: VariableComparatorInput, resolved: ResolvedSymbol, requestedValue: number): ScalarComparator {
  const typed = { type: resolved.type, endian: resolved.endian };
  if (input.mode === "exact") return { mode: "exact", ...typed };
  if (input.mode === "tolerance") return { mode: "tolerance", expected: requestedValue, absTolerance: input.absTolerance, relTolerance: input.relTolerance, ...typed };
  if (input.mode === "masked") return { mode: "masked", maskHex: input.maskHex, ...typed };
  return {
    mode: "observe",
    durationMs: input.durationMs,
    maxPolls: input.maxPolls,
    intervalMs: input.intervalMs,
    comparator: variableComparator(input.comparator, resolved, requestedValue) as NonObserveComparator,
  };
}

function decorateTypedWrite(envelope: OperationEnvelope, resolved: ResolvedSymbol): void {
  if (!envelope.data || typeof envelope.data !== "object") return;
  const data = envelope.data as Record<string, unknown>;
  for (const [hexKey, valueKey] of [["oldHex", "old"], ["readbackHex", "readback"]] as const) {
    const value = data[hexKey];
    if (typeof value === "string") data[valueKey] = decodeHssValue(resolved.type, Buffer.from(value, "hex"), resolved.endian);
  }
  const restore = data.restore;
  if (restore && typeof restore === "object") {
    const record = restore as Record<string, unknown>;
    if (typeof record.readbackHex === "string") record.readback = decodeHssValue(resolved.type, Buffer.from(record.readbackHex, "hex"), resolved.endian);
  }
}

function symbolErrorCode(code: string): string {
  const codes: Record<string, string> = {
    symbol_not_found: "SYMBOL_NOT_FOUND",
    symbol_ambiguous: "SYMBOL_AMBIGUOUS",
    unsupported_symbol: "UNSUPPORTED_SYMBOL",
    unknown_layout: "UNKNOWN_LAYOUT",
    hss_ineligible: "HSS_INELIGIBLE",
  };
  return codes[code] ?? "SYMBOL_RESOLUTION_FAILED";
}

export function classifyDwarfResolutionError(message: string, mapHasRoot: boolean): string {
  if (/ambiguous static/i.test(message)) return "SYMBOL_AMBIGUOUS";
  if (/out of bounds|pointer indexing|bitfields|union layouts|unsupported final scalar|not naturally aligned|outside its fixed root layout|forbidden peripheral|not in an ELF allocated/i.test(message)) return "UNSUPPORTED_SYMBOL";
  if (/There is no member/i.test(message)) return "SYMBOL_NOT_FOUND";
  if (/No symbol|not defined|could not resolve address, size, and type/i.test(message)) return mapHasRoot ? "UNKNOWN_LAYOUT" : "SYMBOL_NOT_FOUND";
  return "DWARF_RESOLUTION_FAILED";
}

function operationError(code: string, stage: string, message: string) {
  return { code, stage, message, retryable: false, writeIssued: false, stateUnknown: false };
}
