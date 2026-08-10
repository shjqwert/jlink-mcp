import type { OperationEnvelope } from "./operation-envelope";

interface StoredOperationDetail {
  json: string;
  storedAt: number;
  bytes: number;
}

export interface OperationDetailStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

export class OperationDetailStore {
  private readonly entries = new Map<string, StoredOperationDetail>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: OperationDetailStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? 64;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  put(envelope: OperationEnvelope): void {
    this.pruneExpired();
    let json: string;
    try { json = JSON.stringify(envelope); }
    catch {
      json = JSON.stringify({
        ok: envelope.ok,
        operationId: envelope.operationId,
        tool: envelope.tool,
        error: envelope.error,
        detailTruncated: true,
        reason: "not_json_serializable",
      });
    }
    let bytes = Buffer.byteLength(json);
    if (bytes > this.maxBytes) {
      json = JSON.stringify({
        ok: envelope.ok,
        operationId: envelope.operationId,
        tool: envelope.tool,
        error: envelope.error,
        detailTruncated: true,
        originalBytes: bytes,
      });
      bytes = Buffer.byteLength(json);
    }
    const previous = this.entries.get(envelope.operationId);
    if (previous) this.totalBytes -= previous.bytes;
    this.entries.delete(envelope.operationId);
    this.entries.set(envelope.operationId, { json, storedAt: this.now(), bytes });
    this.totalBytes += bytes;
    this.pruneBounds();
  }

  get(operationId: string): string | undefined {
    this.pruneExpired();
    const entry = this.entries.get(operationId);
    if (!entry) return undefined;
    this.entries.delete(operationId);
    this.entries.set(operationId, entry);
    return entry.json;
  }

  private pruneExpired(now = this.now()): void {
    for (const [operationId, entry] of this.entries) {
      if (now - entry.storedAt <= this.ttlMs) continue;
      this.entries.delete(operationId);
      this.totalBytes -= entry.bytes;
    }
  }

  private pruneBounds(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value as [string, StoredOperationDetail] | undefined;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].bytes;
    }
  }
}
