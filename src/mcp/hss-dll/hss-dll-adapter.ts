import { execFileSync, spawn } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { HSS_CANDIDATE_FUNCTIONS, hssApiCandidateReport } from "./hss-api-candidate";
import { requireHssReadOnlyVariables } from "./hss-symbols";
import {
  HSS_TRUST_SUITE_VERSION,
  cacheHssScript,
  hssTrustProfileMatches,
  readHssTrustProfile,
  type HssScriptSpec,
  type HssTrustProfile,
} from "../trust/trust-profile";

export interface HssDllDiscovery {
  searchPaths: string[];
  selectedDllPath?: string;
  resolutionSource?: HssDllResolutionSource;
  dllExists: boolean;
  runtimePlatform: string;
  runtimeArchitecture: string;
  architecture?: "x64" | "x86" | "unknown";
  sha256?: string;
  exports: Record<string, boolean>;
  exportsFound: boolean;
  identityValidated: boolean;
  availability: "candidate" | "unavailable";
  unavailableCode?: "HSS_PLATFORM_UNSUPPORTED" | "HSS_DLL_NOT_FOUND" | "HSS_DLL_INVALID_FILE" | "HSS_DLL_ARCH_UNSUPPORTED" | "HSS_DLL_EXPORTS_MISSING" | "HSS_DLL_IDENTITY_UNVALIDATED";
  officialSdkHeaderFound: false;
  publicPrototypeCandidate: true;
}

export type HssDllResolutionSource = "explicit" | "environment" | "registry" | "path" | "common";

export interface HssDllResolverOptions {
  registryInstallDirs?: string[];
  commonInstallDirs?: string[];
  validatedDllSha256?: readonly string[];
  validatedRuntimeIdentitySha256?: readonly string[];
  runtimePlatform?: string;
  runtimeArchitecture?: string;
  adapterPath?: string;
  cwd?: string;
  validatedJlinkScriptSha256?: readonly string[];
  scriptIdentity?: HssScriptIdentity;
  trustProfile?: HssTrustProfile;
  trustValidation?: boolean;
}

export interface HssHelperOptions extends HssDllResolverOptions {
  env?: Record<string, string | undefined>;
  helperPath?: string;
  helperArgsPrefix?: string[];
  timeoutMs?: number;
  deferConnectPreflight?: boolean;
}

export interface HssDllPreflightInput {
  dllPath?: string;
  device?: string;
  interface?: "SWD" | "JTAG";
  speedKhz?: number;
  serial?: string;
  script?: HssScriptSpec;
  jlinkScriptFile?: string;
  approvedJlinkScriptSha256?: string;
}

export interface HssDllVariable {
  name: string;
  address: string;
  size: number;
  type?: string;
}

export interface HssRuntimeIdentity {
  dllPath?: string;
  dllSha256?: string;
  dllVersion?: string;
  helperPath: string;
  helperVersion?: string;
  helperProtocolVersion?: number;
  helperSha256?: string;
  adapterPath: string;
  adapterVersion: string;
  adapterSha256?: string;
  jlinkScriptMode?: "none" | "file";
  jlinkScriptFile?: string;
  jlinkScriptSha256?: string;
  jlinkScriptApprovalSha256?: string;
  sha256?: string;
  validated: boolean;
}

export interface HssScriptIdentity {
  mode: "none" | "file";
  sourcePath?: string;
  path?: string;
  sha256?: string;
  approvalSha256?: string;
  approvalSource?: "trust-profile" | "trust-validation" | "trusted-allowlist";
  validated: boolean;
  errorCode?: "HSS_JLINK_SCRIPT_MODE_INVALID" | "HSS_JLINK_SCRIPT_PATH_INVALID" | "HSS_JLINK_SCRIPT_MISSING" | "HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED" | "HSS_JLINK_SCRIPT_IDENTITY_CHANGED";
  reason?: string;
}

export interface HssRuntimeVersions {
  dllVersion: string;
  helperVersion: string;
  helperProtocolVersion: number;
}

interface HssDllCandidate {
  path: string;
  source: HssDllResolutionSource;
}

const VALIDATED_HSS_DLL_SHA256: readonly string[] = [];
const VALIDATED_HSS_RUNTIME_IDENTITY_SHA256: readonly string[] = [];
const VALIDATED_JLINK_SCRIPT_SHA256: readonly string[] = [];
const HSS_ADAPTER_VERSION = "1";
const fileHashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }>();

export function hssDllSearchPaths(
  env: Record<string, string | undefined> = process.env,
  explicit?: string,
  options: HssDllResolverOptions = {},
): string[] {
  return hssDllCandidates(env, explicit, options).map((candidate) => candidate.path);
}

