import { z } from "zod";

export type HssRiskLevel = "R0" | "R1" | "R2" | "R3";
export type HssToolOperation =
  | "hss_capability_probe"
  | "hss_capture_plan"
  | "hss_capture_start"
  | "hss_capture_status"
  | "hss_capture_stop"
  | "hss_capture_query"
  | "hss_capture_export"
  | "hss_session_recover"
  | "variable_write_plan"
  | "variable_write_execute"
  | "halt"
  | "resume"
  | "reset";

export const HSS_TOOL_RISK: Record<HssToolOperation, HssRiskLevel> = {
  hss_capability_probe: "R0",
  hss_capture_plan: "R1",
  hss_capture_start: "R1",
  hss_capture_status: "R0",
  hss_capture_stop: "R1",
  hss_capture_query: "R0",
  hss_capture_export: "R0",
  hss_session_recover: "R0",
  variable_write_plan: "R2",
  variable_write_execute: "R2",
  halt: "R3",
  resume: "R3",
  reset: "R3",
};

export interface HssSafety {
  targetReset: boolean;
  targetWritten: boolean;
  flashIssued: boolean;
  resetIssued: boolean;
  haltIssued: boolean;
  resumeIssued: boolean;
}

export const HSS_SAFETY_FALSE: HssSafety = {
  targetReset: false,
  targetWritten: false,
  flashIssued: false,
  resetIssued: false,
  haltIssued: false,
  resumeIssued: false,
};

export const HSS_SCALAR_TYPES = ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32"] as const;
export const MAX_HSS_SYMBOLS = 32;
export type HssScalarType = typeof HSS_SCALAR_TYPES[number];
export type HssCaptureState = "planned" | "starting" | "capturing" | "stopping" | "completed" | "stopped" | "failed";
export type HssTransportStatus = "pass" | "failed";
export type HssValidationStatus = "pass" | "failed" | "warning" | "not_run";
export type HssTargetSource = "explicit" | "project-config";
export type HssTargetConfidence = "explicit" | "project-config";

export interface HssTargetConfigurationSource {
  file: string;
  format: "iar-ewp" | "jlink";
}

export interface HssTargetIdentity {
  targetId: string;
  source: HssTargetSource;
  confidence: HssTargetConfidence;
  configurationSource?: HssTargetConfigurationSource;
}

export interface HssRequestedSymbol {
  name: string;
  alias?: string;
  type?: HssScalarType;
  unit?: string;
}

const projectControlSelectorSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^(?:[A-Za-z0-9_./\\\\ -]+::)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/, "selector must be a scalar or fixed member path")
  .refine((value) => !value.includes("->") && !value.includes("[") && !value.includes("]"), "pointer and array traversal are forbidden");
const projectControlScalarTypeSchema = z.enum(HSS_SCALAR_TYPES);
const projectControlConditionSchema = z.object({
  selector: projectControlSelectorSchema,
  type: projectControlScalarTypeSchema,
  operator: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
  value: z.number().finite(),
}).strict();
const projectControlCommandSchema = z.object({
  selector: projectControlSelectorSchema,
  type: projectControlScalarTypeSchema,
  value: z.number().finite(),
  verify: projectControlConditionSchema,
  timeoutMs: z.number().int().min(1).max(10000).optional(),
}).strict();
export const projectControlConfigSchema = z.object({
  version: z.literal(1),
  preStartMs: z.number().int().min(0).max(5000).default(500),
  postStopMs: z.number().int().min(0).max(10000).default(1000),
  commands: z.object({ start: projectControlCommandSchema, stop: projectControlCommandSchema }).strict(),
}).strict();
export type ProjectControlConfig = z.infer<typeof projectControlConfigSchema>;

