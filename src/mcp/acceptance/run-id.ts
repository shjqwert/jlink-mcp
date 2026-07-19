const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const RESERVED_ROOT_NAMES = new Set(["captures", "exports", ".locks"]);
const RESERVED_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function isValidAcceptanceRunId(value: string): boolean {
  if (!RUN_ID.test(value)) return false;
  const lower = value.toLowerCase();
  if (RESERVED_ROOT_NAMES.has(lower) || lower.endsWith(".jcap")) return false;
  return !RESERVED_DEVICE_NAMES.has(lower.split(".", 1)[0]);
}
