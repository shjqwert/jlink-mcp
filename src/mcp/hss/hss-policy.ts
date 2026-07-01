import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HSS_ERROR, HssError } from "./hss-errors";
import { assertInsideProject, hssProjectPaths } from "./project-paths";
import type { HssScalarType } from "./hss-contract";

export type HssPolicyVersion = 2;
export type HssPolicyRisk = "R2" | "R3";
export type HssPolicyKind = "scalar" | "fixed_array";
export type HssPolicyMaxWritesScope = "capture" | "session";

export interface HssPolicy {
  version: HssPolicyVersion;
  requireReadback: boolean;
  allowBurstWrite: boolean;
  defaultMaxWritesScope: HssPolicyMaxWritesScope;
  policyHash: string;
  variableWriteAllowlist: HssPolicyEntry[];
}

export type HssPolicyEntry = HssScalarPolicyEntry | HssFixedArrayPolicyEntry;

export interface HssPolicyBaseEntry {
  path: string;
  kind: HssPolicyKind;
  scope?: string;
  min?: number;
  max?: number;
  allowedValues?: number[];
  maxWriteOps: number;
  maxElementsTotal: number;
  maxBytesPerWrite: number;
  maxWritesScope: HssPolicyMaxWritesScope;
  requireReadback: boolean;
  risk: HssPolicyRisk;
  executable: boolean;
  captureTimeWrite: boolean;
  description?: string;
}

export interface HssScalarPolicyEntry extends HssPolicyBaseEntry {
  kind: "scalar";
  type: HssScalarType;
}

export interface HssFixedArrayPolicyEntry extends HssPolicyBaseEntry {
  kind: "fixed_array";
  elementType: HssScalarType;
  arrayLength: number;
  allowedIndices?: number[];
  allowedIndexRange?: { start: number; end: number };
  allowArrayElementWrite: boolean;
  allowArraySliceWrite: boolean;
  maxElementsPerWrite: number;
}

const SUPPORTED_TYPES = new Set<HssScalarType>(["int8", "uint8", "int16", "uint16", "int32", "uint32", "float32"]);
const TYPE_BYTES: Record<HssScalarType, number> = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4 };
const TYPE_RANGE: Record<HssScalarType, { min: number; max: number; integer: boolean }> = {
  int8: { min: -128, max: 127, integer: true },
  uint8: { min: 0, max: 255, integer: true },
  int16: { min: -32768, max: 32767, integer: true },
  uint16: { min: 0, max: 65535, integer: true },
  int32: { min: -2147483648, max: 2147483647, integer: true },
  uint32: { min: 0, max: 4294967295, integer: true },
  float32: { min: -3.4028234663852886e38, max: 3.4028234663852886e38, integer: false },
};

export function hssPolicyPath(cwd = process.cwd()): string {
  const paths = hssProjectPaths(cwd);
  const file = join(paths.outputRoot, "policy.json");
  assertInsideProject(file, cwd);
  return file;
}

export async function loadHssPolicy(cwd = process.cwd()): Promise<HssPolicy> {
  const file = hssPolicyPath(cwd);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") throw new HssError(HSS_ERROR.POLICY_NOT_FOUND, "HSS policy.json was not found", { file });
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new HssError(HSS_ERROR.POLICY_INVALID_JSON, "HSS policy.json is not valid JSON", { file, reason: error instanceof Error ? error.message : String(error) });
  }
  return normalizeHssPolicy(raw);
}

export function normalizeHssPolicy(raw: unknown): HssPolicy {
  const object = record(raw, "policy");
  if (object.version !== 2) throw new HssError(HSS_ERROR.POLICY_UNSUPPORTED_VERSION, "HSS policy version must be 2");
  const entriesRaw = arrayField(object, "variableWriteAllowlist");
  const rootRequireReadback = optionalBoolean(object, "requireReadback") ?? true;
  const defaultMaxWritesScope = maxWritesScope(optionalString(object, "defaultMaxWritesScope") ?? "capture");
  const policy: Omit<HssPolicy, "policyHash"> = {
    version: 2,
    requireReadback: rootRequireReadback,
    allowBurstWrite: optionalBoolean(object, "allowBurstWrite") ?? false,
    defaultMaxWritesScope,
    variableWriteAllowlist: entriesRaw.map((entry, index) => normalizeEntry(entry, index, rootRequireReadback, defaultMaxWritesScope)),
  };
  return { ...policy, policyHash: hashStable(policy) };
}

export function policyEntryForPath(policy: HssPolicy, path: string, kind?: HssPolicyKind): HssPolicyEntry {
  const entry = policy.variableWriteAllowlist.find((candidate) => candidate.path === path && (!kind || candidate.kind === kind));
  if (!entry) throw new HssError(HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED, "target is not in the variable write allowlist", { path, kind });
  return entry;
}

export function hssPolicyElementSize(type: HssScalarType): number {
  return TYPE_BYTES[type];
}

