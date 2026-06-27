import { ScalarType, scalarTypes } from "../capture-contract";

export type WriteOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export interface VerifyCondition {
  selector: string;
  type: ScalarType;
  operator: WriteOperator;
  value: number;
  timeoutMs?: number;
}

export interface SafeWriteRequest {
  selector: string;
  type: ScalarType;
  value: number | boolean;
  min?: number;
  max?: number;
  verify: VerifyCondition;
  allowlistId: string;
}

export interface WritePolicyEntry {
  selector: string;
  alias?: string;
  type: ScalarType;
  min?: number;
  max?: number;
  modes?: string[];
}

export interface WritePolicy {
  allowlists: Record<string, WritePolicyEntry[]>;
  dangerousSelectors: string[];
}

export type WriteValidationResult =
  | { ok: true; request: SafeWriteRequest; entry: WritePolicyEntry; verifyEntry: WritePolicyEntry }
  | { ok: false; error: { code: "validation_error"; message: string } };

const selectorPattern = /^(?:[A-Za-z0-9_./\\ -]+::)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const operators = new Set<WriteOperator>(["eq", "ne", "lt", "lte", "gt", "gte"]);

export function validateSafeWriteRequest(input: unknown, policy: WritePolicy): WriteValidationResult {
  if (!input || typeof input !== "object") return invalid("write request must be an object");
  const request = input as Partial<SafeWriteRequest>;
  const selectorError = validateSelector(request.selector);
  if (selectorError) return invalid(selectorError);
  if (!isScalarType(request.type)) return invalid("unknown type");
  if (!isFiniteWriteValue(request.value)) return invalid("value must be finite");
  if (!matchesScalarType(request.value, request.type)) return invalid("value does not match scalar type");
  if (!request.verify || typeof request.verify !== "object") return invalid("verify condition is required");
  const verify = request.verify as Partial<VerifyCondition>;
  const verifySelectorError = validateSelector(verify.selector);
  if (verifySelectorError) return invalid(`verify ${verifySelectorError}`);
  if (!isScalarType(verify.type)) return invalid("verify unknown type");
  if (!operators.has(verify.operator as WriteOperator)) return invalid("unknown verify operator");
  if (typeof verify.value !== "number" || !Number.isFinite(verify.value)) return invalid("verify value must be finite");
  if (request.allowlistId === undefined || typeof request.allowlistId !== "string" || request.allowlistId.length === 0) return invalid("allowlistId is required");
  if (isDangerous(request.selector!, policy) || isDangerous(verify.selector!, policy)) return invalid("selector is classified as dangerous");

  const entries = policy.allowlists[request.allowlistId] ?? [];
  const entry = entries.find((item) => matchesSelector(item, request.selector!));
  const verifyEntry = entries.find((item) => matchesSelector(item, verify.selector!));
  if (!entry) return invalid("selector is not allowlisted");
  if (!verifyEntry) return invalid("verify selector is not allowlisted");
  if (entry.type !== request.type) return invalid("type does not match allowlist");
  if (verifyEntry.type !== verify.type) return invalid("verify type does not match allowlist");

  const numeric = numericValue(request.value!);
  const min = maxDefined(entry.min, request.min);
  const max = minDefined(entry.max, request.max);
  if (min !== undefined && numeric < min) return invalid("value is below allowed range");
  if (max !== undefined && numeric > max) return invalid("value is above allowed range");

  return { ok: true, request: request as SafeWriteRequest, entry, verifyEntry };
}

export function isDangerous(selector: string, policy: WritePolicy): boolean {
  return policy.dangerousSelectors.some((pattern) => wildcardMatch(pattern, selector));
}

function validateSelector(selector: unknown): string | null {
  if (typeof selector !== "string" || selector.length === 0) return "selector is required";
  if (selector.includes("->")) return "pointer selectors are forbidden";
  if (selector.includes("[") || selector.includes("]")) return "array selectors are forbidden";
  return selectorPattern.test(selector) ? null : "selector must be a scalar or fixed member path";
}

function matchesSelector(entry: WritePolicyEntry, selector: string): boolean {
  return entry.selector === selector || entry.alias === selector;
}

function wildcardMatch(pattern: string, selector: string): boolean {
  return pattern.endsWith(".*") ? selector.startsWith(pattern.slice(0, -1)) : pattern === selector;
}

function isScalarType(value: unknown): value is ScalarType {
  return typeof value === "string" && scalarTypes.includes(value as ScalarType);
}

function isFiniteWriteValue(value: unknown): value is number | boolean {
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function matchesScalarType(value: number | boolean, type: ScalarType): boolean {
  if (typeof value === "boolean") return true;
  return type === "float32" || Number.isInteger(value);
}

function maxDefined(left?: number, right?: number): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.max(left, right);
}

function minDefined(left?: number, right?: number): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

export function numericValue(value: number | boolean): number {
  return typeof value === "boolean" ? Number(value) : value;
}

function invalid(message: string): WriteValidationResult {
  return { ok: false, error: { code: "validation_error", message } };
}
