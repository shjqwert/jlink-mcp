import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { symbolLogicalIdentity, type ResolvedSymbol, type SymbolRef } from "./symbol-catalog";
import type { HssScalarType } from "../hss/hss-contract";

export interface HotVariableContext {
  projectRoot: string;
  artifactGeneration: string;
  mapSha256?: string;
  targetGeneration: string;
}

export interface HotVariable {
  logicalIdentity: string;
  requestedType: HssScalarType;
  layoutHash: string;
  artifactGeneration: string;
  mapSha256?: string;
  targetGeneration: string;
  validatedAt: string;
  lastError?: { code: string; reason: string; at: string };
}

export type ListedHotVariable = HotVariable & { stale: boolean };

export type HotVariableResult =
  | { ok: true; value: HotVariable }
  | { ok: false; error: { code: "hot_variable_not_found" | "hot_variable_stale"; reason: string } };

export type HotVariableRefreshResult =
  | { ok: true; value: HotVariable }
  | { ok: false; logicalIdentity: string; error: { code: string; reason: string } };

interface HotVariableDocument {
  formatVersion: 1;
  projects: Record<string, Record<string, HotVariable>>;
}

/** Persistent logical references. Resolved addresses are deliberately never serialized. */
export class HotVariables {
  private readonly projects = new Map<string, Map<string, HotVariable>>();

  constructor(private readonly filePath?: string) {
    if (filePath) this.load();
  }

  get size(): number {
    let count = 0;
    for (const variables of this.projects.values()) count += variables.size;
    return count;
  }

  add(resolved: ResolvedSymbol, context: HotVariableContext, requestedType = resolved.type, validatedAt = new Date().toISOString()): HotVariable {
    if (resolved.ref.artifactGeneration !== context.artifactGeneration) throw new Error("cannot cache a resolved symbol from a different artifact generation");
    if (requestedType !== resolved.type) throw new Error(`requested type ${requestedType} does not match resolved type ${resolved.type}`);
    const logicalIdentity = symbolLogicalIdentity(resolved.ref);
    const value: HotVariable = {
      logicalIdentity,
      requestedType,
      layoutHash: resolved.ref.layoutHash,
      artifactGeneration: context.artifactGeneration,
      ...(context.mapSha256 ? { mapSha256: context.mapSha256 } : {}),
      targetGeneration: context.targetGeneration,
      validatedAt,
    };
    return this.mutate(() => {
      this.project(context)!.set(logicalIdentity, value);
      return value;
    });
  }

  get(ref: Pick<SymbolRef, "qualifiedName" | "memberPath" | "layoutHash">, context: HotVariableContext): HotVariableResult {
    this.reloadForRead();
    const logicalIdentity = symbolLogicalIdentity(ref);
    const value = this.project(context, false)?.get(logicalIdentity);
    if (!value) return { ok: false, error: { code: "hot_variable_not_found", reason: `hot variable not found: ${logicalIdentity}` } };
    if (!sameContext(value, context, ref.layoutHash)) return { ok: false, error: { code: "hot_variable_stale", reason: `hot variable is stale: ${logicalIdentity}` } };
    return { ok: true, value };
  }

  list(context: HotVariableContext): ListedHotVariable[] {
    this.reloadForRead();
    return [...(this.project(context, false)?.values() ?? [])]
      .map((value) => ({ ...value, stale: !sameContext(value, context, value.layoutHash) }))
      .sort((left, right) => left.logicalIdentity.localeCompare(right.logicalIdentity));
  }

