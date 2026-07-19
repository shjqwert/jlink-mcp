import { z } from "zod";

export const HSS_SCALAR_TYPES = ["uint8", "int8", "uint16", "int16", "uint32", "int32", "float32"] as const;
export const MAX_HSS_SYMBOLS = 10;
export type HssScalarType = typeof HSS_SCALAR_TYPES[number];
export type HssCaptureState = "planned" | "starting" | "capturing" | "stopping" | "completed" | "stopped" | "failed" | "interrupted";
export type HssTargetSource = "explicit" | "project-config";

export interface HssTargetConfigurationSource {
  file: string;
  format: "iar-ewp" | "jlink";
}

export interface HssTargetIdentity {
  targetId: string;
  source: HssTargetSource;
  confidence: HssTargetSource;
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
  .regex(/^(?:(?:[A-Za-z]:)?[A-Za-z0-9_./\\\\ -]+::)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/, "selector must be a scalar or fixed member path")
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
  timeoutMs: z.number().int().min(1).max(10_000).optional(),
}).strict();

export const projectControlConfigSchema = z.object({
  version: z.literal(1),
  preStartMs: z.number().int().min(0).max(5_000).default(500),
  postStopMs: z.number().int().min(0).max(10_000).default(1_000),
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
