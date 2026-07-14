import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { JLinkMcpServer } from "./server";

test("production tool surface exposes HSS only through HssCaptureService", async () => {
  const instance = new JLinkMcpServer();
  try {
    // ponytail: inspect the SDK registry to keep this catalog test hardware-free; use an in-memory transport if the SDK removes it.
    const registry = (instance as unknown as {
      server: { _registeredTools: Record<string, { description?: string }> };
    }).server._registeredTools;
    const tools = Object.keys(registry);

    assert.deepEqual(tools.filter((name) => name.startsWith("capture_backend_")), []);
    assert.equal(tools.includes("capture_import_experiment"), false);
    assert.deepEqual(tools.filter((name) => name.startsWith("hss_dll_")), []);
    assert.deepEqual(tools.filter((name) => /trust|approve|promote/i.test(name)), []);

    for (const name of [
      "hss_capability_probe",
      "hss_capture_plan",
      "hss_capture_start",
      "hss_capture_status",
      "hss_capture_stop",
      "hss_capture_query",
      "hss_capture_export",
      "hss_session_recover",
      "halt",
      "resume",
      "reset",
      "step",
      "read_memory",
      "write_memory",
      "read_registers",
      "read_register",
      "flash",
      "erase",
      "set_breakpoint",
      "clear_breakpoints",
      "probe_command",
      "gdb_server_start",
      "gdb_server_stop",
      "gdb_server_status",
      "gdb_connect",
      "gdb_command",
      "gdb_wait",
      "gdb_load",
      "gdb_backtrace",
      "gdb_disconnect",
      "rtt_connect",
      "rtt_disconnect",
      "rtt_read",
      "rtt_search",
      "rtt_send",
      "rtt_clear",
      "rtt_channel_list",
      "rtt_channel_read",
      "rtt_channel_write",
      "rtt_stream_capture",
      "rtt_stream_decode",
      "traceagent_decode_stream",
      "traceagent_write_signal",
    ]) {
      assert.ok(tools.includes(name), `${name} must remain registered`);
    }

    const hssDescriptions = tools
      .filter((name) => name === "hss_capability_probe" || name.startsWith("hss_capture_"))
      .map((name) => registry[name].description ?? "")
      .join("\n");
    assert.doesNotMatch(hssDescriptions, /direct RTT|RSP|external import|fallback/i);

    const source = await readFile(join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
    assert.doesNotMatch(source, /capture_backend_|capture_import_experiment|hss_dll_/);
  } finally {
    await instance.dispose();
  }
});
