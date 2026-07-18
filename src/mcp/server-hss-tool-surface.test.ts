import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";
import { JCAP_V0_GOLDEN } from "./jcap/golden-corpus";
import { hssProjectPaths } from "./hss/project-paths";
import { JLinkMcpServer } from "./server";
import { JcapV0QueryService, writeJcapV0Raw } from "./standalone";

test("production tool surface exposes HSS only through HssCaptureService", async () => {
  const instance = new JLinkMcpServer();
  try {
    // ponytail: inspect the SDK registry to keep this catalog test hardware-free; use an in-memory transport if the SDK removes it.
    const registry = (instance as unknown as {
      server: { _registeredTools: Record<string, { description?: string; handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }> };
    }).server._registeredTools;
    const tools = Object.keys(registry);

    assert.deepEqual(tools.filter((name) => name.startsWith("capture_backend_")), []);
    assert.equal(tools.includes("capture_import_experiment"), false);
    assert.deepEqual(tools.filter((name) => name.startsWith("hss_dll_")), []);
    assert.deepEqual(tools.filter((name) => /trust|approve|promote/i.test(name)), []);
    assert.ok(tools.includes("analysis_profiles"));
    assert.ok(tools.includes("analysis_run"));
    for (const name of ["experiment_analyze", "experiment_compare", "evidence_for_codegraph"]) assert.equal(tools.includes(name), false);
    assert.deepEqual(tools.filter((name) => ["capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_index_rebuild", "capture_export"].includes(name)).sort(), [
      "capture_event_window",
      "capture_export",
      "capture_index_rebuild",
      "capture_list",
      "capture_series",
      "capture_summary",
    ]);
    for (const name of ["capture_prepare", "capture_start", "capture_status", "capture_stop", "capture_control", "capture_query", "capture_delete"]) {
      assert.equal(tools.includes(name), false, `${name} legacy CaptureService tool must not remain registered`);
    }

    for (const name of [
      "artifact_probe",
      "symbol_search",
      "symbol_resolve",
      "hot_variable_add",
      "hot_variable_list",
      "hot_variable_refresh",
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
      "read_memory",
      "read_registers",
      "read_register",
      "flash",
      "erase",
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
      "rtt_clear",
      "rtt_channel_list",
      "rtt_channel_read",
    ]) {
      assert.ok(tools.includes(name), `${name} must remain registered`);
    }
    for (const name of ["flash_plan", "erase_plan", "gdb_command_plan", "probe_command_plan", "variable_write_plan", "variable_write_execute"]) {
      assert.ok(tools.includes(name), `${name} must remain registered`);
    }
    assert.equal(tools.includes("write_memory"), false);
    for (const name of ["step", "set_breakpoint", "clear_breakpoints", "rtt_send", "rtt_channel_write", "traceagent_write_signal", "rtt_stream_capture", "rtt_stream_decode", "traceagent_decode_stream", "telnet_proxy_start", "telnet_proxy_stop", "telnet_proxy_status", "telnet_proxy_read"]) assert.equal(tools.includes(name), false, `${name} removed tool must not be registered`);
    assert.deepEqual(tools.filter((name) => /^(artifact|symbol|hot_variable)_/.test(name) && /(write|flash|execute|delete)/.test(name)), []);

    const hssDescriptions = tools
      .filter((name) => name === "hss_capability_probe" || name.startsWith("hss_capture_"))
      .map((name) => registry[name].description ?? "")
      .join("\n");
    assert.doesNotMatch(hssDescriptions, /direct RTT|RSP|external import|fallback/i);
    const jcapDescriptions = ["capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_index_rebuild", "capture_export"]
      .map((name) => registry[name].description ?? "")
      .join("\n");
    assert.match(jcapDescriptions, /Indexed JCAP/);
    assert.match(jcapDescriptions, /no hardware|hardware side effects|hardware access/);
    assert.doesNotMatch(jcapDescriptions, /legacy|fallback|Direct RTT|RSP|external import/i);
    for (const name of ["artifact_probe", "hss_capture_plan", "hss_capture_start", "capture_summary", "analysis_run"]) {
      const discovered = registry[name] as { description?: string; annotations?: Record<string, boolean>; _meta?: Record<string, unknown> };
      assert.match(discovered.description ?? "", /Preconditions:.*Hardware side effects:.*Risk:.*Approval:.*Output:.*Common next:/);
      assert.ok(discovered.annotations);
      assert.ok(discovered._meta?.["jlinkMcp/discovery"]);
    }
    assert.deepEqual(JSON.parse((await registry.capture_list.handler({ limit: 101 })).content[0].text), {
      status: "error",
      code: "bounds_error",
      message: "capture list limit must be 1..100",
    });

    const source = await readFile(join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
    assert.doesNotMatch(source, /capture_backend_|capture_import_experiment|hss_dll_/);
    assert.doesNotMatch(source, /experimentAnalyzeTool|experimentCompareTool|evidenceForCodegraphTool/);
    assert.doesNotMatch(source, /from ["']\.\/capture["']|new CaptureService\b/);
    assert.match(source, /variableRefs: z\.array\(variableRef\)/);
    assert.match(source, /artifactGeneration:[\s\S]*qualifiedName:[\s\S]*layoutHash:/);
    assert.doesNotMatch(source, /symbols: z\.array\(/);
    assert.doesNotMatch(source, /variables: z\.array\(variableSchema\)/);
    assert.match(source, /hss_capture_start[\s\S]*planId: z\.string\(\)\.uuid\(\),/);
    assert.doesNotMatch(source, /this\.server\.tool\("write_memory"/);
    assert.doesNotMatch(source, /this\.server\.tool\("(?:step|set_breakpoint|clear_breakpoints)"/);
    assert.doesNotMatch(source, /probe\.(?:step|setBreakpoint|clearBreakpoints)\(/);
    assert.doesNotMatch(source, /DirectRttMemoryIo|RspMemoryIo|writeDirectRttRing|writeByte|writeUInt32|downRing|upRing/);
    assert.doesNotMatch(source, /approvalToken/);
    assert.match(source, /gdb_load never flashes/);
  } finally {
    await instance.dispose();
  }
});

test("removed RTT writes are rejected without reaching write stubs while read-only RTT remains usable", async () => {
  const instance = new JLinkMcpServer();
  const typed = instance as unknown as {
    rttClient: { send(data: string): boolean };
    probe: { writeMemory(address: number, value: number): Promise<unknown> };
    server: {
      connect(transport: InMemoryTransport): Promise<void>;
      _registeredTools: Record<string, { handler(input: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }>;
    };
  };
  let writes = 0;
  typed.rttClient.send = () => { writes += 1; return true; };
  typed.probe.writeMemory = async () => { writes += 1; return {}; };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rtt-surface-test", version: "1" });
  try {
    await Promise.all([typed.server.connect(serverTransport), client.connect(clientTransport)]);
    for (const name of ["rtt_send", "rtt_channel_write", "traceagent_write_signal"]) {
      const rejected = await client.callTool({ name, arguments: {} });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected), /not found/i);
    }
    assert.equal(writes, 0);

    const read = JSON.parse((await typed.server._registeredTools.rtt_channel_read.handler({
      selector: "AI_TRACE",
      controlBlockAddress: "0x20000000",
      upChannels: [{ index: 1, name: "AI_TRACE", direction: "up", size: 4 }],
      ring: { bufferHex: "aabb0000", rdOff: 0, wrOff: 2 },
      maxBytes: 4,
    })).content[0].text);
    assert.deepEqual(read, { channel: 1, dataHex: "aabb", nextRdOff: 2 });
    assert.equal(writes, 0);
  } finally {
    await client.close();
    await instance.dispose();
  }
});

test("standalone exposes the same bounded JCAP query owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "jcap-standalone-"));
  const capturesDir = join(root, "captures");
  const packageDir = join(capturesDir, `${JCAP_V0_GOLDEN.provenance.captureId}.jcap`);
  try {
    writeJcapV0Raw({ packageDir, ...JCAP_V0_GOLDEN });
    const service = new JcapV0QueryService(capturesDir);
    assert.deepEqual(await service.summary({ captureId: JCAP_V0_GOLDEN.provenance.captureId }), {
      status: "rebuild_required",
      captureState: "completed",
      indexStatus: "rebuild_required",
    });
    await service.rebuild({ captureId: JCAP_V0_GOLDEN.provenance.captureId });
    const summary = await service.summary({ captureId: JCAP_V0_GOLDEN.provenance.captureId });
    assert.equal(summary.captureState, "completed");
    assert.equal(summary.indexStatus, "ready");
    assert.equal(summary.sampleCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server shares explicit external roots with HSS and Indexed JCAP", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "jcap-project-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "jcap-storage-"));
  const evidenceRoot = await mkdtemp(join(tmpdir(), "jcap-evidence-"));
  const defaults = hssProjectPaths(projectRoot);
  const instance = new JLinkMcpServer(undefined, undefined, undefined, { cwd: projectRoot, storageRoot, evidenceRoot });
  try {
    const hssPaths = (instance as unknown as { hssCapture: { paths: { storageRoot: string; evidenceRoot: string; capturesDir: string; sessionsDir: string; auditDir: string } } }).hssCapture.paths;
    const jcapCapturesDir = (instance as unknown as { jcapCapture: { capturesDir: string } }).jcapCapture.capturesDir;
    assert.equal(hssPaths.storageRoot, storageRoot);
    assert.equal(hssPaths.evidenceRoot, evidenceRoot);
    assert.equal(hssPaths.capturesDir, join(storageRoot, "captures"));
    assert.equal(hssPaths.sessionsDir, join(evidenceRoot, "sessions"));
    assert.equal(hssPaths.auditDir, join(evidenceRoot, "audit"));
    assert.equal(jcapCapturesDir, join(storageRoot, "captures"));
    for (const root of [defaults.storageRoot, defaults.evidenceRoot]) {
      const pathFromProject = relative(projectRoot, root);
      assert.equal(pathFromProject !== "" && (pathFromProject.startsWith("..") || isAbsolute(pathFromProject)), true);
    }
  } finally {
    await instance.dispose();
    await Promise.all([rm(projectRoot, { recursive: true, force: true }), rm(storageRoot, { recursive: true, force: true }), rm(evidenceRoot, { recursive: true, force: true })]);
  }
});
