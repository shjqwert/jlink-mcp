import { CodeGraphQuestion, PatternFinding, SignalDefinition } from "../experiment-contract";
import type { EvidenceSignal } from "../evidence/runtime-evidence";

export interface BridgeQuery {
  query: string;
  symbols: string[];
  files: string[];
  reason: string;
}

export function questionsForPattern(
  experimentId: string,
  evidenceId: string,
  pattern: PatternFinding,
  signals: EvidenceSignal[],
  reason: string,
): CodeGraphQuestion[] {
  const roles = new Set(signals.map((signal) => signal.role));
  const symbols = unique(signals.map((signal) => signal.rootSymbol ?? signal.symbol).filter((value): value is string => Boolean(value)));
  const fileHints = unique(signals.map((signal) => signal.fileHint).filter((value): value is string => Boolean(value)));
  const names = signals.map((signal) => signal.displaySymbol ?? signal.symbol ?? signal.name).join(", ") || (pattern.signal ?? pattern.type);
  const base = { symbols, fileHints, reason, experimentId, evidenceId };
  const questions: CodeGraphQuestion[] = [];

  if (roles.has("command") && roles.has("feedback")) {
    questions.push({
      query: `Find writers of command/feedback signals ${names} and the call path to the periodic control-loop update.`,
      ...base,
    });
  }
  if (pattern.type === "overshoot") {
    questions.push({
      query: `Find the PI/PID or feedback-control update for ${names}, including clamp, limit, or saturation handling.`,
      ...base,
    });
  }
  if (pattern.type === "fault_transition") {
    questions.push({
      query: `Find where fault signal ${names} is defined, assigned, reported, and cleared.`,
      ...base,
    });
  }
  if (pattern.type === "stuck_signal") {
    questions.push({
      query: `Find update functions and interrupt/task paths that should change stuck signal ${names}.`,
      ...base,
    });
  }
  if (!questions.length) {
    questions.push({
      query: `Find writers, readers, and update path for runtime signal ${names} related to ${pattern.type}.`,
      ...base,
    });
  }
  return questions;
}

export function bridgeQueriesFromQuestions(questions: CodeGraphQuestion[]): BridgeQuery[] {
  return questions.map((question) => ({
    query: question.query,
    symbols: question.symbols,
    files: question.fileHints,
    reason: question.reason,
  }));
}

export function selectorHints(signal: SignalDefinition): EvidenceSignal {
  const [fileHint, symbolPath] = signal.selector?.includes("::")
    ? signal.selector.split("::", 2)
    : [undefined, signal.selector];
  const [rootSymbol, ...members] = symbolPath?.split(".") ?? [];
  return {
    name: signal.name,
    role: signal.role,
    selector: signal.selector,
    symbol: rootSymbol,
    rootSymbol,
    memberPath: members.length ? members.join(".") : undefined,
    displaySymbol: symbolPath,
    fileHint,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
