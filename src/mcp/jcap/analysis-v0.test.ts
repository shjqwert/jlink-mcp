import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HSS_STATUS_FLAGS } from "../hss/hss-status-flags";
import {
  ANALYSIS_V0_MAX_POINTS,
  analyzeJcapV0,
  type AnalysisV0Input,
} from "./analysis-v0";
import {
  createJcapV1Metadata,
  finalizeJcapV1Metadata,
  readJcapV1Raw,
  rebuildJcapV1Index,
  verifyJcapV1Index,
  writeJcapV1Raw,
  type JcapV1Event,
  type JcapV1Sample,
} from "./jcap-v1";

const captureId = "51000000-0000-4000-8000-000000000001";
const writeEventId = "52000000-0000-4000-8000-000000000001";
const artifactGeneration = "a".repeat(64);
const commandDescriptor = {
  logicalIdentity: "command",
  type: "uint32" as const,
  address: "0x20000000",
  size: 4,
  artifactGeneration,
  layoutHash: "b".repeat(64),
};
const feedbackDescriptor = {
  logicalIdentity: "feedback",
  type: "uint32" as const,
  address: "0x20000004",
  size: 4,
  artifactGeneration,
  layoutHash: "c".repeat(64),
};
const stateDescriptor = {
  logicalIdentity: "state",
  type: "uint32" as const,
  address: "0x20000008",
  size: 4,
  artifactGeneration,
  layoutHash: "d".repeat(64),
};

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "jcap-analysis-v0-"));
}

function v1Samples(): JcapV1Sample[] {
  return [
    { sampleIndex: 0, tick: "0", statusFlags: HSS_STATUS_FLAGS.valid, values: { command: 0, feedback: 0, state: 0 } },
    { sampleIndex: 1, tick: "10", statusFlags: HSS_STATUS_FLAGS.valid, values: { command: 0, feedback: 0, state: 0 } },
    { sampleIndex: 2, tick: "20", statusFlags: HSS_STATUS_FLAGS.valid, values: { command: 10, feedback: 2, state: 1 } },
    { sampleIndex: 3, tick: "40", statusFlags: HSS_STATUS_FLAGS.valid, values: { command: 10, feedback: 12, state: 1 } },
    { sampleIndex: 4, tick: "80", statusFlags: HSS_STATUS_FLAGS.valid, values: { command: 10, feedback: 10, state: 2 } },
    { sampleIndex: 5, tick: "90", statusFlags: HSS_STATUS_FLAGS.valid, values: { command: 10, feedback: 10, state: 2 } },
    { sampleIndex: 6, tick: "100", statusFlags: HSS_STATUS_FLAGS.valid, values: { command: 10, feedback: 10, state: 2 } },
  ];
}

function v1Events(): JcapV1Event[] {
  return [
    {
      eventId: "52000000-0000-4000-8000-000000000000",
      eventSequence: 0,
      type: "lifecycle",
      tick: "0",
      state: "active",
    },
    {
      eventId: writeEventId,
      eventSequence: 1,
      type: "variable_write",
      tick: "15",
      logicalIdentity: "command",
      selector: "command",
      descriptor: commandDescriptor,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.001Z",
      operationStartTick: "14",
      operationEndTick: "15",
      timingSource: "helper_qpc",
      writeAttempted: true,
      writeIssued: true,
      stateUnknown: false,
      old: { state: "not_requested", value: null, bytesHex: null },
      requested: { value: 10, bytesHex: "0a000000" },
      readback: { state: "not_requested", value: null, bytesHex: null },
      restore: { state: "not_requested", attempted: false, writeIssued: false, stateUnknown: false, readback: null, readbackHex: null },
      verification: { state: "executed_unverified" },
      sampleAlignment: { method: "terminal_raw_nearest", status: "derive_on_rebuild" },
      outcome: "completed",
      error: null,
    },
    {
      eventId: "52000000-0000-4000-8000-000000000002",
      eventSequence: 2,
      type: "lifecycle",
      tick: "100",
      state: "finalizing",
    },
    {
      eventId: "52000000-0000-4000-8000-000000000003",
      eventSequence: 3,
      type: "lifecycle",
      tick: "101",
      state: "completed",
    },
  ];
}

