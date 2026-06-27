import {
  type BackendBenchmarkResult,
  type BackendProbeContext,
  type BackendProbeResult,
  type CaptureBackend,
  type CaptureBackendName,
  preferredBackendOrder,
} from "./capture-backend";
import { createDirectRttChannelBackend } from "./direct-rtt-channel-backend";
import { createExternalImportBackend } from "./external-import-backend";
import { createJlinkHssBackend } from "./jlink-hss-backend";
import { EnvJlinkHssAdapter } from "./jlink-hss-adapter";
import { createMemoryPollRspBackend } from "./memory-poll-rsp-backend";

export interface BackendProbeReport {
  preferredOrder: CaptureBackendName[];
  selectedBackend: CaptureBackendName | null;
  fallbackFrom: CaptureBackendName[];
  fallbackReason?: string;
  unavailableReasons: Partial<Record<CaptureBackendName, string>>;
  lowRateWarning?: string;
  backends: BackendProbeResult[];
  warnings: string[];
}

export function createDefaultCaptureBackends(context: BackendProbeContext = {}): CaptureBackend[] {
  return [
    createJlinkHssBackend(context.hssAdapter ?? new EnvJlinkHssAdapter()),
    createDirectRttChannelBackend(),
    createMemoryPollRspBackend(),
    createExternalImportBackend(),
  ];
}

export function probeCaptureBackends(context: BackendProbeContext = {}, backends = createDefaultCaptureBackends(context)): BackendProbeReport {
  const results = backends.map((backend) => backend.probe(context)).sort((a, b) => a.priority - b.priority);
  const warnings = results.flatMap((backend) => backend.warnings);

  if (context.preferredBackend) {
    const preferred = results.find((backend) => backend.name === context.preferredBackend);
    if (!preferred) {
      return report(results, null, [`preferred backend ${context.preferredBackend} is unknown`]);
    }
    warnings.push(`preferred backend override requested: ${context.preferredBackend}`);
    if (preferred.status !== "available") {
      warnings.push(`preferred backend ${context.preferredBackend} unavailable: ${preferred.reason}`);
      return report(results, null, warnings);
    }
    return report(results, preferred.name, warnings);
  }

  const selected = results.find((backend) => backend.status === "available" && (backend.name !== "external-import" || context.mode === "offline-import"));
  return report(results, selected?.name ?? null, warnings);
}

function report(results: BackendProbeResult[], selectedBackend: CaptureBackendName | null, warnings: string[]): BackendProbeReport {
  const selected = results.find((backend) => backend.name === selectedBackend);
  const fallbackFrom = selected
    ? results.filter((backend) => backend.priority < selected.priority && backend.status !== "available").map((backend) => backend.name)
    : [];
  const unavailableReasons = Object.fromEntries(results
    .filter((backend) => backend.status !== "available")
    .map((backend) => [backend.name, backend.reason])) as Partial<Record<CaptureBackendName, string>>;
  const rsp = selectedBackend === "memory-poll-rsp" ? selected : undefined;
  const lowRateWarning = rsp?.warnings.find((warning) => /low-rate fallback/i.test(warning));
  return {
    preferredOrder: preferredBackendOrder,
    selectedBackend,
    fallbackFrom,
    fallbackReason: fallbackFrom.length > 0 ? fallbackFrom.map((name) => `${name}: ${unavailableReasons[name]}`).join("; ") : undefined,
    unavailableReasons,
    lowRateWarning,
    backends: results,
    warnings,
  };
}

export function captureBackendListTool(context: BackendProbeContext = {}): BackendProbeReport {
  return probeCaptureBackends(context);
}

export function captureBackendProbeTool(context: BackendProbeContext = {}): BackendProbeReport {
  return probeCaptureBackends(context);
}

export function captureBackendSelectTool(context: BackendProbeContext = {}): BackendProbeReport {
  return probeCaptureBackends(context);
}

export function captureBackendBenchmarkTool(input: {
  backendName?: CaptureBackendName;
  variables?: string[];
  requestedRateHz?: number;
  durationSec?: number;
  context?: BackendProbeContext;
} = {}): BackendBenchmarkResult {
  const context = input.context ?? {};
  const variables = input.variables ?? [];
  const requestedRateHz = input.requestedRateHz ?? 50;
  const durationSec = input.durationSec ?? 1;
  const report = probeCaptureBackends(context);
  const backendName = input.backendName ?? report.selectedBackend;
  const backend = createDefaultCaptureBackends(context).find((candidate) => candidate.capability.name === backendName);
  if (!backendName || !backend) throw new Error("No available backend selected for benchmark");
  if (!backend.benchmark) throw new Error(`${backendName} benchmark is unavailable without a configured transport/adapter`);
  return backend.benchmark(variables, requestedRateHz, durationSec, context);
}

export function captureImportExperimentTool(input: { sourcePath: string; format: "csv" | "json" | "experiment" }): { backend: CaptureBackendName; accepted: boolean; sourcePath: string; format: string } {
  const report = probeCaptureBackends({ mode: "offline-import", preferredBackend: "external-import" });
  if (report.selectedBackend !== "external-import") throw new Error("external-import backend unavailable");
  return { backend: "external-import", accepted: true, sourcePath: input.sourcePath, format: input.format };
}
