import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  adapterPayload,
  loadLiveToolCatalog,
  readRoutingSuite,
  sanitizeTraceEvents,
  scoreRoutingReportResult,
  scoreRoutingTrace,
  validateRoutingSuite,
} from "./agent-routing-eval.mjs";

const root = resolve(process.cwd());
const suite = readRoutingSuite();
const references = JSON.parse(readFileSync(
  resolve(root, "evals", "agent-routing", "reference-traces.json"),
  "utf8",
));
const tools = await loadLiveToolCatalog();

assert.equal(tools.length, 39, "routing eval must use the live 39-tool MCP catalog");
assert.ok(tools.every(({ description, inputSchema }) => description.length > 0 && inputSchema?.type === "object"));
assert.ok(tools.some(({ name }) => name === "gdb_breakpoint_list"), "routing catalog must include typed breakpoint listing");
assert.ok(tools.some(({ name }) => name === "gdb_breakpoint_delete"), "routing catalog must include typed breakpoint deletion");
assert.deepEqual(validateRoutingSuite(suite, tools), []);
assert.equal(suite.cases.length, 20);
assert.equal(references.schemaVersion, 1);
assert.equal(references.traces.length, suite.cases.length);

const caseById = new Map(suite.cases.map((entry) => [entry.id, entry]));
const traceById = new Map(references.traces.map((entry) => [entry.caseId, entry]));
assert.equal(caseById.size, suite.cases.length);
assert.equal(traceById.size, references.traces.length);

for (const entry of suite.cases) {
  const trace = traceById.get(entry.id);
  assert.ok(trace, `missing reference trace for ${entry.id}`);
  const score = scoreRoutingTrace(entry, trace, { requireAgentMetadata: true, tools });
  assert.equal(score.pass, true, `${entry.id}: ${score.findings.join("; ")}`);

  const payload = adapterPayload(entry, tools);
  assert.equal(Object.hasOwn(payload, "expected"), false, `${entry.id}: adapter must not receive expected answers`);
  assert.equal(Object.hasOwn(payload, "caseId"), false, `${entry.id}: adapter must receive an opaque evaluation ID`);
  assert.deepEqual(Object.keys(payload.modelInput).sort(), ["tools", "userGoal"]);
  assert.equal(Object.hasOwn(payload.modelInput, "scenario"), false);
  assert.equal(Object.hasOwn(payload.modelInput, "simulatedToolResults"), false);
}

const sanitizedEvents = sanitizeTraceEvents([
  {
    type: "tool_call",
    callId: "call-private",
    tool: "target_configure",
    arguments: {
      projectRoot: "D:\\private\\firmware",
      probeSerial: "real-probe-id",
      token: "fixture",
      device: "TEST",
    },
    ignored: "not part of the report contract",
  },
]);
assert.deepEqual(sanitizedEvents, [{
  type: "tool_call",
  callId: "call-private",
  tool: "target_configure",
  arguments: {
    projectRoot: "<redacted>",
    probeSerial: "<redacted>",
    ["token"]: "<redacted>",
    device: "TEST",
  },
}]);

const reportTrace = clone(traceById.get("list-connected-probes"));
reportTrace.events.push({
  type: "tool_call",
  callId: "call-unexpected",
  tool: "target_status",
  arguments: { projectRoot: "D:\\private\\firmware" },
});
const reportResult = scoreRoutingReportResult(caseById.get("list-connected-probes"), reportTrace, {
  requireAgentMetadata: true,
  tools,
});
assert.equal(reportResult.pass, false);
assert.ok(reportResult.findings.includes("unexpected tool call: target_status"));
assert.deepEqual(
  reportResult.events.find((event) => event.callId === "call-unexpected")?.arguments,
  { projectRoot: "<redacted>" },
);

const requiredGoalFacts = new Map([
  ["read-variable-needs-target", ["C:\\eval\\jlink-project", "EVAL-PROBE-001", "STM32F407VG", "SWD", "2000"]],
  ["flash-requires-confirmation", ["C:\\eval\\jlink-project", "EVAL-PROBE-001", "STM32F407VG", "SWD", "2000"]],
  ["hss-capability-only", ["capabilityProbe", "1 Hz", "1 秒", "dryRun=true"]],
  ["hss-fresh-preflight-reuse", ["counter", "500 Hz", "3 秒"]],
  ["hss-rate-change-needs-preflight", ["expectedIncrement=1", "tolerance=0"]],
  ["hss-write-allowlist-preflight", ["500 Hz", "3 秒"]],
  ["capture-summary-may-repair", ["43000000-0000-4000-8000-000000000001"]],
  ["capture-series-bounded", ["43000000-0000-4000-8000-000000000001"]],
  ["capture-event-window", ["43000000-0000-4000-8000-000000000001", "44000000-0000-4000-8000-000000000007"]],
  ["capture-export-csv", ["43000000-0000-4000-8000-000000000001"]],
  ["diagnose-halted-crash", ["聚合诊断能力", "不要打开 GDB", "不要恢复运行"]],
]);
for (const [caseId, facts] of requiredGoalFacts) {
  const goal = caseById.get(caseId)?.userGoal ?? "";
  for (const fact of facts) assert.ok(goal.includes(fact), `${caseId}: userGoal must expose ${fact}`);
}