export function assertHssPolicyValues(entry: HssPolicyEntry, values: number[]): void {
  if (values.length === 0) throw new HssError(HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED, "values must not be empty");
  for (const value of values) {
    assertValueMatchesType(entry.kind === "scalar" ? entry.type : entry.elementType, value);
    if (entry.min !== undefined && value < entry.min) throw new HssError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE, "value is below policy min", { path: entry.path, value, min: entry.min });
    if (entry.max !== undefined && value > entry.max) throw new HssError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE, "value is above policy max", { path: entry.path, value, max: entry.max });
    if (entry.allowedValues && !entry.allowedValues.includes(value)) throw new HssError(HSS_ERROR.POLICY_VALUE_NOT_ALLOWED, "value is not in policy allowedValues", { path: entry.path, value });
  }
}

export function assertHssPolicyArrayElement(entry: HssFixedArrayPolicyEntry, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= entry.arrayLength) {
    throw new HssError(HSS_ERROR.POLICY_ARRAY_INDEX_OUT_OF_RANGE, "array index is outside policy bounds", { path: entry.path, index, arrayLength: entry.arrayLength });
  }
  if (entry.allowedIndices && !entry.allowedIndices.includes(index)) {
    throw new HssError(HSS_ERROR.POLICY_ARRAY_INDEX_NOT_ALLOWED, "array index is not allowlisted", { path: entry.path, index });
  }
  if (entry.allowedIndexRange && (index < entry.allowedIndexRange.start || index > entry.allowedIndexRange.end)) {
    throw new HssError(HSS_ERROR.POLICY_ARRAY_INDEX_NOT_ALLOWED, "array index is outside allowlisted range", { path: entry.path, index, range: entry.allowedIndexRange });
  }
}

export function assertHssPolicyArraySlice(entry: HssFixedArrayPolicyEntry, startIndex: number, elementCount: number): void {
  if (!entry.allowArraySliceWrite) throw new HssError(HSS_ERROR.POLICY_ARRAY_SLICE_NOT_ALLOWED, "array slice writes are disabled by policy", { path: entry.path });
  if (elementCount <= 0) throw new HssError(HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED, "array slice values must not be empty", { path: entry.path });
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex + elementCount > entry.arrayLength) {
    throw new HssError(HSS_ERROR.POLICY_ARRAY_SLICE_OUT_OF_RANGE, "array slice is outside policy bounds", { path: entry.path, startIndex, elementCount, arrayLength: entry.arrayLength });
  }
  if (elementCount > entry.maxElementsPerWrite) {
    throw new HssError(HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED, "array slice exceeds maxElementsPerWrite", { path: entry.path, elementCount, maxElementsPerWrite: entry.maxElementsPerWrite });
  }
  for (let index = startIndex; index < startIndex + elementCount; index += 1) assertHssPolicyArrayElement(entry, index);
}

function normalizeEntry(raw: unknown, index: number, rootRequireReadback: boolean, defaultMaxWritesScope: HssPolicyMaxWritesScope): HssPolicyEntry {
  const entry = record(raw, `variableWriteAllowlist[${index}]`);
  const kind = stringField(entry, "kind");
  const path = stringField(entry, "path");
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(path)) throw new HssError(HSS_ERROR.POLICY_TARGET_NOT_ALLOWLISTED, "policy target path is not a variable path", { path });
  const risk = policyRisk(optionalString(entry, "risk") ?? "R2");
  const base = {
    path,
    scope: optionalString(entry, "scope"),
    min: optionalNumber(entry, "min"),
    max: optionalNumber(entry, "max"),
    allowedValues: optionalNumberArray(entry, "allowedValues"),
    maxWriteOps: positiveInt(entry, "maxWriteOps", 1),
    maxElementsTotal: positiveInt(entry, "maxElementsTotal", Number.MAX_SAFE_INTEGER),
    maxWritesScope: maxWritesScope(optionalString(entry, "maxWritesScope") ?? defaultMaxWritesScope),
    requireReadback: optionalBoolean(entry, "requireReadback") ?? rootRequireReadback,
    risk,
    executable: risk === "R2",
    captureTimeWrite: optionalBoolean(entry, "captureTimeWrite") ?? true,
    description: optionalString(entry, "description"),
  };
  if (kind === "scalar") {
    const type = scalarType(stringField(entry, "type"));
    validateValueBounds(type, base.min, base.max, base.allowedValues);
    return {
      ...base,
      kind,
      type,
      maxBytesPerWrite: positiveInt(entry, "maxBytesPerWrite", TYPE_BYTES[type]),
    };
  }
  if (kind === "fixed_array") {
    const elementType = scalarType(stringField(entry, "elementType"));
    const arrayLength = positiveInt(entry, "arrayLength");
    const allowedIndices = optionalIndexArray(entry, "allowedIndices", arrayLength);
    const allowedIndexRange = optionalIndexRange(entry, "allowedIndexRange", arrayLength);
    const maxElementsPerWrite = positiveInt(entry, "maxElementsPerWrite", 1);
    const maxBytesPerWrite = positiveInt(entry, "maxBytesPerWrite", TYPE_BYTES[elementType] * maxElementsPerWrite);
    if (maxBytesPerWrite < TYPE_BYTES[elementType] * maxElementsPerWrite) {
      throw new HssError(HSS_ERROR.POLICY_MAX_BYTES_EXCEEDED, "maxBytesPerWrite is smaller than maxElementsPerWrite * elementSize", { path, maxBytesPerWrite, maxElementsPerWrite });
    }
    validateValueBounds(elementType, base.min, base.max, base.allowedValues);
    return {
      ...base,
      kind,
      elementType,
      arrayLength,
      allowedIndices,
      allowedIndexRange,
      allowArrayElementWrite: optionalBoolean(entry, "allowArrayElementWrite") ?? true,
      allowArraySliceWrite: optionalBoolean(entry, "allowArraySliceWrite") ?? false,
      maxElementsPerWrite,
      maxBytesPerWrite,
    };
  }
  throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "policy allowlist kind must be scalar or fixed_array", { kind });
}

