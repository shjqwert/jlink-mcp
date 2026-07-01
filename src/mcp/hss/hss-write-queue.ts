import { HSS_ERROR, HssError } from "./hss-errors";

export type HssWriteQueueState = "IDLE" | "QUEUED" | "DONE" | "FAILED";

export class HssCaptureWriteQueue {
  private busy = false;
  private stopping = false;
  private inFlight: Promise<unknown> | null = null;
  state: HssWriteQueueState = "IDLE";

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new HssError(HSS_ERROR.CAPTURE_STOPPING, "capture is stopping; new writes are rejected");
    if (this.busy) throw new HssError(HSS_ERROR.CAPTURE_WRITE_BUSY, "capture write queue is busy");
    this.busy = true;
    this.state = "QUEUED";
    const inFlight = job()
      .then((value) => {
        this.state = "DONE";
        return value;
      })
      .catch((error) => {
        this.state = "FAILED";
        throw error;
      })
      .finally(() => {
        this.busy = false;
        this.inFlight = null;
      });
    this.inFlight = inFlight;
    return inFlight;
  }

  beginStopping(): void {
    this.stopping = true;
  }

  close(): void {
    this.stopping = true;
  }

  async waitForIdle(timeoutMs = 30000): Promise<void> {
    if (!this.inFlight) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.inFlight.then(() => undefined, () => undefined),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
