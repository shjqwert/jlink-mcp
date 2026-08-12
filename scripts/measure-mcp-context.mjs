import assert from "node:assert/strict";
import { createOperationEnvelope, failEnvelope, finishEnvelope } from "../out/mcp/runtime/operation-envelope.js";
import { operationToolResult } from "../out/mcp/runtime/operation-result.js";

const fixtures = [
  simpleReadFixture(),
  hssStatusFixture(),
  nestedWorkflowFixture(),
  failureFixture(),
];

const measurements = fixtures.map(({ name, envelope, previousEnvelope }) => {
  const previous = previousDuplicateResult(previousEnvelope ?? envelope);
  const normal = operationToolResult(envelope, "normal");
  const full = operationToolResult(envelope, "full");
  const text = operationToolResult(envelope, "text");
  assert.equal(JSON.stringify(normal.structuredContent?.data), JSON.stringify(envelope.data), `${name} normal data fidelity`);
  assert.equal(normal.structuredContent?.details, undefined, `${name} normal mode must omit exact details`);
  assert.ok(bytes(normal) < bytes(previous), `${name} normal result must be smaller than the previous duplicated wire result`);
  assert.ok(bytes(full) < bytes(previous), `${name} full result must be smaller than the previous duplicated wire result`);
  assert.ok(bytes(text) < bytes(previous), `${name} text result must be smaller than the previous duplicated wire result`);
  return {
    name,
    previousDuplicateBytes: bytes(previous),
    normalBytes: bytes(normal),
    fullBytes: bytes(full),
    textBytes: bytes(text),
  };
});

const totals = measurements.reduce((sum, item) => ({
  previousDuplicateBytes: sum.previousDuplicateBytes + item.previousDuplicateBytes,
  normalBytes: sum.normalBytes + item.normalBytes,
  fullBytes: sum.fullBytes + item.fullBytes,
  textBytes: sum.textBytes + item.textBytes,
}), { previousDuplicateBytes: 0, normalBytes: 0, fullBytes: 0, textBytes: 0 });

process.stdout.write(`${JSON.stringify({ schemaVersion: 1, measurements, totals }, null, 2)}\n`);

function simpleReadFixture() {
  const envelope = finishEnvelope(createOperationEnvelope("read_variable"), true);
  envelope.data = { ref: "motor.speed", type: "float32", value: 1234.5 };
  envelope.verification = { status: "observed", method: "typed_memory_read" };
  return { name: "simple_read", envelope };
}

function hssStatusFixture() {
  const envelope = finishEnvelope(createOperationEnvelope("hss_status"), true);
  const session = {
    captureId: "43000000-0000-4000-8000-000000000001",
    state: "capturing",
    packageDir: "C:\\captures\\fixture.jcap",
    sampleCount: 250_000,
    eventCount: 4,
    variables: ["motor.speed", "motor.current", "motor.voltage"],
  };
  envelope.capture = { ...session };
  envelope.data = { session, metadata: { ...session }, helperAlive: true };
  envelope.outputFiles = ["capture.json", "raw/samples.bin", "raw/events.bin", "capture.db"];
  envelope.verification = { status: "observed", method: "capture_bound_heartbeat" };
  return { name: "hss_status", envelope };
}

function nestedWorkflowFixture() {
  const steps = Array.from({ length: 6 }, (_, index) => {
    const step = finishEnvelope(createOperationEnvelope("gdb_command"), true);
    step.before = { targetExecutionState: "running" };
    step.after = { targetExecutionState: "running" };
    step.requestedEffects = ["issue_gdb_command"];
    step.observedEffects = ["gdb_command_dispatched"];
    step.verification = { status: "observed", method: "fixture" };
    step.data = {
      commandDispatched: true,
      rawOutput: `breakpoint-${index}-${"sample".repeat(1_000)}`,
    };
    return step;
  });

  const previousEnvelope = finishEnvelope(createOperationEnvelope("debug_sequence_execute"), true);
  previousEnvelope.data = {
    steps: steps.map((step, index) => ({
      index,
      tool: step.tool,
      operationId: step.operationId,
      ok: step.ok,
      verification: step.verification,
      before: step.before,
      after: step.after,
      observedEffects: step.observedEffects,
      data: step.data,
      error: step.error,
    })),
  };
  previousEnvelope.verification = { status: "observed", method: "sequence_steps" };

  const envelope = finishEnvelope(createOperationEnvelope("debug_sequence_execute"), true);
  envelope.data = {
    steps: steps.map((step, index) => ({
      index,
      tool: step.tool,
      operationId: step.operationId,
      ok: step.ok,
      verification: step.verification,
      before: step.before,
      after: step.after,
      observedEffects: step.observedEffects,
      data: { commandDispatched: true },
    })),
  };
  envelope.details = { kind: "debug_sequence", steps };
  envelope.verification = { status: "observed", method: "sequence_steps" };
  return { name: "nested_workflow", envelope, previousEnvelope };
}

function failureFixture() {
  const envelope = failEnvelope(createOperationEnvelope("write_variable"), {
    code: "WRITE_VERIFICATION_FAILED",
    stage: "verify",
    message: "post-write value did not match",
    retryable: false,
    writeIssued: true,
    stateUnknown: true,
  });
  envelope.data = { requestedValue: 10, observedValue: 9 };
  envelope.warnings = ["Do not retry automatically while target state is unknown."];
  return { name: "write_failure", envelope };
}

function previousDuplicateResult(envelope) {
  return {
    isError: !envelope.ok,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}
