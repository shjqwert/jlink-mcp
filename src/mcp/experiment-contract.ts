import { readFile } from "node:fs/promises";
import { z } from "zod";
import { scalarTypeSchema } from "./capture-contract";

export const signalRoles = [
  "command",
  "feedback",
  "error",
  "state",
  "fault",
  "limit",
  "counter",
  "timestamp",
  "event",
  "raw",
  "derived",
] as const;
export type SignalRole = typeof signalRoles[number];

export const experimentSources = ["capture", "imported", "fixture", "synthetic"] as const;
export type ExperimentSource = typeof experimentSources[number];

export const patternTypes = [
  "step_response",
  "overshoot",
  "undershoot",
  "settling_time",
  "steady_error",
  "oscillation",
  "saturation",
  "state_transition",
  "fault_transition",
  "stuck_signal",
  "discontinuity",
  "counter_stall",
  "counter_wrap",
] as const;
export type PatternType = typeof patternTypes[number];

export const metricNames = [
  "overshoot",
  "settling_time",
  "steady_error",
  "saturation",
  "state_transition",
  "fault_transition",
  "stuck_signal",
  "counter_stall",
  "counter_wrap",
] as const;
export type MetricName = typeof metricNames[number];

export const analysisProfileNames = [
  "generic_control",
  "generic_state_machine",
  "motor_bldc",
  "motor_foc",
] as const;
export type AnalysisProfileName = typeof analysisProfileNames[number];

export const evidenceSeverities = ["info", "warning", "error"] as const;
export type EvidenceSeverity = typeof evidenceSeverities[number];

const nameSchema = z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/);
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const selectorSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^(?:[A-Za-z0-9_./\\ -]+::)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/, "selector must be a scalar or fixed member path")
  .refine((value) => !value.includes("->") && !value.includes("[") && !value.includes("]"), "pointer and array traversal are forbidden");
const scalarValueSchema = z.union([z.number().finite(), z.string(), z.boolean(), z.null()]);
const metadataSchema = z.record(z.string(), z.unknown());

export const signalRoleSchema = z.enum(signalRoles);
export const experimentSourceSchema = z.enum(experimentSources);
export const patternTypeSchema = z.enum(patternTypes);
export const metricNameSchema = z.enum(metricNames);
export const analysisProfileNameSchema = z.enum(analysisProfileNames);
export const evidenceSeveritySchema = z.enum(evidenceSeverities);

export const signalDefinitionSchema = z.object({
  name: nameSchema,
  selector: selectorSchema.optional(),
  type: scalarTypeSchema,
  unit: z.string().min(1).max(63).optional(),
  role: signalRoleSchema,
  domain: z.string().min(1).max(64).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  description: z.string().min(1).max(512).optional(),
}).strict();
export type SignalDefinition = z.infer<typeof signalDefinitionSchema>;

export const experimentEventSchema = z.object({
  timeMs: z.number().finite().nonnegative(),
  type: z.string().min(1).max(128),
  signal: nameSchema.optional(),
  value: scalarValueSchema.optional(),
  detail: z.string().min(1).max(1024).optional(),
  metadata: metadataSchema.optional(),
}).strict();
export type ExperimentEvent = z.infer<typeof experimentEventSchema>;

export const experimentSampleSchema = z.object({
  timeMs: z.number().finite().nonnegative(),
  values: z.record(nameSchema, scalarValueSchema),
}).strict();
export type ExperimentSample = z.infer<typeof experimentSampleSchema>;

