import { z } from "zod";

export const CAPTURE_IPC_VERSION = 1;
export const CAPTURE_BINARY_MAGIC = "JLCP";
export const CAPTURE_BINARY_VERSION = 1;
export const MAX_CAPTURE_SYMBOLS = 32;
export const MAX_QUERY_BUCKETS = 2000;

export const captureStates = [
  "idle",
  "preparing",
  "armed",
  "capturing",
  "completed",
  "stopped",
  "failed",
] as const;
export type CaptureState = typeof captureStates[number];

export const scalarTypes = [
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "float32",
] as const;
export type ScalarType = typeof scalarTypes[number];

export const scalarTypeSchema = z.enum(scalarTypes);
export const captureStateSchema = z.enum(captureStates);

export interface CaptureSymbol {
  name: string;
  alias?: string;
  unit?: string;
  address: number;
  size: number;
  type: ScalarType;
}

export interface CaptureFrameRecord {
  index: number;
  scheduledQpc: string;
  readStartQpc: string;
  readEndQpc: string;
  readMidpointQpc: string;
  readDurationQpc: string;
  flags: number;
  values: number[];
}

export interface CaptureEventRecord {
  qpc: string;
  type: string;
  success: boolean;
  detail: string;
}

export interface CaptureBinaryHeader {
  magic: typeof CAPTURE_BINARY_MAGIC;
  version: typeof CAPTURE_BINARY_VERSION;
  headerSize: number;
  qpcFrequency: string;
  symbolCount: number;
  frameCount: number;
  eventCount: number;
}

export interface CaptureMetadata {
  version: 1;
  sessionId: string;
  state: Exclude<CaptureState, "idle" | "preparing" | "armed" | "capturing">;
  elfPath: string;
  elfSha256: string;
  device: string;
  probeModel: string;
  probeSerial?: string;
  swdRateKhz: number;
  gdbServerPath: string;
  gdbServerVersion: string;
  rspCapabilities: string[];
  symbols: CaptureSymbol[];
  timing: Record<string, number>;
  events: CaptureEventRecord[];
  failures: string[];
  resets: CaptureEventRecord[];
  terminationReason: string;
  binaryFile: string;
}

const selectorSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^(?:[A-Za-z0-9_./\\ -]+::)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/, "selector must be a scalar or fixed member path")
  .refine((value) => !value.includes("->") && !value.includes("[") && !value.includes("]"), "pointer and array traversal are forbidden");

const conditionSchema = z.object({
  selector: selectorSchema,
  type: scalarTypeSchema,
  operator: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
  value: z.number().finite(),
}).strict();

const commandSchema = z.object({
  selector: selectorSchema,
  type: scalarTypeSchema,
  value: z.number().finite(),
  verify: conditionSchema,
  timeoutMs: z.number().int().min(1).max(10000).optional(),
}).strict();

export const projectControlConfigSchema = z.object({
  version: z.literal(1),
  preStartMs: z.number().int().min(0).max(5000).default(500),
  postStopMs: z.number().int().min(0).max(10000).default(1000),
  commands: z.object({
    start: commandSchema,
    stop: commandSchema,
  }).strict(),
}).strict();

export type ProjectControlConfig = z.infer<typeof projectControlConfigSchema>;

export interface CaptureIpcMessage<T = unknown> {
  version: typeof CAPTURE_IPC_VERSION;
  id: string;
  type: string;
  payload: T;
}

export function encodeCaptureIpc<T>(message: CaptureIpcMessage<T>): string {
  return JSON.stringify(message) + "\n";
}

export function decodeCaptureIpc(line: string): CaptureIpcMessage {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object") throw new Error("IPC message must be an object");
  const message = value as Record<string, unknown>;
  if (message.version !== CAPTURE_IPC_VERSION) throw new Error(`Unsupported IPC version: ${String(message.version)}`);
  if (typeof message.id !== "string" || !message.id) throw new Error("IPC message id is required");
  if (typeof message.type !== "string" || !message.type) throw new Error("IPC message type is required");
  if (!("payload" in message)) throw new Error("IPC message payload is required");
  return message as unknown as CaptureIpcMessage;
}
