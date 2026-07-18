import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";
import { ANALYSIS_V0_MAX_POINTS, analyzeJcapV0, type AnalysisV0Result } from "./analysis-v0";
import { JCAP_V0_ANALYSIS } from "./golden-corpus";
import { JcapBoundsError, JcapV0QueryService, rebuildJcapV0Index, writeJcapV0Raw } from "./jcap-v0";

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jcap-analysis-v0-"));
}

async function capture(root: string, corpus = JCAP_V0_ANALYSIS): Promise<{ packageDir: string; service: JcapV0QueryService }> {
  const packageDir = path.join(root, `${corpus.provenance.captureId}.jcap`);
  writeJcapV0Raw({ packageDir, ...corpus });
  await rebuildJcapV0Index(packageDir);
  return { packageDir, service: new JcapV0QueryService(root) };
}

function alternatingStateCorpus(captureId: string, sampleCount: number) {
  const signalRoles = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`state_${index}`, "state" as const]));
  return {
    request: { captureId, profile: "generic_state_machine" as const, signalRoles, startTick: "0", endTick: String(sampleCount) },
    corpus: {
      provenance: { ...JCAP_V0_ANALYSIS.provenance, captureId },
      samples: Array.from({ length: sampleCount }, (_, sampleIndex) => ({
        sampleIndex,
        tick: String(sampleIndex),
        statusFlags: HSS_STATUS_FLAGS.valid,
        values: Object.fromEntries(Object.keys(signalRoles).map((variable) => [variable, sampleIndex % 2])),
      })),
      events: JCAP_V0_ANALYSIS.events,
    },
  };
}

function rawHashes(packageDir: string): string[] {
  return ["samples.bin", "events.bin"].map((name) => createHash("sha256").update(readFileSync(path.join(packageDir, "raw", name))).digest("hex"));
}

function count(databaseFile: string, table: string): Promise<number> {
  return rows(databaseFile, `SELECT COUNT(*) AS count FROM ${table}`).then((result) => Number(result[0].count));
}

function rows(databaseFile: string, sql: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(databaseFile, sqlite3.OPEN_READONLY, (openError) => {
      if (openError) return reject(openError);
      database.all(sql, (error, result: Array<Record<string, unknown>>) => {
        database.close((closeError) => {
          if (error) reject(error);
          else if (closeError) reject(closeError);
          else resolve(result);
        });
      });
    });
  });
}