export const experimentRecordSchema = z.object({
  experimentId: nameSchema,
  createdAt: z.string().datetime(),
  source: experimentSourceSchema,
  target: z.object({
    device: z.string().min(1).max(128).optional(),
    interface: z.enum(["SWD", "JTAG"]).optional(),
    speedKhz: z.number().finite().positive().optional(),
  }).strict().optional(),
  capture: z.object({
    captureId: idSchema.optional(),
    backend: z.string().min(1).max(64).optional(),
    requestedRateHz: z.number().finite().positive().optional(),
    actualRateHz: z.number().finite().positive().optional(),
    recommendedRateHz: z.number().finite().positive().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    quality: metadataSchema.optional(),
  }).strict().optional(),
  signals: z.array(signalDefinitionSchema).min(1),
  events: z.array(experimentEventSchema).default([]),
  timeWindowMs: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]).optional(),
  samples: z.array(experimentSampleSchema).optional(),
  artifacts: z.record(z.string(), z.string()).optional(),
  metadata: metadataSchema.optional(),
}).strict().superRefine((record, context) => {
  const signalNames = new Set<string>();
  for (const [index, signal] of record.signals.entries()) {
    if (signalNames.has(signal.name)) {
      context.addIssue({ code: "custom", path: ["signals", index, "name"], message: `Duplicate signal name: ${signal.name}` });
    }
    signalNames.add(signal.name);
  }
  for (const [sampleIndex, sample] of (record.samples ?? []).entries()) {
    for (const name of Object.keys(sample.values)) {
      if (!signalNames.has(name)) {
        context.addIssue({ code: "custom", path: ["samples", sampleIndex, "values", name], message: `Unknown sample signal: ${name}` });
      }
    }
  }
});
export type ExperimentRecord = z.infer<typeof experimentRecordSchema>;

export const patternFindingSchema = z.object({
  type: patternTypeSchema,
  signal: nameSchema.optional(),
  relatedSignals: z.array(nameSchema).optional(),
  startMs: z.number().finite().nonnegative().optional(),
  endMs: z.number().finite().nonnegative().optional(),
  value: z.union([z.number().finite(), z.string(), z.boolean()]).optional(),
  unit: z.string().min(1).max(63).optional(),
  confidence: z.enum(["low", "medium", "high"]),
  evidence: z.string().min(1).max(2048),
}).strict();
export type PatternFinding = z.infer<typeof patternFindingSchema>;

export const analysisProfileSchema = z.object({
  name: analysisProfileNameSchema,
  domain: z.string().min(1).max(64),
  status: z.enum(["implemented", "optional", "planned"]),
  patterns: z.array(patternTypeSchema).min(1),
}).strict();
export type AnalysisProfile = z.infer<typeof analysisProfileSchema>;

export const codeHintSchema = z.object({
  symbol: nameSchema.optional(),
  fileHint: z.string().min(1).max(260).optional(),
  selector: selectorSchema.optional(),
  reason: z.string().min(1).max(1024),
}).strict();
export type CodeHint = z.infer<typeof codeHintSchema>;

export const codeGraphQuestionSchema = z.object({
  query: z.string().min(1).max(2048),
  symbols: z.array(nameSchema).default([]),
  fileHints: z.array(z.string().min(1).max(260)).default([]),
  reason: z.string().min(1).max(1024),
  experimentId: nameSchema.optional(),
  evidenceId: nameSchema.optional(),
}).strict();
export type CodeGraphQuestion = z.infer<typeof codeGraphQuestionSchema>;

export const runtimeEvidenceSignalSchema = z.object({
  name: nameSchema,
  role: signalRoleSchema,
  selector: selectorSchema.optional(),
  symbol: nameSchema.optional(),
  rootSymbol: nameSchema.optional(),
  memberPath: nameSchema.optional(),
  displaySymbol: nameSchema.optional(),
  fileHint: z.string().min(1).max(260).optional(),
}).strict();

export const runtimeEvidenceSchema = z.object({
  evidenceId: nameSchema,
  experimentId: nameSchema,
  summary: z.string().min(1).max(2048),
  severity: evidenceSeveritySchema,
  timeWindowMs: z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()]).optional(),
  signals: z.array(runtimeEvidenceSignalSchema),
  patterns: z.array(patternTypeSchema),
  codeHints: z.array(codeHintSchema).default([]),
  questionsForCodeGraph: z.array(codeGraphQuestionSchema).default([]),
  artifacts: z.record(z.string(), z.string()).optional(),
}).strict();
export type RuntimeEvidence = z.infer<typeof runtimeEvidenceSchema>;

export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
  code: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export function validateWithSchema<T>(schema: z.ZodType<T>, value: unknown): ValidationResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
      message: issue.message,
      code: issue.code,
    })),
  };
}

export function validateSignalDefinition(value: unknown): ValidationResult<SignalDefinition> {
  return validateWithSchema(signalDefinitionSchema, value);
}

export function validateExperimentRecord(value: unknown): ValidationResult<ExperimentRecord> {
  return validateWithSchema(experimentRecordSchema, value);
}

export async function loadExperimentFixture(filePath: string): Promise<ExperimentRecord> {
  return experimentRecordSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}
