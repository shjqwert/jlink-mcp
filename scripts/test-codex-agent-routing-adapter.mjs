import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { codexSandboxMode } from "./codex-agent-routing-adapter.mjs";

const adapter = resolve(process.cwd(), "scripts", "codex-agent-routing-adapter.mjs");

assert.equal(codexSandboxMode({}), "read-only");
assert.equal(codexSandboxMode({ JLINK_ROUTING_ALLOW_DANGER_FULL_ACCESS: "1" }), "danger-full-access");
assert.equal(codexSandboxMode({ JLINK_ROUTING_ALLOW_DANGER_FULL_ACCESS: "true" }), "read-only");

const events = await exerciseShim();
assertFailedEventPair(events, "unknown_tool");
assertFailedEventPair(events, "read_variable");
assertSuccessfulEventPair(events, "flash");
assert.equal(events.some((event) => event.type === "confirmation_request" || event.type === "user_confirmation"), false);
assert.deepEqual(
  events.filter((event) => event.type === "tool_result" && event.result?.executionMarker).map((event) => event.result.executionMarker),
  ["first-execution", "second-execution"],
  "direct calls must consume one simulated result each",
);
const callIds = events.filter((event) => event.type === "tool_call").map((event) => event.callId);
assert.equal(new Set(callIds).size, callIds.length, "every audited tool call requires a unique callId");
assert.deepEqual(
  events
    .filter((event) => event.type === "tool_result" && event.result?.statusMarker)
    .map((event) => event.result.statusMarker),
  ["active", "stopped"],
  "array-valued simulations must advance once per tool call",
);
assert.deepEqual(
  events
    .filter((event) => event.type === "tool_result" && event.result?.statusMarker)
    .map((event) => event.result.active),
  [true, false],
  "HSS status must reflect simulated live start and stop transitions",
);

process.stdout.write("Codex agent routing adapter: simulated MCP auditing and sandbox opt-in passed.\n");

async function exerciseShim() {
  const root = mkdtempSync(join(tmpdir(), "jlink-routing-adapter-test-"));
  const statePath = join(root, "state.json");
  const eventsPath = join(root, "events.jsonl");
  writeFileSync(statePath, JSON.stringify({
    evaluationId: "eval-test",
    modelInput: {
      tools: [
        { name: "read_variable", description: "test", inputSchema: { type: "object" } },
        { name: "flash", description: "test", inputSchema: { type: "object" } },
        { name: "hss_start", description: "test", inputSchema: { type: "object" } },
        { name: "hss_status", description: "test", inputSchema: { type: "object" } },
        { name: "hss_stop", description: "test", inputSchema: { type: "object" } },
      ],
    },
    harnessPolicy: {
      scenario: {},
      simulatedToolResults: {
        flash: [
          { ok: true, executionMarker: "first-execution" },
          { ok: true, executionMarker: "second-execution" },
        ],
        hss_start: { ok: true },
        hss_status: [
          { ok: true, active: false, statusMarker: "active" },
          { ok: true, active: true, statusMarker: "stopped" },
        ],
        hss_stop: { ok: true },
      },
    },
    eventsPath,
  }), "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [adapter, "--mcp-shim", statePath],
    stderr: "pipe",
  });
  const client = new Client({ name: "adapter-test", version: "1" });
  try {
    await client.connect(transport);
    await client.callTool({ name: "unknown_tool", arguments: {} });
    await client.callTool({ name: "read_variable", arguments: { projectRoot: "C:\\eval\\project", ref: "state" } });
    await client.callTool({ name: "flash", arguments: { projectRoot: "C:\\eval\\project", path: "firmware.hex" } });
    await client.callTool({ name: "flash", arguments: { projectRoot: "C:\\eval\\project", path: "firmware.hex" } });
    await client.callTool({
      name: "hss_start",
      arguments: { projectRoot: "C:\\eval\\project", variables: [{ ref: "state" }], rateHz: 1, durationSec: 1 },
    });
    await client.callTool({ name: "hss_status", arguments: { projectRoot: "C:\\eval\\project" } });
    await client.callTool({ name: "hss_stop", arguments: { projectRoot: "C:\\eval\\project" } });
    await client.callTool({ name: "hss_status", arguments: { projectRoot: "C:\\eval\\project" } });
  } finally {
    await client.close();
  }
  const events = readFileSync(eventsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  rmSync(root, { recursive: true, force: true });
  return events;
}

function assertFailedEventPair(events, tool) {
  const call = events.find((event) => event.type === "tool_call" && event.tool === tool);
  assert.ok(call, `${tool}: missing audited tool_call`);
  assert.ok(
    events.some((event) => event.type === "tool_result" && event.callId === call.callId && event.ok === false),
    `${tool}: missing failed tool_result`,
  );
}

function assertSuccessfulEventPair(events, tool) {
  const call = events.find((event) => event.type === "tool_call" && event.tool === tool);
  assert.ok(call, `${tool}: missing audited tool_call`);
  assert.ok(
    events.some((event) => event.type === "tool_result" && event.callId === call.callId && event.ok === true),
    `${tool}: missing successful tool_result`,
  );
}
