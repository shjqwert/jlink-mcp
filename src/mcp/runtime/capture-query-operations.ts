import path from "node:path";
import {
  JcapExportPublishError,
  JcapRebuildPublishError,
  jcapCaptureEventWindow,
  jcapCaptureExportCsv,
  jcapCaptureList,
  jcapCaptureSeries,
  jcapCaptureSummary,
  jcapV1ReadinessResponse,
  jcapV2CaptureEventWindow,
  jcapV2CaptureExportCsv,
  jcapV2CaptureList,
  jcapV2CaptureSeries,
  jcapV2CaptureSummary,
  rebuildJcapV1IndexWithinLease,
  resolveJcapV2CaptureFile,
  verifyJcapV2,
  resolveJcapV1CaptureLocation,
  verifyJcapV1Index,
  validateJcapV1EventWindowQuery,
  validateJcapV1SeriesQuery,
  withJcapV1PackageLease,
  type JcapV1CaptureLocation,
  type JcapV2Resolution,
  type JcapV2Statistic,
} from "../jcap/jcap-v1";
import {
  createOperationEnvelope,
  failEnvelope,
  finishEnvelope,
  type OperationEnvelope,
} from "./operation-envelope";

export interface CaptureListInput {
  limit?: number;
  cursor?: string;
}

export interface CaptureSeriesInput {
  captureId: string;
  variables: string[];
  timeRange?: { startMs?: number; endMs?: number };
  resolution?: JcapV2Resolution;
  statistics?: JcapV2Statistic[];
  cursor?: string;
  maxBytes?: number;
  startTick?: string;
  endTick?: string;
  bucketCount?: number;
}

export interface CaptureEventWindowInput {
  captureId: string;
  eventId: string;
  variables: string[];
  beforeMs: number;
  afterMs: number;
  resolution?: JcapV2Resolution;
  statistics?: JcapV2Statistic[];
  cursor?: string;
  maxBytes?: number;
  bucketCount?: number;
}

export type CaptureMutationGuard = <T>(runId: string, operation: () => Promise<T>) => Promise<T>;

type CaptureQueryTool =
  | "capture_summary"
  | "capture_series"
  | "capture_event_window"
  | "capture_export_csv";

interface QueryResult {
  data: Record<string, unknown>;
  ready: boolean;
}

export class CaptureQueryOperations {
  private readonly rootDir: string;

  constructor(rootDir: string, private readonly guardRunMutation?: CaptureMutationGuard) {
    this.rootDir = path.resolve(rootDir);
  }

