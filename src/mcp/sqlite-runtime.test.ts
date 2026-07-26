import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import {
  createJcapV1Metadata,
  finalizeJcapV1Metadata,
  jcapCaptureSummary,
  rebuildJcapV1Index,
  writeJcapV1Raw,
  type JcapV1Event,
} from "./jcap/jcap-v1";

const captureId = "41000000-0000-4000-8000-000000000010";
const events: JcapV1Event[] = [
  { eventId: "42000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
  { eventId: "42000000-0000-4000-8000-000000000002", eventSequence: 1, type: "lifecycle", tick: "3", state: "finalizing" },
  { eventId: "42000000-0000-4000-8000-000000000003", eventSequence: 2, type: "lifecycle", tick: "4", state: "stopped" },
];

function writeFixture(packageDir: string): void {
  writeJcapV1Raw({
    packageDir,
    metadata: createJcapV1Metadata({
      captureId,
      backend: "fake-jlink-hss",
      requestedRateHz: 3,
      durationSec: 1,
      variables: [{ logicalIdentity: "signal", type: "uint32", address: "0x20000000", size: 4, artifactGeneration: "a".repeat(64), layoutHash: "b".repeat(64) }],
      provenance: {
        captureId,
        backend: "fake-jlink-hss",
        runtime: { helperProtocolVersion: 1 },
        target: { projectRoot: "C:\\fixture-project", generation: "43000000-0000-4000-8000-000000000010", device: "FIXTURE", probeSerial: "123456789", interface: "SWD", speed: 4000 },
        script: { mode: "none" },
        artifact: { path: "C:\\fixture-project\\firmware.elf", generation: "a".repeat(64), sha256: "e".repeat(64) },
      },
    }),
    samples: [
      { sampleIndex: 0, tick: "1", statusFlags: 1, values: { signal: 1 } },
      { sampleIndex: 1, tick: "2", statusFlags: 1, values: { signal: 2 } },
      { sampleIndex: 2, tick: "3", statusFlags: 1, values: { signal: 3 } },
    ],
    events,
  });
  finalizeJcapV1Metadata(packageDir, "stopped");
}

test("sqlite3 loads its native binding and passes transaction plus integrity_check", (_, done) => {
  const database = new sqlite3.Database(":memory:", (openError) => {
    if (openError) {
      done(openError);
      return;
    }
    database.exec("BEGIN; CREATE TABLE probe (id INTEGER PRIMARY KEY); INSERT INTO probe VALUES (1); COMMIT", (createError) => {
      if (createError) {
        database.close(() => done(createError));
        return;
      }
      database.get<{ integrity_check: string }>("PRAGMA integrity_check", (checkError, row) => {
        database.close((closeError) => {
          try {
            assert.ifError(checkError);
            assert.deepEqual(row, { integrity_check: "ok" });
            assert.ifError(closeError);
            done();
          } catch (error) {
            done(error);
          }
        });
      });
    });
  });
});

test("sqlite3 adapter performs the JCAP rebuild and atomic publication path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sqlite-jcap-"));
  const packageDir = path.join(root, `${captureId}.jcap`);
  try {
    writeFixture(packageDir);
    const result = await rebuildJcapV1Index(packageDir);
    assert.equal(result.indexStatus, "ready");
    assert.equal(existsSync(path.join(packageDir, "capture.db.tmp")), false);
    assert.equal(existsSync(path.join(packageDir, "capture.db")), true);
    const summary = await jcapCaptureSummary(packageDir);
    assert.equal(summary.sampleCount, 3);
    assert.equal(summary.eventCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
