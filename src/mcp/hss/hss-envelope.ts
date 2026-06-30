import { HSS_TOOL_RISK, type HssToolOperation } from "./hss-contract";
import { hssError } from "./hss-errors";

export interface HssEnvelope<T> {
  ok: boolean;
  operation: HssToolOperation;
  data: T | null;
  risk: {
    level: "R0" | "R1";
    requiresUserApproval: false;
  };
  backend: {
    selected: "jlink-hss" | null;
    fallbackFrom: null;
    reason: string | null;
  };
  artifacts: string[];
  warnings: string[];
  message: "completed" | "failed";
  error?: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
}

export function hssOk<T>(
  operation: HssToolOperation,
  data: T,
  artifacts: string[] = [],
  warnings: string[] = [],
): HssEnvelope<T> {
  return {
    ok: true,
    operation,
    data,
    risk: { level: HSS_TOOL_RISK[operation], requiresUserApproval: false },
    backend: { selected: "jlink-hss", fallbackFrom: null, reason: null },
    artifacts,
    warnings,
    message: "completed",
  };
}

export function hssFail<T>(
  operation: HssToolOperation,
  error: unknown,
  artifacts: string[] = [],
  warnings: string[] = [],
): HssEnvelope<T> {
  const hss = hssError(error);
  return {
    ok: false,
    operation,
    data: null,
    risk: { level: HSS_TOOL_RISK[operation], requiresUserApproval: false },
    backend: { selected: null, fallbackFrom: null, reason: hss.message },
    artifacts,
    warnings,
    message: "failed",
    error: { code: hss.code, message: hss.message, details: hss.details },
  };
}
