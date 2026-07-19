import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { applyEvidenceLogFailure, operationHadIssuedEffects } from "./server";
import { createOperationEnvelope, failEnvelope } from "./runtime/operation-envelope";

const EXPECTED_TOOLS = [
  "analysis_profiles", "analysis_run", "artifact_probe", "capture_event_window",
  "capture_export_csv", "capture_index_rebuild", "capture_list", "capture_series",
  "capture_summary", "diagnose_crash", "erase", "flash", "gdb_backtrace",
  "gdb_command", "gdb_connect", "gdb_disconnect", "gdb_server_start",
  "gdb_server_status", "gdb_server_stop", "gdb_wait", "halt", "hot_variable_add",
  "hot_variable_list", "hot_variable_refresh", "hss_capability", "hss_plan",
  "hss_recover", "hss_start", "hss_status", "hss_stop", "list_devices",
  "probe_command", "read_core_register", "read_core_registers", "read_memory",
  "read_register", "read_registers", "read_variable", "reset", "reset_halt",
  "resume", "rtt_channel_list", "rtt_channel_read", "rtt_clear", "rtt_connect",
  "rtt_disconnect", "rtt_read", "rtt_search", "snapshot", "symbol_resolve",
  "symbol_search", "target_configure", "target_status", "write_core_register",
  "write_memory", "write_register", "write_variable",
].sort();

test("evidence failure classifies every observed explicit side effect as issued", () => {
  for (const effect of ["halt", "resume", "reset", "raw_command_issued", "hss_helper_started", "capture_finalized"]) {
    assert.equal(operationHadIssuedEffects({ observedEffects: [effect] }), true, effect);
  }
  assert.equal(operationHadIssuedEffects({ observedEffects: [] }), false);
  const failed = failEnvelope(createOperationEnvelope("hss_stop"), {
    code: "HSS_STOP_PENDING_STARTUP",
    stage: "query",
    message: "durable stop request is pending",
    retryable: true,
    writeIssued: false,
    stateUnknown: true,
  });
  failed.observedEffects.push("hss_stop_requested", "capture_marked_stopping");
  const evidenceFailed = applyEvidenceLogFailure(failed, new Error("commands log unavailable"));
  assert.equal(evidenceFailed.error?.code, "HSS_STOP_PENDING_STARTUP");
  assert.equal(evidenceFailed.error?.writeIssued, true);
  assert.equal(evidenceFailed.error?.retryable, false);
  assert.match(evidenceFailed.warnings.join("\n"), /do not retry/i);
});