async function indexedEvidenceDigest(databaseFile: string): Promise<string> {
  const evidence = {
    samples: await rows(databaseFile, "SELECT sample_index,tick,tick_key,status_flags FROM samples ORDER BY sample_index"),
    events: await rows(databaseFile, "SELECT event_id,event_sequence,type,tick,tick_key,json FROM events ORDER BY event_sequence"),
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

test("analysis_run deterministically persists write comparison, directional peak, steady mean and overshoot without mutating raw", async () => {
  const root = workspace();
  try {
    const { packageDir, service } = await capture(root);
    const before = rawHashes(packageDir);
    const databaseFile = path.join(packageDir, "capture.db");
    const indexedBefore = await indexedEvidenceDigest(databaseFile);
    const request = {
      captureId: JCAP_V0_ANALYSIS.provenance.captureId,
      profile: "generic_control" as const,
      signalRoles: { command: "command" as const, feedback: "feedback" as const },
      startTick: "0",
      endTick: "100000000",
    };
    const first = await service.analysisRun(request) as AnalysisV0Result;
    const second = await service.analysisRun(request) as AnalysisV0Result;
    assert.deepEqual(second, first);
    assert.match(first.analysisRunId, /^[0-9a-f]{64}$/);
    assert.deepEqual(first.findings.map((finding) => finding.type), ["write_window_comparison", "control_response"]);
    const comparison = first.findings[0].comparisons as Array<{ variable: string; before: number; after: number; delta: number }>;
    assert.deepEqual(comparison.find((item) => item.variable === "command"), { variable: "command", before: 0, beforeTick: "10000000", after: 10, afterTick: "21000000", delta: 10 });
    assert.equal(first.findings[1].peak, 12);
    assert.equal(first.findings[1].steady, 10);
    assert.equal(first.findings[1].overshoot, 2);
    assert.equal(first.findings[1].overshootPercent, 20);
    assert.ok(!first.findings.some((finding) => ["settling", "steady_error", "saturation", "stuck", "fault", "counter", "comparison"].includes(String(finding.type))));
    assert.deepEqual(rawHashes(packageDir), before);
    assert.equal(await indexedEvidenceDigest(databaseFile), indexedBefore);
    assert.equal(await count(databaseFile, "analysis_schema_version"), 1);
    assert.equal(await count(databaseFile, "analysis_runs"), 1);
    assert.equal(await count(databaseFile, "analysis_findings"), 2);
    assert.deepEqual(readdirSync(packageDir).sort(), ["capture.db", "raw"]);

    await rebuildJcapV0Index(packageDir);
    const rebuilt = await service.analysisRun(request) as AnalysisV0Result;
    assert.deepEqual(rebuilt, first);
    assert.equal(await count(databaseFile, "analysis_runs"), 1);
    assert.deepEqual(rawHashes(packageDir), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analysis_run supports the exclusive event window and reports adjacent state transitions with observed durations", async () => {
  const root = workspace();
  try {
    const { service } = await capture(root);
    const result = await service.analysisRun({
      captureId: JCAP_V0_ANALYSIS.provenance.captureId,
      profile: "generic_state_machine",
      signalRoles: { state: "state" },
      eventId: "30000000-0000-4000-8000-000000000002",
      beforeMs: 20,
      afterMs: 80,
    }) as AnalysisV0Result;
    assert.deepEqual(result.window, { startTick: "0", endTick: "100000000", eventId: "30000000-0000-4000-8000-000000000002" });
    const transitions = result.findings.filter((finding) => finding.type === "state_transition");
    assert.deepEqual(transitions.map((finding) => [finding.oldValue, finding.newValue, finding.transitionTick, finding.observedDurationTicks]), [
      [0, 1, "21000000", "21000000"],
      [1, 2, "40000000", "19000000"],
    ]);
    assert.equal(result.findings.at(-1)?.type, "state_duration");
    assert.equal(result.findings.at(-1)?.observedDurationTicks, "60000000");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analysis_run returns bounded warnings for missing evidence and blocks inference across invalid quality", async () => {
  const root = workspace();
  try {
    const invalid = {
      ...JCAP_V0_ANALYSIS,
      provenance: { ...JCAP_V0_ANALYSIS.provenance, captureId: "30000000-0000-4000-8000-000000000010" },
      samples: JCAP_V0_ANALYSIS.samples.map((sample) => sample.sampleIndex === 4 ? { ...sample, statusFlags: HSS_STATUS_FLAGS.valid | HSS_STATUS_FLAGS.read_error } : sample),
      events: [
        ...JCAP_V0_ANALYSIS.events.slice(0, 3),
        { eventId: "30000000-0000-4000-8000-000000000010", eventSequence: 3, type: "quality" as const, tick: "45000000", reason: "fixture_gap" },
        { ...JCAP_V0_ANALYSIS.events[3], eventSequence: 4 },
        { ...JCAP_V0_ANALYSIS.events[4], eventSequence: 5 },
      ],
    };
    const { service } = await capture(root, invalid);
    const missing = await service.analysisRun({
      captureId: invalid.provenance.captureId,
      profile: "generic_control",
      signalRoles: { command: "command" },
      startTick: "0",
      endTick: "100000000",
    }) as AnalysisV0Result;
    assert.deepEqual(missing.findings, []);
    assert.ok(missing.warnings.length > 0);
    assert.ok(missing.suggestions.length <= 3);
    const unmapped = await service.analysisRun({
      captureId: invalid.provenance.captureId,
      profile: "generic_state_machine",
      signalRoles: {},
      startTick: "0",
      endTick: "100000000",
    }) as AnalysisV0Result;
    assert.deepEqual(unmapped.findings, []);
    assert.ok(unmapped.suggestions.length <= 3);

    const state = await service.analysisRun({
      captureId: invalid.provenance.captureId,
      profile: "generic_state_machine",
      signalRoles: { state: "state" },
      startTick: "0",
      endTick: "100000000",
    }) as AnalysisV0Result;
    assert.ok(!state.findings.some((finding) => finding.type === "state_transition" && finding.newValue === 2));
    assert.match(state.warnings.join(" "), /invalid-quality|quality\/flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analysis_run rejects input, time and point bounds without alternate sources or downsampling", async () => {
  const root = workspace();
  try {
    const { service } = await capture(root);
    const captureId = JCAP_V0_ANALYSIS.provenance.captureId;
    await assert.rejects(() => service.analysisRun({ captureId, profile: "generic_control", signalRoles: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`v${index}`, "command"])), startTick: "0", endTick: "1" } as never), JcapBoundsError);
    await assert.rejects(() => service.analysisRun({ captureId, profile: "generic_control", signalRoles: { command: "command", feedback: "feedback" }, eventId: "30000000-0000-4000-8000-000000000002", beforeMs: 0, afterMs: 0, startTick: "0", endTick: "1" }), JcapBoundsError);
    await assert.rejects(() => service.analysisRun({ captureId, profile: "generic_control", signalRoles: { command: "command", feedback: "feedback" }, startTick: "01", endTick: "1" }), JcapBoundsError);
    await assert.rejects(() => service.analysisRun({ captureId, profile: "generic_control", signalRoles: { command: "command", feedback: "feedback" }, eventId: "30000000-0000-4000-8000-000000000002", beforeMs: 60001, afterMs: 0 }), JcapBoundsError);
    await assert.rejects(() => service.analysisRun({ captureId, profile: "generic_control", signalRoles: { command: "command", feedback: "feedback" }, startTick: "0", endTick: "1", metadataFile: "legacy.json" } as never), JcapBoundsError);
    assert.throws(() => analyzeJcapV0({
      captureId,
      profile: "generic_state_machine",
      signalRoles: { state: "state" },
      window: { startTick: "0", endTick: "1" },
      points: Array.from({ length: ANALYSIS_V0_MAX_POINTS + 1 }, (_, sampleIndex) => ({ sampleIndex, tick: String(sampleIndex), statusFlags: 1, variable: "state", value: 0 })),
      events: [],
      rawSources: [],
    }), /point limit/);
    assert.throws(() => analyzeJcapV0({
      captureId,
      profile: "generic_state_machine",
      signalRoles: { state: "state" },
      window: { startTick: "0", endTick: "1" },
      points: [{ sampleIndex: 0, tick: "0", statusFlags: 1, variable: "state", value: Number.NaN }],
      events: [],
      rawSources: [],
    }), /non-finite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analysis_run bounds encoded responses before persisting derived rows", async () => {
  const root = workspace();
  try {
    const near = alternatingStateCorpus("30000000-0000-4000-8000-000000000006", 850);
    const nearPackage = path.join(root, `${near.request.captureId}.jcap`);
    writeJcapV0Raw({ packageDir: nearPackage, ...near.corpus });
    await rebuildJcapV0Index(nearPackage);
    const nearService = new JcapV0QueryService(root);
    const nearResult = await nearService.analysisRun(near.request) as AnalysisV0Result;
    const nearBytes = Buffer.byteLength(JSON.stringify(nearResult), "utf8");
    assert.ok(nearBytes > 3 * 1024 * 1024 && nearBytes <= 4 * 1024 * 1024);
    assert.equal(await count(path.join(nearPackage, "capture.db"), "analysis_runs"), 1);
    assert.equal(await count(path.join(nearPackage, "capture.db"), "analysis_findings"), 850 * 16);

    const over = alternatingStateCorpus("30000000-0000-4000-8000-000000000007", 1000);
    const overPackage = path.join(root, `${over.request.captureId}.jcap`);
    writeJcapV0Raw({ packageDir: overPackage, ...over.corpus });
    await rebuildJcapV0Index(overPackage);
    const overService = new JcapV0QueryService(root);
    await overService.analysisRun({ ...over.request, signalRoles: { state_0: "state" } });
    const databaseFile = path.join(overPackage, "capture.db");
    const beforeRows = [await count(databaseFile, "analysis_runs"), await count(databaseFile, "analysis_findings")];
    const beforeRaw = rawHashes(overPackage);
    const reject = () => overService.analysisRun(over.request);
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(reject, (error: unknown) => error instanceof JcapBoundsError && error.message === "encoded response exceeds 4194304 bytes");
    }
    assert.deepEqual([await count(databaseFile, "analysis_runs"), await count(databaseFile, "analysis_findings")], beforeRows);
    assert.deepEqual(rawHashes(overPackage), beforeRaw);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
