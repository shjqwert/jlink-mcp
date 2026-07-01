import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { appendHssAudit } from "./audit-log";

test("HSS audit records MVP-B write fields at top level", async () => {
  const root = await tempProject();
  try {
    const file = await appendHssAudit("session", "variable_write_execute", {
      captureId: "cap",
      targetRef: { kind: "scalar", path: "Debug_IqRef" },
    }, {
      ok: true,
      data: {
        captureId: "cap",
        canonicalTarget: "Debug_IqRef",
        targetRef: { kind: "scalar", path: "Debug_IqRef" },
        writeId: "wr",
        eventId: "evt",
        policyHash: "policy",
        symbolLayoutHash: "layout",
      },
      risk: { level: "R2" },
    }, root);
    const record = JSON.parse((await readFile(file, "utf8")).trim());
    assert.equal(record.sessionId, "session");
    assert.equal(record.operation, "variable_write_execute");
    assert.equal(record.captureId, "cap");
    assert.equal(record.canonicalTarget, "Debug_IqRef");
    assert.equal(record.risk, "R2");
    assert.equal(record.writeId, "wr");
    assert.equal(record.eventId, "evt");
    assert.equal(record.policyHash, "policy");
    assert.equal(record.symbolLayoutHash, "layout");
    assert.equal(typeof record.timeUs, "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempProject(): Promise<string> {
  const root = join(process.cwd(), ".tmp", `hss-audit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  return root;
}
