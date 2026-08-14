import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpResultMode } from "../result-mode";
import { createOperationEnvelope, failEnvelope, finishEnvelope } from "./operation-envelope";
import { operationToolResult, projectNormalOperationResult } from "./operation-result";

test("result mode parser defaults to normal and preserves explicit compatibility modes", () => {
  assert.equal(parseMcpResultMode(undefined), "normal");
  assert.equal(parseMcpResultMode("normal"), "normal");
  assert.equal(parseMcpResultMode("full"), "full");
  assert.equal(parseMcpResultMode("text"), "text");
  assert.throws(() => parseMcpResultMode("compact"), /Invalid JLINK_MCP_RESULT_MODE/);
});

test("normal read result exposes only the value through identical text and structured content", () => {
  const envelope = finishEnvelope(createOperationEnvelope("read_variable"), true);
  envelope.data = {
    dataHex: "00009a44",
    resolved: { logicalIdentity: "motor.speed", address: "0x20001000", type: "float32" },
    cacheRefreshed: true,
    typedValue: 1232,
  };
  envelope.details = { rawOutput: "x".repeat(20_000) };

  const result = operationToolResult(envelope, "normal");
  assert.deepEqual(result.structuredContent, { ok: true, result: { value: 1232 } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_024);
});

test("normal capture completion returns a bounded receipt and anomaly codes", () => {
  const envelope = finishEnvelope(createOperationEnvelope("hss_stop"), true);
  envelope.capture = {
    captureId: "cap-001",
    state: "completed",
    sampleCount: 3_001,
    requestedRateHz: 1_000,
    actualRateHz: 920,
    sampleThresholdMet: false,
    packageDir: "C:\\captures\\cap-001.jcap",
    readStatistics: { attempts: 3_001, emptyReads: 0, shortReads: 1, readErrors: 0 },
  };
  envelope.data = {
    captureId: "cap-001",
    state: "completed",
    packageDir: "C:\\captures\\cap-001.jcap",
  };

  const result = operationToolResult(envelope, "normal");
  assert.deepEqual(result.structuredContent, {
    ok: true,
    result: {
      captureId: "cap-001",
      state: "completed",
      sampleCount: 3_001,
      anomalies: {
        level: "warning",
        count: 2,
        codes: ["RATE_DEGRADED", "SAMPLES_DROPPED"],
      },
    },
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.doesNotMatch(result.content[0].text, /packageDir|0x2000|probe/i);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1_024);
});

test("normal query data remains aligned while local paths are removed", () => {
  const envelope = finishEnvelope(createOperationEnvelope("capture_series"), true);
  envelope.data = {
    captureId: "cap-001",
    time: { unit: "ms", start: [0, 10], end: [10, 20] },
    variables: [{ name: "speed", type: "float32", last: [1, 2], min: [1, 2], max: [1, 2] }],
    quality: { missing: 0, dropped: 0 },
    nextCursor: null,
    databaseFile: "C:\\captures\\cap-001.jcap",
  };

  assert.deepEqual(projectNormalOperationResult(envelope), {
    ok: true,
    result: {
      captureId: "cap-001",
      time: { unit: "ms", start: [0, 10], end: [10, 20] },
      variables: [{ name: "speed", type: "float32", last: [1, 2], min: [1, 2], max: [1, 2] }],
      quality: { missing: 0, dropped: 0 },
      nextCursor: null,
    },
  });
});

test("normal failures retain safety fields and diagnostics only by reference", () => {
  const envelope = failEnvelope(createOperationEnvelope("write_variable"), {
    code: "WRITE_FAILED",
    stage: "write",
    message: "sensitive internal diagnostic",
    retryable: false,
    writeIssued: true,
    stateUnknown: true,
  });
  envelope.details = { rawOutput: "exact" };

  const diagnosticRef = `jlink://operation/${envelope.operationId}`;
  const normal = operationToolResult(envelope, "normal", diagnosticRef);
  assert.deepEqual(normal.structuredContent, {
    ok: false,
    error: {
      code: "WRITE_FAILED",
      stage: "write",
      retryable: false,
      writeIssued: true,
      stateUnknown: true,
    },
    diagnosticRef,
  });
  assert.deepEqual(JSON.parse(normal.content[0].text), normal.structuredContent);
  assert.doesNotMatch(normal.content[0].text, /sensitive|rawOutput/);

  const full = operationToolResult(envelope, "full");
  assert.equal(full.structuredContent, envelope);
  assert.deepEqual(full.structuredContent?.details, envelope.details);
  assert.throws(() => JSON.parse(full.content[0].text));

  const text = operationToolResult(envelope, "text");
  assert.equal(text.structuredContent, undefined);
  assert.deepEqual(JSON.parse(text.content[0].text), envelope);
});