  async list(input: CaptureListInput = {}): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("capture_list");
    envelope.requestedEffects = ["read_bounded_capture_index"];
    try {
      const v2Probe = await jcapV2CaptureList(this.rootDir, { limit: 1 });
      const hasV2 = Array.isArray(v2Probe.captures) && v2Probe.captures.length > 0;
      envelope.data = hasV2
        ? await jcapV2CaptureList(this.rootDir, input)
        : await jcapCaptureList(this.rootDir, input);
      envelope.verification = {
        status: "verified",
        method: hasV2 ? "bounded_jcap_v2_list_snapshot" : "bounded_jcap_v1_list_snapshot",
      };
      return finishEnvelope(envelope, true);
    } catch (error) {
      return captureFailure(envelope, error, "list");
    }
  }

  summary(captureId: string): Promise<OperationEnvelope> {
    const captureFile = resolveJcapV2CaptureFile(this.rootDir, captureId);
    if (captureFile) {
      return this.queryV2("capture_summary", captureId, captureFile, () => jcapV2CaptureSummary(captureFile));
    }
    return this.query("capture_summary", captureId, async (location) => jcapCaptureSummary(location.packageDir));
  }

  series(input: CaptureSeriesInput): Promise<OperationEnvelope> {
    const captureFile = resolveJcapV2CaptureFile(this.rootDir, input.captureId);
    if (captureFile) {
      return this.queryV2("capture_series", input.captureId, captureFile, () => jcapV2CaptureSeries({
        captureFile,
        ...input,
      }));
    }
    try {
      const legacy = {
        captureId: input.captureId,
        variables: input.variables,
        startTick: input.startTick!,
        endTick: input.endTick!,
        bucketCount: input.bucketCount!,
      };
      validateJcapV1SeriesQuery(legacy);
      return this.query("capture_series", input.captureId, async (location) => jcapCaptureSeries({
        packageDir: location.packageDir,
        variables: legacy.variables,
        startTick: legacy.startTick,
        endTick: legacy.endTick,
        bucketCount: legacy.bucketCount,
      }));
    } catch (error) {
      return Promise.resolve(captureFailure(createQueryEnvelope("capture_series"), error, "validation"));
    }
  }

  eventWindow(input: CaptureEventWindowInput): Promise<OperationEnvelope> {
    const captureFile = resolveJcapV2CaptureFile(this.rootDir, input.captureId);
    if (captureFile) {
      return this.queryV2("capture_event_window", input.captureId, captureFile, () => jcapV2CaptureEventWindow({
        captureFile,
        ...input,
      }));
    }
    try {
      const legacy = {
        captureId: input.captureId,
        eventId: input.eventId,
        variables: input.variables,
        beforeMs: input.beforeMs,
        afterMs: input.afterMs,
        bucketCount: input.bucketCount!,
      };
      validateJcapV1EventWindowQuery(legacy);
      return this.query("capture_event_window", input.captureId, async (location) => jcapCaptureEventWindow({
        packageDir: location.packageDir,
        eventId: legacy.eventId,
        variables: legacy.variables,
        beforeMs: legacy.beforeMs,
        afterMs: legacy.afterMs,
        bucketCount: legacy.bucketCount,
      }));
    } catch (error) {
      return Promise.resolve(captureFailure(createQueryEnvelope("capture_event_window"), error, "validation"));
    }
  }

  exportCsv(captureId: string): Promise<OperationEnvelope> {
    const captureFile = resolveJcapV2CaptureFile(this.rootDir, captureId);
    if (captureFile) {
      return this.queryV2("capture_export_csv", captureId, captureFile, () => jcapV2CaptureExportCsv(
        captureFile,
        path.join(this.rootDir, "exports"),
      ));
    }
    return this.query("capture_export_csv", captureId, async (location, status) => ({
      ...status,
      ...await jcapCaptureExportCsv(
        location.packageDir,
        path.join(path.dirname(path.dirname(location.packageDir)), "exports"),
      ),
    }));
  }

  private async queryV2(
    tool: CaptureQueryTool,
    captureId: string,
    captureFile: string,
    operation: () => Promise<Record<string, unknown>>,
  ): Promise<OperationEnvelope> {
    const envelope = createQueryEnvelope(tool);
    try {
      const verified = await verifyJcapV2(captureFile);
      if (verified.captureId !== captureId) {
        throw new Error("captureId does not match JCAP v2 manifest");
      }
      const data = await operation();
      envelope.data = data;
      if (tool === "capture_export_csv" && typeof data.exportFile === "string") {
        envelope.outputFiles.push(data.exportFile);
        envelope.observedEffects.push("external_csv_created");
      }
      envelope.verification = {
        status: "verified",
        method: tool === "capture_export_csv"
          ? "bounded_external_csv_export_after_jcap_v2_integrity"
          : "bounded_jcap_v2_query_after_integrity",
      };
      return finishEnvelope(envelope, true);
    } catch (error) {
      recordExportFailureEffects(envelope, error);
      return captureFailure(envelope, error, "query");
    }
  }

  private async query(
    tool: CaptureQueryTool,
    captureId: string,
    operation: (
      location: JcapV1CaptureLocation,
      status: Awaited<ReturnType<typeof verifyJcapV1Index>>,
    ) => Promise<Record<string, unknown>>,
  ): Promise<OperationEnvelope> {
    const envelope = createQueryEnvelope(tool);
    try {
      const location = resolveJcapV1CaptureLocation(this.rootDir, captureId);
      const execute = () => withJcapV1PackageLease(
        location.packageDir,
        () => this.executeLocked(envelope, location, operation),
        "JCAP_QUERY_BUSY",
      );
      const result = location.runId && this.guardRunMutation
        ? await this.guardRunMutation(location.runId, execute)
        : await execute();
      envelope.data = result.data;
      if (tool === "capture_export_csv" && typeof result.data.exportFile === "string") {
        envelope.outputFiles.push(result.data.exportFile);
        envelope.observedEffects.push("external_csv_created");
      }
      envelope.verification = result.ready
        ? {
          status: "verified",
          method: tool === "capture_export_csv"
            ? "bounded_external_csv_export_after_jcap_v1_integrity"
            : "bounded_jcap_v1_query_after_integrity",
        }
        : { status: "observed", method: "capture_not_queryable" };
      return finishEnvelope(envelope, true);
    } catch (error) {
      recordRebuildFailureEffects(envelope, error);
      recordExportFailureEffects(envelope, error);
      return captureFailure(envelope, error, "query");
    }
  }

  private async executeLocked(
    envelope: OperationEnvelope,
    location: JcapV1CaptureLocation,
    operation: (
      location: JcapV1CaptureLocation,
      status: Awaited<ReturnType<typeof verifyJcapV1Index>>,
    ) => Promise<Record<string, unknown>>,
  ): Promise<QueryResult> {
    let status = await verifyJcapV1Index(location.packageDir);
    let indexRebuilt = false;
    if (
      status.indexStatus === "rebuild_required"
      && ["completed", "stopped", "interrupted"].includes(status.captureState)
    ) {
      try {
        await rebuildJcapV1IndexWithinLease(location.packageDir);
      } catch (error) {
        recordRebuildFailureEffects(envelope, error);
        throw error;
      }
      envelope.observedEffects.push(
        "capture_db_atomically_published",
        "capture_metadata_atomically_published",
      );
      indexRebuilt = true;
      status = await verifyJcapV1Index(location.packageDir);
    }
    const unavailable = ["active", "finalizing"].includes(status.captureState)
      ? {
        status: "not_ready",
        captureState: status.captureState,
        indexStatus: status.indexStatus,
      }
      : jcapV1ReadinessResponse(status, true);
    if (unavailable) {
      return {
        data: { ...unavailable, ...(indexRebuilt ? { indexRebuilt: true } : {}) },
        ready: false,
      };
    }
    return {
      data: {
        ...await operation(location, status),
        ...(indexRebuilt ? { indexRebuilt: true } : {}),
      },
      ready: true,
    };
  }
}

