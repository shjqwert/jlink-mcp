import { dirname } from "node:path";
import {
  discoverHssDll,
  hssDllGetCaps,
  hssDllPreflight,
  resolveHssHelperPath,
  type HssDllPreflightInput,
  type HssHelperOptions,
} from "../hss-dll/hss-dll-adapter";
import { HSS_SAFETY_FALSE } from "./hss-contract";
import { hssProjectPaths } from "./project-paths";

export async function hssCapabilityProbe(input: HssDllPreflightInput = {}, options: HssHelperOptions & { cwd?: string } = {}): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const discovery = discoverHssDll(input, env);
  const helperPath = resolveHssHelperPath(env, options.helperPath);
  const preflight = await hssDllPreflight(input, options);
  const getCapsAllowed = discovery.exportsFound;
  const getCaps = getCapsAllowed ? await hssDllGetCaps(input, options) : undefined;
  const caps = getCaps && getCaps.status === "ok" ? getCaps.caps as Record<string, unknown> : undefined;
  const connectPreflight = preflight.connectPreflight as { targetWasHalted?: unknown } | undefined;
  const targetWasHalted = connectPreflight?.targetWasHalted === true;
  const startReadStopCandidate = preflight.status === "candidate"
    && discovery.exportsFound
    && Boolean(preflight.helperExists);
  const startReadStopValidated = getCaps?.status === "ok";
  return {
    jlink: {
      installDir: discovery.selectedDllPath ? dirname(discovery.selectedDllPath) : undefined,
      dllPath: discovery.selectedDllPath,
      dllExists: discovery.dllExists,
      dllVersion: getCaps && getCaps.status === "ok" ? getCaps.dllVersion : undefined,
      device: input.device ?? env.JLINK_DEVICE ?? "Z20K146MC",
      interface: input.interface ?? "SWD",
      speedKhz: input.speedKhz ?? Number(env.JLINK_MCP_HSS_SPEED_KHZ ?? 4000),
      probeSerial: input.serial,
      probeModel: undefined,
    },
    hss: {
      exports: discovery.exports,
      exportsFound: discovery.exportsFound,
      getCapsAllowed,
      getCapsOk: getCaps?.status === "ok",
      maxBlocks: Number(caps?.maxBlocks ?? 0),
      maxFreqHz: Number(caps?.maxFreq ?? 0),
      targetWasHalted,
      startReadStopValidated,
      startReadStopAttemptAllowed: startReadStopCandidate,
      startReadStopReady: startReadStopValidated,
    },
    helper: {
      path: helperPath,
      exists: Boolean(preflight.helperExists),
      version: "unknown",
    },
    project: hssProjectPaths(options.cwd).projectRoot,
    safety: HSS_SAFETY_FALSE,
    preflight,
    getCaps,
  };
}
