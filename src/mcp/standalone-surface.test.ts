import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_TOOL_NAMES, applyEvidenceLogFailure, operationHadIssuedEffects } from "./server";
import { createOperationEnvelope, failEnvelope } from "./runtime/operation-envelope";

const EXPECTED_TOOLS = [
  "list_devices", "target_configure", "target_status",
  "artifact_probe", "symbol_search", "symbol_resolve",
  "read_variable", "write_variable", "read_memory", "write_memory", "core_register_access", "peripheral_register_access",
  "target_control", "flash", "erase",
  "hss_start", "hss_status", "hss_stop", "hss_recover",
  "debug_sequence_execute",
  "capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_export_csv",
  "gdb_open", "gdb_command", "gdb_wait", "gdb_backtrace", "gdb_close",
  "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close",
  "diagnose_crash", "probe_command",
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
    assert.equal(client.getServerVersion()?.version, "1.1.5");
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), EXPECTED_TOOLS);
    const tools = (await client.listTools()).tools;
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const sequenceDescription = tools.find((tool) => tool.name === "debug_sequence_execute")?.description ?? "";
    assert.match(sequenceDescription, /multiple.*at least one second/i);
    assert.match(sequenceDescription, /wait until completion/i);
    assert.match(sequenceDescription, /not.*single variable read or write/i);
    const hssStartDescription = toolByName.get("hss_start")?.description ?? "";
    assert.match(hssStartDescription, /dryRun=true/i);
    assert.match(hssStartDescription, /same capture parameters/i);
    assert.match(hssStartDescription, /capability-only.*dryRun=true/i);
    assert.match(hssStartDescription, /capability-only.*at least one.*variable/i);
    const hssVariablesSchema = toolByName.get("hss_start")?.inputSchema.properties?.variables as { description?: unknown } | undefined;
    const hssVariablesDescription = typeof hssVariablesSchema?.description === "string" ? hssVariablesSchema.description : "";
    assert.match(hssVariablesDescription, /capability-only.*non-empty/i);
    for (const name of ["flash", "erase", "probe_command", "gdb_command"]) {
      const description = toolByName.get(name)?.description ?? "";
      assert.match(description, /explain the exact target effects/i, `${name} must explain confirmation effects`);
      assert.match(description, /explicit user confirmation/i, `${name} must require explicit user confirmation`);
    }
    for (const name of ["capture_summary", "capture_series", "capture_event_window", "capture_export_csv"]) {
      const description = toolByName.get(name)?.description ?? "";
      assert.match(description, /repair and atomically republish capture\.db/i, `${name} must disclose index repair`);
      assert.match(description, /Raw identity.*SQLite integrity/i, `${name} must disclose repair verification`);
    }
    assert.doesNotMatch(toolByName.get("capture_list")?.description ?? "", /republish capture\.db/i);
    for (const name of [
      "target_status", "artifact_probe", "symbol_search", "symbol_resolve", "read_variable", "write_variable",
      "read_memory", "write_memory", "core_register_access", "peripheral_register_access", "target_control",
      "flash", "erase", "hss_start", "hss_status", "hss_stop", "hss_recover", "debug_sequence_execute",
      "gdb_open", "gdb_command", "gdb_wait", "gdb_backtrace", "gdb_close",
      "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close", "diagnose_crash", "probe_command",
    ]) {
      assert.match(toolByName.get(name)?.description ?? "", /target_configure/i, `${name} must disclose target_configure prerequisite`);
    }
    for (const tool of tools) {
      const runId = tool.inputSchema.properties?.runId as { description?: string } | undefined;
      assert.ok(runId, `${tool.name} must accept optional runId evidence routing`);
      assert.match(runId.description ?? "", /Acceptance evidence routing identifier/i, `${tool.name}.runId must explain evidence routing`);
      assert.match(runId.description ?? "", /not a general task ID/i, `${tool.name}.runId must reject task-ID semantics`);
    }
    assert.deepEqual([...AGENT_TOOL_NAMES].sort(), EXPECTED_TOOLS, "AGENT_TOOL_NAMES must remain the canonical 37-tool list");
    for (const name of ["target_control", "read_memory", "write_memory", "core_register_access", "peripheral_register_access", "flash", "erase", "gdb_open", "gdb_command", "gdb_wait", "gdb_backtrace", "gdb_close", "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close", "diagnose_crash", "probe_command", "hss_start"] as const) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties?.projectRoot, `${name} must expose projectRoot`);
      assert.ok(schema.required?.includes("projectRoot"), `${name} must require projectRoot`);
      const removedFields = ["challenge" + "Id", "nonce", "approval" + "Token", "plan" + "Id"];
      for (const removed of removedFields) assert.equal(schema.properties?.[removed], undefined, `${name} must not expose ${removed}`);
    }
    {
      const properties = tools.find((tool) => tool.name === "gdb_open")?.inputSchema.properties as Record<string, { default?: unknown; description?: string }>;
      assert.equal(properties.restoreRunningStateAfterAttach?.default, false);
      assert.match(properties.restoreRunningStateAfterAttach?.description ?? "", /explicitly authorize.*previously running target/i);
      assert.match(properties.restoreRunningStateAfterAttach?.description ?? "", /reasonless stop cannot distinguish.*BKPT.*watchpoint.*fault/i);
      assert.match(properties.restoreRunningStateAfterAttach?.description ?? "", /independently verifying healthy running state/i);
    }
    {
      const properties = tools.find((tool) => tool.name === "target_configure")?.inputSchema.properties as Record<string, { description?: string }>;
      assert.match(properties.gdbDevice?.description ?? "", /non-invasive J-Link device\/profile/i);
      assert.match(properties.gdbDevice?.description ?? "", /Flash\/Erase/i);
    }
    {
      const properties = tools.find((tool) => tool.name === "write_variable")?.inputSchema.properties as Record<string, { default?: unknown; description?: string }>;
      assert.equal(properties.captureOld?.default, true);
      assert.equal(properties.verify?.default, true);
      assert.equal(properties.restore?.default, false);
      assert.equal(properties.verificationConnection?.default, "same_session");
      assert.match(properties.verificationConnection?.description ?? "", /independent_session.*separate runtime/i);
      assert.match(properties.comparator?.description ?? "", /post-write value is verified/i);
    }
    {
      const properties = tools.find((tool) => tool.name === "hss_start")?.inputSchema.properties as Record<string, { description?: string }>;
      assert.match(properties.writeVariables?.description ?? "", /do not consume.*sampling slots/i);
      assert.match(properties.qualityOracle?.description ?? "", /not a universal capture quality verdict/i);
      assert.match(properties.dryRun?.description ?? "", /Repeat preflight after capture parameters change/i);
    }
    {
      const properties = tools.find((tool) => tool.name === "capture_series")?.inputSchema.properties as Record<string, { description?: string }>;
      assert.match(properties.startTick?.description ?? "", /Inclusive unsigned decimal capture tick/i);
      assert.match(properties.startTick?.description ?? "", /less than or equal to endTick/i);
      assert.match(properties.endTick?.description ?? "", /greater than or equal to startTick/i);
    }
    {
      const properties = tools.find((tool) => tool.name === "write_memory")?.inputSchema.properties as Record<string, { default?: unknown }>;
      assert.equal(properties.verify?.default, true);
    }
    {
      const properties = tools.find((tool) => tool.name === "peripheral_register_access")?.inputSchema.properties as Record<string, { default?: unknown }>;
      assert.equal(properties.captureOld?.default, false);
      assert.equal(properties.verify?.default, true);
      assert.equal(properties.restore?.default, false);
    }
    for (const name of ["flash", "erase", "probe_command", "gdb_command"] as const) {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { default?: unknown }>;
      assert.ok(properties.userConfirmed, `${name} must expose explicit user confirmation`);
    }
    for (const removed of [
      "hot_variable_add", "hot_variable_list", "hot_variable_refresh", "read_core_register", "read_core_registers", "write_core_register",
      "read_register", "read_registers", "write_register", "halt", "resume", "reset", "reset_halt", "hss_capability", "hss_plan",
      "capture_index_rebuild", "snapshot", "gdb_server_start", "gdb_server_stop", "gdb_server_status", "gdb_connect", "gdb_disconnect",
      "rtt_connect", "rtt_disconnect", "rtt_channel_list", "rtt_channel_read", "analysis_profiles", "analysis_run",
    ]) {
      assert.equal(tools.some((tool) => tool.name === removed), false, `${removed} must not be public`);
    }
    for (const name of ["write_variable", "peripheral_register_access"] as const) {
      const properties = tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, { default?: unknown }>;
      assert.ok(properties);
    }
    const eventWindowVariables = tools.find((tool) => tool.name === "capture_event_window")?.inputSchema.properties?.variables as { minItems?: number; maxItems?: number };
    assert.equal(eventWindowVariables.minItems, undefined);
    assert.equal(eventWindowVariables.maxItems, 16);
    const ref = "counter";
    const publicHandlerCalls = [
      ["list_devices", {}],
      ["artifact_probe", { projectRoot: root }],
      ["symbol_search", { projectRoot: root, query: "counter" }],
      ["symbol_resolve", { projectRoot: root, selector: "counter" }],
      ["read_variable", { projectRoot: root, ref }],
      ["write_variable", { projectRoot: root, ref, value: 1 }],
      ["read_memory", { projectRoot: root, address: 0x2000_0000, width: 32, byteCount: 4 }],
      ["write_memory", { projectRoot: root, address: 0x2000_0000, width: 32, byteCount: 4, dataHex: "00000000" }],
      ["core_register_access", { projectRoot: root, action: "read", name: "PC" }],
      ["peripheral_register_access", { projectRoot: root, action: "read", selector: "GPIO.CTRL" }],
      ["target_control", { projectRoot: root, action: "halt" }],
      ["flash", { projectRoot: root, path: "missing.hex" }],
      ["erase", { projectRoot: root }],
      ["hss_start", { projectRoot: root, variables: [{ ref }], rateHz: 1, durationSec: 1, dryRun: true }],
      ["hss_status", { projectRoot: root }],
      ["hss_stop", { projectRoot: root }],
      ["hss_recover", { projectRoot: root }],
      ["capture_list", {}],
      ["capture_summary", { captureId: "43000000-0000-4000-8000-000000000001" }],
      ["capture_series", { captureId: "43000000-0000-4000-8000-000000000001", variables: ["counter"], startTick: "0", endTick: "1", bucketCount: 1 }],
      ["capture_event_window", { captureId: "43000000-0000-4000-8000-000000000001", eventId: "43000000-0000-4000-8000-000000000002", variables: [], beforeMs: 0, afterMs: 0, bucketCount: 1 }],
      ["capture_export_csv", { captureId: "43000000-0000-4000-8000-000000000001" }],
      ["gdb_open", { projectRoot: root }],
      ["gdb_command", { projectRoot: root, command: "info registers" }],
      ["gdb_wait", { projectRoot: root }],
      ["gdb_backtrace", { projectRoot: root }],
      ["gdb_close", { projectRoot: root }],
      ["rtt_open", { projectRoot: root }],
      ["rtt_read", { projectRoot: root }],
      ["rtt_search", { projectRoot: root }],
      ["rtt_clear", { projectRoot: root }],
      ["rtt_close", { projectRoot: root }],
      ["diagnose_crash", { projectRoot: root }],
      ["probe_command", { projectRoot: root, commands: ["showconf"] }],
    ] as const;
    for (const [name, argumentsValue] of publicHandlerCalls) {
      const envelope = parseEnvelope(await client.callTool({ name, arguments: argumentsValue }));
      assert.notEqual((envelope.error as { code?: string } | undefined)?.code, "NOT_IMPLEMENTED", `${name} must have a concrete handler`);
    }
    for (const [name, argumentsValue] of [
      ["flash", { projectRoot: root, path: "missing.hex" }],
      ["erase", { projectRoot: root }],
      ["probe_command", { projectRoot: root, commands: ["showconf"] }],
      ["gdb_command", { projectRoot: root, command: "info registers" }],
    ] as const) {
      const envelope = parseEnvelope(await client.callTool({ name, arguments: argumentsValue }));
      assert.equal((envelope.error as { code?: string } | undefined)?.code, "USER_CONFIRMATION_REQUIRED", `${name} must not execute without user confirmation`);
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
