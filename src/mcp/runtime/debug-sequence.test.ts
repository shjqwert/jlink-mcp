import assert from "node:assert/strict";
import test from "node:test";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./operation-envelope";
import {
  DebugSequenceExecutor,
  type DebugSequenceArtifactOperations,
  type DebugSequenceHssOperations,
  type DebugSequenceScheduler,
} from "./debug-sequence";

test("debug sequence executes absolute steps synchronously and reports timing", async () => {
  const fixture = sequenceFixture();
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1, captureOld: true, verify: true },
      { atMs: 2_000, action: "read_variable", ref: "control" },
      { atMs: 3_000, action: "write_variable", ref: "control", value: 0, verify: true },
      { atMs: 4_000, action: "hss_stop" },
    ],
    cleanup: [
      { action: "restore_variable", ref: "control", value: 0 },
      { action: "hss_stop" },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data as {
    state: string;
    steps: Array<{ plannedAtMs: number; actualAtMs: number; delayMs: number; queueDelayMs: number }>;
    cleanup: unknown[];
  };
  assert.equal(data.state, "completed");
  assert.deepEqual(data.steps.map(({ plannedAtMs }) => plannedAtMs), [0, 1_000, 2_000, 3_000, 4_000]);
  assert.deepEqual(data.steps.map(({ actualAtMs }) => actualAtMs), [0, 1_000, 2_000, 3_000, 4_000]);
  assert.deepEqual(data.steps.map(({ delayMs }) => delayMs), [0, 0, 0, 0, 0]);
  assert.deepEqual(data.steps.map(({ queueDelayMs }) => queueDelayMs), [3, 3, 3, 3, 3]);
  assert.deepEqual(data.cleanup, []);
  assert.deepEqual(fixture.actions, ["plan", "start", "write:1", "read", "write:0", "stop:capture-1"]);
});

test("debug sequence stops normal steps on failure and executes bounded cleanup", async () => {
  const fixture = sequenceFixture({ failWrite: true });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1, verify: true },
      { atMs: 2_000, action: "read_variable", ref: "control" },
    ],
    cleanup: [
      { action: "restore_variable", ref: "control", value: 0 },
      { action: "hss_stop" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_STEP_FAILED");
  const data = result.data as {
    state: string;
    steps: Array<{ action: string }>;
    cleanup: Array<{ action: string; ok: boolean }>;
  };
  assert.equal(data.state, "failed");
  assert.deepEqual(data.steps.map(({ action }) => action), ["hss_start", "write_variable"]);
  assert.deepEqual(data.cleanup.map(({ action, ok }) => ({ action, ok })), [
    { action: "restore_variable", ok: true },
    { action: "hss_stop", ok: true },
  ]);
  assert.deepEqual(fixture.actions, ["plan", "start", "write:1", "write:0", "stop:capture-1"]);
});

test("debug sequence cancellation before dispatch does not perform unnecessary cleanup writes", async () => {
  const fixture = sequenceFixture();
  const controller = new AbortController();
  controller.abort(new Error("cancelled by fixture"));
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1 },
    ],
    cleanup: [
      { action: "restore_variable", ref: "control", value: 0 },
      { action: "hss_stop" },
    ],
  }, controller.signal);

  assert.equal(result.error?.code, "DEBUG_SEQUENCE_CANCELLED");
  const data = result.data as { cleanup: Array<{ result: { data: { skipped?: boolean } | null } }> };
  assert.equal(data.cleanup[0].result.data?.skipped, true);
  assert.deepEqual(fixture.actions, ["plan"]);
});

test("debug sequence rejects an active-capture variable omitted from immutable descriptors", async () => {
  const fixture = sequenceFixture();
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_INVALID");
  assert.match(result.error?.message ?? "", /immutable HSS descriptor/i);
  assert.deepEqual(fixture.actions, ["plan"]);
});

test("debug sequence rejects an unencodable write value during preflight", async () => {
  const fixture = sequenceFixture();
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 0x1_0000_0000 },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_INVALID");
  assert.match(result.error?.message ?? "", /uint32/i);
  assert.deepEqual(fixture.actions, ["plan"]);
});

