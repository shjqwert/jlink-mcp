export type HssRiskLevel = "R0" | "R1";
export type HssToolOperation =
  | "hss_capability_probe"
  | "hss_capture_plan"
  | "hss_capture_start"
  | "hss_capture_status"
  | "hss_capture_stop"
  | "hss_capture_query"
  | "hss_capture_export";

export const HSS_TOOL_RISK: Record<HssToolOperation, HssRiskLevel> = {
  hss_capability_probe: "R0",
  hss_capture_plan: "R1",
  hss_capture_start: "R1",
  hss_capture_status: "R0",
  hss_capture_stop: "R1",
  hss_capture_query: "R0",
  hss_capture_export: "R0",
};

export const HSS_SAFETY_FALSE = {
  targetReset: false,
  targetWritten: false,
  flashIssued: false,
  resetIssued: false,
  haltIssued: false,
} as const;

export type HssScalarType = "uint8" | "int8" | "uint16" | "int16" | "uint32" | "int32" | "float32";
export type HssCaptureState = "planned" | "starting" | "capturing" | "stopping" | "completed" | "stopped" | "failed";

export interface HssRequestedSymbol {
  name: string;
  alias?: string;
  type?: HssScalarType;
  unit?: string;
}

export interface HssResolvedSymbol extends Required<Pick<HssRequestedSymbol, "name" | "type">> {
  alias?: string;
  unit?: string;
  address: string;
  size: number;
  source: "elf-dwarf" | "iar-map";
}

export interface HssSegmentMetadata {
  file: string;
  sampleStart: number;
  sampleCount: number;
  recordSize: number;
  crc32: string;
}

export interface HssCaptureMetadata {
  version: 1;
  captureId: string;
  sessionName: string;
  projectRoot: string;
  backend: "jlink-hss";
  state: "completed" | "stopped" | "failed";
  artifact: {
    file: string;
    mapFile?: string;
    sha256: string;
    resolver: "elf-dwarf" | "iar-map" | "mixed";
  };
  target: {
    device: string;
    interface: "SWD" | "JTAG";
    speedKhz: number;
  };
  probe: {
    model?: string;
    serial?: string;
    dllVersion?: string;
  };
  symbols: HssResolvedSymbol[];
  sampling: {
    requestedRateHz: number;
    actualRateHz: number;
    durationSec: number;
    timestampSource: "qpc";
    timestampFrequency: string;
  };
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
  warnings: string[];
  failures: string[];
  safety: typeof HSS_SAFETY_FALSE;
}
