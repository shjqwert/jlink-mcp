import assert from "node:assert/strict";
import test from "node:test";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./operation-envelope";
import {
  DebugSequenceExecutor,
  type DebugSequenceHssOperations,
  type DebugSequenceScheduler,
  type DebugSequenceVariableAccess,
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

test("debug sequence anchors timed HSS steps after a slow leading capture startup", async () => {
  const fixture = sequenceFixture({ startDurationMs: 7_000 });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1 },
      { atMs: 2_000, action: "read_variable", ref: "control" },
      { atMs: 3_000, action: "write_variable", ref: "control", value: 0 },
      { atMs: 4_000, action: "hss_stop" },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data as {
    actualDurationMs: number;
    setupDurationMs: number;
    timelineAnchor: string;
    steps: Array<{ actualAtMs: number; durationMs: number }>;
  };
  assert.equal(data.actualDurationMs, 11_000);
  assert.equal(data.setupDurationMs, 7_000);
  assert.equal(data.timelineAnchor, "hss_ready");
  assert.deepEqual(data.steps.map(({ actualAtMs }) => actualAtMs), [0, 1_000, 2_000, 3_000, 4_000]);
  assert.equal(data.steps[0].durationMs, 7_000);
  assert.deepEqual(fixture.dispatches, [
    { action: "start", at: 0 },
    { action: "write:1", at: 8_000 },
    { action: "read", at: 9_000 },
    { action: "write:0", at: 10_000 },
    { action: "stop:capture-1", at: 11_000 },
  ]);
});

test("debug sequence default timeout includes a bounded HSS startup allowance", async () => {
  const fixture = sequenceFixture({ startDurationMs: 12_288 });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "read_variable", ref: "sample" },
      { atMs: 4_000, action: "hss_stop" },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data as { actualDurationMs: number; timeoutMs: number };
  assert.equal(data.actualDurationMs, 16_288);
  assert.equal(data.timeoutMs, 34_000);
  assert.deepEqual(fixture.actions, ["plan", "start", "read", "stop:capture-1"]);
});

test("debug sequence keeps the end-to-end deadline when HSS startup rebases the timeline", async () => {
  const fixture = sequenceFixture({ startDurationMs: 7_000 });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    timeoutMs: 7_500,
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1 },
      { atMs: 2_000, action: "read_variable", ref: "control" },
      { atMs: 4_000, action: "hss_stop" },
    ],
    cleanup: [{ action: "hss_stop" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_TIMEOUT");
  assert.deepEqual(fixture.actions, ["plan", "start", "stop:capture-1"]);
});

test("debug sequence rejects catch-up dispatch after a step overruns the next schedule point", async () => {
  const fixture = sequenceFixture({ writeDurationMs: 1_500 });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1 },
      { atMs: 2_000, action: "read_variable", ref: "control" },
    ],
    cleanup: [
      { action: "restore_variable", ref: "control", value: 0 },
      { action: "hss_stop" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_SCHEDULE_OVERRUN");
  assert.deepEqual(fixture.actions, ["plan", "start", "write:1", "write:0", "stop:capture-1"]);
  assert.equal(fixture.actions.includes("read"), false);
});

test("debug sequence without leading HSS keeps the original absolute timeline", async () => {
  const fixture = sequenceFixture();
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "write_variable", ref: "control", value: 1 },
      { atMs: 1_000, action: "read_variable", ref: "control" },
    ],
  });

  assert.equal(result.ok, true, JSON.stringify(result.error));
  const data = result.data as { timelineAnchor: string; steps: Array<{ actualAtMs: number }> };
  assert.equal(data.timelineAnchor, "sequence_start");
  assert.deepEqual(data.steps.map(({ actualAtMs }) => actualAtMs), [0, 1_000]);
  assert.deepEqual(fixture.dispatches, [
    { action: "write:1", at: 0 },
    { action: "read", at: 1_000 },
  ]);
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
    cleanup: Array<{ action: string; ok: boolean; result: { data?: { skipped?: boolean } } }>;
  };
  assert.equal(data.state, "failed");
  assert.deepEqual(data.steps.map(({ action }) => action), ["hss_start", "write_variable"]);
  assert.deepEqual(data.cleanup.map(({ action, ok }) => ({ action, ok })), [
    { action: "restore_variable", ok: true },
    { action: "hss_stop", ok: true },
  ]);
  assert.equal(data.cleanup[0].result.data?.skipped, true);
  assert.deepEqual(fixture.actions, ["plan", "start", "write:1", "stop:capture-1"]);
});