assertFails("missing required tool", "read-variable-needs-target", (trace) => {
  trace.events = trace.events.filter((event) => event.tool !== "read_variable");
});
assertFails("wrong partial order", "gdb-command-requires-confirmation", (trace) => {
  const open = trace.events.shift();
  trace.events.push(open);
});
assertFails("forbidden tool", "single-read-not-sequence", (trace) => {
  trace.events.push({ type: "tool_call", tool: "debug_sequence_execute", arguments: {} });
});
assertFails("missing user approval", "flash-requires-confirmation", (trace) => {
  trace.events = trace.events.filter((event) => event.type !== "user_confirmation");
});
assertFails("wrong dry-run mode", "hss-capability-only", (trace) => {
  trace.events[0].arguments.dryRun = false;
});
assertFails("preflight parameter drift", "hss-new-capture-preflight", (trace, definition) => {
  delete definition.expected.steps.find(({ id }) => id === "live").arguments.rateHz;
  trace.events.find((event) => event.tool === "hss_start" && event.arguments.dryRun === false).arguments.rateHz = 999;
});
assertFails("execution after rejection", "erase-requires-confirmation", (trace) => {
  trace.events.splice(2, 0, {
    type: "user_confirmation",
    operationId: "erase-1",
    source: "user",
    approved: false,
  });
});
assertFails("confirmation argument substitution", "probe-command-requires-confirmation", (trace) => {
  trace.events.find((event) => event.type === "tool_call").arguments.projectRoot = "<different-project-root>";
});
assertFails("unexpected confirmation", "capture-summary-may-repair", (trace) => {
  trace.events.unshift({
    type: "confirmation_request",
    operationId: "unexpected-1",
    tool: "capture_summary",
    impact: "This query should not need destructive confirmation.",
    arguments: trace.events[0].arguments,
  });
});
assertFails("missing real-agent metadata", "list-connected-probes", (trace) => {
  delete trace.agent;
});
assertFails("unexpected target mutation", "list-connected-probes", (trace) => {
  trace.events.push({
    type: "tool_call",
    tool: "target_control",
    arguments: { projectRoot: "<project-root>", action: "reset" },
  });
});
assertFails("unconfirmed extra raw command", "flash-requires-confirmation", (trace) => {
  trace.events.push({
    type: "tool_call",
    tool: "gdb_command",
    arguments: { projectRoot: "<project-root>", command: "monitor reset", timeoutMs: 15000, userConfirmed: true },
  });
});
assertFails("missing successful HSS preflight result", "hss-new-capture-preflight", (trace) => {
  trace.events = trace.events.filter((event) => event.type !== "tool_result");
});
assertFails("invalid tool arguments", "single-read-not-sequence", (trace) => {
  delete trace.events[0].arguments.projectRoot;
});
assertFails("runId outside Acceptance", "single-read-not-sequence", (trace) => {
  trace.events[0].arguments.runId = "ordinary-debug-task";
});
assertFails("duplicate confirmation operation ID", "flash-requires-confirmation", (trace) => {
  const request = clone(trace.events.find((event) => event.type === "confirmation_request"));
  trace.events.splice(2, 0, request);
});
assertFails("confirmation replay", "flash-requires-confirmation", (trace, definition) => {
  definition.expected.allowedExtraTools = ["flash"];
  trace.events.push(clone(trace.events.find((event) => event.type === "tool_call" && event.tool === "flash")));
});
assertFails("rejected request without impact", "erase-user-rejects", (trace) => {
  delete trace.events.find((event) => event.type === "confirmation_request").impact;
});
assertFails("exclusive minimum schema violation", "read-variable-needs-target", (trace) => {
  trace.events.find((event) => event.tool === "target_configure").arguments.memoryRegions = [{
    start: 0,
    length: 0,
    kind: "ram",
    writable: true,
  }];
});

process.stdout.write(`Agent routing eval: ${suite.cases.length}/${suite.cases.length} reference traces passed; 19/19 negative controls rejected.\n`);

function assertFails(label, caseId, mutate) {
  const definition = clone(caseById.get(caseId));
  const trace = clone(traceById.get(caseId));
  mutate(trace, definition);
  const score = scoreRoutingTrace(definition, trace, { requireAgentMetadata: true, tools });
  assert.equal(score.pass, false, `${label}: scorer accepted an invalid trace`);
  assert.ok(score.findings.length > 0, `${label}: scorer returned no finding`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
