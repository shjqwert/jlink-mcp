import assert from "node:assert/strict";
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
    const jcapDescriptions = ["capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_index_rebuild", "capture_export"]
      .map((name) => registry[name].description ?? "")
      .join("\n");
    assert.match(jcapDescriptions, /Indexed JCAP/);
    assert.match(jcapDescriptions, /no hardware|hardware side effects|hardware access/);
    assert.doesNotMatch(jcapDescriptions, /legacy|fallback|Direct RTT|RSP|external import/i);
    assert.deepEqual(JSON.parse((await registry.capture_list.handler({ limit: 101 })).content[0].text), {
      status: "error",
      code: "bounds_error",
      message: "capture list limit must be 1..100",
    });

    const source = await readFile(join(process.cwd(), "src", "mcp", "server.ts"), "utf8");
    assert.doesNotMatch(source, /capture_backend_|capture_import_experiment|hss_dll_/);
    assert.doesNotMatch(source, /from ["']\.\/capture["']|new CaptureService\b/);
  } finally {
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
  const instance = new JLinkMcpServer(undefined, undefined, undefined, undefined, { cwd: projectRoot, storageRoot, evidenceRoot });
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
