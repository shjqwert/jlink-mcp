import { createHash } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { HSS_ERROR, HssError } from "./hss-errors";

export interface HssProjectPaths {
  projectRoot: string;
  storageRoot: string;
  evidenceRoot: string;
  outputRoot: string;
  capturesDir: string;
  exportsDir: string;
  auditDir: string;
  sessionsDir: string;
}

export interface HssExternalRoots {
  storageRoot: string;
  evidenceRoot: string;
}

const configuredPaths = new Map<string, HssProjectPaths>();

export function hssProjectRoot(cwd = process.cwd()): string {
  const root = resolve(cwd);
  return existsSync(root) ? realpathSync.native(root) : root;
}

export function hssProjectPaths(cwd = process.cwd()): HssProjectPaths {
  const projectRoot = hssProjectRoot(cwd);
  const configured = configuredPaths.get(projectRoot.toLowerCase());
  if (configured) return configured;
  const roots = defaultExternalRoots(projectRoot);
  const outputRoot = join(projectRoot, ".jlink-mcp");
  return {
    projectRoot,
    storageRoot: roots.storageRoot,
    evidenceRoot: roots.evidenceRoot,
    outputRoot,
    capturesDir: join(roots.storageRoot, "captures"),
    exportsDir: join(roots.storageRoot, "exports"),
    auditDir: join(roots.evidenceRoot, "audit"),
    sessionsDir: join(roots.evidenceRoot, "sessions"),
  };
}

function defaultExternalRoots(projectRoot: string): HssExternalRoots {
  const localRoot = process.env.LOCALAPPDATA
    ?? process.env.XDG_STATE_HOME
    ?? join(homedir(), ".local", "state");
  const namespace = createHash("sha256").update(projectRoot.toLowerCase()).digest("hex");
  const base = join(localRoot, "jlink-mcp", namespace);
  return {
    storageRoot: externalRoot(join(base, "storage"), projectRoot, "storageRoot"),
    evidenceRoot: externalRoot(join(base, "evidence"), projectRoot, "evidenceRoot"),
  };
}

export function configureHssProjectPaths(cwd: string, roots: HssExternalRoots): HssProjectPaths {
  const projectRoot = hssProjectRoot(cwd);
  const storageRoot = externalRoot(roots.storageRoot, projectRoot, "storageRoot");
  const evidenceRoot = externalRoot(roots.evidenceRoot, projectRoot, "evidenceRoot");
  const paths: HssProjectPaths = {
    projectRoot,
    storageRoot,
    evidenceRoot,
    outputRoot: join(projectRoot, ".jlink-mcp"),
    capturesDir: join(storageRoot, "captures"),
    exportsDir: join(storageRoot, "exports"),
    auditDir: join(evidenceRoot, "audit"),
    sessionsDir: join(evidenceRoot, "sessions"),
  };
  configuredPaths.set(projectRoot.toLowerCase(), paths);
  return paths;
}

export async function ensureHssProjectDirs(cwd = process.cwd()): Promise<HssProjectPaths> {
  const paths = hssProjectPaths(cwd);
  await Promise.all([paths.capturesDir, paths.exportsDir, paths.auditDir, paths.sessionsDir].map((dir) => mkdir(dir, { recursive: true })));
  return paths;
}

export function resolveInsideProject(input: string | undefined, cwd = process.cwd(), fallback?: string): string {
  const root = hssProjectRoot(cwd);
  const target = resolve(root, input ?? fallback ?? ".");
  assertInsideProject(target, root);
  return target;
}

export function assertInsideProject(target: string, cwd = process.cwd()): void {
  const root = hssProjectRoot(cwd);
  const normalizedRoot = root.toLowerCase();
  const normalizedTarget = resolve(target).toLowerCase();
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + sep.toLowerCase())) {
    throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, "path escapes process.cwd()", { cwd: root, path: target });
  }
}

export async function existingInsideProject(input: string, cwd = process.cwd()): Promise<string> {
  const resolved = resolveInsideProject(input, cwd);
  const real = await realpath(resolved);
  assertInsideProject(real, cwd);
  return real;
}

export async function ensureParentInsideProject(file: string, cwd = process.cwd()): Promise<string> {
  const resolved = isAbsolute(file) ? resolve(file) : resolveInsideProject(file, cwd);
  assertInsideProject(resolved, cwd);
  await mkdir(dirname(resolved), { recursive: true });
  return resolved;
}

export function insideProjectIfExists(input: string | undefined, cwd = process.cwd()): string | undefined {
  if (!input) return undefined;
  const resolved = resolveInsideProject(input, cwd);
  return existsSync(resolved) ? resolved : undefined;
}

function externalRoot(input: string, projectRoot: string, name: string): string {
  if (!isAbsolute(input)) throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, `${name} must be absolute`, { [name]: input });
  if (/^\\\\\?\\|~\d(?:\\|$)/i.test(input)) throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, `${name} uses an unsupported path alias`, { [name]: input });
  let existing = resolve(input);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    existing = parent;
  }
  const root = resolve(realpathSync.native(existing), ...suffix);
  const normalizedProject = projectRoot.toLowerCase();
  const normalizedRoot = root.toLowerCase();
  if (normalizedRoot === normalizedProject || normalizedRoot.startsWith(normalizedProject + sep.toLowerCase())) {
    throw new HssError(HSS_ERROR.PATH_OUTSIDE_CWD, `${name} must be outside projectRoot`, { projectRoot, [name]: root });
  }
  return root;
}
