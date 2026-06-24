import { access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { ExperimentRecord, PatternFinding, loadExperimentFixture, patternFindingSchema } from "../experiment-contract";
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
  experimentId: z.string().min(1).max(128),
  analysisResult: z.unknown(),
}).strict();

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

  const record = await loadFixture(parsed.data.experimentId);
  if ("error" in record) return record;

  const evidence = buildRuntimeEvidence(record, { ...analysis, experimentId: parsed.data.experimentId });
  return {
    experimentId: parsed.data.experimentId,
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

async function loadFixture(experimentId: string): Promise<ExperimentRecord | ToolError> {
  const slug = experimentId.replace(/^fixture_/, "").replace(/_/g, "-");
  for (const candidate of [`${experimentId}.experiment.json`, `${slug}.experiment.json`]) {
    const filePath = fixturePath(candidate);
    try {
      await access(filePath);
      return await loadExperimentFixture(filePath);
    } catch {
      // Try the next known fixture spelling.
    }
  }
  return { error: { code: "not_found", message: `Experiment fixture not found: ${experimentId}` } };
}

function fixturePath(fileName: string): string {
  const root = resolve(process.cwd(), "src", "mcp", "fixtures");
  const filePath = resolve(root, fileName);
  if (!filePath.toLowerCase().startsWith(root.toLowerCase() + sep)) throw new Error("fixture path escapes fixture directory");
  return filePath;
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
