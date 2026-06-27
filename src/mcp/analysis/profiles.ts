import {
  AnalysisProfile,
  AnalysisProfileName,
  ExperimentRecord,
  ExperimentSample,
  PatternFinding,
} from "../experiment-contract";

export interface AnalysisOptions {
  windowMs?: [number, number];
}

export interface AnalysisResult {
  profile: AnalysisProfileName;
  summary: {
    verdict: "ok" | "warning";
    mainFindings: string[];
  };
  patterns: PatternFinding[];
  quality: {
    warnings: string[];
  };
}

export const analysisProfiles: AnalysisProfile[] = [
  {
    name: "generic_control",
    domain: "generic",
    status: "implemented",
    patterns: ["step_response", "overshoot", "settling_time", "steady_error", "saturation"],
  },
  {
    name: "generic_state_machine",
    domain: "generic",
    status: "implemented",
    patterns: ["state_transition", "fault_transition", "stuck_signal", "counter_stall", "counter_wrap"],
  },
];

export function listAnalysisProfiles(): AnalysisProfile[] {
  return analysisProfiles;
}

export function analyzeExperiment(record: ExperimentRecord, profile: AnalysisProfileName, options: AnalysisOptions = {}): AnalysisResult {
  const samples = samplesInWindow(record.samples ?? [], options.windowMs ?? record.timeWindowMs);
  const warnings = qualityWarnings(record, samples);
  let patterns: PatternFinding[];
  if (profile === "generic_control") {
    patterns = analyzeGenericControl(record, samples, warnings);
  } else if (profile === "generic_state_machine") {
    patterns = analyzeGenericStateMachine(record, samples, warnings);
  } else {
    throw new Error(`Analysis profile is not implemented: ${profile}`);
  }
  return {
    profile,
    summary: {
      verdict: warnings.length || patterns.some((pattern) => pattern.confidence !== "low") ? "warning" : "ok",
      mainFindings: patterns.map((pattern) => pattern.evidence),
    },
    patterns,
    quality: { warnings },
  };
}

function analyzeGenericControl(record: ExperimentRecord, samples: ExperimentSample[], warnings: string[]): PatternFinding[] {
  const patterns: PatternFinding[] = [];
  const command = record.signals.find((signal) => signal.role === "command");
  const feedback = record.signals.find((signal) => signal.role === "feedback");
  const limit = record.signals.find((signal) => signal.role === "limit");
  if (!feedback) {
    warnings.push("generic_control requires a feedback signal");
    return patterns;
  }
  if (!command) {
    warnings.push("command-response metrics unavailable without a command signal");
  }

  const step = command ? largestStep(samples, command.name) : null;
  if (step) {
    const finalCommand = numberAt(samples[samples.length - 1], command!.name);
    patterns.push({
      type: "step_response",
      signal: command!.name,
      relatedSignals: [feedback.name],
      startMs: step.timeMs,
      endMs: samples[samples.length - 1]?.timeMs,
      value: step.to - step.from,
      unit: command!.unit,
      confidence: "high",
      evidence: `${command!.name} changed from ${step.from} to ${step.to}`,
    });

    if (finalCommand !== null) {
      const afterStep = samples.filter((sample) => sample.timeMs >= step.timeMs);
      const feedbackValues = afterStep.map((sample) => numberAt(sample, feedback.name)).filter((value): value is number => value !== null);
      const maxFeedback = Math.max(...feedbackValues);
      const overshoot = maxFeedback - finalCommand;
      if (Number.isFinite(overshoot) && overshoot > Math.max(Math.abs(finalCommand) * 0.05, 1e-9)) {
        patterns.push({
          type: "overshoot",
          signal: feedback.name,
          relatedSignals: [command!.name],
          startMs: step.timeMs,
          endMs: afterStep.find((sample) => numberAt(sample, feedback.name) === maxFeedback)?.timeMs,
          value: overshoot,
          unit: feedback.unit,
          confidence: "high",
          evidence: `${feedback.name} exceeded final command by ${overshoot}`,
        });
      }

      const lastFeedback = numberAt(samples[samples.length - 1], feedback.name);
      if (lastFeedback !== null) {
        const steadyError = lastFeedback - finalCommand;
        patterns.push({
          type: "steady_error",
          signal: feedback.name,
          relatedSignals: [command!.name],
          startMs: samples[samples.length - 1].timeMs,
          value: steadyError,
          unit: feedback.unit,
          confidence: "high",
          evidence: `${feedback.name} final error is ${steadyError}`,
        });
      }

      const settledAt = settlingTime(afterStep, feedback.name, finalCommand);
      if (settledAt !== null) {
        patterns.push({
          type: "settling_time",
          signal: feedback.name,
          relatedSignals: [command!.name],
          startMs: step.timeMs,
          endMs: settledAt,
          value: settledAt - step.timeMs,
          unit: "ms",
          confidence: "medium",
          evidence: `${feedback.name} settled after ${settledAt - step.timeMs} ms`,
        });
      } else {
        warnings.push(`${feedback.name} did not settle in the analysis window`);
      }
    }
  }

  if (limit && samples.some((sample) => truthy(sample.values[limit.name]))) {
    patterns.push({
      type: "saturation",
      signal: limit.name,
      startMs: samples.find((sample) => truthy(sample.values[limit.name]))?.timeMs,
      confidence: "high",
      evidence: `${limit.name} indicated saturation`,
    });
  }
  return patterns;
}