function validateValueBounds(type: HssScalarType, min?: number, max?: number, allowedValues?: number[]): void {
  if (min !== undefined) assertValueMatchesType(type, min);
  if (max !== undefined) assertValueMatchesType(type, max);
  if (min !== undefined && max !== undefined && min > max) throw new HssError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE, "policy min must be <= max");
  for (const value of allowedValues ?? []) assertValueMatchesType(type, value);
}

function assertValueMatchesType(type: HssScalarType, value: number): void {
  const range = TYPE_RANGE[type];
  if (!Number.isFinite(value) || value < range.min || value > range.max || (range.integer && !Number.isInteger(value))) {
    throw new HssError(HSS_ERROR.POLICY_VALUE_OUT_OF_RANGE, `value does not fit ${type}`, { type, value });
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HssError(HSS_ERROR.POLICY_INVALID_JSON, `${name} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(source: Record<string, unknown>, name: string): string {
  const value = source[name];
  if (typeof value !== "string" || !value) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, `${name} must be a non-empty string`);
  return value;
}

function optionalString(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, `${name} must be a string`);
  return value;
}

function optionalBoolean(source: Record<string, unknown>, name: string): boolean | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, `${name} must be a boolean`);
  return value;
}

function optionalNumber(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, `${name} must be a finite number`);
  return value;
}

function positiveInt(source: Record<string, unknown>, name: string, fallback?: number): number {
  const value = source[name] ?? fallback;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new HssError(HSS_ERROR.POLICY_MAX_ELEMENTS_EXCEEDED, `${name} must be a positive integer`);
  return Number(value);
}

function arrayField(source: Record<string, unknown>, name: string): unknown[] {
  const value = source[name];
  if (!Array.isArray(value)) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, `${name} must be an array`);
  return value;
}

function optionalNumberArray(source: Record<string, unknown>, name: string): number[] | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new HssError(HSS_ERROR.POLICY_VALUE_NOT_ALLOWED, `${name} must contain finite numbers`);
  }
  return value as number[];
}

function optionalIndexArray(source: Record<string, unknown>, name: string, arrayLength: number): number[] | undefined {
  const values = optionalNumberArray(source, name);
  if (!values) return undefined;
  if (values.some((value) => !Number.isInteger(value))) throw new HssError(HSS_ERROR.POLICY_ARRAY_INDEX_OUT_OF_RANGE, `${name} must contain integer indices`);
  for (const value of values) {
    if (value < 0 || value >= arrayLength) throw new HssError(HSS_ERROR.POLICY_ARRAY_INDEX_OUT_OF_RANGE, "allowed index is outside array bounds", { index: value, arrayLength });
  }
  return [...new Set(values)];
}

function optionalIndexRange(source: Record<string, unknown>, name: string, arrayLength: number): { start: number; end: number } | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  const range = record(value, name);
  const start = positiveIndex(range, "start");
  const end = positiveIndex(range, "end");
  if (start > end || end >= arrayLength) throw new HssError(HSS_ERROR.POLICY_ARRAY_SLICE_OUT_OF_RANGE, "allowedIndexRange is outside array bounds", { start, end, arrayLength });
  return { start, end };
}

function positiveIndex(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (!Number.isInteger(value) || Number(value) < 0) throw new HssError(HSS_ERROR.POLICY_ARRAY_SLICE_OUT_OF_RANGE, `${name} must be a non-negative integer`);
  return Number(value);
}

function scalarType(value: string): HssScalarType {
  if (!SUPPORTED_TYPES.has(value as HssScalarType)) throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "unsupported policy scalar type", { type: value });
  return value as HssScalarType;
}

function policyRisk(value: string): HssPolicyRisk {
  if (value !== "R2" && value !== "R3") throw new HssError(HSS_ERROR.POLICY_RISK_NOT_EXECUTABLE, "policy risk must be R2 or R3", { risk: value });
  return value;
}

function maxWritesScope(value: string): HssPolicyMaxWritesScope {
  if (value !== "capture" && value !== "session") throw new HssError(HSS_ERROR.POLICY_TYPE_MISMATCH, "maxWritesScope must be capture or session", { value });
  return value;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
