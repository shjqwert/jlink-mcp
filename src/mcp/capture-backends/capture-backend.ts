export const backendNames = ["jlink-hss", "direct-rtt-channel", "memory-poll-rsp", "external-import"] as const;
export type CaptureBackendName = typeof backendNames[number];

export const preferredBackendOrder: CaptureBackendName[] = ["jlink-hss", "direct-rtt-channel", "memory-poll-rsp", "external-import"];

export type BackendStatus = "available" | "unavailable" | "available-if-configured";
export type BackendMode = "realtime" | "offline-import";
export type HssValidationStatus =
  | "blocked_missing_adapter"
  | "experimental_getcaps_pass"
  | "experimental_read_pass"
  | "experimental_benchmark_pass"
  | "official_sdk_ready";

export interface BackendCapability {
  name: CaptureBackendName;
  priority: number;
  requiresFirmware: boolean;
  requiresTargetCodeChange: boolean;
  requiresSDK: boolean;
  requiresExternalTool: boolean;
  supportsRead: boolean;
  supportsWrite: boolean;
  supportsStreaming: boolean;
  supportsRunWhileTargetRunning: boolean;
  supportsExperimentExport: boolean;
  expectedUse: string;
}

export interface BackendProbeResult extends BackendCapability {
  status: BackendStatus;
  reason: string;
  warnings: string[];
  preflight?: Record<string, unknown>;
  headlessBenchmark?: {
    status: "available" | "blocked" | "not_tested";
    reason: string;
    artifact?: string;
  };
  sdkPrototype?: {
    status: "found" | "missing";
    headerPath?: string;
    evidence?: string;
  };
  hssValidationState?: {
    status: HssValidationStatus;
    benchmarkReady: boolean;
    publicPrototypeCandidate?: boolean;
    experimentalEnvEnabled?: boolean;
    reason: string;
  };
}

export interface BackendBenchmarkResult {
  backendName: CaptureBackendName;
  variables: string[];
  requestedRateHz: number;
  actualRateHz: number;
  successRate: number;
  missedSamples: number;
  readErrors: number;
  jitter: {
    minMs: number;
    maxMs: number;
    avgMs: number;
  };
  durationSec: number;
  warnings: string[];
}

export interface RttChannelProbe {
  index: number;
  name?: string;
}

export interface RttProbeSnapshot {
  controlBlockAddress?: string;
  upChannels: RttChannelProbe[];
  downChannels: RttChannelProbe[];
  requestedChannel?: number;
  requestedChannelName?: string;
}

export interface HssAdapter {
  isAvailable(sdkDir: string): boolean;
  preflight?(sdkDir: string): Record<string, unknown>;
  benchmark?(variables: string[], requestedRateHz: number, durationSec: number): BackendBenchmarkResult;
}

export interface BackendProbeContext {
  env?: Record<string, string | undefined>;
  mode?: BackendMode;
  preferredBackend?: CaptureBackendName;
  rtt?: RttProbeSnapshot;
  hssAdapter?: HssAdapter;
}

export interface CaptureBackend {
  capability: BackendCapability;
  probe(context?: BackendProbeContext): BackendProbeResult;
  benchmark?(variables: string[], requestedRateHz: number, durationSec: number, context?: BackendProbeContext): BackendBenchmarkResult;
}

export function unavailable(capability: BackendCapability, reason: string, warnings: string[] = []): BackendProbeResult {
  return { ...capability, status: "unavailable", reason, warnings };
}

export function available(capability: BackendCapability, reason = "available", warnings: string[] = []): BackendProbeResult {
  return { ...capability, status: "available", reason, warnings };
}

export function capability(
  name: CaptureBackendName,
  priority: number,
  expectedUse: string,
  options: Partial<Omit<BackendCapability, "name" | "priority" | "expectedUse">>,
): BackendCapability {
  return {
    name,
    priority,
    expectedUse,
    requiresFirmware: options.requiresFirmware ?? false,
    requiresTargetCodeChange: options.requiresTargetCodeChange ?? false,
    requiresSDK: options.requiresSDK ?? false,
    requiresExternalTool: options.requiresExternalTool ?? false,
    supportsRead: options.supportsRead ?? true,
    supportsWrite: options.supportsWrite ?? false,
    supportsStreaming: options.supportsStreaming ?? false,
    supportsRunWhileTargetRunning: options.supportsRunWhileTargetRunning ?? false,
    supportsExperimentExport: options.supportsExperimentExport ?? true,
  };
}