function analyzeGenericStateMachine(record: ExperimentRecord, samples: ExperimentSample[], warnings: string[]): PatternFinding[] {
  const patterns: PatternFinding[] = [];
  const command = record.signals.find((signal) => signal.role === "command");
  for (const signal of record.signals.filter((item) => item.role === "state")) {
    const transitions = transitionsFor(samples, signal.name);
    patterns.push(...transitions.map((transition) => ({
      type: "state_transition" as const,
      signal: signal.name,
      startMs: transition.timeMs,
      value: `${transition.from}->${transition.to}`,
      confidence: "high" as const,
      evidence: `${signal.name} changed from ${transition.from} to ${transition.to}`,
    })));
    if (!transitions.length && command && largestStep(samples, command.name)) {
      patterns.push({
        type: "stuck_signal",
        signal: signal.name,
        relatedSignals: [command.name],
        startMs: samples[0]?.timeMs,
        endMs: samples[samples.length - 1]?.timeMs,
        confidence: "medium",
        evidence: `${signal.name} did not change while ${command.name} changed`,
      });
    }
  }
  for (const signal of record.signals.filter((item) => item.role === "fault")) {
    patterns.push(...transitionsFor(samples, signal.name)
      .filter((transition) => transition.to !== 0 && transition.to !== "0")
      .map((transition) => ({
        type: "fault_transition" as const,
        signal: signal.name,
        startMs: transition.timeMs,
        value: `${transition.from}->${transition.to}`,
        confidence: "high" as const,
        evidence: `${signal.name} changed from ${transition.from} to ${transition.to}`,
      })));
  }
  for (const signal of record.signals.filter((item) => item.role === "counter")) {
    const values = samples.map((sample) => ({ timeMs: sample.timeMs, value: numberAt(sample, signal.name) })).filter((item): item is { timeMs: number; value: number } => item.value !== null);
    if (values.some((item, index) => index > 0 && item.value < values[index - 1].value)) {
      patterns.push({
        type: "counter_wrap",
        signal: signal.name,
        confidence: "medium",
        evidence: `${signal.name} decreased during the window`,
      });
    } else if (values.length >= 3 && values.every((item) => item.value === values[0].value)) {
      patterns.push({
        type: "counter_stall",
        signal: signal.name,
        startMs: values[0].timeMs,
        endMs: values[values.length - 1].timeMs,
        confidence: "medium",
        evidence: `${signal.name} did not advance`,
      });
    } else {
      const stall = repeatedTail(values);
      if (stall) {
        patterns.push({
          type: "counter_stall",
          signal: signal.name,
          startMs: stall.startMs,
          endMs: values[values.length - 1].timeMs,
          confidence: "medium",
          evidence: `${signal.name} stopped advancing`,
        });
      }
    }
  }
  if (!patterns.length) warnings.push("no state, fault, or counter transitions detected");
  return patterns;
}

function samplesInWindow(samples: ExperimentSample[], windowMs?: [number, number]): ExperimentSample[] {
  const filtered = windowMs ? samples.filter((sample) => sample.timeMs >= windowMs[0] && sample.timeMs <= windowMs[1]) : samples;
  return [...filtered].sort((a, b) => a.timeMs - b.timeMs);
}

function qualityWarnings(record: ExperimentRecord, samples: ExperimentSample[]): string[] {
  const warnings: string[] = [];
  if (!samples.length) warnings.push("experiment has no samples in the analysis window");
  const requested = record.capture?.requestedRateHz;
  const actual = record.capture?.actualRateHz;
  if (requested && actual && actual < requested) warnings.push(`actual sample rate ${actual} Hz is below requested ${requested} Hz`);
  return warnings;
}

function largestStep(samples: ExperimentSample[], signal: string): { timeMs: number; from: number; to: number } | null {
  let best: { timeMs: number; from: number; to: number; delta: number } | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const from = numberAt(samples[index - 1], signal);
    const to = numberAt(samples[index], signal);
    if (from === null || to === null) continue;
    const delta = Math.abs(to - from);
    if (delta > (best?.delta ?? 0)) best = { timeMs: samples[index].timeMs, from, to, delta };
  }
  return best && best.delta > 0 ? best : null;
}

function transitionsFor(samples: ExperimentSample[], signal: string): Array<{ timeMs: number; from: number | string | boolean | null; to: number | string | boolean | null }> {
  const transitions: Array<{ timeMs: number; from: number | string | boolean | null; to: number | string | boolean | null }> = [];
  for (let index = 1; index < samples.length; index += 1) {
    const from = samples[index - 1].values[signal];
    const to = samples[index].values[signal];
    if (from !== to) transitions.push({ timeMs: samples[index].timeMs, from, to });
  }
  return transitions;
}

function settlingTime(samples: ExperimentSample[], signal: string, target: number): number | null {
  const tolerance = Math.max(Math.abs(target) * 0.02, 1e-9);
  for (let index = 0; index < samples.length; index += 1) {
    const tail = samples.slice(index);
    if (tail.every((sample) => {
      const value = numberAt(sample, signal);
      return value !== null && Math.abs(value - target) <= tolerance;
    })) return samples[index].timeMs;
  }
  return null;
}

function numberAt(sample: ExperimentSample | undefined, signal: string): number | null {
  const value = sample?.values[signal];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function repeatedTail(values: Array<{ timeMs: number; value: number }>): { startMs: number } | null {
  let first = values.length - 1;
  while (first > 0 && values[first - 1].value === values[values.length - 1].value) first -= 1;
  return values.length - first >= 3 ? { startMs: values[first].timeMs } : null;
}

function truthy(value: unknown): boolean {
  return value === true || (typeof value === "number" && value !== 0) || (typeof value === "string" && value.length > 0 && value !== "0");
}