export interface HssResolvedSymbol extends Required<Pick<HssRequestedSymbol, "name" | "type">> {
  alias?: string;
  unit?: string;
  address: string;
  size: number;
  source: "elf-dwarf" | "iar-map";
  artifactGeneration?: string;
  qualifiedName?: string;
  memberPath?: string;
  layoutHash?: string;
  region?: "ram";
  confidence?: "dwarf" | "map";
  rootAddress?: string;
  memberOffset?: number;
}

export interface HssSegmentMetadata {
  file: string;
  sampleStart: number;
  sampleCount: number;
  recordSize: number;
  crc32: string;
}

export interface HssFlagInterval {
  eventId?: string;
  startUs: number;
  endUs: number;
  flags: number;
  reason: "write_in_progress" | "write_nearby" | "backend_busy";
}

export interface HssCaptureMetadata {
  version: 1;
  captureId: string;
  sessionName: string;
  projectRoot: string;
  storageRoot?: string;
  evidenceRoot?: string;
  backend: "jlink-hss";
  state: "completed" | "stopped" | "failed";
  transportStatus: HssTransportStatus;
  dataQualityStatus: HssValidationStatus;
  semanticValidationStatus: HssValidationStatus;
  payloadValidationStatus: HssValidationStatus;
  artifact: {
    file: string;
    mapFile?: string;
    mapSha256?: string;
    sha256: string;
    resolver: "elf-dwarf" | "iar-map" | "mixed";
    generation?: string;
    format?: "elf";
  };
  target: {
    device: string;
    targetId?: string;
    source?: HssTargetSource;
    confidence?: HssTargetConfidence;
    configurationSource?: HssTargetConfigurationSource;
    requestedDevice?: string;
    resolvedDevice?: string;
    interface: "SWD" | "JTAG";
    speedKhz: number;
  };
  probe: {
    model?: string;
    serial?: string;
    dllVersion?: string;
  };
  script?: {
    mode: "none" | "file";
    sourcePath?: string;
    path?: string;
    sha256?: string;
    approvalSha256: string;
    approvalSource: "trust-profile" | "trust-validation" | "trusted-allowlist";
    getCapsSelectionReturnCode: number;
    captureSelectionReturnCode?: number;
    noDefaultFallback: true;
  };
  reset?: Record<string, unknown>;
  symbols: HssResolvedSymbol[];
  sampling: {
    requestedRateHz: number;
    actualRateHz: number;
    hssIndexRateHz: number;
    hostObservedRateHz: number;
    helperReportedRateHz: number;
    helperActualRateHz: number;
    readMode: "periodic" | "drain";
    durationSec: number;
    timestampSource: "qpc";
    timestampFrequency: string;
  };
  layout: {
    hssSampleHeaderBytes: number;
    hssSampleStrideBytes: number;
    bytesPerSample: number;
    hssBlockCount: number;
    readBufferBytes: number;
    firstChangedOffset: number | null;
    firstChangedBytes: string;
    headerChangedRatio: number;
    payloadChangedRatio: number;
    payloadFirstChangedOffset: number | null;
    payloadFirstChangedBytes: string;
    payloadAllConstant: boolean;
    payloadAllZero: boolean;
  };
  targetState: {
    targetWasHaltedBeforeCapture: boolean;
    targetWasHaltedRaw?: number;
    resumeBeforeStart: boolean;
    resumeIssued: boolean;
    targetWasHaltedAfterResume: boolean | null;
    targetWasHaltedBeforeResume?: boolean;
    targetHaltedBeforeResumeRaw?: number;
    targetHaltedAfterResumeRaw?: number;
  };
  hmC095?: Record<string, unknown>;
  hmC095Oracle?: Record<string, unknown>;
  segments: HssSegmentMetadata[];
  quality: {
    sampleCount: number;
    validSamples: number;
    readErrors: number;
    timeouts: number;
    overflows: number;
    droppedSamples: number;
    targetHaltedSamples: number;
    actualRateHz: number;
  };
  events: Array<Record<string, unknown>>;
  flagIntervals?: HssFlagInterval[];
  warnings: string[];
  failures: string[];
  safety: HssSafety;
}
