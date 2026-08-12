import type { McpResultMode } from "../result-mode";
import type { OperationEnvelope } from "./operation-envelope";

export interface OperationToolResult {
  [key: string]: unknown;
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Project an operation envelope onto the model-visible semantic result.
 * This removes defaults and compatibility aliases without truncating values.
 */
export function projectNormalOperationResult(envelope: OperationEnvelope): Record<string, unknown> {
  const result: Record<string, unknown> = {
    ok: envelope.ok,
    operationId: envelope.operationId,
    tool: envelope.tool,
    verification: envelope.verification,
  };
  if (envelope.target) result.target = envelope.target;
  if (envelope.probe) result.probe = envelope.probe;
  if (envelope.queueSequence !== undefined) result.queueSequence = envelope.queueSequence;
  if (envelope.artifact) {
    const { match, ...canonicalArtifact } = envelope.artifact;
    result.artifact = match === envelope.artifact.firmwareIdentity ? canonicalArtifact : envelope.artifact;
  }
  if (envelope.svd) result.svd = envelope.svd;
  if (envelope.capture) result.capture = envelope.capture;
  if (Object.keys(envelope.before).length) result.before = envelope.before;
  if (Object.keys(envelope.after).length) result.after = envelope.after;
  if (envelope.requestedEffects.length) result.requestedEffects = envelope.requestedEffects;
  if (envelope.observedEffects.length) result.observedEffects = envelope.observedEffects;
  if (envelope.data !== null && envelope.data !== undefined) result.data = envelope.data;
  if (envelope.outputFiles.length) result.outputFiles = envelope.outputFiles;
  if (envelope.warnings.length) result.warnings = envelope.warnings;
  if (envelope.error) result.error = envelope.error;
  return result;
}

export function operationToolResult(envelope: OperationEnvelope, mode: McpResultMode): OperationToolResult {
  if (mode === "text") {
    return {
      isError: !envelope.ok,
      content: [{ type: "text", text: JSON.stringify(envelope) }],
    };
  }
  return {
    isError: !envelope.ok,
    content: [{ type: "text", text: operationReceipt(envelope) }],
    structuredContent: mode === "full"
      ? envelope as unknown as Record<string, unknown>
      : projectNormalOperationResult(envelope),
  };
}

function operationReceipt(envelope: OperationEnvelope): string {
  if (envelope.ok) return `OK ${envelope.tool} ${envelope.operationId}`;
  return `ERROR ${envelope.tool} ${envelope.operationId} ${envelope.error?.code ?? "UNKNOWN"}`;
}
