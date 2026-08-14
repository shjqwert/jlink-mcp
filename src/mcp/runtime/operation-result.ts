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
export function projectNormalOperationResult(
  envelope: OperationEnvelope,
  diagnosticRef?: string,
): Record<string, unknown> {
  if (!envelope.ok) {
    const error = envelope.error ?? {
      code: "UNKNOWN",
      stage: "unknown",
      retryable: false,
      writeIssued: false,
      stateUnknown: true,
    };
    const result: Record<string, unknown> = {
      ok: false,
      error: {
        code: error.code,
        stage: error.stage,
        retryable: error.retryable,
        writeIssued: error.writeIssued,
        stateUnknown: error.stateUnknown,
      },
    };
    if (diagnosticRef) result.diagnosticRef = diagnosticRef;
    return result;
  }

  return {
    ok: true,
    result: projectSuccessResult(envelope),
  };
}

export function operationToolResult(
  envelope: OperationEnvelope,
  mode: McpResultMode,
  diagnosticRef?: string,
): OperationToolResult {
  if (mode === "text") {
    return {
      isError: !envelope.ok,
      content: [{ type: "text", text: JSON.stringify(envelope) }],
    };
  }
  if (mode === "full") {
    return {
      isError: !envelope.ok,
      content: [{ type: "text", text: operationReceipt(envelope) }],
      structuredContent: envelope as unknown as Record<string, unknown>,
    };
  }

  const projected = projectNormalOperationResult(envelope, diagnosticRef);
  return {
    isError: !envelope.ok,
    content: [{ type: "text", text: JSON.stringify(projected) }],
    structuredContent: projected,
  };
}

function operationReceipt(envelope: OperationEnvelope): string {
  if (envelope.ok) return `OK ${envelope.tool} ${envelope.operationId}`;
  return `ERROR ${envelope.tool} ${envelope.operationId} ${envelope.error?.code ?? "UNKNOWN"}`;
}

const CAPTURE_LIFECYCLE_TOOLS = new Set([
  "hss_start",
  "hss_status",
  "hss_stop",
  "hss_recover",
  "trace",
]);

const STATE_ONLY_TOOLS = new Set([
  "write",
  "write_variable",
  "write_memory",
  "target_control",
  "flash",
  "erase",
]);

const INTERNAL_RESULT_KEYS = new Set([
  "operationId",
  "tool",
  "verification",
  "requestedEffects",
  "observedEffects",
  "outputFiles",
  "warnings",
  "details",
  "detailsUri",
  "queueSequence",
  "target",
  "probe",
  "artifact",
  "svd",
  "before",
  "after",
  "resolved",
  "cacheRefreshed",
  "runtime",
  "control",
  "session",
  "metadata",
  "limits",
  "linkRate",
  "variableResolution",
  "writeVariableResolution",
]);

function projectSuccessResult(envelope: OperationEnvelope): Record<string, unknown> {
  const data = asRecord(envelope.data);
  const capture = asRecord(envelope.capture);
  const session = asRecord(data?.session);
  const captureId = firstString(capture?.captureId, data?.captureId, session?.captureId);

  if (captureId && CAPTURE_LIFECYCLE_TOOLS.has(envelope.tool)) {
    return projectCaptureReceipt(envelope, captureId, capture, data, session);
  }

  const typedValue = data?.typedValue ?? data?.value;
  if (typedValue !== undefined && (envelope.tool === "read_variable" || envelope.tool === "inspect")) {
    return { value: typedValue };
  }

  if (STATE_ONLY_TOOLS.has(envelope.tool)) return { state: "completed" };

  const sanitized = sanitizeNormalValue(envelope.data);
  if (sanitized === undefined || sanitized === null) return { state: "completed" };
  if (Array.isArray(sanitized)) return { items: sanitized };
  if (typeof sanitized === "object") {
    const record = sanitized as Record<string, unknown>;
    return Object.keys(record).length ? record : { state: "completed" };
  }
  return { value: sanitized };
}

function projectCaptureReceipt(
  envelope: OperationEnvelope,
  captureId: string,
  capture: Record<string, unknown> | undefined,
  data: Record<string, unknown> | undefined,
  session: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const state = firstString(capture?.state, data?.state, session?.state) ?? "completed";
  const sampleCount = firstFiniteInteger(capture?.sampleCount, data?.sampleCount, asRecord(data?.quality)?.sampleCount) ?? 0;
  return {
    captureId,
    state,
    sampleCount,
    anomalies: captureAnomalies(envelope, capture, data),
  };
}

function captureAnomalies(
  envelope: OperationEnvelope,
  capture: Record<string, unknown> | undefined,
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const codes = new Set<string>();
  const actualRate = firstFiniteNumber(capture?.actualRateHz, data?.actualRateHz);
  const requestedRate = firstFiniteNumber(capture?.requestedRateHz, data?.requestedRateHz, data?.rateHz);
  if (capture?.sampleThresholdMet === false || (
    actualRate !== undefined
    && requestedRate !== undefined
    && requestedRate > 0
    && actualRate < requestedRate * 0.95
  )) codes.add("RATE_DEGRADED");

  const quality = asRecord(data?.quality);
  if ((firstFiniteInteger(quality?.missing) ?? 0) > 0) codes.add("SAMPLES_MISSING");
  if ((firstFiniteInteger(quality?.dropped) ?? 0) > 0) codes.add("SAMPLES_DROPPED");

  const statistics = asRecord(capture?.readStatistics);
  if (
    (firstFiniteInteger(statistics?.readErrors) ?? 0) > 0
    || (firstFiniteInteger(statistics?.shortReads) ?? 0) > 0
  ) codes.add("SAMPLES_DROPPED");

  const backend = firstString(capture?.backend, data?.backend);
  if (backend === "background_poll" || backend === "stop_poll") codes.add("BACKEND_FALLBACK");

  for (const warning of envelope.warnings) {
    for (const code of ["RATE_DEGRADED", "SAMPLES_MISSING", "SAMPLES_DROPPED", "BACKEND_FALLBACK"]) {
      if (warning.includes(code)) codes.add(code);
    }
  }

  const values = [...codes].sort();
  return {
    level: values.length ? "warning" : "none",
    count: values.length,
    codes: values,
  };
}

function sanitizeNormalValue(value: unknown, key?: string): unknown {
  if (key && shouldOmitResultKey(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNormalValue(item)).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeNormalValue(entryValue, entryKey);
    if (sanitized !== undefined) result[entryKey] = sanitized;
  }
  return result;
}

function shouldOmitResultKey(key: string): boolean {
  if (INTERNAL_RESULT_KEYS.has(key)) return true;
  if (key === "captureId" || key === "eventId") return false;
  return /(path|dir|file|uri|address|generation|hash|nonce|pid|token|root)$/i.test(key);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function firstFiniteInteger(...values: unknown[]): number | undefined {
  return values.find((value): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
