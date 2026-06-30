export const HSS_STATUS_FLAGS = {
  valid: 1 << 0,
  read_error: 1 << 1,
  timeout: 1 << 2,
  overflow: 1 << 3,
  dropped_before_this_sample: 1 << 4,
  target_halted: 1 << 5,
  write_nearby: 1 << 6,
  write_in_progress: 1 << 7,
  backend_busy: 1 << 8,
} as const;

export const HSS_MVP_A_RESERVED_WRITE_FLAGS =
  HSS_STATUS_FLAGS.write_nearby | HSS_STATUS_FLAGS.write_in_progress | HSS_STATUS_FLAGS.backend_busy;

export function assertNoMvpAWriteFlags(statusFlags: number): void {
  if ((statusFlags & HSS_MVP_A_RESERVED_WRITE_FLAGS) !== 0) {
    throw new Error("HSS MVP-A capture set a reserved write status flag");
  }
}
