export const HSS_ERROR = {
  PATH_OUTSIDE_CWD: "PATH_OUTSIDE_CWD",
  UNSUPPORTED_ARTIFACT: "UNSUPPORTED_ARTIFACT",
  ARTIFACT_NOT_FOUND: "ARTIFACT_NOT_FOUND",
  MAP_NOT_FOUND: "MAP_NOT_FOUND",
  SYMBOL_NOT_FOUND: "SYMBOL_NOT_FOUND",
  SYMBOL_UNSAFE: "SYMBOL_UNSAFE",
  SYMBOL_DUPLICATE: "SYMBOL_DUPLICATE",
  TYPE_MISMATCH: "TYPE_MISMATCH",
  VALUE_OUT_OF_RANGE: "VALUE_OUT_OF_RANGE",
  ELEMENT_COUNT_INVALID: "ELEMENT_COUNT_INVALID",
  HSS_HELPER_BAD_JSON: "HSS_HELPER_BAD_JSON",
} as const;

export type HssErrorCode = typeof HSS_ERROR[keyof typeof HSS_ERROR];

export class HssError extends Error {
  constructor(
    readonly code: HssErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HssError";
  }
}

export function hssError(error: unknown): HssError {
  if (error instanceof HssError) return error;
  return new HssError(HSS_ERROR.HSS_HELPER_BAD_JSON, error instanceof Error ? error.message : String(error));
}