test("debug sequence restores a variable when a failed write may have been issued", async () => {
  const fixture = sequenceFixture({ failWrite: true, failedWriteIssued: true });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], writeVariables: ["control"], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "write_variable", ref: "control", value: 1 },
    ],
    cleanup: [{ action: "restore_variable", ref: "control", value: 0 }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(fixture.actions, ["plan", "start", "write:1", "write:0", "stop:capture-1"]);
});

test("debug sequence automatically stops its active capture after failure", async () => {
  const fixture = sequenceFixture({ failRead: true });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "read_variable", ref: "sample" },
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_STEP_FAILED");
  const data = result.data as { cleanup: Array<{ action: string; automatic?: boolean; ok: boolean }> };
  assert.equal(data.cleanup.length, 1);
  assert.deepEqual(
    data.cleanup.map(({ action, automatic, ok }) => ({ action, automatic, ok })),
    [{ action: "hss_stop", automatic: true, ok: true }],
  );
  assert.deepEqual(fixture.actions, ["plan", "start", "read", "stop:capture-1"]);
});

test("debug sequence preserves the original failure when automatic HSS stop fails", async () => {
  const fixture = sequenceFixture({ failRead: true, failStop: true });
  const result = await fixture.executor.execute({
    projectRoot: "D:\\fixture",
    steps: [
      { atMs: 0, action: "hss_start", variables: [{ ref: "sample" }], rateHz: 100, durationSec: 10 },
      { atMs: 1_000, action: "read_variable", ref: "sample" },
    ],
  });

  assert.equal(result.error?.code, "DEBUG_SEQUENCE_STEP_FAILED");
  assert.equal(result.error?.stateUnknown, true);
  const data = result.data as { cleanup: Array<{ automatic?: boolean; ok: boolean }> };
  assert.deepEqual(data.cleanup.map(({ automatic, ok }) => ({ automatic, ok })), [{ automatic: true, ok: false }]);
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

test("debug sequence rejects variable access after hss_stop before any target operation", async () => {
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
  assert.equal(result.error?.code, "DEBUG_SEQUENCE_INVALID");
  assert.match(result.error?.message ?? "", /hss_stop must be the final scheduled step/i);
  assert.deepEqual(fixture.actions, ["plan"]);
});

function sequenceFixture(options: {
  failWrite?: boolean;
  failedWriteIssued?: boolean;
  failedWriteStateUnknown?: boolean;
  failRead?: boolean;
  failStop?: boolean;
  startDurationMs?: number;
  writeDurationMs?: number;
} = {}): {
  executor: DebugSequenceExecutor;
  actions: string[];
  dispatches: Array<{ action: string; at: number }>;
} {
  const actions: string[] = [];
  const dispatches: Array<{ action: string; at: number }> = [];
  let now = 0;
  let failed = false;
  const scheduler: DebugSequenceScheduler = {
    now: () => now,
    wait: async (delayMs, signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("cancelled");
      now += delayMs;
    },
  };
  const variables: DebugSequenceVariableAccess = {
    resolveVariable: async (_projectRoot, ref) => ({
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
      dispatches.push({ action: "read", at: now });
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
      dispatches.push({ action: `write:${input.value}`, at: now });
      now += options.writeDurationMs ?? 0;
      if (options.failWrite && !failed && input.value === 1) {
        failed = true;
        return failEnvelope(createOperationEnvelope("write_variable"), {
          code: "FIXTURE_WRITE_FAILED",
          stage: "write",
          message: "fixture write failed",
          retryable: false,
          writeIssued: options.failedWriteIssued ?? false,
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
      dispatches.push({ action: "start", at: now });
      now += options.startDurationMs ?? 0;
      return operation("hss_start", { captureId: "capture-1" });
    },
    stop: async ({ captureId }) => {
      actions.push(`stop:${captureId}`);
      dispatches.push({ action: `stop:${captureId}`, at: now });
      if (options.failStop) {
        return failEnvelope(createOperationEnvelope("hss_stop"), {
          code: "FIXTURE_STOP_FAILED",
          stage: "stop",
          message: "fixture stop failed",
          retryable: false,
          writeIssued: true,
          stateUnknown: true,
        });
      }
      return operation("hss_stop", { captureId });
    },
  };
  return { executor: new DebugSequenceExecutor(variables, hss, scheduler), actions, dispatches };
}

function operation(tool: string, data: Record<string, unknown>): OperationEnvelope {
  const envelope = createOperationEnvelope(tool);
  envelope.timestamps.queuedAt = "2026-01-01T00:00:00.000Z";
  envelope.timestamps.startedAt = "2026-01-01T00:00:00.003Z";
  envelope.data = data;
  return finishEnvelope(envelope, true);
}