test("standalone stdio exposes only the Agent-first MCP surface", async (context) => {
  const root = testDirectory(context, "surface-contract");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(__dirname, "standalone.js")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: childEnvironment(join(root, "queue")),
  });
  const client = new Client({ name: "standalone-surface-test", version: "1" });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "jlink-mcp");
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), EXPECTED_TOOLS);
    const tools = (await client.listTools()).tools;
    for (const tool of tools) assert.ok(tool.inputSchema.properties?.runId, `${tool.name} must accept optional runId evidence routing`);
    for (const name of ["halt", "resume", "reset", "reset_halt", "read_memory", "write_memory", "flash", "erase", "gdb_command", "probe_command", "hss_start"] as const) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties?.projectRoot, `${name} must expose projectRoot`);
      assert.ok(schema.required?.includes("projectRoot"), `${name} must require projectRoot`);
      const removedFields = ["challenge" + "Id", "nonce", "approval" + "Token", "plan" + "Id"];
      for (const removed of removedFields) assert.equal(schema.properties?.[removed], undefined, `${name} must not expose ${removed}`);
    }
    for (const name of ["write_variable", "write_register"] as const) {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { default?: unknown }>;
      assert.equal(properties.captureOld?.default, false);
      assert.equal(properties.verify?.default, false);
      assert.equal(properties.restore?.default, false);
    }
    const eventWindowVariables = tools.find((tool) => tool.name === "capture_event_window")?.inputSchema.properties?.variables as { minItems?: number; maxItems?: number };
    assert.equal(eventWindowVariables.minItems, undefined);
    assert.equal(eventWindowVariables.maxItems, 16);
    const ref = { artifactGeneration: "a".repeat(64), qualifiedName: "counter", layoutHash: "b".repeat(64) };
    const phaseThreeCalls = [
      ["artifact_probe", { projectRoot: root }],
      ["symbol_search", { projectRoot: root, query: "counter" }],
      ["symbol_resolve", { projectRoot: root, selector: "counter" }],
      ["hot_variable_add", { projectRoot: root, ref }],
      ["hot_variable_list", { projectRoot: root }],
      ["hot_variable_refresh", { projectRoot: root, selectors: ["counter"] }],
      ["read_variable", { projectRoot: root, ref }],
      ["write_variable", { projectRoot: root, ref, value: 1 }],
      ["read_register", { projectRoot: root, selector: "GPIO.CTRL" }],
      ["read_registers", { projectRoot: root, selectors: ["GPIO.CTRL"] }],
      ["write_register", { projectRoot: root, selector: "GPIO.CTRL", value: 1 }],
    ] as const;
    for (const [name, argumentsValue] of phaseThreeCalls) {
      const envelope = parseEnvelope(await client.callTool({ name, arguments: argumentsValue }));
      assert.notEqual((envelope.error as { code?: string } | undefined)?.code, "NOT_IMPLEMENTED", `${name} must be implemented in Phase 3`);
    }
    assert.deepEqual(readdirSync(join(root, "evidence")), [], "operations without runId must not create a command log or synthetic run directory");
    const logged = parseEnvelope(await client.callTool({ name: "target_configure", arguments: { projectRoot: root, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000, runId: "surface-run" } }));
    assert.equal(logged.ok, true, JSON.stringify(logged.error));
    const commandsFile = join(root, "evidence", "surface-run", "commands.ndjson");
    const commandLines = readFileSync(commandsFile, "utf8").trim().split(/\r?\n/);
    assert.equal(commandLines.length, 1);
    const command = JSON.parse(commandLines[0]) as { sequence: number; tool: string; request: { runId: string }; result: { operationId: string } };
    assert.equal(command.sequence, 1);
    assert.equal(command.tool, "target_configure");
    assert.equal(command.request.runId, "surface-run");
    assert.equal(command.result.operationId, logged.operationId);
    const configuredGeneration = ((logged.data as { target: { generation: string } }).target.generation);
    const completedRun = join(root, "evidence", "completed-run");
    mkdirSync(completedRun, { recursive: true });
    writeFileSync(join(completedRun, "run.json"), `${JSON.stringify({ schemaVersion: 1, runId: "completed-run" })}\n`, { flag: "wx" });
    writeFileSync(join(completedRun, "acceptance-index.json"), "{}\n", { flag: "wx" });
    const completedRunRequest = parseEnvelope(await client.callTool({ name: "target_configure", arguments: { projectRoot: root, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 2000, runId: "completed-run" } }));
    assert.equal(completedRunRequest.ok, false);
    assert.equal((completedRunRequest.error as { code?: string }).code, "RUN_ID_COMPLETE");
    assert.equal((completedRunRequest.error as { writeIssued?: boolean }).writeIssued, false);
    const completedCaptureId = "43000000-0000-4000-8000-000000000099";
    mkdirSync(join(completedRun, "captures", `${completedCaptureId}.jcap`), { recursive: true });
    const ownerGuarded = parseEnvelope(await client.callTool({ name: "capture_index_rebuild", arguments: { captureId: completedCaptureId } }));
    assert.equal((ownerGuarded.error as { code?: string }).code, "RUN_ID_COMPLETE");
    const mismatchedRun = parseEnvelope(await client.callTool({ name: "capture_index_rebuild", arguments: { captureId: completedCaptureId, runId: "surface-run" } }));
    assert.equal((mismatchedRun.error as { code?: string }).code, "RUN_ID_CAPTURE_MISMATCH");
    const unchanged = parseEnvelope(await client.callTool({ name: "target_status", arguments: { projectRoot: root } }));
    assert.equal(((unchanged.data as { target: { generation: string } }).target.generation), configuredGeneration);
    rmSync(commandsFile);
    mkdirSync(commandsFile);
    const effectFailure = parseEnvelope(await client.callTool({ name: "target_configure", arguments: { projectRoot: root, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 2000, runId: "surface-run" } }));
    assert.equal(effectFailure.ok, false);
    assert.equal((effectFailure.error as { code?: string }).code, "EVIDENCE_LOG_FAILED");
    assert.equal((effectFailure.error as { writeIssued?: boolean }).writeIssued, true);
    const reconfigured = parseEnvelope(await client.callTool({ name: "target_status", arguments: { projectRoot: root } }));
    assert.notEqual(((reconfigured.data as { target: { generation: string } }).target.generation), configuredGeneration);
    const evidenceFailure = parseEnvelope(await client.callTool({ name: "target_status", arguments: { projectRoot: root, runId: "surface-run" } }));
    assert.equal(evidenceFailure.ok, false);
    assert.equal((evidenceFailure.error as { code?: string }).code, "EVIDENCE_LOG_FAILED");
    assert.equal((evidenceFailure.error as { retryable?: boolean }).retryable, false);
    assert.equal((evidenceFailure.error as { writeIssued?: boolean }).writeIssued, false);
    assert.match((evidenceFailure.warnings as string[]).join("\n"), /do not retry/i);
    assert.deepEqual((await client.listResources()).resources.map(({ uri }) => uri).sort(), [
      "probe://gdb-server-log",
      "probe://status",
      "rtt://output",
    ]);
    assert.equal(client.getServerCapabilities()?.prompts, undefined);
  } finally {
    await client.close();
  }
});

