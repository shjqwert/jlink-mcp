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
      const preflight = hss.preflight?.(sdkDir) ?? {};
      if (!hss.isAvailable(sdkDir)) {
        return {
          ...unavailable(cap, "JScope/J-Link HSS preflight unavailable"),
          preflight,
          headlessBenchmark: { status: "not_tested", reason: "HSS preflight unavailable" },
          sdkPrototype: { status: "missing", evidence: "typed JLINK_HSS_* prototypes not found" },
        };
      }
      const benchmark = (hss as HssAdapter).benchmark;
      if (!benchmark) {
        return {
          ...cap,
          status: "available-if-configured" as const,
          reason: "HSS preflight available, headless benchmark blocked: missing typed JLINK_HSS prototypes",
          warnings: ["JScope/J-Link HSS preflight is not a headless HSS benchmark."],
          preflight,
          headlessBenchmark: { status: "blocked", reason: "missing typed JLINK_HSS prototypes" },
          sdkPrototype: { status: "missing", evidence: "No trusted local JLINK_HSS_* header/prototype evidence is configured" },
        };
      }
      return {
        ...available(cap, "typed HSS adapter benchmark available"),
        preflight,
        headlessBenchmark: { status: "available", reason: "typed HSS adapter benchmark is configured" },
        sdkPrototype: { status: "found", evidence: "test or typed adapter exposes benchmark()" },
      };
    },
    benchmark(variables, requestedRateHz, durationSec, context = {}) {
      const hss = context.hssAdapter ?? adapter;
      if (!hss?.benchmark) throw new Error("J-Link SDK/HSS benchmark adapter not configured");
      return hss.benchmark(variables, requestedRateHz, durationSec);
    },
  };
}
