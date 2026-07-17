import { HSS_ERROR, HssError } from "./hss-errors";

export type HssWriteQueueState = "IDLE" | "QUEUED" | "PRE_READ_OLD" | "WRITING" | "READBACK" | "EVENT_APPEND" | "FLAG_APPEND" | "AUDIT_APPEND" | "DONE" | "FAILED";
export interface HssWriteQueueStageRecord {
  stage: HssWriteQueueState;
  timeUs: number;
}

export type HssWriteQueueOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export class HssCaptureWriteQueue {
  private stopping = false;
  private tail: Promise<void> = Promise.resolve();
  private inFlight: Promise<unknown> | null = null;
  private readonly stageHistory: HssWriteQueueStageRecord[] = [];
  state: HssWriteQueueState = "IDLE";

  async run<T>(job: () => Promise<T>, beforeRelease?: (outcome: HssWriteQueueOutcome<T>) => Promise<void>): Promise<T> {
    if (this.stopping) throw new HssError(HSS_ERROR.CAPTURE_STOPPING, "capture is stopping; new writes are rejected");
    const run = this.tail.then(async () => {
      if (this.stopping) throw new HssError(HSS_ERROR.CAPTURE_STOPPING, "capture is stopping; queued writes are rejected");
      this.stageHistory.length = 0;
      this.setStage("QUEUED");
      let value: T;
      try {
        value = await job();
      } catch (error) {
        try {
          await beforeRelease?.({ ok: false, error });
        } catch (auditError) {
          this.stopping = true;
          throw auditError;
        } finally {
          this.setStage("FAILED");
        }
        throw error;
      }
      try {
        await beforeRelease?.({ ok: true, value });
      } catch (error) {
        this.stopping = true;
        this.setStage("FAILED");
        throw error;
      }
      this.setStage("DONE");
      return value;
    });
    this.tail = run.then(() => undefined, () => undefined);
    const completion = this.tail;
    this.inFlight = completion;
    void completion.finally(() => {
      if (this.inFlight === completion) this.inFlight = null;
    });
    return run;
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
