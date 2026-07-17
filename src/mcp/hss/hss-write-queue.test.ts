import assert from "node:assert/strict";
import test from "node:test";
import { HSS_ERROR, HssError } from "./hss-errors";
import { HssCaptureWriteQueue } from "./hss-write-queue";

test("HSS write queue serializes concurrent jobs through the before-release boundary", async () => {
  const queue = new HssCaptureWriteQueue();
  let release!: () => void;
  const order: string[] = [];
  const first = queue.run(async () => {
    order.push("first-write");
    await new Promise<void>((resolve) => { release = resolve; });
    return "ok";
  }, async () => {
    queue.setStage("AUDIT_APPEND");
    order.push("first-audit");
  });
  const second = queue.run(async () => {
    order.push("second-write");
    return "second";
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-write"]);
  release();
  assert.equal(await first, "ok");
  assert.equal(await second, "second");
  assert.deepEqual(order, ["first-write", "first-audit", "second-write"]);
});

test("HSS write queue records scalar write stages", async () => {
  const queue = new HssCaptureWriteQueue();
  await queue.run(async () => {
    queue.setStage("PRE_READ_OLD");
    queue.setStage("WRITING");
    queue.setStage("READBACK");
  });
  assert.deepEqual(queue.history().map((record) => record.stage), ["QUEUED", "PRE_READ_OLD", "WRITING", "READBACK", "DONE"]);
});

test("HSS write queue releases lock after failure and rejects when stopping", async () => {
  const queue = new HssCaptureWriteQueue();
  await assert.rejects(() => queue.run(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await queue.run(async () => "recovered"), "recovered");
  queue.beginStopping();
  await assert.rejects(() => queue.run(async () => "late"), queueError(HSS_ERROR.CAPTURE_STOPPING));
});

test("HSS write queue rejects queued hardware work when outcome audit fails", async () => {
  const queue = new HssCaptureWriteQueue();
  let secondEntered = false;
  const first = queue.run(async () => "written", async () => { throw new Error("audit fsync failed"); });
  const second = queue.run(async () => { secondEntered = true; return "second"; });
  await assert.rejects(first, /audit fsync failed/);
  await assert.rejects(second, queueError(HSS_ERROR.CAPTURE_STOPPING));
  assert.equal(secondEntered, false);
});

test("HSS write queue waitForIdle lets current write finish while stopping", async () => {
  const queue = new HssCaptureWriteQueue();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let done = false;
  const first = queue.run(async () => {
    entered();
    await new Promise<void>((resolve) => { release = resolve; });
    done = true;
  });
  await started;
  queue.beginStopping();
  release();
  await queue.waitForIdle();
  await first;
  assert.equal(done, true);
});

function queueError(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof HssError && error.code === code;
}
