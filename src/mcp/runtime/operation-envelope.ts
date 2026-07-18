import { randomUUID } from "node:crypto";
import type { StoredTarget } from "./target-store";

export interface OperationError {
  code: string;
  stage: string;
  message: string;
  retryable: boolean;
  writeIssued: boolean;
  stateUnknown: boolean;
}

export interface OperationEnvelope {
  ok: boolean;
  operationId: string;
  tool: string;
  timestamps: { requestedAt: string; queuedAt?: string; startedAt?: string; endedAt: string };
  target: null | { projectRoot: string; generation: string; device: string };
  probe: null | { serial: string; interface: string; speed: number; owner?: unknown };
  queueSequence?: number;
  artifact: null | { generation: string; path: string; match: string; evidenceSource: string; evidenceTimestamp: string };
  svd: null | { path: string; sha256: string };
  capture: null | Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  requestedEffects: string[];
  observedEffects: string[];
  verification: { status: string; method?: string; details?: unknown };
  data: unknown;
  outputFiles: string[];
  warnings: string[];
  error?: OperationError;
}

export class OperationExecutionError extends Error {
  constructor(readonly detail: OperationError) {
    super(detail.message);
    this.name = "OperationExecutionError";
  }
}

export function createOperationEnvelope(tool: string, target?: StoredTarget): OperationEnvelope {
  const requestedAt = new Date().toISOString();
  return {
    ok: false,
    operationId: randomUUID(),
    tool,
    timestamps: { requestedAt, endedAt: requestedAt },
    target: target ? { projectRoot: target.projectRoot, generation: target.generation, device: target.device } : null,
    probe: target ? { serial: target.probeSerial, interface: target.interface, speed: target.speed } : null,
    artifact: target?.artifact ? {
      generation: target.artifact.generation,
      path: target.artifact.path,
      match: target.liveArtifactMatch.status,
      evidenceSource: target.liveArtifactMatch.source,
      evidenceTimestamp: target.liveArtifactMatch.timestamp,
    } : null,
    svd: target?.svd ? { path: target.svd.path, sha256: target.svd.sha256 } : null,
    capture: null,
    before: {},
    after: {},
    requestedEffects: [],
    observedEffects: [],
    verification: { status: "not_requested" },
    data: null,
    outputFiles: [],
    warnings: [],
  };
}

export function finishEnvelope(envelope: OperationEnvelope, ok: boolean): OperationEnvelope {
  envelope.ok = ok;
  envelope.timestamps.endedAt = new Date().toISOString();
  return envelope;
}

export function failEnvelope(envelope: OperationEnvelope, error: OperationError): OperationEnvelope {
  envelope.error = error;
  return finishEnvelope(envelope, false);
}

export function executionError(
  code: string,
  stage: string,
  message: string,
  options: Partial<Pick<OperationError, "retryable" | "writeIssued" | "stateUnknown">> = {},
): OperationExecutionError {
  return new OperationExecutionError({
    code,
    stage,
    message,
    retryable: options.retryable ?? false,
    writeIssued: options.writeIssued ?? false,
    stateUnknown: options.stateUnknown ?? false,
  });
}
