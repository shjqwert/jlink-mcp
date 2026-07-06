import { HSS_ERROR, HssError } from "./hss-errors";

export type HssWriteQueueState = "IDLE" | "QUEUED" | "PRE_READ_OLD" | "WRITING" | "READBACK" | "EVENT_APPEND" | "FLAG_APPEND" | "AUDIT_APPEND" | "DONE" | "FAILED";
export interface HssWriteQueueStageRecord {
  stage: HssWriteQueueState;
  timeUs: number;
}

export class HssCaptureWriteQueue {
  private busy = false;
  private stopping = false;
  private inFlight: Promise<unknown> | null = null;
  private readonly stageHistory: HssWriteQueueStageRecord[] = [];
  state: HssWriteQueueState = "IDLE";

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new HssError(HSS_ERROR.CAPTURE_STOPPING, "capture is stopping; new writes are rejected");
    if (this.busy) throw new HssError(HSS_ERROR.CAPTURE_WRITE_BUSY, "capture write queue is busy");
    this.busy = true;
    this.stageHistory.length = 0;
    this.setStage("QUEUED");
    const inFlight = job()
      .then((value) => {
        this.setStage("DONE");
        return value;
      })
      .catch((error) => {
        this.setStage("FAILED");
        throw error;
      })
      .finally(() => {
        this.busy = false;
        this.inFlight = null;
      });
    this.inFlight = inFlight;
    return inFlight;
  }

  setStage(stage: HssWriteQueueState): void {
    this.state = stage;
    this.stageHistory.push({ stage, timeUs: Date.now() * 1000 });
  }

  history(): HssWriteQueueStageRecord[] {
    return this.stageHistory.map((record) => ({ ...record }));
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
