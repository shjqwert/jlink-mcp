import { z } from "zod";
import {
  AnalysisProfileName,
  ExperimentRecord,
  ExperimentSample,
  MetricName,
  PatternFinding,
  metricNameSchema,
  signalRoleSchema,
} from "../experiment-contract";
import { LoadedExperiment, LoadExperimentInput, loadExperimentForAnalysis } from "../experiment-store";
import { AnalysisResult, analyzeExperiment, listAnalysisProfiles } from "./profiles";

interface ToolError {
  error: {
    code: "validation_error" | "not_found";
    message: string;
    issues?: Array<{ path: Array<string | number>; message: string }>;
  };
}

export interface ExperimentAnalyzeOutput {
  experimentId: string;
  analysisProfile: AnalysisProfileName;
  selectedSignals: string[];
  summary: AnalysisResult["summary"];
  patterns: PatternFinding[];
  quality: {
    warnings: string[];
  };
}

export interface ExperimentCompareOutput {
  baselineExperimentId: string;
  candidateExperimentId: string;
  analysisProfile: AnalysisProfileName;
  summary: {
    verdict: "improved" | "regressed" | "unchanged" | "warning";
    changes: string[];
  };
  metricDiffs: Array<{
    metric: MetricName;
    baseline: number;
    candidate: number;
    direction: "improved" | "regressed" | "unchanged";
  }>;
  quality: {
    warnings: string[];
  };
}

const analysisInputSchema = z.object({
  experimentId: z.string().min(1).max(128).optional(),
  fixturePath: z.string().min(1).max(1024).optional(),
  experimentPath: z.string().min(1).max(1024).optional(),
  metadataFile: z.string().min(1).max(1024).optional(),
  captureId: z.string().min(1).max(64).optional(),
  outputDir: z.string().min(1).max(1024).optional(),
  analysisProfile: z.string().min(1).max(128),
  signals: z.array(z.string().min(1).max(128)).optional(),
  signalRoles: z.record(z.string(), signalRoleSchema).optional(),
  windowMs: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]).optional(),
  maxSamples: z.number().int().min(1).max(100000).optional(),
}).strict().superRefine((input, context) => {
  if (!input.experimentId && !input.fixturePath && !input.experimentPath && !input.metadataFile && !input.captureId) {
    context.addIssue({ code: "custom", path: ["experimentId"], message: "experimentId, fixturePath, experimentPath, metadataFile, or captureId is required" });
  }
  if (input.captureId && !input.outputDir) {
    context.addIssue({ code: "custom", path: ["outputDir"], message: "outputDir is required with captureId" });
  }
  if (input.windowMs && input.windowMs[1] < input.windowMs[0]) {
    context.addIssue({ code: "custom", path: ["windowMs"], message: "windowMs end must be greater than or equal to start" });
  }
});

const compareInputSchema = z.object({
  baselineExperimentId: z.string().min(1).max(128).optional(),
  baselineExperimentPath: z.string().min(1).max(1024).optional(),
  baselineMetadataFile: z.string().min(1).max(1024).optional(),
  candidateExperimentId: z.string().min(1).max(128).optional(),
  candidateExperimentPath: z.string().min(1).max(1024).optional(),
  candidateMetadataFile: z.string().min(1).max(1024).optional(),
  analysisProfile: z.string().min(1).max(128),
  metrics: z.array(metricNameSchema).min(1).optional(),
  signalRoles: z.record(z.string(), signalRoleSchema).optional(),
  windowMs: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]).optional(),
  maxSamples: z.number().int().min(1).max(100000).optional(),
}).strict().superRefine((input, context) => {
  if (!input.baselineExperimentId && !input.baselineExperimentPath && !input.baselineMetadataFile) {
    context.addIssue({ code: "custom", path: ["baselineExperimentId"], message: "baseline experiment source is required" });
  }
  if (!input.candidateExperimentId && !input.candidateExperimentPath && !input.candidateMetadataFile) {
    context.addIssue({ code: "custom", path: ["candidateExperimentId"], message: "candidate experiment source is required" });
  }
});

export function analysisProfilesTool(): { profiles: ReturnType<typeof listAnalysisProfiles> } {
  return { profiles: listAnalysisProfiles() };
}

