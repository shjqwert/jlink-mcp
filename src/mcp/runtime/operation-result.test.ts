import assert from "node:assert/strict";
import test from "node:test";
import { parseMcpResultMode } from "../result-mode";
import { createOperationEnvelope, failEnvelope, finishEnvelope } from "./operation-envelope";
import { operationToolResult, projectNormalOperationResult } from "./operation-result";

test("result mode parser preserves text compatibility by default", () => {
  assert.equal(parseMcpResultMode(undefined), "text");
  assert.equal(parseMcpResultMode("normal"), "normal");
  assert.equal(parseMcpResultMode("full"), "full");
  assert.equal(parseMcpResultMode("text"), "text");
  assert.throws(() => parseMcpResultMode("compact"), /Invalid JLINK_MCP_RESULT_MODE/);
});

test("normal result removes defaults and aliases without truncating semantic data", () => {
  const envelope = finishEnvelope(createOperationEnvelope("read_variable"), true);
  envelope.artifact = {
    generation: "artifact-generation",
    path: "firmware.elf",
    match: "verified",
    firmwareIdentity: "verified",
    mutationTrust: "verified",
    evidenceSource: "fixture",
    evidenceTimestamp: "2026-08-11T00:00:00.000Z",
    mutationTrustSource: "fixture",
    mutationTrustTimestamp: "2026-08-11T00:00:00.000Z",
  };
  envelope.data = { output: "x".repeat(20_000) };
  envelope.details = { rawOutput: "y".repeat(20_000) };

  const projected = projectNormalOperationResult(envelope);
  assert.equal(projected.timestamps, undefined);
  assert.equal(projected.before, undefined);
  assert.equal(projected.after, undefined);
  assert.equal(projected.warnings, undefined);
  assert.equal(projected.details, undefined);
  assert.equal((projected.artifact as { match?: string }).match, undefined);
  assert.equal(((projected.data as { output: string }).output).length, 20_000, "normal mode must not truncate data");
});

test("full, normal, and text modes carry one envelope representation", () => {
  const envelope = failEnvelope(createOperationEnvelope("write_variable"), {
    code: "WRITE_FAILED",
    stage: "write",
    message: "failed",
    retryable: false,
    writeIssued: true,
    stateUnknown: true,
  });

  envelope.details = { kind: "fixture", rawOutput: "exact" };

  const full = operationToolResult(envelope, "full");
  assert.equal(full.structuredContent, envelope);
  assert.deepEqual(full.structuredContent?.details, envelope.details);
  assert.throws(() => JSON.parse(full.content[0].text));
  assert.match(full.content[0].text, /^ERROR write_variable /);

  const normal = operationToolResult(envelope, "normal");
  assert.equal(normal.structuredContent?.ok, false);
  assert.equal(normal.structuredContent?.details, undefined);
  assert.equal((normal.structuredContent?.error as { stateUnknown?: boolean }).stateUnknown, true);
  assert.match(normal.content[0].text, /^ERROR write_variable /);

  const text = operationToolResult(envelope, "text");
  assert.equal(text.structuredContent, undefined);
  assert.deepEqual(JSON.parse(text.content[0].text), envelope);
  assert.deepEqual((JSON.parse(text.content[0].text) as { details: unknown }).details, envelope.details);

  const previousDuplicateBytes = Buffer.byteLength(JSON.stringify({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < previousDuplicateBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(text)) < previousDuplicateBytes);
});
