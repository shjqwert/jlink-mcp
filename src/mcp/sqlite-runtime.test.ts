import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { JCAP_V0_GOLDEN } from "./jcap/golden-corpus";
import { jcapCaptureSummary, rebuildJcapV0Index, writeJcapV0Raw } from "./jcap/jcap-v0";

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
  const packageDir = path.join(root, "runtime.jcap");
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    const result = await rebuildJcapV0Index(packageDir);
    assert.equal(result.indexStatus, "ready");
    assert.equal(existsSync(path.join(packageDir, "capture.db.tmp")), false);
    assert.equal(existsSync(path.join(packageDir, "capture.db")), true);
    const summary = await jcapCaptureSummary(packageDir);
    assert.equal(summary.sampleCount, 3);
    assert.equal(summary.eventCount, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the bundled standalone export and a loopback handler use the same JCAP SQLite adapter", async () => {
  const standalone = require(path.join(process.cwd(), "out", "mcp", "standalone.js")) as { jcapCaptureSummary?: typeof jcapCaptureSummary };
  assert.equal(typeof standalone.jcapCaptureSummary, "function");
  const root = mkdtempSync(path.join(os.tmpdir(), "sqlite-loopback-"));
  const packageDir = path.join(root, "loopback.jcap");
  const server = createServer((_request, response) => {
    void jcapCaptureSummary(packageDir).then((summary) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(summary));
    }, (error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    await rebuildJcapV0Index(packageDir);
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/summary`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as Record<string, unknown>).indexStatus, "ready");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
