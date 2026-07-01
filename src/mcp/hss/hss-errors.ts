export const HSS_ERROR = {
  PATH_OUTSIDE_CWD: "PATH_OUTSIDE_CWD",
  UNSUPPORTED_ARTIFACT: "UNSUPPORTED_ARTIFACT",
  ARTIFACT_NOT_FOUND: "ARTIFACT_NOT_FOUND",
  MAP_NOT_FOUND: "MAP_NOT_FOUND",
  SYMBOL_NOT_FOUND: "SYMBOL_NOT_FOUND",
  SYMBOL_UNSAFE: "SYMBOL_UNSAFE",
  SYMBOL_DUPLICATE: "SYMBOL_DUPLICATE",
  HSS_DLL_MISSING: "HSS_DLL_MISSING",
  HSS_DLL_EXPORTS_MISSING: "HSS_DLL_EXPORTS_MISSING",
  HSS_HELPER_MISSING: "HSS_HELPER_MISSING",
  HSS_HELPER_TIMEOUT: "HSS_HELPER_TIMEOUT",
  HSS_HELPER_BAD_JSON: "HSS_HELPER_BAD_JSON",
  HSS_TARGET_HALTED: "HSS_TARGET_HALTED",
  HSS_CAPTURE_ACTIVE: "HSS_CAPTURE_ACTIVE",
  HSS_CAPTURE_NOT_FOUND: "HSS_CAPTURE_NOT_FOUND",
  HSS_CAPTURE_NOT_TERMINAL: "HSS_CAPTURE_NOT_TERMINAL",
  HSS_CRC_MISMATCH: "HSS_CRC_MISMATCH",
  HSS_CAPABILITY_LIMIT: "HSS_CAPABILITY_LIMIT",
  HSS_EXPORT_EXISTS: "HSS_EXPORT_EXISTS",
} as const;

export type HssErrorCode = typeof HSS_ERROR[keyof typeof HSS_ERROR];

export class HssError extends Error {
  constructor(
    readonly code: HssErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function hssError(error: unknown): HssError {
  if (error instanceof HssError) return error;
  return new HssError("HSS_HELPER_BAD_JSON", error instanceof Error ? error.message : String(error));
}
