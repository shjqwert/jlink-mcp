import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HSS_TRUST_SUITE_VERSION = "hss-runtime-v1";

export type HssScriptSpec = { mode: "none" } | { mode: "file"; path: string };

export interface CachedHssScript {
  mode: "none" | "file";
  sourcePath?: string;
  path?: string;
  sha256?: string;
}

export interface HssTrustProfile {
  version: 1;
  suiteVersion: string;
  validatedAt: string;
  runtime: {
    dllPath: string;
    dllSha256: string;
    dllVersion: string;
    helperPath: string;
    helperSha256: string;
    helperVersion: string;
    helperProtocolVersion: number;
    adapterPath: string;
    adapterSha256: string;
    adapterVersion: string;
    sha256: string;
  };
  script: CachedHssScript;
  project: { root: string; namespaceSha256: string };
  target: { targetId: string };
  probe: { serial?: string; interface: "SWD" | "JTAG"; speedKhz: number };
  validation: { getCaps: true; lifecycle: true; decoderSemantics: true };
  profileSha256: string;
}

export interface HssTrustContext {
  targetId?: string;
  serial?: string;
  interface?: "SWD" | "JTAG";
  speedKhz?: number;
}

export function cacheHssScript(spec: HssScriptSpec, projectRoot = process.cwd(), trustStoreRoot?: string): CachedHssScript {
  if (spec.mode === "none") return { mode: "none" };
  if (!path.isAbsolute(spec.path) || /[\0\r\n]/.test(spec.path)) throw new Error("script.file path must be an absolute canonical path");
  const stat = fs.lstatSync(spec.path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("script.file path must be a regular non-reparse file");
  const sourcePath = fs.realpathSync.native(spec.path);
  if (normalizePath(sourcePath) !== normalizePath(path.resolve(spec.path))) throw new Error("script.file path must be canonical");

  const contents = fs.readFileSync(sourcePath);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const cacheDir = assertTrustPathOutsideProject(projectRoot, path.join(hssTrustProjectStorePath(projectRoot, trustStoreRoot), "hss-scripts"));
  let cachePath = assertTrustPathOutsideProject(projectRoot, path.join(cacheDir, `${sha256}.jlinkscript`));
  fs.mkdirSync(cacheDir, { recursive: true });
  assertTrustPathOutsideProject(projectRoot, cacheDir);
  if (!fs.existsSync(cachePath)) {
    const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    assertTrustPathOutsideProject(projectRoot, temporary);
    try {
      fs.writeFileSync(temporary, contents, { flag: "wx" });
      fs.renameSync(temporary, cachePath);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  cachePath = assertTrustPathOutsideProject(projectRoot, cachePath);
  if (createHash("sha256").update(fs.readFileSync(cachePath)).digest("hex") !== sha256) {
    throw new Error("cached ScriptFile identity does not match its content address");
  }
  return { mode: "file", sourcePath, path: cachePath, sha256 };
}

export function readHssTrustProfile(projectRoot = process.cwd(), trustStoreRoot?: string): HssTrustProfile | undefined {
  try {
    const project = hssTrustProjectIdentity(projectRoot);
    const parsed = JSON.parse(fs.readFileSync(hssTrustProfilePath(projectRoot, trustStoreRoot), "utf8")) as HssTrustProfile;
    return validProfile(parsed)
      && parsed.project.root === project.root
      && parsed.project.namespaceSha256 === project.namespaceSha256
      && parsed.profileSha256 === profileDigest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveHssTrustProfile(profile: Omit<HssTrustProfile, "profileSha256">, projectRoot = process.cwd(), trustStoreRoot?: string): HssTrustProfile {
  const project = hssTrustProjectIdentity(projectRoot);
  if (profile.project.root !== project.root || profile.project.namespaceSha256 !== project.namespaceSha256) {
    throw new Error("Trust Profile project namespace does not match the selected project");
  }
  const complete = { ...profile, profileSha256: profileDigest(profile) };
  const file = hssTrustProfilePath(projectRoot, trustStoreRoot);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const directory = assertTrustPathOutsideProject(projectRoot, path.dirname(file));
  fs.mkdirSync(directory, { recursive: true });
  assertTrustPathOutsideProject(projectRoot, directory);
  assertTrustPathOutsideProject(projectRoot, temporary);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(complete, null, 2)}\n`, { flag: "wx", encoding: "utf8" });
    fs.renameSync(temporary, file);
    assertTrustPathOutsideProject(projectRoot, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return complete;
}

export function hssTrustProfileMatches(profile: HssTrustProfile, context: HssTrustContext, script: CachedHssScript): boolean {
  return profile.suiteVersion === HSS_TRUST_SUITE_VERSION
    && profile.target.targetId === context.targetId
    && profile.probe.interface === (context.interface ?? "SWD")
    && profile.probe.speedKhz === (context.speedKhz ?? 4000)
    && (profile.probe.serial ?? "") === (context.serial ?? "")
    && profile.script.mode === script.mode
    && (script.mode === "none" || (
      normalizePath(profile.script.path ?? "") === normalizePath(script.path ?? "")
      && profile.script.sha256 === script.sha256
    ));
}

export function hssTrustProfilePath(projectRoot = process.cwd(), trustStoreRoot?: string): string {
  return assertTrustPathOutsideProject(projectRoot, path.join(hssTrustProjectStorePath(projectRoot, trustStoreRoot), "trust-profile.json"));
}

export function hssTrustProjectIdentity(projectRoot = process.cwd()): HssTrustProfile["project"] {
  const root = stripWindowsExtendedPath(fs.realpathSync.native(resolveConfiguredPath(projectRoot)));
  return {
    root,
    namespaceSha256: createHash("sha256").update(normalizePath(root)).digest("hex"),
  };
}

export function hssTrustStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? env.APPDATA ?? env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return resolveConfiguredPath(env.JLINK_MCP_TRUST_STORE_ROOT ?? path.join(base, "jlink-mcp", "trust"));
}

function hssTrustProjectStorePath(projectRoot: string, trustStoreRoot?: string): string {
  const project = hssTrustProjectIdentity(projectRoot);
  const store = assertTrustPathOutsideProject(project.root, trustStoreRoot ?? hssTrustStoreRoot());
  return assertTrustPathOutsideProject(project.root, path.join(store, "projects", project.namespaceSha256));
}

function stripWindowsExtendedPath(value: string): string {
  if (process.platform !== "win32") return value;
  if (value.slice(0, 8).toLowerCase() === "\\\\?\\unc\\") return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) {
    const conventional = value.slice(4);
    if (!/^[a-z]:\\/i.test(conventional)) throw new Error("Unsupported Windows extended trust path");
    return conventional;
  }
  if (value.startsWith("\\\\.\\")) throw new Error("Unsupported Windows device trust path");
  return value;
}

function resolveConfiguredPath(value: string): string {
  const conventional = stripWindowsExtendedPath(value);
  if (conventional.split(/[\\/]+/u).includes("..")) throw new Error("Trust path must not contain parent traversal");
  return path.resolve(conventional);
}

function resolveExistingOrFutureRealPath(value: string): string {
  let cursor = resolveConfiguredPath(value);
  const suffix: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    const name = path.basename(cursor);
    if (parent === cursor || !name || name === "." || name === "..") throw new Error("Cannot resolve trust path ancestor");
    suffix.unshift(name);
    cursor = parent;
  }
  return path.resolve(stripWindowsExtendedPath(fs.realpathSync.native(cursor)), ...suffix);
}

function assertTrustPathOutsideProject(projectRoot: string, candidate: string): string {
  const project = hssTrustProjectIdentity(projectRoot);
  const realCandidate = resolveExistingOrFutureRealPath(candidate);
  const relative = path.relative(normalizePath(project.root), normalizePath(realCandidate));
  if (!relative
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    || hasProjectAncestorIdentity(project.root, candidate)) {
    throw new Error("HSS trust storage must be outside the project workspace");
  }
  return realCandidate;
}

function hasProjectAncestorIdentity(projectRoot: string, candidate: string): boolean {
  const projectStat = fs.statSync(projectRoot, { bigint: true });
  let cursor = resolveConfiguredPath(candidate);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  for (;;) {
    const candidateStat = fs.statSync(cursor, { bigint: true });
    if (projectStat.ino !== 0n && candidateStat.dev === projectStat.dev && candidateStat.ino === projectStat.ino) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function profileDigest(profile: Omit<HssTrustProfile, "profileSha256"> | HssTrustProfile): string {
  const { profileSha256: _ignored, ...content } = profile as HssTrustProfile;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function validProfile(profile: HssTrustProfile): boolean {
  const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  return profile?.version === 1
    && typeof profile.suiteVersion === "string"
    && typeof profile.validatedAt === "string"
    && hash(profile.runtime?.dllSha256)
    && hash(profile.runtime?.helperSha256)
    && hash(profile.runtime?.adapterSha256)
    && hash(profile.runtime?.sha256)
    && (profile.script?.mode === "none" || (profile.script?.mode === "file" && hash(profile.script.sha256) && typeof profile.script.path === "string"))
    && typeof profile.project?.root === "string"
    && hash(profile.project?.namespaceSha256)
    && typeof profile.target?.targetId === "string"
    && (profile.probe?.interface === "SWD" || profile.probe?.interface === "JTAG")
    && Number.isInteger(profile.probe?.speedKhz)
    && profile.validation?.getCaps === true
    && profile.validation?.lifecycle === true
    && profile.validation?.decoderSemantics === true
    && hash(profile.profileSha256);
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
