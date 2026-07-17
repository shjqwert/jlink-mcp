import { createHash } from "node:crypto";
import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";

export const ANALYSIS_V0_MAX_POINTS = 65_536;
export type AnalysisV0Profile = "generic_control" | "generic_state_machine";
export type AnalysisV0Role = "command" | "feedback" | "state";

export class AnalysisV0Error extends Error {
  readonly code = "JCAP_ANALYSIS_INVALID";
}

export interface AnalysisV0Point {
  sampleIndex: number;
  tick: string;
  statusFlags: number;
  variable: string;
  value: number;
}

export interface AnalysisV0Event extends Record<string, unknown> {
  eventId: string;
  type: string;
  tick: string;
}

export interface AnalysisV0Source {
  file: string;
  sha256: string;
  bytes: number;
  validBytes: number;
}

export interface AnalysisV0Input {
  captureId: string;
  profile: AnalysisV0Profile;
  signalRoles: Record<string, AnalysisV0Role>;
  window: { startTick: string; endTick: string; eventId?: string };
  points: AnalysisV0Point[];
  events: AnalysisV0Event[];
  rawSources: AnalysisV0Source[];
}

export interface AnalysisV0Result extends Record<string, unknown> {
  analysisRunId: string;
  schema: { name: "jlink-mcp-analysis-run"; version: 0 };
  analyzerVersion: "analysis-v0";
  profile: { name: AnalysisV0Profile; version: 0 };
  captureId: string;
  window: AnalysisV0Input["window"];
  signals: Array<{ variable: string; role: AnalysisV0Role }>;
  quality: Record<string, number>;
  findings: Array<Record<string, unknown>>;
  warnings: string[];
  suggestions: string[];
  confidence: "high" | "medium" | "low";
  explanation: string;
  rawSources: AnalysisV0Source[];
}

const INVALID_FLAGS = HSS_STATUS_FLAGS.read_error
  | HSS_STATUS_FLAGS.timeout
  | HSS_STATUS_FLAGS.overflow
  | HSS_STATUS_FLAGS.dropped_before_this_sample
  | HSS_STATUS_FLAGS.target_halted
  | HSS_STATUS_FLAGS.write_nearby
  | HSS_STATUS_FLAGS.write_in_progress
  | HSS_STATUS_FLAGS.backend_busy;

export function analyzeJcapV0(input: AnalysisV0Input): AnalysisV0Result {
  if (input.points.length > ANALYSIS_V0_MAX_POINTS) throw new AnalysisV0Error(`analysis point limit exceeded: ${ANALYSIS_V0_MAX_POINTS}`);
  if (input.points.some((point) => !Number.isFinite(point.value))) throw new AnalysisV0Error("analysis rejects non-finite values");

  const signals = Object.entries(input.signalRoles)
    .sort(([left], [right]) => ordinal(left, right))
    .map(([variable, role]) => ({ variable, role }));
  const rawSources = [...input.rawSources].sort((left, right) => ordinal(left.file, right.file));
  const points = [...input.points].sort((left, right) => compareTick(left.tick, right.tick)
    || left.sampleIndex - right.sampleIndex
    || ordinal(left.variable, right.variable));
  const events = [...input.events].sort((left, right) => compareTick(left.tick, right.tick)
    || ordinal(left.eventId, right.eventId));
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const findings: Array<Record<string, unknown>> = [];
  const invalidPoints = points.filter((point) => !valid(point));
  const barrierEvents = events.filter((event) => event.type === "quality" || event.type === "flag");

  if (invalidPoints.length) warnings.push(`${invalidPoints.length} invalid-quality points split inference windows`);
  if (barrierEvents.length) warnings.push(`${barrierEvents.length} quality/flag events split inference windows`);

  if (input.profile === "generic_control") analyzeControl(input, points, events, barrierEvents, findings, warnings, suggestions);
  else analyzeState(input, points, barrierEvents, findings, warnings, suggestions);

  const digestInput = {
    analyzerVersion: "analysis-v0",
    captureId: input.captureId,
    profile: input.profile,
    rawSources,
    signalRoles: Object.fromEntries(signals.map(({ variable, role }) => [variable, role])),
    window: input.window,
  };
  const analysisRunId = createHash("sha256").update(canonicalJson(digestInput)).digest("hex");
  const confidence = findings.length === 0 ? "low" : warnings.length === 0 ? "high" : "medium";
  return {
    analysisRunId,
    schema: { name: "jlink-mcp-analysis-run", version: 0 },
    analyzerVersion: "analysis-v0",
    profile: { name: input.profile, version: 0 },
    captureId: input.captureId,
    window: input.window,
    signals,
    quality: {
      pointCount: points.length,
      validPointCount: points.length - invalidPoints.length,
      invalidPointCount: invalidPoints.length,
      barrierEventCount: barrierEvents.length,
    },
    findings,
    warnings,
    suggestions: suggestions.slice(0, 3),
    confidence,
    explanation: findings.length
      ? `${input.profile} produced ${findings.length} deterministic finding(s) from quality-qualified indexed points.`
      : `${input.profile} had insufficient quality-qualified evidence; no finding was inferred.`,
    rawSources,
  };
}