test("analysis-v0 deterministically analyzes quality-qualified JCAP v1 Raw evidence", async () => {
  const root = workspace();
  const packageDir = join(root, `${captureId}.jcap`);
  try {
    const metadata = createJcapV1Metadata({
      captureId,
      backend: "fake-jlink-hss",
      requestedRateHz: 7,
      durationSec: 1,
      variables: [commandDescriptor, feedbackDescriptor, stateDescriptor],
      provenance: {
        captureId,
        backend: "fake-jlink-hss",
        runtime: { helperProtocolVersion: 2 },
        target: { projectRoot: "C:\\fixture-project", generation: "53000000-0000-4000-8000-000000000001", device: "FIXTURE", probeSerial: "123456789", interface: "SWD", speed: 4000 },
        script: { mode: "none" },
        artifact: { path: "C:\\fixture-project\\firmware.elf", generation: artifactGeneration, sha256: "e".repeat(64) },
      },
    });
    writeJcapV1Raw({ packageDir, metadata, samples: v1Samples(), events: v1Events() });
    finalizeJcapV1Metadata(packageDir, "completed");
    await rebuildJcapV1Index(packageDir);
    assert.equal((await verifyJcapV1Index(packageDir)).indexStatus, "ready");

    const raw = readJcapV1Raw(packageDir);
    const input: AnalysisV0Input = {
      captureId,
      profile: "generic_control",
      signalRoles: { command: "command", feedback: "feedback" },
      window: { startTick: "0", endTick: "100", eventId: writeEventId },
      points: raw.samples.flatMap((sample) => Object.entries(sample.values).map(([variable, value]) => ({
        sampleIndex: sample.sampleIndex,
        tick: sample.tick,
        statusFlags: sample.statusFlags,
        variable,
        value,
      }))),
      events: raw.events,
      rawSources: raw.sources,
    };
    const first = analyzeJcapV0(input);
    const second = analyzeJcapV0(input);

    assert.deepEqual(second, first);
    assert.match(first.analysisRunId, /^[0-9a-f]{64}$/);
    assert.deepEqual(first.findings.map((finding) => finding.type), ["write_window_comparison", "control_response"]);
    assert.equal(first.findings[1].peak, 12);
    assert.equal(first.findings[1].steady, 10);
    assert.equal(first.findings[1].overshoot, 2);
    assert.equal(first.findings[1].overshootPercent, 20);
    assert.deepEqual(first.rawSources, [...raw.sources].sort((left, right) => left.file.localeCompare(right.file)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("analysis-v0 preserves quality barriers and input bounds independently of storage format", () => {
  const state = analyzeJcapV0({
    captureId,
    profile: "generic_state_machine",
    signalRoles: { state: "state" },
    window: { startTick: "0", endTick: "30" },
    points: [
      { sampleIndex: 0, tick: "0", statusFlags: HSS_STATUS_FLAGS.valid, variable: "state", value: 0 },
      { sampleIndex: 1, tick: "10", statusFlags: HSS_STATUS_FLAGS.valid, variable: "state", value: 1 },
      { sampleIndex: 2, tick: "20", statusFlags: HSS_STATUS_FLAGS.valid | HSS_STATUS_FLAGS.read_error, variable: "state", value: 2 },
      { sampleIndex: 3, tick: "30", statusFlags: HSS_STATUS_FLAGS.valid, variable: "state", value: 3 },
    ],
    events: [],
    rawSources: [],
  });
  assert.ok(state.findings.some((finding) => finding.type === "state_transition" && finding.newValue === 1));
  assert.ok(!state.findings.some((finding) => finding.type === "state_transition" && finding.newValue === 3));
  assert.match(state.warnings.join(" "), /invalid-quality/);

  assert.throws(() => analyzeJcapV0({
    captureId,
    profile: "generic_state_machine",
    signalRoles: { state: "state" },
    window: { startTick: "0", endTick: "1" },
    points: Array.from({ length: ANALYSIS_V0_MAX_POINTS + 1 }, (_, sampleIndex) => ({
      sampleIndex,
      tick: String(sampleIndex),
      statusFlags: HSS_STATUS_FLAGS.valid,
      variable: "state",
      value: 0,
    })),
    events: [],
    rawSources: [],
  }), /point limit/);
  assert.throws(() => analyzeJcapV0({
    captureId,
    profile: "generic_state_machine",
    signalRoles: { state: "state" },
    window: { startTick: "0", endTick: "1" },
    points: [{ sampleIndex: 0, tick: "0", statusFlags: HSS_STATUS_FLAGS.valid, variable: "state", value: Number.NaN }],
    events: [],
    rawSources: [],
  }), /non-finite/);
});