export async function experimentAnalyzeTool(input: unknown): Promise<ExperimentAnalyzeOutput | ToolError> {
  const parsed = analysisInputSchema.safeParse(input);
  if (!parsed.success) return validationError("Invalid experiment_analyze input", parsed.error);
  const profile = implementedProfile(parsed.data.analysisProfile);
  if (!profile) return validationError(`Unknown or unimplemented analysisProfile: ${parsed.data.analysisProfile}`);

  const loaded = await loadForTool({
    ...parsed.data,
    variables: parsed.data.signals,
    startSec: parsed.data.windowMs?.[0] === undefined ? undefined : parsed.data.windowMs[0] / 1000,
    endSec: parsed.data.windowMs?.[1] === undefined ? undefined : parsed.data.windowMs[1] / 1000,
  });
  if ("error" in loaded) return loaded;

  const selected = selectSignals(loaded.record, parsed.data.signals);
  const record = {
    ...selected.record,
    timeWindowMs: parsed.data.windowMs ?? selected.record.timeWindowMs,
  };
  const result = analyzeExperiment(record, profile);
  return {
    experimentId: loaded.experimentId,
    analysisProfile: profile,
    selectedSignals: selected.selectedSignals,
    summary: result.summary,
    patterns: result.patterns,
    quality: { warnings: [...loaded.qualityWarnings, ...selected.warnings, ...result.quality.warnings] },
  };
}

export async function experimentCompareTool(input: unknown): Promise<ExperimentCompareOutput | ToolError> {
  const parsed = compareInputSchema.safeParse(input);
  if (!parsed.success) return validationError("Invalid experiment_compare input", parsed.error);
  const profile = implementedProfile(parsed.data.analysisProfile);
  if (!profile) return validationError(`Unknown or unimplemented analysisProfile: ${parsed.data.analysisProfile}`);

  const baseline = await loadForTool({
    experimentId: parsed.data.baselineExperimentId,
    experimentPath: parsed.data.baselineExperimentPath,
    metadataFile: parsed.data.baselineMetadataFile,
    signalRoles: parsed.data.signalRoles,
    startSec: parsed.data.windowMs?.[0] === undefined ? undefined : parsed.data.windowMs[0] / 1000,
    endSec: parsed.data.windowMs?.[1] === undefined ? undefined : parsed.data.windowMs[1] / 1000,
    maxSamples: parsed.data.maxSamples,
  });
  if ("error" in baseline) return baseline;
  const candidate = await loadForTool({
    experimentId: parsed.data.candidateExperimentId,
    experimentPath: parsed.data.candidateExperimentPath,
    metadataFile: parsed.data.candidateMetadataFile,
    signalRoles: parsed.data.signalRoles,
    startSec: parsed.data.windowMs?.[0] === undefined ? undefined : parsed.data.windowMs[0] / 1000,
    endSec: parsed.data.windowMs?.[1] === undefined ? undefined : parsed.data.windowMs[1] / 1000,
    maxSamples: parsed.data.maxSamples,
  });
  if ("error" in candidate) return candidate;

  const baselineResult = analyzeExperiment({ ...baseline.record, timeWindowMs: parsed.data.windowMs ?? baseline.record.timeWindowMs }, profile);
  const candidateResult = analyzeExperiment({ ...candidate.record, timeWindowMs: parsed.data.windowMs ?? candidate.record.timeWindowMs }, profile);
  const warnings = [...baseline.qualityWarnings, ...candidate.qualityWarnings, ...baselineResult.quality.warnings, ...candidateResult.quality.warnings];
  const metrics = parsed.data.metrics ?? [...new Set([...baselineResult.patterns, ...candidateResult.patterns].map((pattern) => pattern.type))]
    .filter((metric): metric is MetricName => metricNameSchema.safeParse(metric).success);
  const metricDiffs: ExperimentCompareOutput["metricDiffs"] = [];
  for (const metric of metrics) {
    if (metricDirection[metric] === "neutral") {
      warnings.push(`${metric} is neutral without configured comparison semantics`);
      continue;
    }
    const baselineValue = metricValue(baselineResult, metric);
    const candidateValue = metricValue(candidateResult, metric);
    if (baselineValue === null || candidateValue === null) {
      warnings.push(`${metric} unavailable in one or both experiments`);
      continue;
    }
    metricDiffs.push({
      metric,
      baseline: baselineValue,
      candidate: candidateValue,
      direction: directionFor(metric, baselineValue, candidateValue),
    });
  }

  const changes = metricDiffs
    .filter((diff) => diff.direction !== "unchanged")
    .map((diff) => `${diff.metric} ${diff.direction === "improved" ? "reduced" : "increased"}`);
  return {
    baselineExperimentId: baseline.experimentId,
    candidateExperimentId: candidate.experimentId,
    analysisProfile: profile,
    summary: {
      verdict: metricDiffs.some((diff) => diff.direction === "regressed")
        ? "regressed"
        : metricDiffs.some((diff) => diff.direction === "improved")
          ? "improved"
          : warnings.length
            ? "warning"
            : "unchanged",
      changes,
    },
    metricDiffs,
    quality: { warnings },
  };
}