function analyzeControl(
  input: AnalysisV0Input,
  points: AnalysisV0Point[],
  events: AnalysisV0Event[],
  barriers: AnalysisV0Event[],
  findings: Array<Record<string, unknown>>,
  warnings: string[],
  suggestions: string[],
): void {
  const command = roleSignal(input, "command");
  const feedback = roleSignal(input, "feedback");
  if (!command || !feedback) {
    warnings.push("generic_control requires one command and one feedback signal");
    suggestions.push("map one command and one feedback signal");
    return;
  }
  const selectedWrite = input.window.eventId ? events.find((event) => event.eventId === input.window.eventId && event.type === "variable_write") : undefined;
  const write = selectedWrite ?? events.find((event) => event.type === "variable_write" && (event.variable === undefined || event.variable === command));
  if (!write) {
    warnings.push("no command variable_write event exists in the selected window");
    suggestions.push("capture a command write event inside the analysis window");
    return;
  }

  const comparisons: Array<Record<string, unknown>> = [];
  for (const variable of [command, feedback]) {
    const signalPoints = points.filter((point) => point.variable === variable);
    const before = [...signalPoints].reverse().find((point) => valid(point) && compareTick(point.tick, write.tick) < 0);
    const after = signalPoints.find((point) => valid(point) && compareTick(point.tick, write.tick) > 0);
    if (!before || !after || blocked(signalPoints, barriers, before.tick, after.tick)) continue;
    comparisons.push({
      variable,
      before: normalize(before.value),
      beforeTick: before.tick,
      after: normalize(after.value),
      afterTick: after.tick,
      delta: normalize(after.value - before.value),
    });
  }
  const commandComparison = comparisons.find((item) => item.variable === command);
  const feedbackComparison = comparisons.find((item) => item.variable === feedback);
  if (!commandComparison || !feedbackComparison) {
    warnings.push("write before/after evidence is missing or crosses an invalid-quality gap");
    suggestions.push("capture valid command and feedback points immediately before and after the write");
    return;
  }
  findings.push({
    type: "write_window_comparison",
    signals: [command, feedback],
    window: { startTick: commandComparison.beforeTick, endTick: feedbackComparison.afterTick, eventId: write.eventId },
    comparisons,
    confidence: "high",
    explanation: "Last valid pre-write and first valid post-write values were compared without crossing a quality barrier.",
  });

  const commandDelta = commandComparison.delta as number;
  if (commandDelta === 0) {
    warnings.push("command write has zero observed step delta");
    suggestions.push("capture a non-zero command step");
    return;
  }
  const feedbackPoints = points.filter((point) => point.variable === feedback && valid(point) && compareTick(point.tick, write.tick) > 0);
  if (feedbackPoints.length === 0 || blocked(points.filter((point) => point.variable === feedback), barriers, write.tick, input.window.endTick)) {
    warnings.push("feedback response is missing or split by an invalid-quality gap");
    suggestions.push("repeat the capture without quality gaps after the command write");
    return;
  }
  const peakPoint = feedbackPoints.reduce((peak, point) => commandDelta > 0
    ? (point.value > peak.value ? point : peak)
    : (point.value < peak.value ? point : peak));
  const start = BigInt(input.window.startTick);
  const end = BigInt(input.window.endTick);
  const tailStart = start + (end - start) * 4n / 5n;
  const steadyPoints = feedbackPoints.filter((point) => BigInt(point.tick) >= tailStart);
  if (steadyPoints.length < 3) {
    warnings.push("steady-state evidence requires at least 3 points in the final 20% of the time window");
    suggestions.push("extend the capture to include at least 3 valid tail points");
    return;
  }
  let sum = 0;
  for (const point of steadyPoints) sum += point.value;
  const steady = normalize(sum / steadyPoints.length);
  const directionalOvershoot = commandDelta > 0 ? peakPoint.value - steady : steady - peakPoint.value;
  const overshoot = normalize(Math.max(0, directionalOvershoot));
  findings.push({
    type: "control_response",
    signals: [command, feedback],
    window: { startTick: write.tick, endTick: input.window.endTick, eventId: write.eventId },
    direction: commandDelta > 0 ? "increasing" : "decreasing",
    peak: normalize(peakPoint.value),
    peakTick: peakPoint.tick,
    steady,
    steadyPointCount: steadyPoints.length,
    steadyStartTick: tailStart.toString(),
    overshoot,
    overshootPercent: normalize(overshoot / Math.abs(commandDelta) * 100),
    confidence: "high",
    explanation: "Peak follows the command direction; steady is the ordered mean of valid points in the final 20% of the selected time window.",
  });
}

