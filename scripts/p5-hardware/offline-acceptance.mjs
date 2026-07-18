#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const { JcapV0QueryService, readJcapV0Raw } = require(path.join(repoRoot, "out", "mcp", "jcap", "jcap-v0.js"));
const { startJcapUi, UI_TOKEN_HEADER } = require(path.join(repoRoot, "out", "mcp", "ui.js"));

const packageDir = path.resolve(valueAfter("--package") ?? path.join(
  repoRoot,
  "reports", "p5", "hardware", "runs", "2026-07-18T14-30-00-000+08-00-v14-hss-r2-r4",
  "storage", "captures", "fa734840-f61e-4c00-9253-689bf996ef58.jcap",
));
const reportFile = path.resolve(valueAfter("--report") ?? path.join(repoRoot, "reports", "p5", "offline", "jcap-v14-evidence.json"));
const captureId = path.basename(packageDir, ".jcap");
const capturesDir = path.dirname(packageDir);
const databaseFile = path.join(packageDir, "capture.db");
const backupFile = path.join(path.dirname(reportFile), `${captureId}.capture.db.backup`);
const raw = readJcapV0Raw(packageDir);
const variables = [...new Set(raw.samples.flatMap((sample) => Object.keys(sample.values)))].sort();
const ticks = raw.samples.map((sample) => BigInt(sample.tick));
const startTick = ticks.reduce((left, right) => left < right ? left : right).toString();
const endTick = ticks.reduce((left, right) => left > right ? left : right).toString();
const writeEvent = raw.events.find((event) => event.type === "variable_write");

assert.ok(variables.length > 0, "capture contains no variables");
assert.ok(writeEvent, "capture contains no variable_write event");
mkdirSync(path.dirname(reportFile), { recursive: true });
rmSync(backupFile, { force: true });

const service = new JcapV0QueryService(capturesDir);
const rawBefore = rawHashes(packageDir);
const before = await criticalQueries(service);
let ui;
let databaseMoved = false;

try {
  renameSync(databaseFile, backupFile);
  databaseMoved = true;
  assert.equal(readdirSync(packageDir).includes("capture.db"), false, "capture.db was not removed from the package");

  const rebuild = await service.rebuild({ captureId });
  assert.equal(rebuild.indexStatus, "ready");
  databaseMoved = false;

  const after = await criticalQueries(service);
  assert.deepEqual(after, before, "critical bounded JCAP results changed after rebuild");
  const rawAfter = rawHashes(packageDir);
  assert.deepEqual(rawAfter, rawBefore, "immutable raw hashes changed during rebuild");

  const exported = await service.exportCsv({ captureId });
  assert.ok(typeof exported.exportFile === "string" && exported.exportFile.length > 0, "explicit export was not created");

  ui = await startJcapUi({ capturesDir, initialCaptureId: captureId });
  const rootResponse = await fetch(`${ui.origin}/?captureId=${encodeURIComponent(captureId)}`);
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const rejected = await fetch(`${ui.origin}/api/summary?captureId=${encodeURIComponent(captureId)}`);
  assert.equal(rejected.status, 401, "loopback API accepted a request without its capability token");
  const uiSummaryResponse = await fetch(`${ui.origin}/api/summary?captureId=${encodeURIComponent(captureId)}`, {
    headers: { [UI_TOKEN_HEADER]: ui.token },
  });
  assert.equal(uiSummaryResponse.status, 200);
  assert.deepEqual(await uiSummaryResponse.json(), after.summary);

  const result = {
    schema: "p5-offline-jcap-acceptance-v1",
    state: "completed",
    packageDir,
    captureId,
    inputs: {
      variables,
      startTick,
      endTick,
      eventId: writeEvent.eventId,
    },
    rawBefore,
    rawAfter,
    criticalResultSha256: sha256(JSON.stringify(before)),
    rebuild,
    explicitExport: exported,
    ui: {
      origin: "http://127.0.0.1:<ephemeral>",
      rootStatus: rootResponse.status,
      unauthorizedApiStatus: rejected.status,
      summaryStatus: uiSummaryResponse.status,
      cspPresent: true,
    },
    packageEntries: packageEntries(packageDir),
    hardwareCalls: 0,
  };
  writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  rmSync(backupFile, { force: true });
  process.stdout.write(`${JSON.stringify({ reportFile, state: result.state, captureId, criticalResultSha256: result.criticalResultSha256 })}\n`);
} catch (error) {
  if (databaseMoved && !readdirSync(packageDir).includes("capture.db")) renameSync(backupFile, databaseFile);
  throw error;
} finally {
  await ui?.close();
}

async function criticalQueries(query) {
  const summary = await query.summary({ captureId });
  const series = await query.series({ captureId, variables, startTick, endTick, bucketCount: 20 });
  const eventWindow = await query.eventWindow({
    captureId,
    eventId: writeEvent.eventId,
    variables,
    beforeMs: 100,
    afterMs: 100,
    bucketCount: 20,
  });
  const analysis = await query.analysisRun({
    captureId,
    profile: "generic_control",
    signalRoles: Object.fromEntries(variables.map((variable, index) => [variable, index === 0 ? "feedback" : "command"])),
    eventId: writeEvent.eventId,
    beforeMs: 100,
    afterMs: 100,
  });
  return { summary, series, eventWindow, analysis };
}

function rawHashes(root) {
  return Object.fromEntries(["samples.bin", "events.bin"].map((name) => {
    const file = path.join(root, "raw", name);
    return [name, sha256(readFileSync(file))];
  }));
}

function packageEntries(root) {
  const output = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else output.push(path.relative(root, file).replace(/\\/g, "/"));
    }
  };
  walk(root);
  return output.sort();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
