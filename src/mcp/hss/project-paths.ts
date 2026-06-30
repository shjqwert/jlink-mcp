import { mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { HSS_ERROR, HssError } from "./hss-errors";

export interface HssProjectPaths {
  projectRoot: string;
  outputRoot: string;
  capturesDir: string;
  exportsDir: string;
  auditDir: string;
  sessionsDir: string;
}

export function hssProjectRoot(cwd = process.cwd()): string {
  return resolve(cwd);
}

export function hssProjectPaths(cwd = process.cwd()): HssProjectPaths {
  const projectRoot = hssProjectRoot(cwd);
  const outputRoot = join(projectRoot, ".jlink-mcp");
  return {
    projectRoot,
    outputRoot,
    capturesDir: join(outputRoot, "captures"),
    exportsDir: join(outputRoot, "exports"),
    auditDir: join(outputRoot, "audit"),
    sessionsDir: join(outputRoot, "sessions"),
  };
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
