import { available, capability, type BackendProbeContext, type CaptureBackend, type HssAdapter, unavailable } from "./capture-backend";
import { EnvJlinkHssAdapter } from "./jlink-hss-adapter";

export function createJlinkHssBackend(adapter?: HssAdapter): CaptureBackend {
  const cap = capability("jlink-hss", 1, "highest-rate host-side streaming when J-Link SDK/HSS is configured", {
    requiresFirmware: false,
    requiresTargetCodeChange: false,
    requiresSDK: true,
    requiresExternalTool: true,
    supportsRead: true,
    supportsWrite: false,
    supportsStreaming: true,
    supportsRunWhileTargetRunning: true,
  });

  return {
    capability: cap,
    probe(context: BackendProbeContext = {}) {
      const env = context.env ?? process.env;
      if (env.JLINK_HSS_ENABLED === "0") {
        return unavailable(cap, "J-Link HSS explicitly disabled by JLINK_HSS_ENABLED=0");
      }
      const hss = context.hssAdapter ?? adapter ?? new EnvJlinkHssAdapter();
      const sdkDir = env.JLINK_SDK_DIR ?? env.JLINK_INSTALL_DIR ?? "";
      return hss.isAvailable(sdkDir)
        ? available(cap, "JScope/J-Link HSS preflight available", ["HSS benchmark requires an implemented adapter; JScope CLI exposes project open/probe selection but no verified headless export path."])
        : unavailable(cap, "JScope/J-Link HSS preflight unavailable");
    },
    benchmark(variables, requestedRateHz, durationSec, context = {}) {
      const hss = context.hssAdapter ?? adapter;
      if (!hss?.benchmark) throw new Error("J-Link SDK/HSS benchmark adapter not configured");
      return hss.benchmark(variables, requestedRateHz, durationSec);
    },
  };
}
