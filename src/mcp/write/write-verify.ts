import { numericValue, SafeWriteRequest, validateSafeWriteRequest, WriteOperator, WritePolicy } from "./write-contract";

export interface SymbolMemoryBackend {
  readSymbol(selector: string): number;
  writeSymbol(selector: string, value: number): void;
}

export type WriteVerifyResult =
  | { ok: true; readback: number }
  | { ok: false; error: { code: "validation_error" | "unknown_symbol" | "verify_timeout"; message: string; readback?: number } };

export function executeSafeWrite(request: SafeWriteRequest, policy: WritePolicy, backend: SymbolMemoryBackend): WriteVerifyResult {
  const validation = validateSafeWriteRequest(request, policy);
  if (!validation.ok) return validation;
  try {
    backend.writeSymbol(validation.entry.selector, numericValue(request.value));
    const deadline = Date.now() + (request.verify.timeoutMs ?? 0);
    do {
      const readback = backend.readSymbol(validation.verifyEntry.selector);
      if (compare(readback, request.verify.operator, request.verify.value)) return { ok: true, readback };
      if ((request.verify.timeoutMs ?? 0) === 0) return { ok: false, error: { code: "verify_timeout", message: "write verification did not match", readback } };
    } while (Date.now() <= deadline);
    return { ok: false, error: { code: "verify_timeout", message: "write verification timed out" } };
  } catch (error) {
    return { ok: false, error: { code: "unknown_symbol", message: error instanceof Error ? error.message : String(error) } };
  }
}

function compare(left: number, operator: WriteOperator, right: number): boolean {
  switch (operator) {
    case "eq": return left === right;
    case "ne": return left !== right;
    case "lt": return left < right;
    case "lte": return left <= right;
    case "gt": return left > right;
    case "gte": return left >= right;
  }
}