function implementedProfile(value: string): AnalysisProfileName | null {
  return listAnalysisProfiles().some((profile) => profile.name === value && profile.status === "implemented")
    ? value as AnalysisProfileName
    : null;
}

async function loadForTool(input: LoadExperimentInput): Promise<LoadedExperiment | ToolError> {
  try {
    return await loadExperimentForAnalysis(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /not found/i.test(message) ? notFound(message) : validationError(message);
  }
}

function selectSignals(record: ExperimentRecord, requested?: string[]): { record: ExperimentRecord; selectedSignals: string[]; warnings: string[] } {
  if (!requested?.length) return { record, selectedSignals: record.signals.map((signal) => signal.name), warnings: [] };
  const selected = new Set(requested);
  const signals = record.signals.filter((signal) => selected.has(signal.name));
  const selectedSignals = signals.map((signal) => signal.name);
  const warnings = requested.filter((name) => !selectedSignals.includes(name)).map((name) => `requested signal not found: ${name}`);
  return {
    record: {
      ...record,
      signals,
      samples: record.samples?.map((sample) => filterSample(sample, selectedSignals)),
    },
    selectedSignals,
    warnings,
  };
}

function filterSample(sample: ExperimentSample, selectedSignals: string[]): ExperimentSample {
  return {
    timeMs: sample.timeMs,
    values: Object.fromEntries(selectedSignals.map((name) => [name, sample.values[name]]).filter(([, value]) => value !== undefined)),
  };
}

function metricValue(result: AnalysisResult, metric: MetricName): number | null {
  const found = result.patterns.filter((pattern) => pattern.type === metric);
  const numeric = found.find((pattern) => typeof pattern.value === "number")?.value;
  if (typeof numeric === "number") return numeric;
  if (found.length) return found.length;
  if (metric === "overshoot" && result.patterns.some((pattern) => pattern.type === "step_response")) return 0;
  if (metric === "saturation") return 0;
  return null;
}

const metricDirection: Record<MetricName, "lower" | "absoluteLower" | "neutral"> = {
  overshoot: "lower",
  settling_time: "lower",
  steady_error: "absoluteLower",
  saturation: "lower",
  state_transition: "neutral",
  fault_transition: "lower",
  stuck_signal: "lower",
  counter_stall: "lower",
  counter_wrap: "lower",
};

function directionFor(metric: MetricName, baseline: number, candidate: number): "improved" | "regressed" | "unchanged" {
  const baselineScore = metricDirection[metric] === "absoluteLower" ? Math.abs(baseline) : baseline;
  const candidateScore = metricDirection[metric] === "absoluteLower" ? Math.abs(candidate) : candidate;
  if (candidateScore < baselineScore) return "improved";
  if (candidateScore > baselineScore) return "regressed";
  return "unchanged";
}

function validationError(message: string, error?: z.ZodError): ToolError {
  return {
    error: {
      code: "validation_error",
      message,
      issues: error?.issues.map((issue) => ({
        path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
        message: issue.message,
      })),
    },
  };
}

function notFound(message: string): ToolError {
  return { error: { code: "not_found", message } };
}
