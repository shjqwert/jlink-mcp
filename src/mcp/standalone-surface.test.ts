import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    for (const name of ["halt", "resume", "reset", "reset_halt", "read_memory", "write_memory", "flash", "erase", "gdb_command", "probe_command", "hss_start"] as const) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties?.projectRoot, `${name} must expose projectRoot`);
      assert.ok(schema.required?.includes("projectRoot"), `${name} must require projectRoot`);
      const removedFields = ["challenge" + "Id", "nonce", "approval" + "Token", "plan" + "Id"];
      for (const removed of removedFields) assert.equal(schema.properties?.[removed], undefined, `${name} must not expose ${removed}`);
    }
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
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    JLINK_MCP_QUEUE_ROOT: queueRoot,
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
