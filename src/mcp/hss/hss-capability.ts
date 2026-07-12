import { dirname } from "node:path";
import {
  discoverHssDll,
  hssDllGetCaps,
  hssDllPreflight,
  hssDllTargetState,
  isValidatedHssGetCapsResult,
  resolveHssHelperPath,
  type HssDllPreflightInput,
  type HssHelperOptions,
} from "../hss-dll/hss-dll-adapter";
import { HSS_SAFETY_FALSE, type HssTargetIdentity } from "./hss-contract";
import { hssProjectPaths } from "./project-paths";
import { resolveHssTargetIdentity, type HssTargetIdentityInput } from "./target-identity";

export interface HssCapabilityOptions extends HssHelperOptions {
  cwd?: string;
  targetIdentity?: HssTargetIdentity;
}

export async function hssCapabilityProbe(
  input: HssDllPreflightInput & HssTargetIdentityInput = {},
  options: HssCapabilityOptions = {},
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const target = options.targetIdentity ?? await resolveHssTargetIdentity(input, { cwd: options.cwd });
  const resolvedInput: HssDllPreflightInput = {
    dllPath: input.dllPath,
    device: target.targetId,
    interface: input.interface,
    speedKhz: input.speedKhz,
    serial: input.serial,
    jlinkScriptFile: input.jlinkScriptFile,
    approvedJlinkScriptSha256: input.approvedJlinkScriptSha256,
  };
  const discovery = discoverHssDll(resolvedInput, env, options);
  const helperPath = resolveHssHelperPath(env, options.helperPath);
  const preflight = await hssDllPreflight(resolvedInput, { ...options, deferConnectPreflight: true });
  const runtimeIdentity = preflight.runtimeIdentity as import("../hss-dll/hss-dll-adapter").HssRuntimeIdentity;
  const helperPreflight = preflight.helperPreflight as { status?: unknown; errorCode?: unknown; exportsFound?: unknown } | undefined;
  const exportsValidated = helperPreflight?.status === "ok" && helperPreflight.exportsFound === true;
  const getCapsAllowed = discovery.availability === "candidate"
    && Boolean(preflight.helperExists)
    && runtimeIdentity.validated
    && exportsValidated;
  const getCaps = getCapsAllowed ? await hssDllGetCaps(resolvedInput, options) : undefined;
  const getCapsIdentity = getCaps?.runtimeIdentity as import("../hss-dll/hss-dll-adapter").HssRuntimeIdentity | undefined;
  const getCapsValidated = Boolean(getCaps && getCapsIdentity && isValidatedHssGetCapsResult(getCaps, getCapsIdentity));
  const caps = getCapsValidated ? getCaps!.caps as Record<string, unknown> : undefined;
  const connectPreflight = getCapsValidated ? await hssDllTargetState(resolvedInput, getCapsIdentity!, options) as { status?: unknown; errorCode?: unknown; targetWasHalted?: unknown; targetWasHaltedRaw?: unknown } : undefined;
  const targetStateValidated = connectPreflight?.status === "ok" && typeof connectPreflight.targetWasHalted === "boolean";
  const targetWasHalted = connectPreflight?.targetWasHalted === true;
  const targetWasHaltedRaw = typeof connectPreflight?.targetWasHaltedRaw === "number" ? connectPreflight.targetWasHaltedRaw : undefined;
  const requestedDevice = input.targetId?.trim() || input.device?.trim();
  const startReadStopCandidate = discovery.availability === "candidate"
    && exportsValidated
    && Boolean(preflight.helperExists)
    && runtimeIdentity.validated;
  const unavailableCode = discovery.unavailableCode
    ?? (!preflight.helperExists ? "HSS_HELPER_MISSING" : undefined)
    ?? (!runtimeIdentity.validated ? "HSS_RUNTIME_IDENTITY_UNVALIDATED" : undefined)
    ?? (!exportsValidated ? String(helperPreflight?.errorCode ?? "HSS_DLL_EXPORTS_MISSING") : undefined)
    ?? (!getCapsValidated ? String(getCaps?.errorCode ?? "HSS_GETCAPS_FAILED") : undefined)
    ?? (!targetStateValidated ? String(connectPreflight?.errorCode ?? "HSS_TARGET_STATE_FAILED") : undefined);
  return {
    target,
    jlink: {
      installDir: discovery.selectedDllPath ? dirname(discovery.selectedDllPath) : undefined,
      dllPath: discovery.selectedDllPath,
      dllExists: discovery.dllExists,
      dllVersion: getCapsValidated ? getCaps?.dllVersion : undefined,
      device: target.targetId,
      requestedDevice,
      resolvedDevice: target.targetId,
      targetId: target.targetId,
      targetSource: target.source,
      targetConfidence: target.confidence,
      configurationSource: target.configurationSource,
      interface: input.interface ?? "SWD",
      speedKhz: input.speedKhz ?? Number(env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000),
      probeSerial: input.serial,
      probeModel: undefined,
    },
    hss: {
      availability: unavailableCode ? "unavailable" : "available",
      unavailableCode,
      exports: discovery.exports,
      exportsFound: discovery.exportsFound,
      exportsValidated,
      getCapsAllowed,
      getCapsOk: getCapsValidated,
      maxBlocks: Number(caps?.maxBlocks ?? 0),
      maxFreqHz: Number(caps?.maxFreq ?? 0),
      targetWasHalted,
      targetWasHaltedRaw,
      getCapsValidated,
      runtimeIdentityValidated: runtimeIdentity.validated,
      startReadStopValidated: runtimeIdentity.validated,
      startReadStopAttemptAllowed: startReadStopCandidate,
      startReadStopReady: getCapsValidated && targetStateValidated && startReadStopCandidate,
    },
    helper: {
      path: helperPath,
      exists: Boolean(preflight.helperExists),
      version: runtimeIdentity.helperVersion,
      sha256: runtimeIdentity.helperSha256,
    },
    adapter: {
      path: runtimeIdentity.adapterPath,
      version: runtimeIdentity.adapterVersion,
      sha256: runtimeIdentity.adapterSha256,
    },
    runtimeIdentity: {
      ...runtimeIdentity,
      dllVersion: getCapsValidated ? getCaps?.dllVersion : runtimeIdentity.dllVersion,
    },
    project: hssProjectPaths(options.cwd).projectRoot,
    safety: HSS_SAFETY_FALSE,
    preflight,
    getCaps,
    targetState: connectPreflight,
  };
}
