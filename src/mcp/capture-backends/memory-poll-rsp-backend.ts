import { available, capability, type BackendBenchmarkResult, type CaptureBackend } from "./capture-backend";

export const memoryPollWarning = "memory-poll-rsp is a low-rate fallback and may not satisfy motor-loop high-speed capture";

export function createMemoryPollRspBackend(): CaptureBackend {
  const cap = capability("memory-poll-rsp", 3, "low-rate fallback", {
    requiresFirmware: false,
    requiresTargetCodeChange: false,
    supportsRead: true,
    supportsWrite: false,
    supportsStreaming: false,
    supportsRunWhileTargetRunning: false,
  });

  return {
    capability: cap,
    probe() {
      return available(cap, "available as low-rate fallback", [memoryPollWarning]);
    },
    benchmark(variables: string[], requestedRateHz: number, durationSec: number): BackendBenchmarkResult {
      const actualRateHz = Math.min(requestedRateHz, 10);
      return {
        backendName: "memory-poll-rsp",
        variables,
        requestedRateHz,
        actualRateHz,
        successRate: 1,
        missedSamples: Math.max(0, Math.round((requestedRateHz - actualRateHz) * durationSec)),
        readErrors: 0,
        jitter: { minMs: 0, maxMs: actualRateHz > 0 ? 1000 / actualRateHz : 0, avgMs: actualRateHz > 0 ? 1000 / actualRateHz : 0 },
        durationSec,
        warnings: [memoryPollWarning],
      };
    },
  };
}
