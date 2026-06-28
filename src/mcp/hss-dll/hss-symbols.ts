export const DEFAULT_HSS_READ_ONLY_VARIABLES = [
  "s_traceAliveCounter",
  "trace_state",
  "motor_fault",
  "sector",
  "theta_rad",
  "mod_pu",
  "iu_pu",
  "iv_pu",
  "iw_pu",
  "duty_u",
  "duty_v",
  "duty_w",
] as const;

const FORBIDDEN_PATTERNS = [
  /(^|[.:])bMotorStarted$/i,
  /gstMotorCtrl/i,
  /gstMotorDbg/i,
  /(^|[^A-Za-z0-9])(capture_control|start|stop|run|dir|control|ref)($|[^A-Za-z0-9])/i,
];

export function validateHssReadOnlyVariable(name: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, reason: "symbol name is empty" };
  const forbidden = FORBIDDEN_PATTERNS.find((pattern) => pattern.test(trimmed));
  if (forbidden) return { ok: false, reason: `unsafe HSS observation symbol rejected: ${trimmed}` };
  return { ok: true };
}

export function requireHssReadOnlyVariables(names: string[]): void {
  for (const name of names) {
    const validation = validateHssReadOnlyVariable(name);
    if (!validation.ok) throw new Error(validation.reason);
  }
}

export function selectDefaultHssReadOnlyVariables(count: number): string[] {
  return DEFAULT_HSS_READ_ONLY_VARIABLES.slice(0, count);
}
