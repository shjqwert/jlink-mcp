import assert from "node:assert/strict";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import { HssCaptureWriteQueue } from "./hss-write-queue";

test("HSS write queue allows one job and rejects concurrent jobs", async () => {
  const queue = new HssCaptureWriteQueue();
  let release!: () => void;
  const first = queue.run(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return "ok";
  });
  await assert.rejects(() => queue.run(async () => "second"), queueError(HSS_ERROR.CAPTURE_WRITE_BUSY));
  release();
  assert.equal(await first, "ok");
  assert.equal(await queue.run(async () => "next"), "next");
});

test("HSS write queue releases lock after failure and rejects when stopping", async () => {
  const queue = new HssCaptureWriteQueue();
  await assert.rejects(() => queue.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await queue.run(async () => "recovered"), "recovered");
  queue.beginStopping();
  await assert.rejects(() => queue.run(async () => "late"), queueError(HSS_ERROR.CAPTURE_STOPPING));
});

test("HSS write queue waitForIdle lets current write finish while stopping", async () => {
  const queue = new HssCaptureWriteQueue();
  let release!: () => void;
  let done = false;
  const first = queue.run(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    done = true;
  });
  queue.beginStopping();
  release();
  await queue.waitForIdle();
  await first;
  assert.equal(done, true);
});

function queueError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HssError && error.code === code;
}