export function discoverHssDll(
  input: HssDllPreflightInput = {},
  env: Record<string, string | undefined> = process.env,
  options: HssDllResolverOptions = {},
): HssDllDiscovery {
  const candidates = hssDllCandidates(env, input.dllPath, options);
  const selected = candidates.find((candidate) => fs.existsSync(candidate.path));
  const selectedDllPath = selected?.path;
  let invalidFile = false;
  let data = Buffer.alloc(0);
  if (selectedDllPath) {
    try {
      if (!fs.statSync(selectedDllPath).isFile()) invalidFile = true;
      else data = fs.readFileSync(selectedDllPath);
    } catch {
      invalidFile = true;
    }
  }
  const text = data.toString("latin1");
  const exports = Object.fromEntries(HSS_CANDIDATE_FUNCTIONS.map((name) => [name, text.includes(name)]));
  const exportsFound = HSS_CANDIDATE_FUNCTIONS.every((name) => exports[name]);
  const architecture = selectedDllPath ? peArchitecture(data) : undefined;
  const sha256 = selectedDllPath && !invalidFile ? createHash("sha256").update(data).digest("hex") : undefined;
  const validatedHashes = options.validatedDllSha256 ?? VALIDATED_HSS_DLL_SHA256;
  const identityValidated = Boolean(sha256 && validatedHashes.some((hash) => hash.toLowerCase() === sha256));
  const runtimePlatform = options.runtimePlatform ?? process.platform;
  const runtimeArchitecture = options.runtimeArchitecture ?? process.arch;
  const unavailableCode = runtimePlatform !== "win32" || runtimeArchitecture !== "x64"
    ? "HSS_PLATFORM_UNSUPPORTED"
    : !selectedDllPath
      ? "HSS_DLL_NOT_FOUND"
      : invalidFile
        ? "HSS_DLL_INVALID_FILE"
        : architecture !== "x64"
          ? "HSS_DLL_ARCH_UNSUPPORTED"
          : !exportsFound
            ? "HSS_DLL_EXPORTS_MISSING"
            : !identityValidated
              ? "HSS_DLL_IDENTITY_UNVALIDATED"
              : undefined;
  return {
    searchPaths: candidates.map((candidate) => candidate.path),
    selectedDllPath,
    resolutionSource: selected?.source,
    dllExists: Boolean(selectedDllPath),
    runtimePlatform,
    runtimeArchitecture,
    architecture,
    sha256,
    exports,
    exportsFound,
    identityValidated,
    availability: unavailableCode ? "unavailable" : "candidate",
    unavailableCode,
    officialSdkHeaderFound: false,
    publicPrototypeCandidate: true,
  };
}

export function resolveHssRuntimeIdentity(
  discovery: Pick<HssDllDiscovery, "selectedDllPath" | "sha256">,
  env: Record<string, string | undefined> = process.env,
  options: HssHelperOptions = {},
  versions: Partial<HssRuntimeVersions> = {},
  fresh = false,
): HssRuntimeIdentity {
  const helperPath = resolveHssHelperPath(env, options.helperPath);
  const adapterPath = options.adapterPath ?? __filename;
  const dllSha256 = discovery.selectedDllPath && fresh ? fileSha256(discovery.selectedDllPath, true) : discovery.sha256;
  const helperSha256 = fileSha256(helperPath, fresh);
  const adapterSha256 = fileSha256(adapterPath, fresh);
  const script = options.scriptIdentity;
  const jlinkScriptSha256 = script?.path && fresh ? fileSha256(script.path, true) : script?.sha256;
  const helperVersion = validVersion(versions.helperVersion);
  const helperProtocolVersion = validProtocolVersion(versions.helperProtocolVersion);
  const dllVersion = validVersion(versions.dllVersion);
  const sha256 = dllSha256 && helperSha256 && adapterSha256 && helperVersion && helperProtocolVersion && dllVersion
    && script?.validated && script.approvalSha256
    && (script.mode === "none" || (script.path && jlinkScriptSha256))
    ? createHash("sha256").update(JSON.stringify({
      dllSha256,
      dllVersion,
      helperVersion,
      helperProtocolVersion,
      helperSha256,
      adapterVersion: HSS_ADAPTER_VERSION,
      adapterSha256,
      jlinkScriptMode: script.mode,
      ...(script.mode === "file" ? {
        jlinkScriptSha256,
        jlinkScriptApprovalSha256: script.approvalSha256,
      } : { jlinkScriptApprovalSha256: script.approvalSha256 }),
    })).digest("hex")
    : undefined;
  const validatedHashes = options.validatedRuntimeIdentitySha256 ?? VALIDATED_HSS_RUNTIME_IDENTITY_SHA256;
  return {
    dllPath: discovery.selectedDllPath,
    dllSha256,
    dllVersion,
    helperPath,
    helperVersion,
    helperProtocolVersion,
    helperSha256,
    adapterPath,
    adapterVersion: HSS_ADAPTER_VERSION,
    adapterSha256,
    jlinkScriptMode: script?.mode,
    jlinkScriptFile: script?.path,
    jlinkScriptSha256,
    jlinkScriptApprovalSha256: script?.approvalSha256,
    sha256,
    validated: Boolean(sha256 && validatedHashes.some((hash) => hash.toLowerCase() === sha256)),
  };
}