test("target configuration survives a standalone restart and explicit reconfigure advances generation", async (context) => {
  const root = testDirectory(context, "target-persistence");
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { recursive: true });
  const first = await connectClient(root, "target-persistence-first");
  let firstGeneration: string;
  try {
    const configured = await first.client.callTool({ name: "target_configure", arguments: { projectRoot, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000 } });
    const envelope = parseEnvelope(configured);
    assert.equal(envelope.ok, true);
    firstGeneration = ((envelope.data as { target: { generation: string } }).target.generation);
  } finally {
    await first.client.close();
  }

  const second = await connectClient(root, "target-persistence-second");
  try {
    const status = parseEnvelope(await second.client.callTool({ name: "target_status", arguments: { projectRoot } }));
    assert.equal(status.ok, true);
    assert.equal((status.data as { target: { generation: string } }).target.generation, firstGeneration!);
    const configured = parseEnvelope(await second.client.callTool({ name: "target_configure", arguments: { projectRoot, device: "TEST", probeSerial: "00123456", interface: "SWD", speed: 1000 } }));
    assert.equal(configured.ok, true);
    assert.notEqual((configured.data as { target: { generation: string } }).target.generation, firstGeneration!);
  } finally {
    await second.client.close();
  }
});

async function connectClient(cwd: string, name: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(__dirname, "standalone.js")], cwd, stderr: "pipe", env: childEnvironment(join(cwd, "queue")) });
  const client = new Client({ name, version: "1" });
  await client.connect(transport);
  return { client, transport };
}

function childEnvironment(queueRoot: string): Record<string, string> {
  const localRoot = dirname(queueRoot);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    JLINK_MCP_QUEUE_ROOT: queueRoot,
    JLINK_MCP_STORAGE_ROOT: join(localRoot, "storage"),
    JLINK_MCP_EVIDENCE_ROOT: join(localRoot, "evidence"),
  };
}

function parseEnvelope(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((item) => item.type === "text");
  assert.ok(text?.text);
  return JSON.parse(text.text) as Record<string, unknown>;
}

function testDirectory(_context: TestContext, name: string): string {
  const root = join(process.env.TEMP ?? process.cwd(), `jlink-mcp-surface-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