function recordRebuildFailureEffects(envelope: OperationEnvelope, error: unknown): void {
  if (!(error instanceof JcapRebuildPublishError)) return;
  if (error.databasePublished && !envelope.observedEffects.includes("capture_db_atomically_published")) {
    envelope.observedEffects.push("capture_db_atomically_published");
  }
  if (error.metadataPublished && !envelope.observedEffects.includes("capture_metadata_atomically_published")) {
    envelope.observedEffects.push("capture_metadata_atomically_published");
  }
}

function recordExportFailureEffects(envelope: OperationEnvelope, error: unknown): void {
  if (!(error instanceof JcapExportPublishError)) return;
  if (!envelope.observedEffects.includes("external_csv_created")) {
    envelope.observedEffects.push("external_csv_created");
  }
  if (!envelope.outputFiles.includes(error.exportFile)) envelope.outputFiles.push(error.exportFile);
}

function createQueryEnvelope(tool: CaptureQueryTool): OperationEnvelope {
  const envelope = createOperationEnvelope(tool);
  envelope.requestedEffects = tool === "capture_export_csv"
    ? ["read_bounded_capture_rows", "repair_capture_index_if_required", "create_external_csv"]
    : ["read_bounded_capture_index", "repair_capture_index_if_required"];
  return envelope;
}

function captureFailure(envelope: OperationEnvelope, error: unknown, stage: string): OperationEnvelope {
  const coded = error as { code?: unknown };
  const stateUnknown = error instanceof JcapRebuildPublishError && error.stateUnknown;
  return failEnvelope(envelope, {
    code: typeof coded?.code === "string" ? coded.code : "CAPTURE_QUERY_FAILED",
    stage,
    message: error instanceof Error ? error.message : String(error),
    retryable: coded?.code === "JCAP_QUERY_BUSY",
    writeIssued: envelope.observedEffects.length > 0
      || (error instanceof JcapRebuildPublishError && error.metadataWriteIssued),
    stateUnknown,
  });
}
