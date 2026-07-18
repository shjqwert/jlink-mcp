import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
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

test("standalone stdio exposes only the Agent-first MCP surface", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(__dirname, "standalone.js")],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "standalone-surface-test", version: "1" });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "jlink-mcp");
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), EXPECTED_TOOLS);
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