export function refreshHssRuntimeIdentity(identity: HssRuntimeIdentity, options: HssHelperOptions = {}): HssRuntimeIdentity {
  return resolveHssRuntimeIdentity({
    selectedDllPath: identity.dllPath,
    sha256: identity.dllSha256,
  }, options.env ?? process.env, {
    ...options,
    helperPath: identity.helperPath,
    adapterPath: identity.adapterPath,
    scriptIdentity: identity.jlinkScriptMode ? {
      mode: identity.jlinkScriptMode,
      path: identity.jlinkScriptFile,
      sha256: identity.jlinkScriptSha256,
      approvalSha256: identity.jlinkScriptApprovalSha256,
      validated: true,
    } : undefined,
  }, {
    dllVersion: identity.dllVersion ?? "",
    helperVersion: identity.helperVersion ?? "",
    helperProtocolVersion: identity.helperProtocolVersion ?? 0,
  }, true);
}

export function resolveHssScriptIdentity(
  input: Pick<HssDllPreflightInput, "script" | "device" | "interface" | "speedKhz" | "serial" | "jlinkScriptFile" | "approvedJlinkScriptSha256">,
  env: Record<string, string | undefined> = process.env,
  options: HssHelperOptions = {},
): HssScriptIdentity {
  if (options.scriptIdentity) return revalidateCachedScript(options.scriptIdentity);
  const trustedPath = input.jlinkScriptFile ?? (options.validatedJlinkScriptSha256 ? env.JLINK_SCRIPT_FILE : undefined);
  const spec = input.script ?? (trustedPath && options.validatedJlinkScriptSha256 ? { mode: "file" as const, path: trustedPath } : undefined);
  if (!spec) return { mode: "none", validated: false, errorCode: "HSS_JLINK_SCRIPT_MODE_INVALID", reason: "script.mode must be explicitly set to none or file" };
  let cached: ReturnType<typeof cacheHssScript>;
  try {
    cached = cacheHssScript(spec, options.cwd ?? process.cwd());
  } catch (error) {
    return { mode: spec.mode, path: spec.mode === "file" ? spec.path : undefined, validated: false, errorCode: "HSS_JLINK_SCRIPT_MISSING", reason: error instanceof Error ? error.message : "J-Link ScriptFile is unavailable" };
  }
  const profile = options.trustProfile ?? readHssTrustProfile(options.cwd);
  const profileTrusted = Boolean(profile && hssTrustProfileMatches(profile, {
    targetId: input.device,
    interface: input.interface,
    speedKhz: input.speedKhz,
    serial: input.serial,
  }, cached));
  const explicitlyTrusted = cached.mode === "file" && Boolean(cached.sha256 && (options.validatedJlinkScriptSha256 ?? VALIDATED_JLINK_SCRIPT_SHA256).includes(cached.sha256));
  const validated = options.trustValidation === true || profileTrusted || explicitlyTrusted;
  const approvalSource = options.trustValidation ? "trust-validation" : profileTrusted ? "trust-profile" : "trusted-allowlist";
  return {
    ...cached,
    approvalSha256: createHash("sha256").update(JSON.stringify({ mode: cached.mode, sha256: cached.sha256 })).digest("hex"),
    approvalSource,
    validated,
    ...(!validated ? { errorCode: "HSS_JLINK_SCRIPT_IDENTITY_UNVALIDATED" as const, reason: "script identity is not present in the local Trust Profile" } : {}),
  };
}

function revalidateCachedScript(script: HssScriptIdentity): HssScriptIdentity {
  if (!script.validated) return script;
  if (script.mode === "none") return script.path || script.sha256
    ? { ...script, validated: false, errorCode: "HSS_JLINK_SCRIPT_IDENTITY_CHANGED", reason: "script mode none must not carry a path or hash" }
    : script;
  const sha256 = script.path ? fileSha256(script.path, true) : undefined;
  return sha256 && sha256 === script.sha256
    ? script
    : { ...script, validated: false, errorCode: "HSS_JLINK_SCRIPT_IDENTITY_CHANGED", reason: "cached ScriptFile identity changed" };
}

