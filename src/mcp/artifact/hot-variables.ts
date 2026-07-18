import { symbolLogicalIdentity, type ResolvedSymbol, type SymbolRef } from "./symbol-catalog";

export interface HotVariableContext {
  artifactGeneration: string;
  mapSha256?: string;
  targetGeneration: string;
}

export interface HotVariable {
  logicalIdentity: string;
  layoutHash: string;
  resolved: ResolvedSymbol;
  artifactGeneration: string;
  mapSha256?: string;
  targetGeneration: string;
  validatedAt: string;
}

export type HotVariableResult =
  | { ok: true; value: HotVariable }
  | { ok: false; error: { code: "hot_variable_not_found" | "hot_variable_stale"; reason: string } };

/** Process-local only: a new server constructs a new, empty store. */
export class HotVariables {
  private readonly variables = new Map<string, HotVariable>();

  get size(): number {
    return this.variables.size;
  }

  add(resolved: ResolvedSymbol, context: HotVariableContext, validatedAt = new Date().toISOString()): HotVariable {
    if (resolved.ref.artifactGeneration !== context.artifactGeneration) throw new Error("cannot cache a resolved symbol from a different artifact generation");
    const logicalIdentity = symbolLogicalIdentity(resolved.ref);
    const value: HotVariable = { logicalIdentity, layoutHash: resolved.ref.layoutHash, resolved, artifactGeneration: context.artifactGeneration, ...(context.mapSha256 ? { mapSha256: context.mapSha256 } : {}), targetGeneration: context.targetGeneration, validatedAt };
    this.variables.set(logicalIdentity, value);
    return value;
  }

  get(ref: Pick<SymbolRef, "qualifiedName" | "memberPath" | "layoutHash">, context: HotVariableContext): HotVariableResult {
    const logicalIdentity = symbolLogicalIdentity(ref);
    const value = this.variables.get(logicalIdentity);
    if (!value) return { ok: false, error: { code: "hot_variable_not_found", reason: `hot variable not found: ${logicalIdentity}` } };
    if (!sameContext(value, context, ref.layoutHash)) return { ok: false, error: { code: "hot_variable_stale", reason: `hot variable is stale: ${logicalIdentity}` } };
    return { ok: true, value };
  }

  list(context: HotVariableContext): Array<HotVariable & { stale: boolean }> {
    return [...this.variables.values()].map((value) => ({
      ...value,
      stale: !sameContext(value, context, value.layoutHash),
    }));
  }

  /** Refreshes exactly the referenced identities; it never scans artifacts or starts a build. */
  async refresh(refs: readonly Pick<SymbolRef, "qualifiedName" | "memberPath">[], context: HotVariableContext, resolve: (ref: Pick<SymbolRef, "qualifiedName" | "memberPath">) => Promise<ResolvedSymbol>): Promise<HotVariable[]> {
    const refreshed: HotVariable[] = [];
    for (const ref of uniqueRefs(refs)) refreshed.push(this.add(await resolve(ref), context));
    return refreshed;
  }
}

function sameContext(value: HotVariable, context: HotVariableContext, layoutHash?: string): boolean {
  return value.artifactGeneration === context.artifactGeneration
    && value.mapSha256 === context.mapSha256
    && value.targetGeneration === context.targetGeneration
    && value.resolved.ref.artifactGeneration === context.artifactGeneration
    && (layoutHash === undefined || value.layoutHash === layoutHash);
}

function uniqueRefs(refs: readonly Pick<SymbolRef, "qualifiedName" | "memberPath">[]): Array<Pick<SymbolRef, "qualifiedName" | "memberPath">> {
  return [...new Map(refs.map((ref) => [symbolLogicalIdentity(ref), ref])).values()];
}
