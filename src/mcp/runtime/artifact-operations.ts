import { discoverArtifacts, ArtifactCatalogError } from "../artifact/artifact-catalog";
import {
  parseSymbolSelector,
  SymbolCatalog,
  symbolLogicalIdentity,
  type ResolvedSymbol,
  type SymbolCandidate,
  type SymbolRef,
} from "../artifact/symbol-catalog";
import { parseIarMap } from "../hss/iar-map-parser";
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
  VariableResolutionError,
  type VariableRefInput,
  type VariableResolver,
} from "./variable-access-contract";

export interface TypedSymbolResolver {
  resolve(target: StoredTarget, selector: string): Promise<ResolvedSymbol>;
  search(target: StoredTarget, query: string, limit: number): Promise<Array<Record<string, unknown>>>;
}

interface ResolvedReference {
  resolved: ResolvedSymbol;
  cacheRefreshed: boolean;
}

export class ArtifactVariableService implements VariableResolver {
  constructor(
    private readonly targets: TargetStore,
    private readonly symbols: TypedSymbolResolver = new GdbTypedSymbolResolver(),
  ) {}

  async resolveVariable(projectRoot: string, ref: VariableRefInput): Promise<{ target: StoredTarget; resolved: ResolvedSymbol; cacheRefreshed: boolean }> {
    const target = this.targets.require(projectRoot);
    const reference = await this.resolveReference(target, ref);
    return { target, resolved: reference.resolved, cacheRefreshed: reference.cacheRefreshed };
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
        configuredArtifact: target.artifact?.path,
        configuredArtifactSha256: target.artifact?.sha256,
        configuredMap: target.map?.path,
        maxFiles: input.maxFiles,
        maxDepth: input.maxDepth,
        maxCandidates: input.maxCandidates,
      });
      envelope.data = {
        ...result,
        selectionRequired: !result.explicit && (result.scanTruncated || result.candidates.length > 1),
      };
      if (!result.explicit && (result.scanTruncated || result.candidates.length !== 1)) {
        throw new ArtifactCatalogError(
          result.candidates.length === 0 && !result.scanTruncated ? "ARTIFACT_NOT_FOUND" : "ARTIFACT_SELECTION_REQUIRED",
          result.candidates.length === 0 && !result.scanTruncated
            ? "no supported Artifact candidate was found"
            : result.scanTruncated
              ? "artifact discovery reached a configured bound; select an explicitArtifact before proceeding"
              : "multiple Artifact candidates require explicitArtifact",
          { candidates: result.candidates, scanTruncated: result.scanTruncated, reachedBound: result.reachedBound },
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
      const resolved = await this.resolveReference(target, selector);
      envelope.data = { ...resolved.resolved, cacheRefreshed: resolved.cacheRefreshed };
      envelope.verification = { status: "verified", method: "elf_dwarf_layout" };
    });
  }

  private requireCurrentArtifact(target: StoredTarget): void {
    assertArtifactBindingsCurrent(target);
  }

  private async resolveReference(target: StoredTarget, ref: VariableRefInput): Promise<ResolvedReference> {
    this.requireCurrentArtifact(target);
    if (typeof ref !== "string" && target.artifact!.generation !== ref.artifactGeneration) throw new VariableResolutionError("STALE_ARTIFACT_REFERENCE", "legacy variable reference belongs to a stale Artifact generation");
    const resolved = await this.symbols.resolve(target, typeof ref === "string" ? ref : symbolLogicalIdentity(ref));
    if (typeof ref !== "string" && resolved.ref.layoutHash !== ref.layoutHash) throw new VariableResolutionError("STALE_ARTIFACT_REFERENCE", "legacy variable layout hash changed; resolve the selector again");
    return { resolved, cacheRefreshed: false };
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
    if (error instanceof VariableResolutionError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    if (error instanceof TargetStoreError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    if (error instanceof ArtifactCatalogError) return failEnvelope(envelope, operationError(error.code, stage, error.message));
    return failEnvelope(envelope, operationError("SYMBOL_OPERATION_FAILED", stage, error instanceof Error ? error.message : String(error)));
  }
}

class GdbTypedSymbolResolver implements TypedSymbolResolver {
  async resolve(target: StoredTarget, selector: string): Promise<ResolvedSymbol> {
    if (!target.artifact) throw new VariableResolutionError("ARTIFACT_NOT_CONFIGURED", "an ELF Artifact is required");
    try { validateSelector(selector); }
    catch (error) { throw new VariableResolutionError("UNSUPPORTED_SYMBOL", error instanceof Error ? error.message : "unsupported selector"); }
    const root = parseSymbolSelector(selector).qualifiedName.split("::").at(-1)!;
    const mapHasRoot = Boolean(target.map && (parseIarMap(target.map.path).get(root)?.length ?? 0) > 0);
    if (!target.gdbPath) {
      if (mapHasRoot) throw new VariableResolutionError("UNKNOWN_LAYOUT", `${selector} has MAP address evidence but no trustworthy DWARF layout`);
      throw new VariableResolutionError("GDB_NOT_CONFIGURED", "typed DWARF resolution requires an explicit gdbPath in target_configure");
    }
    let resolution: Awaited<ReturnType<typeof resolveElfSymbols>>;
    try {
      resolution = await resolveElfSymbols(target.gdbPath.path, target.artifact.path, [{ name: selector }]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = classifyDwarfResolutionError(message, mapHasRoot);
      throw new VariableResolutionError(code, code === "UNKNOWN_LAYOUT" ? `${selector} has MAP address evidence but no trustworthy DWARF layout` : message);
    }
    if (resolution.elfSha256 !== target.artifact.sha256) throw new VariableResolutionError("ARTIFACT_GENERATION_STALE", "Artifact content changed during DWARF resolution; call target_configure again");
    const [symbol] = resolution.symbols;
    if (!symbol) throw new VariableResolutionError("SYMBOL_NOT_FOUND", `symbol not found: ${selector}`);
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
    if (!issued.ok) throw new VariableResolutionError(symbolErrorCode(issued.error.code), issued.error.reason);
    return issued.value;
  }

  async search(target: StoredTarget, query: string, limit: number): Promise<Array<Record<string, unknown>>> {
    if (!query.trim() || query.length > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new VariableResolutionError("SYMBOL_QUERY_INVALID", "query and limit are outside their bounds");
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
    throw new VariableResolutionError("SYMBOL_ADDRESS_CONFLICT", `DWARF and MAP evidence conflict for ${logical}`);
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
