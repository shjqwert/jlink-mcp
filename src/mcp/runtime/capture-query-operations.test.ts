import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createJcapV1Metadata,
  finalizeJcapV1Metadata,
  writeJcapV1Raw,
  type JcapV1Metadata,
} from "../jcap/jcap-v1";
import { CaptureQueryOperations } from "./capture-query-operations";

const artifactGeneration = "a".repeat(64);
const layoutHash = "b".repeat(64);

test("Capture queries report index repair side effects after integrity verification", async () => {
  const root = workspace();
  const captureId = "61000000-0000-4000-8000-000000000001";
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  try {
    writeTerminalCapture(packageDir, captureId);
    const result = await new CaptureQueryOperations(root).summary(captureId);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(result.requestedEffects, ["read_bounded_capture_index", "repair_capture_index_if_required"]);
    assert.deepEqual(result.observedEffects, [
      "capture_db_atomically_published",
      "capture_metadata_atomically_published",
    ]);
    assert.equal((result.data as { indexRebuilt?: boolean }).indexRebuilt, true);
    assert.deepEqual(result.verification, {
      status: "verified",
      method: "bounded_jcap_v1_query_after_integrity",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Capture queries keep active packages read-only and report not-ready facts", async () => {
  const root = workspace();
  const captureId = "61000000-0000-4000-8000-000000000002";
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  try {
    writeJcapV1Raw({
      packageDir,
      metadata: metadata(captureId),
      samples: [{ sampleIndex: 0, tick: "10", statusFlags: 1, values: { counter: 1 } }],
      events: [{ eventId: "62000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" }],
    });
    const result = await new CaptureQueryOperations(root).summary(captureId);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(result.observedEffects, []);
    assert.deepEqual(result.data, {
      status: "not_ready",
      captureState: "active",
      indexStatus: "absent",
    });
    assert.deepEqual(result.verification, { status: "observed", method: "capture_not_queryable" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Capture query failures retain already published repair effects and guard run-scoped mutation", async () => {
  const root = workspace();
  const captureId = "61000000-0000-4000-8000-000000000003";
  const packageDir = path.join(root, "run-1", "captures", `${captureId}.jcap`);
  const guardedRuns: string[] = [];
  try {
    writeTerminalCapture(packageDir, captureId);
    const operations = new CaptureQueryOperations(root, async (runId, operation) => {
      guardedRuns.push(runId);
      return operation();
    });
    const result = await operations.eventWindow({
      captureId,
      eventId: "62000000-0000-4000-8000-000000000099",
      variables: [],
      beforeMs: 0,
      afterMs: 0,
      bucketCount: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "CAPTURE_QUERY_FAILED");
    assert.equal(result.error?.writeIssued, true);
    assert.deepEqual(result.observedEffects, [
      "capture_db_atomically_published",
      "capture_metadata_atomically_published",
    ]);
    assert.deepEqual(guardedRuns, ["run-1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Capture query validation rejects invalid bounds before index repair", async () => {
  const root = workspace();
  const captureId = "61000000-0000-4000-8000-000000000004";
  const packageDir = path.join(root, "captures", `${captureId}.jcap`);
  try {
    writeTerminalCapture(packageDir, captureId);
    const result = await new CaptureQueryOperations(root).series({
      captureId,
      variables: Array.from({ length: 33 }, (_, index) => `var${index}`),
      startTick: "0",
      endTick: "10",
      bucketCount: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "JCAP_BOUNDS");
    assert.equal(result.error?.stage, "validation");
    assert.deepEqual(result.observedEffects, []);
    assert.equal(existsSync(path.join(packageDir, "capture.db")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Capture queries do not repair finalizing or failed packages", async () => {
  const root = workspace();
  const finalizingId = "61000000-0000-4000-8000-000000000005";
  const failedId = "61000000-0000-4000-8000-000000000006";
  const finalizingDir = path.join(root, "captures", `${finalizingId}.jcap`);
  const failedDir = path.join(root, "captures", `${failedId}.jcap`);
  try {
    writeJcapV1Raw({
      packageDir: finalizingDir,
      metadata: { ...metadata(finalizingId), state: "finalizing" },
      samples: [{ sampleIndex: 0, tick: "10", statusFlags: 1, values: { counter: 1 } }],
      events: [
        { eventId: "62000000-0000-4000-8000-000000000011", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: "62000000-0000-4000-8000-000000000012", eventSequence: 1, type: "lifecycle", tick: "10", state: "finalizing" },
      ],
    });
    writeJcapV1Raw({
      packageDir: failedDir,
      metadata: { ...metadata(failedId), state: "failed" },
      samples: [{ sampleIndex: 0, tick: "10", statusFlags: 1, values: { counter: 1 } }],
      events: [
        { eventId: "62000000-0000-4000-8000-000000000021", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
        { eventId: "62000000-0000-4000-8000-000000000022", eventSequence: 1, type: "lifecycle", tick: "10", state: "failed" },
      ],
    });
    const operations = new CaptureQueryOperations(root);
    const finalizing = await operations.summary(finalizingId);
    const failed = await operations.summary(failedId);
    assert.equal(finalizing.ok, true, JSON.stringify(finalizing.error));
    assert.equal(failed.ok, true, JSON.stringify(failed.error));
    assert.equal((finalizing.data as { status: string }).status, "not_ready");
    assert.equal((failed.data as { status: string }).status, "not_ready");
    assert.deepEqual(finalizing.observedEffects, []);
    assert.deepEqual(failed.observedEffects, []);
    assert.equal(existsSync(path.join(finalizingDir, "capture.db")), false);
    assert.equal(existsSync(path.join(failedDir, "capture.db")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Run-scoped guard rejection happens before locking or index repair", async () => {
  const root = workspace();
  const captureId = "61000000-0000-4000-8000-000000000007";
  const packageDir = path.join(root, "run-guarded", "captures", `${captureId}.jcap`);
  try {
    writeTerminalCapture(packageDir, captureId);
    const operations = new CaptureQueryOperations(root, async () => {
      const error = new Error("acceptance run is immutable") as Error & { code: string };
      error.code = "ACCEPTANCE_RUN_IMMUTABLE";
      throw error;
    });
    const result = await operations.summary(captureId);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "ACCEPTANCE_RUN_IMMUTABLE");
    assert.deepEqual(result.observedEffects, []);
    assert.equal(existsSync(path.join(packageDir, "capture.db")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "capture-query-"));
}

function metadata(captureId: string): JcapV1Metadata {
  return createJcapV1Metadata({
    captureId,
    backend: "fake-jlink-hss",
    requestedRateHz: 1,
    durationSec: 1,
    variables: [{
      logicalIdentity: "counter",
      type: "uint32",
      address: "0x20000000",
      size: 4,
      artifactGeneration,
      layoutHash,
    }],
    provenance: {
      captureId,
      backend: "fake-jlink-hss",
      runtime: { fixture: "capture-query-operations" },
      target: {
        projectRoot: "C:\\fixture-project",
        generation: "63000000-0000-4000-8000-000000000001",
        device: "FIXTURE",
        probeSerial: "123456789",
        interface: "SWD",
        speed: 4000,
      },
      script: { mode: "none" },
      artifact: {
        path: "C:\\fixture-project\\firmware.elf",
        generation: artifactGeneration,
        sha256: "c".repeat(64),
      },
    },
  });
}

function writeTerminalCapture(packageDir: string, captureId: string): void {
  writeJcapV1Raw({
    packageDir,
    metadata: metadata(captureId),
    samples: [{ sampleIndex: 0, tick: "10", statusFlags: 1, values: { counter: 1 } }],
    events: [
      { eventId: "62000000-0000-4000-8000-000000000001", eventSequence: 0, type: "lifecycle", tick: "0", state: "active" },
      { eventId: "62000000-0000-4000-8000-000000000002", eventSequence: 1, type: "lifecycle", tick: "10", state: "finalizing" },
      { eventId: "62000000-0000-4000-8000-000000000003", eventSequence: 2, type: "lifecycle", tick: "11", state: "stopped" },
    ],
  });
  finalizeJcapV1Metadata(packageDir, "stopped");
}
