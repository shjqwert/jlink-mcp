import { z } from "zod";
import { PatternFinding, patternFindingSchema, signalRoleSchema } from "../experiment-contract";
import { LoadExperimentInput, LoadedExperiment, loadExperimentForAnalysis } from "../experiment-store";
import { AnalysisForEvidence, buildRuntimeEvidence } from "../evidence/runtime-evidence";
import { BridgeQuery, bridgeQueriesFromQuestions } from "./queries";

interface ToolError {
  error: {
    code: "validation_error" | "not_found";
    message: string;
    issues?: Array<{ path: Array<string | number>; message: string }>;
  };
}

export interface EvidenceForCodegraphOutput {
  experimentId: string;
  evidence: ReturnType<typeof buildRuntimeEvidence>;
  queries: BridgeQuery[];
}

const evidenceInputSchema = z.object({
  experimentId: z.string().min(1).max(128).optional(),
  fixturePath: z.string().min(1).max(1024).optional(),
  experimentPath: z.string().min(1).max(1024).optional(),
  metadataFile: z.string().min(1).max(1024).optional(),
  captureId: z.string().min(1).max(64).optional(),
  outputDir: z.string().min(1).max(1024).optional(),
  signalRoles: z.record(z.string(), signalRoleSchema).optional(),
  analysisResult: z.unknown(),
}).strict().superRefine((input, context) => {
  if (!input.experimentId && !input.fixturePath && !input.experimentPath && !input.metadataFile && !input.captureId) {
    context.addIssue({ code: "custom", path: ["experimentId"], message: "experiment source is required" });
  }
  if (input.captureId && !input.outputDir) {
    context.addIssue({ code: "custom", path: ["outputDir"], message: "outputDir is required with captureId" });
  }
});

const analysisResultSchema = z.object({
  experimentId: z.string().min(1).max(128).optional(),
  summary: z.object({
    verdict: z.string().optional(),
    mainFindings: z.array(z.string()).optional(),
  }).passthrough().optional(),
  patterns: z.array(patternFindingSchema),
}).passthrough();

export async function evidenceForCodegraphTool(input: unknown): Promise<EvidenceForCodegraphOutput | ToolError> {
  const parsed = evidenceInputSchema.safeParse(input);
  if (!parsed.success) return validationError("Invalid evidence_for_codegraph input", parsed.error);
  const analysis = parseAnalysisResult(parsed.data.analysisResult);
  if ("error" in analysis) return analysis;

  const loaded = await loadForTool(parsed.data);
  if ("error" in loaded) return loaded;

  const evidence = buildRuntimeEvidence(loaded.record, { ...analysis, experimentId: loaded.experimentId });
  return {
    experimentId: loaded.experimentId,
    evidence,
    queries: bridgeQueriesFromQuestions(evidence.flatMap((item) => item.questionsForCodeGraph)),
  };
}

function parseAnalysisResult(value: unknown): AnalysisForEvidence | ToolError {
  let raw = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      return validationError("analysisResult must be an object or JSON string");
    }
  }
  const parsed = analysisResultSchema.safeParse(raw);
  if (!parsed.success) return validationError("Invalid analysisResult", parsed.error);
  return {
    experimentId: parsed.data.experimentId,
    summary: parsed.data.summary,
    patterns: parsed.data.patterns as PatternFinding[],
  };
}

async function loadForTool(input: LoadExperimentInput): Promise<LoadedExperiment | ToolError> {
  try {
    return await loadExperimentForAnalysis(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /not found/i.test(message) ? { error: { code: "not_found", message } } : validationError(message);
  }
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