test("debug sequence rejects cleanup that can run under an incompatible later HSS capture", async () => {
  const fixture = sequenceFixture();
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "write_variable", ref: "control", value: 1 },
      { atMs: 1_000, action: "hss_start", variables: [{ ref: "sample" }], rateHz: 100, durationSec: 10 },
      { atMs: 2_000, action: "read_variable", ref: "sample" },
    ],
    cleanup: [
      { action: "restore_variable", ref: "control", value: 0 },
      { action: "hss_stop" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_INVALID");
  assert.match(result.error?.message ?? "", /cleanup restore.*immutable HSS descriptor/i);
  assert.deepEqual(fixture.actions, ["plan"]);
});

test("debug sequence preserves a failed step stateUnknown after successful cleanup", async () => {
  const fixture = sequenceFixture({ failWrite: true, failedWriteStateUnknown: true });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1 },
    ],
    cleanup: [
      { action: "restore_variable", ref: "control", value: 0 },
      { action: "hss_stop" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.stateUnknown, true);
  assert.deepEqual(fixture.actions, ["plan", "start", "write:1", "write:0", "stop:capture-1"]);
});

test("debug sequence cleanup does not stop an already stopped capture", async () => {
  const fixture = sequenceFixture({ failRead: true });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "hss_stop" },
      { atMs: 2_000, action: "read_variable", ref: "control" },
    ],
    cleanup: [{ action: "hss_stop" }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(fixture.actions, ["plan", "start", "stop:capture-1", "read"]);
});

function sequenceFixture(options: { failWrite?: boolean; failedWriteStateUnknown?: boolean; failRead?: boolean } = {}): {
  executor: DebugSequenceExecutor;
  actions: string[];
} {
  const actions: string[] = [];
  let now = 0;
  let failed = false;
  const scheduler: DebugSequenceScheduler = {
    now: () => now,
    wait: async (delayMs, signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
      now += delayMs;
    },
  };
  const artifacts: DebugSequenceArtifactOperations = {
    resolveCaptureVariable: async (_projectRoot, ref) => ({
      resolved: {
        ref: {
          artifactGeneration: "fixture",
          qualifiedName: typeof ref === "string" ? ref : ref.qualifiedName,
          layoutHash: "fixture-layout",
        },
        region: "ram",
        type: "uint32",
        endian: "little",
      },
    }),
    readVariable: async () => {
      actions.push("read");
      if (options.failRead) {
        return failEnvelope(createOperationEnvelope("read_variable"), {
          code: "FIXTURE_READ_FAILED",
          stage: "read",
          message: "fixture read failed",
          retryable: false,
          writeIssued: false,
          stateUnknown: false,
        });
      }
      return operation("read_variable", { typedValue: 1 });
    },
    writeVariable: async (input) => {
      actions.push(`write:${input.value}`);
      if (options.failWrite && !failed && input.value === 1) {
        failed = true;
        return failEnvelope(createOperationEnvelope("write_variable"), {
          code: "FIXTURE_WRITE_FAILED",
          stage: "write",
          message: "fixture write failed",
          retryable: false,
          writeIssued: false,
          stateUnknown: options.failedWriteStateUnknown ?? false,
        });
      }
      return operation("write_variable", { requestedValue: input.value });
    },
  };
  const hss: DebugSequenceHssOperations = {
    plan: async (input) => {
      actions.push("plan");
      return operation("hss_plan", {
        variables: input.variables.map((variable) => ({ logicalIdentity: typeof variable.ref === "string" ? variable.ref : variable.ref.qualifiedName })),
        writeVariables: (input.writeVariables ?? []).map((ref) => ({ logicalIdentity: typeof ref === "string" ? ref : ref.qualifiedName })),
      });
    },
    start: async () => {
      actions.push("start");
      return operation("hss_start", { captureId: "capture-1" });
    },
    stop: async ({ captureId }) => {
      actions.push(`stop:${captureId}`);
      return operation("hss_stop", { captureId });
    },
  };
  return { executor: new DebugSequenceExecutor(artifacts, hss, scheduler), actions };
}

function operation(tool: string, data: Record<string, unknown>): OperationEnvelope {
  const envelope = createOperationEnvelope(tool);
  envelope.timestamps.queuedAt = "2026-01-01T00:00:00.000Z";
  envelope.timestamps.startedAt = "2026-01-01T00:00:00.003Z";
  envelope.data = data;
  return finishEnvelope(envelope, true);
}