function analyzeState(
  input: AnalysisV0Input,
  points: AnalysisV0Point[],
  barriers: AnalysisV0Event[],
  findings: Array<Record<string, unknown>>,
  warnings: string[],
  suggestions: string[],
): void {
  const states = Object.entries(input.signalRoles).filter(([, role]) => role === "state").map(([variable]) => variable).sort(ordinal);
  if (states.length === 0) {
    warnings.push("generic_state_machine requires at least one state signal");
    suggestions.push("map a state signal");
    return;
  }
  for (const variable of states) {
    const signalPoints = points.filter((point) => point.variable === variable);
    let previous: AnalysisV0Point | undefined;
    let stateStart: AnalysisV0Point | undefined;
    for (const point of signalPoints) {
      if (!valid(point)) {
        previous = undefined;
        stateStart = undefined;
        continue;
      }
      if (!previous || !stateStart || blocked(signalPoints, barriers, previous.tick, point.tick)) {
        previous = point;
        stateStart = point;
        continue;
      }
      if (point.value !== previous.value) {
        findings.push({
          type: "state_transition",
          signals: [variable],
          window: { startTick: stateStart.tick, endTick: point.tick },
          oldValue: normalize(previous.value),
          newValue: normalize(point.value),
          transitionTick: point.tick,
          observedDurationTicks: (BigInt(point.tick) - BigInt(stateStart.tick)).toString(),
          confidence: "high",
          explanation: "Adjacent valid state observations changed without crossing a quality barrier.",
        });
        stateStart = point;
      }
      previous = point;
    }
    if (previous && stateStart) findings.push({
      type: "state_duration",
      signals: [variable],
      window: { startTick: stateStart.tick, endTick: previous.tick },
      stateValue: normalize(previous.value),
      observedDurationTicks: (BigInt(previous.tick) - BigInt(stateStart.tick)).toString(),
      confidence: "high",
      explanation: "Duration is observed only between quality-qualified state samples.",
    });
  }
  if (findings.length === 0) {
    warnings.push("no quality-qualified state duration or transition evidence exists");
    suggestions.push("capture at least two adjacent valid state observations");
  }
}

function roleSignal(input: AnalysisV0Input, role: AnalysisV0Role): string | undefined {
  const matches = Object.entries(input.signalRoles).filter(([, value]) => value === role).map(([variable]) => variable).sort(ordinal);
  return matches.length === 1 ? matches[0] : undefined;
}

function valid(point: AnalysisV0Point): boolean {
  return (point.statusFlags & HSS_STATUS_FLAGS.valid) !== 0 && (point.statusFlags & INVALID_FLAGS) === 0;
}

function blocked(points: AnalysisV0Point[], barriers: AnalysisV0Event[], startTick: string, endTick: string): boolean {
  return points.some((point) => compareTick(point.tick, startTick) > 0 && compareTick(point.tick, endTick) <= 0 && !valid(point))
    || barriers.some((event) => compareTick(event.tick, startTick) > 0 && compareTick(event.tick, endTick) <= 0);
}

function compareTick(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => ordinal(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) throw new AnalysisV0Error("analysis rejects non-finite values");
  return JSON.stringify(value);
}