function trustedOptions(input: HssDllPreflightInput, script: HssScriptIdentity, options: HssHelperOptions): HssHelperOptions {
  if (options.trustValidation === true) return { ...options, scriptIdentity: script };
  const profile = options.trustProfile ?? readHssTrustProfile(options.cwd);
  if (!profile || !hssTrustProfileMatches(profile, {
    targetId: input.device,
    interface: input.interface,
    speedKhz: input.speedKhz,
    serial: input.serial,
  }, script)) return { ...options, scriptIdentity: script };
  return {
    ...options,
    scriptIdentity: script,
    trustProfile: profile,
    validatedDllSha256: [profile.runtime.dllSha256],
    validatedRuntimeIdentitySha256: [profile.runtime.sha256],
  };
}

export function hssScriptHelperArgs(script: HssScriptIdentity): string[] {
  return [
    "--jlink-script-mode", script.mode,
    ...(script.mode === "file" ? ["--jlink-script-file", script.path!, "--approved-jlink-script-sha256", script.sha256!] : []),
  ];
}

export function hssRuntimeIdentityMatches(expected: HssRuntimeIdentity, actual: HssRuntimeIdentity): boolean {
  return Boolean(expected.validated && actual.validated && expected.sha256 && expected.sha256 === actual.sha256);
}

export function isValidatedHssGetCapsResult(result: Record<string, unknown>, identity?: HssRuntimeIdentity): boolean {
  const caps = result.caps as Record<string, unknown> | undefined;
  const returnCode = result.returnCode;
  return result.status === "ok"
    && typeof returnCode === "number"
    && Number.isInteger(returnCode)
    && returnCode === 0
    && typeof caps?.maxBlocks === "number"
    && Number.isInteger(caps.maxBlocks)
    && caps.maxBlocks > 0
    && typeof caps?.maxFreq === "number"
    && Number.isInteger(caps.maxFreq)
    && caps.maxFreq > 0
    && (!identity || (
      result.helperVersion === identity.helperVersion
      && result.helperProtocolVersion === identity.helperProtocolVersion
      && validVersion(result.dllVersion) === identity.dllVersion
      && result.jlinkScriptMode === identity.jlinkScriptMode
      && (result.jlinkScriptFile || undefined) === identity.jlinkScriptFile
      && (result.jlinkScriptSha256 || undefined) === identity.jlinkScriptSha256
      && result.jlinkScriptReturnCode === 0
    ));
}

function fileSha256(file: string, fresh = false): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const resolved = path.resolve(file);
    const cached = fileHashes.get(resolved);
    if (!fresh && cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) return cached.sha256;
    const sha256 = createHash("sha256").update(fs.readFileSync(resolved)).digest("hex");
    fileHashes.set(resolved, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256 });
    return sha256;
  } catch {
    return undefined;
  }
}

function validVersion(value: unknown): string | undefined {
  const normalized = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return normalized && normalized.toLowerCase() !== "unknown" ? normalized : undefined;
}

function validProtocolVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

async function inspectRuntimeIdentity(
  discovery: HssDllDiscovery,
  env: Record<string, string | undefined>,
  options: HssHelperOptions,
): Promise<{
  status: "ok" | "unavailable";
  errorCode?: string;
  reason?: string;
  helperVersion: Record<string, unknown>;
  helperPreflight: Record<string, unknown>;
  runtimeIdentity: HssRuntimeIdentity;
}> {
  const helperVersion = await runHssHelperCommand("version", [], options);
  const helperPreflight = discovery.selectedDllPath
    ? await runHssHelperCommand("preflight", ["--dll", discovery.selectedDllPath], options)
    : { status: "error", errorCode: "HSS_DLL_NOT_FOUND" };
  const versions = {
    helperVersion: validVersion(helperVersion.helperVersion) ?? "",
    helperProtocolVersion: validProtocolVersion(helperVersion.helperProtocolVersion) ?? 0,
    dllVersion: validVersion(helperPreflight.dllVersion) ?? "",
  };
  const runtimeIdentity = resolveHssRuntimeIdentity(discovery, env, options, versions, true);
  if (helperVersion.status !== "ok" || !versions.helperVersion || !versions.helperProtocolVersion) {
    return { status: "unavailable", errorCode: "HSS_HELPER_VERSION_INVALID", reason: "native helper did not report a valid version and protocol", helperVersion, helperPreflight, runtimeIdentity };
  }
  if (helperPreflight.status !== "ok" || helperPreflight.exportsFound !== true || !versions.dllVersion) {
    return { status: "unavailable", errorCode: String(helperPreflight.errorCode ?? "HSS_DLL_EXPORTS_MISSING"), reason: String(helperPreflight.reason ?? "native preflight did not report valid exports and DLL version"), helperVersion, helperPreflight, runtimeIdentity };
  }
  if (!runtimeIdentity.validated) {
    return { status: "unavailable", errorCode: "HSS_RUNTIME_IDENTITY_UNVALIDATED", reason: "the reported DLL/helper/adapter identity tuple has not passed the validation suite", helperVersion, helperPreflight, runtimeIdentity };
  }
  return { status: "ok", helperVersion, helperPreflight, runtimeIdentity };
}

