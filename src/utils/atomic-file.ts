import { existsSync, renameSync } from "node:fs";

const DEFAULT_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64] as const;
const RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

type RenameOperation = (source: string, destination: string) => void;

export interface AtomicReplaceOptions {
  rename?: RenameOperation;
  retryDelaysMs?: readonly number[];
}

/**
 * Publishes a prepared file without removing the previous destination.
 * Windows may transiently reject an otherwise atomic replace while another
 * process briefly holds a sharing handle, so those failures receive a small,
 * bounded retry window. All other failures are propagated immediately.
 */
export function atomicReplaceSync(source: string, destination: string, options: AtomicReplaceOptions = {}): void {
  const rename = options.rename ?? renameSync;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!RETRYABLE_RENAME_CODES.has(String(code)) || attempt >= retryDelays.length || !existsSync(source)) throw error;
      waitSync(retryDelays[attempt]);
    }
  }
}

function waitSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
