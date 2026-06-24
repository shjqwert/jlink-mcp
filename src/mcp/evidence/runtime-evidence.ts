import {
  ExperimentRecord,
  PatternFinding,
  RuntimeEvidence,
  SignalDefinition,
  SignalRole,
  runtimeEvidenceSchema,
} from "../experiment-contract";
import { questionsForPattern, selectorHints } from "../bridge/queries";

export interface EvidenceSignal {
  name: string;
  role: SignalRole;
  selector?: string;
  symbol?: string;
  fileHint?: string;
}

export interface AnalysisForEvidence {
  experimentId?: string;
  summary?: {
    verdict?: string;
    mainFindings?: string[];
  };
  patterns: PatternFinding[];
}

export function buildRuntimeEvidence(record: ExperimentRecord, analysis: AnalysisForEvidence): RuntimeEvidence[] {
  const experimentId = analysis.experimentId ?? record.experimentId;
  return analysis.patterns.map((pattern, index) => {
    const evidenceId = stableEvidenceId(experimentId, pattern.type, index);
    const signals = involvedSignals(record, pattern).map(selectorHints);
    const summary = pattern.evidence;
    return runtimeEvidenceSchema.parse({
      evidenceId,
      experimentId,
      summary,
      severity: severityFor(pattern),
      timeWindowMs: pattern.startMs === undefined ? undefined : [pattern.startMs, pattern.endMs ?? pattern.startMs],
      signals,
      patterns: [pattern.type],
      codeHints: signals
        .filter((signal) => signal.selector)
        .map((signal) => ({
          symbol: signal.symbol,
          fileHint: signal.fileHint,
          selector: signal.selector,
          reason: `${signal.name} (${signal.role}) is involved in ${pattern.type}`,
        })),
      questionsForCodeGraph: questionsForPattern(experimentId, evidenceId, pattern, signals, summary),
      artifacts: record.artifacts,
    });
  });
}

function involvedSignals(record: ExperimentRecord, pattern: PatternFinding): SignalDefinition[] {
  const names = new Set([pattern.signal, ...(pattern.relatedSignals ?? [])].filter((name): name is string => Boolean(name)));
  return record.signals.filter((signal) => names.has(signal.name));
}

function severityFor(pattern: PatternFinding): RuntimeEvidence["severity"] {
  if (["fault_transition", "overshoot", "saturation", "stuck_signal", "counter_stall"].includes(pattern.type)) return "warning";
  return pattern.confidence === "low" ? "info" : "warning";
}

function stableEvidenceId(experimentId: string, patternType: string, index: number): string {
  return `ev_${experimentId}_${patternType}_${index + 1}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
}