  /** Refreshes exactly the named identities; each failure remains explicit and stale. */
  async refresh(
    refs: readonly Pick<SymbolRef, "qualifiedName" | "memberPath">[],
    context: HotVariableContext,
    resolveSymbol: (ref: Pick<SymbolRef, "qualifiedName" | "memberPath">) => Promise<ResolvedSymbol>,
  ): Promise<HotVariableRefreshResult[]> {
    const results: HotVariableRefreshResult[] = [];
    this.reloadForRead();
    for (const ref of uniqueRefs(refs)) {
      const logicalIdentity = symbolLogicalIdentity(ref);
      const previous = this.project(context, false)?.get(logicalIdentity);
      if (!previous) {
        results.push({ ok: false, logicalIdentity, error: { code: "hot_variable_not_found", reason: `hot variable not found: ${logicalIdentity}` } });
        continue;
      }
      try {
        const resolved = await resolveSymbol(ref);
        results.push({ ok: true, value: this.add(resolved, context, previous.requestedType) });
      } catch (error) {
        const detail = normalizeRefreshError(error);
        if (previous) {
          this.mutate(() => {
            const current = this.project(context, false)?.get(logicalIdentity) ?? previous;
            this.project(context)!.set(logicalIdentity, {
              ...current,
              lastError: { ...detail, at: new Date().toISOString() },
            });
          });
        }
        results.push({ ok: false, logicalIdentity, error: detail });
      }
    }
    return results;
  }

  private project(context: Pick<HotVariableContext, "projectRoot">, create = true): Map<string, HotVariable> | undefined {
    const key = projectKey(context.projectRoot);
    let variables = this.projects.get(key);
    if (!variables && create) {
      variables = new Map();
      this.projects.set(key, variables);
    }
    return variables;
  }

  private load(): void {
    let document: HotVariableDocument;
    try {
      document = JSON.parse(readFileSync(this.filePath!, "utf8")) as HotVariableDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`HOT_VARIABLE_STORE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (document.formatVersion !== 1 || !document.projects || typeof document.projects !== "object") {
      throw new Error("HOT_VARIABLE_STORE_INVALID: unsupported hot-variable store structure");
    }
    for (const [project, values] of Object.entries(document.projects)) {
      this.projects.set(project, new Map(Object.entries(values)));
    }
  }

  private reloadForRead(): void {
    if (!this.filePath) return;
    this.projects.clear();
    this.load();
  }

  private mutate<T>(operation: () => T): T {
    if (!this.filePath) return operation();
    return this.withLock(() => {
      this.projects.clear();
      this.load();
      const result = operation();
      this.persist();
      return result;
    });
  }

  private persist(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const document: HotVariableDocument = {
      formatVersion: 1,
      projects: Object.fromEntries([...this.projects].map(([project, values]) => [project, Object.fromEntries(values)])),
    };
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, this.filePath);
  }

  private withLock<T>(operation: () => T): T {
    mkdirSync(dirname(this.filePath!), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(lockPath);
        writeFileSync(join(lockPath, "owner"), token, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
        } catch { /* another process changed the lock */ }
        if (Date.now() >= deadline) throw new Error("HOT_VARIABLE_STORE_BUSY: timed out waiting for the persistent store lock");
        blockingWait(10);
      }
    }
    try {
      return operation();
    } finally {
      try {
        if (readFileSync(join(lockPath, "owner"), "utf8") === token) rmSync(lockPath, { recursive: true, force: true });
      } catch { /* a stale-lock recovery already replaced it */ }
    }
  }
}

function sameContext(value: HotVariable, context: HotVariableContext, layoutHash?: string): boolean {
  return value.artifactGeneration === context.artifactGeneration
    && value.mapSha256 === context.mapSha256
    && value.targetGeneration === context.targetGeneration
    && (layoutHash === undefined || value.layoutHash === layoutHash)
    && !value.lastError;
}

function uniqueRefs(refs: readonly Pick<SymbolRef, "qualifiedName" | "memberPath">[]): Array<Pick<SymbolRef, "qualifiedName" | "memberPath">> {
  return [...new Map(refs.map((ref) => [symbolLogicalIdentity(ref), ref])).values()];
}

function projectKey(projectRoot: string): string {
  const key = resolve(projectRoot);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

function blockingWait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function normalizeRefreshError(error: unknown): { code: string; reason: string } {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; reason?: unknown };
    return {
      code: typeof value.code === "string" ? value.code : "symbol_refresh_failed",
      reason: typeof value.reason === "string" ? value.reason : typeof value.message === "string" ? value.message : String(error),
    };
  }
  return { code: "symbol_refresh_failed", reason: String(error) };
}
