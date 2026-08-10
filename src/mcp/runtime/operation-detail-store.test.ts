import assert from "node:assert/strict";
import test from "node:test";
import { OperationDetailStore } from "./operation-detail-store";
import { createOperationEnvelope, finishEnvelope } from "./operation-envelope";

test("operation detail store enforces LRU entry and TTL bounds", () => {
  let now = 1_000;
  const store = new OperationDetailStore({ maxEntries: 2, ttlMs: 10, now: () => now });
  const first = detail("first");
  const second = detail("second");
  const third = detail("third");

  store.put(first);
  store.put(second);
  assert.ok(store.get(first.operationId), "read refreshes the first detail");
  store.put(third);
  assert.equal(store.get(second.operationId), undefined, "least recently used detail is evicted");
  assert.ok(store.get(first.operationId));
  now += 11;
  assert.equal(store.get(first.operationId), undefined, "expired detail is removed");
  assert.equal(store.get(third.operationId), undefined, "TTL applies to every entry");
});

test("operation detail store replaces an oversized envelope with explicit truncation metadata", () => {
  const store = new OperationDetailStore({ maxEntries: 2, maxBytes: 512 });
  const envelope = detail("large");
  envelope.data = { output: "x".repeat(2_000) };
  store.put(envelope);

  const stored = store.get(envelope.operationId);
  assert.ok(stored);
  const parsed = JSON.parse(stored) as { detailTruncated?: boolean; originalBytes?: number };
  assert.equal(parsed.detailTruncated, true);
  assert.ok((parsed.originalBytes ?? 0) > 512);
});

function detail(tool: string) {
  return finishEnvelope(createOperationEnvelope(tool), true);
}