function runtimeIdentityChanged(
  base: Record<string, unknown>,
  runtimeIdentity: HssRuntimeIdentity,
  helperPreflight?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...base,
    status: "unavailable",
    hssStatus: "unavailable",
    errorCode: "HSS_RUNTIME_IDENTITY_CHANGED",
    reason: "DLL/helper/adapter identity changed across an execution boundary",
    runtimeIdentity,
    ...(helperPreflight ? { helperPreflight } : {}),
  };
}

function hssDllCandidates(
  env: Record<string, string | undefined>,
  explicit: string | undefined,
  options: HssDllResolverOptions,
): HssDllCandidate[] {
  const registryInstallDirs = options.registryInstallDirs ?? seggerRegistryInstallDirs();
  const commonInstallDirs = options.commonInstallDirs ?? commonSeggerInstallDirs(env);
  const candidates: HssDllCandidate[] = [
    ...(explicit ? [{ path: explicit, source: "explicit" as const }] : []),
    ...(env.JLINK_DLL_PATH ? [{ path: env.JLINK_DLL_PATH, source: "environment" as const }] : []),
    ...registryInstallDirs.map((installDir) => ({ path: dllUnder(installDir), source: "registry" as const })),
    ...pathJLinkInstallDirs(env).map((installDir) => ({ path: dllUnder(installDir), source: "path" as const })),
    ...commonInstallDirs.map((installDir) => ({ path: dllUnder(installDir), source: "common" as const })),
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dllUnder(installDirOrDll: string): string {
  return installDirOrDll.toLowerCase().endsWith(".dll")
    ? installDirOrDll
    : path.join(installDirOrDll, "JLink_x64.dll");
}

function seggerRegistryInstallDirs(): string[] {
  if (process.platform !== "win32") return [];
  const keys = [
    "HKLM\\SOFTWARE\\SEGGER\\J-Link",
    "HKCU\\SOFTWARE\\SEGGER\\J-Link",
    "HKLM\\SOFTWARE\\WOW6432Node\\SEGGER\\J-Link",
  ];
  return keys.flatMap((key) => {
    try {
      const output = execFileSync("reg.exe", ["query", key, "/v", "InstallPath"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const match = output.match(/^\s*InstallPath\s+REG_\w+\s+(.+?)\s*$/im);
      return match?.[1] ? [match[1]] : [];
    } catch {
      return [];
    }
  });
}

function pathJLinkInstallDirs(env: Record<string, string | undefined>): string[] {
  const pathValue = env.Path ?? env.PATH ?? "";
  return pathValue.split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0 && fs.existsSync(path.join(entry, "JLink.exe")));
}

function commonSeggerInstallDirs(env: Record<string, string | undefined>): string[] {
  const programRoots = [
    env.ProgramFiles ?? "C:\\Program Files",
    env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  ];
  return programRoots.flatMap((programRoot) => {
    const seggerRoot = path.join(programRoot, "SEGGER");
    const current = path.join(seggerRoot, "JLink");
    let versioned: string[] = [];
    try {
      versioned = fs.readdirSync(seggerRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^JLink_/i.test(entry.name))
        .map((entry) => path.join(seggerRoot, entry.name))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    } catch {
      // Missing common installation roots are expected.
    }
    return [current, ...versioned];
  });
}

function peArchitecture(data: Buffer): "x64" | "x86" | "unknown" {
  if (data.length < 0x40 || data.toString("ascii", 0, 2) !== "MZ") return "unknown";
  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 6 > data.length || data.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return "unknown";
  const machine = data.readUInt16LE(peOffset + 4);
  return machine === 0x8664 ? "x64" : machine === 0x014c ? "x86" : "unknown";
}

export async function hssDllPreflight(input: HssDllPreflightInput = {}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const scriptIdentity = resolveHssScriptIdentity(input, env, options);
  const identityOptions = trustedOptions(input, scriptIdentity, options);
  const discovery = discoverHssDll(input, env, identityOptions);
  const helperPath = resolveHssHelperPath(env, options.helperPath);
  const helperExists = fs.existsSync(helperPath);
  const device = input.device ?? env.JLINK_DEVICE;
  const initialIdentity = resolveHssRuntimeIdentity(discovery, env, identityOptions);
  const base = {
    status: discovery.availability,
    hssStatus: discovery.availability,
    errorCode: discovery.unavailableCode,
    reason: discovery.unavailableCode ?? "HSS DLL candidate found; GetCaps and lifecycle validation remain required",
    candidateApi: hssApiCandidateReport(false),
    discovery,
    runtimeIdentity: initialIdentity,
    getcapsAllowed: false,
    helperPath,
    helperExists,
    benchmarkReady: false,
    jscopeUsed: false,
    scriptIdentity,
  };
  if (!discovery.selectedDllPath || !helperExists || discovery.availability !== "candidate") return base;
  if (!scriptIdentity.validated) return { ...base, status: "unavailable", hssStatus: "unavailable", errorCode: scriptIdentity.errorCode, reason: scriptIdentity.reason };
  const inspection = await inspectRuntimeIdentity(discovery, env, identityOptions);
  const runtimeIdentity = inspection.runtimeIdentity;
  const helperPreflight = inspection.helperPreflight;
  const exportsValidated = inspection.status === "ok";
  if (!exportsValidated || !runtimeIdentity.validated) {
    return {
      ...base,
      status: "unavailable",
      hssStatus: "unavailable",
      errorCode: inspection.errorCode ?? "HSS_RUNTIME_IDENTITY_UNVALIDATED",
      reason: inspection.reason ?? "the DLL/helper/adapter identity tuple has not passed the validation suite",
      helperVersion: inspection.helperVersion,
      helperPreflight,
      runtimeIdentity,
      exportsValidated: false,
    };
  }
  let connectPreflight: Record<string, unknown> | undefined;
  if (device && !options.deferConnectPreflight) {
    const before = refreshHssRuntimeIdentity(runtimeIdentity, identityOptions);
    if (!hssRuntimeIdentityMatches(runtimeIdentity, before)) return runtimeIdentityChanged(base, before, helperPreflight);
    connectPreflight = await runHssHelperCommand("connect-preflight", [
      "--dll", discovery.selectedDllPath,
      "--device", device!,
      "--interface", input.interface ?? "SWD",
      "--speed", String(input.speedKhz ?? Number(env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
      ...(input.serial ? ["--serial", input.serial] : []),
      ...hssScriptHelperArgs(scriptIdentity),
    ], identityOptions);
    const after = refreshHssRuntimeIdentity(runtimeIdentity, identityOptions);
    if (!hssRuntimeIdentityMatches(runtimeIdentity, after)) return runtimeIdentityChanged(base, after, helperPreflight);
  }
  return {
    ...base,
    status: exportsValidated ? base.status : "unavailable",
    hssStatus: exportsValidated ? base.hssStatus : "unavailable",
    errorCode: exportsValidated ? base.errorCode : String(helperPreflight.errorCode ?? "HSS_DLL_EXPORTS_MISSING"),
    reason: exportsValidated ? base.reason : String(helperPreflight.reason ?? "native preflight did not validate required HSS exports"),
    helperPreflight,
    helperVersion: inspection.helperVersion,
    runtimeIdentity,
    getcapsAllowed: true,
    exportsValidated,
    connectPreflight,
    safetyStatus: connectPreflight && connectPreflight.targetWasHalted === true ? "HSS_SAFETY_FAIL" : "not_evaluated",
  };
}

export async function hssDllGetCaps(input: HssDllPreflightInput = {}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const preliminary = discoverHssDll(input, env, options);
  if (preliminary.availability !== "candidate"
      && (preliminary.unavailableCode !== "HSS_DLL_IDENTITY_UNVALIDATED" || !(options.trustProfile ?? readHssTrustProfile(options.cwd)))) {
    return {
      status: "unavailable",
      errorCode: preliminary.unavailableCode ?? "HSS_DLL_EXPORTS_MISSING",
      reason: "the resolved Windows x64 J-Link DLL is unavailable for HSS",
      discovery: preliminary,
    };
  }
  const scriptIdentity = resolveHssScriptIdentity(input, env, options);
  if (!scriptIdentity.validated) return { status: "unavailable", errorCode: scriptIdentity.errorCode, reason: scriptIdentity.reason, scriptIdentity };
  const identityOptions = trustedOptions(input, scriptIdentity, options);
  const discovery = discoverHssDll(input, env, identityOptions);
  const dllPath = discovery.selectedDllPath;
  if (discovery.availability !== "candidate" || !dllPath) {
    return {
      status: "unavailable",
      errorCode: discovery.unavailableCode ?? "HSS_DLL_EXPORTS_MISSING",
      reason: "the resolved Windows x64 J-Link DLL is unavailable for HSS",
      discovery,
    };
  }
  const inspection = await inspectRuntimeIdentity(discovery, env, identityOptions);
  const runtimeIdentity = inspection.runtimeIdentity;
  if (!runtimeIdentity.validated) {
    return {
      status: "unavailable",
      errorCode: inspection.errorCode ?? "HSS_RUNTIME_IDENTITY_UNVALIDATED",
      reason: inspection.reason ?? "the DLL/helper/adapter identity tuple has not passed the validation suite",
      discovery,
      runtimeIdentity,
      helperVersion: inspection.helperVersion,
      helperPreflight: inspection.helperPreflight,
    };
  }
  const device = input.device ?? env.JLINK_DEVICE;
  if (!device) {
    return { status: "error", errorCode: "HSS_GETCAPS_DEVICE_REQUIRED", reason: "JLINK_HSS_GetCaps requires a configured target device", discovery };
  }
  const before = refreshHssRuntimeIdentity(runtimeIdentity, identityOptions);
  if (!hssRuntimeIdentityMatches(runtimeIdentity, before)) return runtimeIdentityChanged({ discovery }, before, inspection.helperPreflight);
  const result = await runHssHelperCommand("getcaps", [
    "--dll", dllPath,
    "--device", device,
    "--interface", input.interface ?? "SWD",
    "--speed", String(input.speedKhz ?? Number(env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
    ...(input.serial ? ["--serial", input.serial] : []),
    ...hssScriptHelperArgs(scriptIdentity),
  ], identityOptions);
  const after = refreshHssRuntimeIdentity(runtimeIdentity, identityOptions);
  if (!hssRuntimeIdentityMatches(runtimeIdentity, after)) return runtimeIdentityChanged({ discovery }, after, inspection.helperPreflight);
  const withIdentity = { ...result, runtimeIdentity: after };
  if (result.status !== "ok") return withIdentity;
  if (!isValidatedHssGetCapsResult(withIdentity, after)) {
    return {
      ...withIdentity,
      status: "error",
      errorCode: Number(result.returnCode) < 0 ? "HSS_GETCAPS_FAILED" : "HSS_GETCAPS_INVALID",
      reason: "JLINK_HSS_GetCaps returned an error or invalid capabilities",
    };
  }
  return withIdentity;
}

export async function hssDllTargetState(
  input: HssDllPreflightInput,
  expectedIdentity: HssRuntimeIdentity,
  options: HssHelperOptions = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const scriptIdentity = resolveHssScriptIdentity(input, env, options);
  if (!scriptIdentity.validated
      || scriptIdentity.mode !== expectedIdentity.jlinkScriptMode
      || scriptIdentity.path !== expectedIdentity.jlinkScriptFile
      || scriptIdentity.sha256 !== expectedIdentity.jlinkScriptSha256
      || scriptIdentity.approvalSha256 !== expectedIdentity.jlinkScriptApprovalSha256) {
    return { status: "unavailable", errorCode: "HSS_JLINK_SCRIPT_IDENTITY_CHANGED", reason: "target-state ScriptFile identity does not match GetCaps", scriptIdentity };
  }
  const identityOptions = trustedOptions(input, scriptIdentity, options);
  const before = refreshHssRuntimeIdentity(expectedIdentity, identityOptions);
  if (!hssRuntimeIdentityMatches(expectedIdentity, before)) return runtimeIdentityChanged({}, before);
  const result = await runHssHelperCommand("target-state", [
    "--dll", expectedIdentity.dllPath ?? "",
    "--approved-dll-sha256", expectedIdentity.dllSha256 ?? "",
    "--device", input.device ?? env.JLINK_DEVICE ?? "",
    "--interface", input.interface ?? "SWD",
    "--speed", String(input.speedKhz ?? Number(env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
    ...(input.serial ? ["--serial", input.serial] : []),
    ...hssScriptHelperArgs(scriptIdentity),
  ], identityOptions);
  const after = refreshHssRuntimeIdentity(expectedIdentity, identityOptions);
  if (!hssRuntimeIdentityMatches(expectedIdentity, after)) return runtimeIdentityChanged({}, after);
  if (result.status === "ok" && (result.helperVersion !== expectedIdentity.helperVersion
      || result.helperProtocolVersion !== expectedIdentity.helperProtocolVersion
      || String(result.dllVersion ?? "") !== expectedIdentity.dllVersion
      || result.jlinkScriptMode !== expectedIdentity.jlinkScriptMode
      || (result.jlinkScriptFile || undefined) !== expectedIdentity.jlinkScriptFile
      || (result.jlinkScriptSha256 || undefined) !== expectedIdentity.jlinkScriptSha256
      || result.jlinkScriptReturnCode !== 0)) {
    return runtimeIdentityChanged({ result }, after);
  }
  return { ...result, runtimeIdentity: after };
}

export async function hssDllSmoke(input: HssDllPreflightInput & {
  elf?: string;
  symbol: string;
  address?: string;
  size?: number;
  durationSec?: number;
  periodUs?: number;
}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  requireHssReadOnlyVariables([input.symbol]);
  const gate = await requireExperimentalDllReady(input, options);
  if (gate) return gate;
  return runHssHelperCommand("hss-smoke", [
    "--dll", discoverHssDll(input, options.env ?? process.env, options).selectedDllPath!,
    "--device", input.device ?? process.env.JLINK_DEVICE ?? "",
    "--interface", input.interface ?? "SWD",
    "--speed", String(input.speedKhz ?? Number(process.env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
    "--symbol", input.symbol,
    "--address", input.address ?? "",
    "--size", String(input.size ?? 4),
    "--duration", String(input.durationSec ?? 5),
    "--period-us", String(input.periodUs ?? 1000),
    ...(input.elf ? ["--elf", input.elf] : []),
  ], options);
}

export async function hssDllBenchmark(input: HssDllPreflightInput & {
  variables: HssDllVariable[];
  durationSec?: number;
  periodUs?: number;
}, options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  requireHssReadOnlyVariables(input.variables.map((variable) => variable.name));
  const gate = await requireExperimentalDllReady(input, options);
  if (gate) return gate;
  return runHssHelperCommand("hss-benchmark", [
    "--dll", discoverHssDll(input, options.env ?? process.env, options).selectedDllPath!,
    "--device", input.device ?? process.env.JLINK_DEVICE ?? "",
    "--interface", input.interface ?? "SWD",
    "--speed", String(input.speedKhz ?? Number(process.env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000)),
    "--variables", JSON.stringify(input.variables),
    "--duration", String(input.durationSec ?? 30),
    "--period-us", String(input.periodUs ?? 1000),
  ], options);
}

export function resolveHssHelperPath(env: Record<string, string | undefined> = process.env, explicit?: string): string {
  if (explicit) return explicit;
  if (env.JLINK_MCP_HSS_HELPER_PATH) return env.JLINK_MCP_HSS_HELPER_PATH;
  const bundled = path.resolve(__dirname, "..", "..", "..", "native", "hss-helper", "bin", "hss_helper.exe");
  return fs.existsSync(bundled) ? bundled : path.join(process.cwd(), "native", "hss-helper", "bin", "hss_helper.exe");
}

export function runHssHelperCommand(command: string, args: string[], options: HssHelperOptions = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const helperPath = resolveHssHelperPath(env, options.helperPath);
  if (!fs.existsSync(helperPath)) {
    return Promise.resolve({ status: "error", errorCode: "HSS_HELPER_MISSING", helperPath, reason: "native HSS helper is not built" });
  }
  const helperArgs = [...(options.helperArgsPrefix ?? []), command, ...args];
  return new Promise((resolve) => {
    const child = spawn(helperPath, helperArgs, { windowsHide: true, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: "error", errorCode: "HSS_HELPER_TIMEOUT", helperPath, command, stderr, reason: "native HSS helper timed out" });
    }, options.timeoutMs ?? 10000);
    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ status: "error", errorCode: "HSS_HELPER_SPAWN_FAILED", helperPath, command, reason: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout);
        resolve({ helperExitCode: code, ...parsed });
      } catch {
        resolve({ status: "error", errorCode: "HSS_HELPER_JSON_PARSE_FAILED", helperPath, command, exitCode: code, stdout, stderr, reason: "native HSS helper did not return JSON" });
      }
    });
  });
}

async function requireExperimentalDllReady(input: HssDllPreflightInput, options: HssHelperOptions): Promise<Record<string, unknown> | null> {
  const env = options.env ?? process.env;
  const discovery = discoverHssDll(input, env, options);
  if (discovery.availability !== "candidate") {
    return {
      status: "unavailable",
      errorCode: discovery.unavailableCode,
      reason: "the resolved Windows x64 HSS DLL identity is not ready for supported capture",
      discovery,
    };
  }
  const inspection = await inspectRuntimeIdentity(discovery, env, options);
  const runtimeIdentity = inspection.runtimeIdentity;
  if (!runtimeIdentity.validated) {
    return {
      status: "unavailable",
      errorCode: inspection.errorCode ?? "HSS_RUNTIME_IDENTITY_UNVALIDATED",
      reason: inspection.reason ?? "the DLL/helper/adapter identity tuple has not passed the validation suite",
      discovery,
      runtimeIdentity,
    };
  }
  return null;
}

function normalizePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
