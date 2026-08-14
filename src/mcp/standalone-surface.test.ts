import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ADVANCED_TOOL_NAMES,
  AGENT_TOOL_NAMES,
  COMPACT_TOOL_NAMES,
  applyEvidenceLogFailure,
  compactToolResult,
  operationHadIssuedEffects,
} from "./server";
import { createOperationEnvelope, failEnvelope } from "./runtime/operation-envelope";

const EXPECTED_TOOLS = [
  "mcp_init", "list_devices", "target_configure", "target_status",
  "artifact_probe", "symbol_search", "symbol_resolve",
  "read_variable", "write_variable", "read_memory", "write_memory", "core_register_access", "peripheral_register_access",
  "target_control", "flash", "erase",
  "hss_start", "hss_status", "hss_stop", "hss_recover",
  "debug_sequence_execute",
  "capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_export_csv",
  "gdb_open", "gdb_command", "gdb_breakpoint_list", "gdb_breakpoint_delete", "gdb_wait", "gdb_backtrace", "gdb_close",
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

test("compact result projection preserves safety fields under a total size budget", () => {
  const envelope = failEnvelope(createOperationEnvelope("debug"), {
    code: "DEBUG_FAILED",
    stage: "managed_debug_workflow",
    message: "m".repeat(20_000),
    retryable: false,
    writeIssued: true,
    stateUnknown: true,
  });
  envelope.data = { output: "d".repeat(20_000) };
  envelope.verification = { status: "observed", method: "v".repeat(20_000), details: "x".repeat(20_000) };
  envelope.requestedEffects = Array.from({ length: 20 }, (_, index) => `requested-${index}-${"r".repeat(1_000)}`);
  envelope.observedEffects = Array.from({ length: 20 }, (_, index) => `observed-${index}-${"o".repeat(1_000)}`);
  envelope.outputFiles = Array.from({ length: 20 }, (_, index) => `C:\\fixture-${index}-${"p".repeat(1_000)}`);
  envelope.warnings = Array.from({ length: 20 }, (_, index) => `warning-${index}-${"w".repeat(1_000)}`);

  const result = compactToolResult(envelope);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024, "whole MCP result must stay within the compact wire budget");
  const error = (result.structuredContent.error as { writeIssued?: boolean; stateUnknown?: boolean; message?: string });
  assert.equal(error.writeIssued, true);
  assert.equal(error.stateUnknown, true);
  assert.ok((error.message?.length ?? 0) <= 512);
  assert.match(String(result.structuredContent.detailsUri), /^jlink:\/\/operation\//);

  const incomplete = compactToolResult(envelope, {
    available: true,
    complete: false,
    storedBytes: 256,
    originalBytes: 80_000,
    reason: "max_bytes",
  });
  assert.deepEqual(incomplete.structuredContent.details, {
    available: true,
    complete: false,
    storedBytes: 256,
    originalBytes: 80_000,
    reason: "max_bytes",
  });
});

test("legacy result modes carry one envelope representation and preserve explicit compatibility", async (context) => {
  const root = testDirectory(context, "result-mode-contract");
  for (const mode of ["normal", "full", "text"] as const) {
    const environment = profileEnvironment(join(root, `${mode}-queue`), "legacy");
    environment.JLINK_MCP_RESULT_MODE = mode;
    const connection = await connectClientWithEnvironment(root, `${mode}-result`, environment);
    try {
      const rawResult = await connection.client.callTool({ name: "mcp_init", arguments: { projectRoot: root } });
      const result = rawResult as unknown as {
        content: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
      const text = result.content.find((item) => item.type === "text") as { type: "text"; text: string } | undefined;
      assert.ok(text?.text);
      if (mode === "text") {
        assert.equal(result.structuredContent, undefined);
        assert.equal((JSON.parse(text.text) as { ok: boolean }).ok, true);
      } else {
        assert.ok(result.structuredContent);
        assert.equal((result.structuredContent as { ok: boolean }).ok, true);
        if (mode === "normal") {
          assert.deepEqual(JSON.parse(text.text), result.structuredContent);
          assert.ok(result.structuredContent?.result);
          assert.equal(result.structuredContent?.timestamps, undefined);
        } else {
          assert.throws(() => JSON.parse(text.text));
          assert.match(text.text, /^OK mcp_init /);
          assert.ok(result.structuredContent?.timestamps);
        }
      }
    } finally {
      await connection.client.close();
    }
  }
});

test("task profiles honor explicit result modes without changing the compact default", async (context) => {
  const root = testDirectory(context, "task-result-mode-contract");
  for (const mode of ["normal", "full", "text"] as const) {
    const environment = profileEnvironment(join(root, `${mode}-queue`), "compact");
    environment.JLINK_MCP_RESULT_MODE = mode;
    const connection = await connectClientWithEnvironment(root, `compact-${mode}-result`, environment);
    try {
      const rawResult = await connection.client.callTool({ name: "inspect", arguments: { action: "core" } });
      const result = rawResult as unknown as {
        content: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
      const content = result.content.find((item) => item.type === "text") as { type: "text"; text: string } | undefined;
      assert.ok(content?.text);
      if (mode === "text") {
        assert.equal(result.structuredContent, undefined);
        assert.equal((JSON.parse(content.text) as { error: { code: string } }).error.code, "PROJECT_NOT_BOUND");
      } else {
        assert.ok(result.structuredContent);
        assert.equal((result.structuredContent?.error as { code: string }).code, "PROJECT_NOT_BOUND");
        if (mode === "normal") {
          assert.equal(result.structuredContent?.timestamps, undefined);
          assert.deepEqual(JSON.parse(content.text), result.structuredContent);
          assert.match(String(result.structuredContent?.diagnosticRef), /^jlink:\/\/operation\//);
        } else {
          assert.throws(() => JSON.parse(content.text));
        }
      }
      const boundRaw = await connection.client.callTool({ name: "project", arguments: { action: "bind", projectRoot: root } });
      const boundResult = boundRaw as unknown as {
        content: Array<{ type: string; text?: string }>;
        structuredContent?: Record<string, unknown>;
      };
      const boundText = boundResult.content.find((item) => item.type === "text") as { type: "text"; text: string } | undefined;
      const boundEnvelope = mode === "text" ? JSON.parse(boundText!.text) as Record<string, unknown> : boundResult.structuredContent!;
      assert.equal(boundEnvelope.ok, true);

      const workflows = [
        { name: "debug", arguments: { action: "run_to", params: { location: "MainTask", timeoutMs: 1_000 } }, detailKind: "task_workflow" },
        { name: "trace", arguments: { action: "rtt_window", params: { durationMs: 0, count: 1 } }, detailKind: "task_workflow" },
        { name: "trace", arguments: { action: "hss_window", params: { variables: [{ ref: "counter" }], rateHz: 10, durationSec: 1 } }, detailKind: undefined },
      ] as const;
      for (const workflow of workflows) {
        const rawWorkflow = await connection.client.callTool({ name: workflow.name, arguments: workflow.arguments });
        const wire = rawWorkflow as unknown as {
          content: Array<{ type: string; text?: string }>;
          structuredContent?: Record<string, unknown>;
        };
        const receipt = wire.content.find((item) => item.type === "text") as { type: "text"; text: string } | undefined;
        assert.ok(receipt?.text);
        const workflowEnvelope = mode === "text"
          ? JSON.parse(receipt.text) as Record<string, unknown>
          : wire.structuredContent!;
        if (mode === "text") {
          assert.equal(wire.structuredContent, undefined);
          assert.equal(workflowEnvelope.tool, workflow.name);
        } else if (mode === "normal") {
          assert.ok(wire.structuredContent);
          assert.deepEqual(JSON.parse(receipt.text), wire.structuredContent);
          assert.equal(workflowEnvelope.timestamps, undefined);
          assert.equal(workflowEnvelope.details, undefined);
        } else {
          assert.ok(wire.structuredContent);
          assert.throws(() => JSON.parse(receipt.text));
          assert.equal(workflowEnvelope.tool, workflow.name);
          if (workflow.detailKind) {
            assert.equal((workflowEnvelope.details as { kind?: string } | undefined)?.kind, workflow.detailKind);
          }
        }
      }
      const templates = (await connection.client.listResourceTemplates()).resourceTemplates;
      assert.deepEqual(templates.map(({ uriTemplate }) => uriTemplate), mode === "normal"
        ? ["jlink://operation/{operationId}"]
        : []);
    } finally {
      await connection.client.close();
    }
  }
});

test("standalone defaults to the compact catalog and preserves explicit profiles", async (context) => {
  const root = testDirectory(context, "profile-contract");
  const compact = await connectClientWithEnvironment(root, "compact-default", compactEnvironment(join(root, "compact-queue")));
  try {
    const tools = (await compact.client.listTools()).tools;
    assert.deepEqual(tools.map(({ name }) => name).sort(), [...COMPACT_TOOL_NAMES].sort());
    assert.ok(JSON.stringify(tools).length <= 10_000, "compact tools/list payload must remain within the 10k-character budget");
    for (const tool of tools) {
      assert.equal(tool.inputSchema.properties?.runId, undefined, `${tool.name} must not expose runId`);
      if (tool.name !== "project") assert.equal(tool.inputSchema.properties?.projectRoot, undefined, `${tool.name} must use the bound project root`);
    }
    const unboundResult = await compact.client.callTool({ name: "inspect", arguments: { action: "core" } });
    const unbound = parseEnvelope(unboundResult);
    assert.equal(unbound.ok, false);
    assert.equal((unbound.error as { code?: string }).code, "PROJECT_NOT_BOUND");
    const unboundWire = unboundResult as unknown as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    };
    assert.deepEqual(
      JSON.parse((unboundWire.content.find((item) => item.type === "text") as { text: string }).text),
      unboundWire.structuredContent,
    );

    const implicit = parseEnvelope(await compact.client.callTool({ name: "project", arguments: { action: "bind" } }));
    assert.equal(implicit.ok, false);
    assert.equal((implicit.error as { code?: string }).code, "PROJECT_ROOT_REQUIRED");
    assert.equal(existsSync(join(root, ".jlink-mcp")), false, "compact binding must never infer cwd");

    const smuggled = parseEnvelope(await compact.client.callTool({
      name: "project",
      arguments: { action: "bind", projectRoot: root, params: { runId: "not-acceptance" } },
    }));
    assert.equal(smuggled.ok, false);
    assert.equal((smuggled.error as { code?: string }).code, "ACTION_INPUT_INVALID");
    assert.equal(existsSync(join(root, "storage")), false, "compact params must not smuggle acceptance routing");

    const boundResult = await compact.client.callTool({ name: "project", arguments: { action: "bind", projectRoot: root } });
    const bound = parseEnvelope(boundResult);
    assert.equal(bound.ok, true, JSON.stringify(bound.error));
    assert.ok(JSON.stringify(boundResult).length <= 1_024, "simple compact success must stay within 1 KiB on the wire");
    assert.equal(existsSync(join(root, "storage")), true);
    assert.equal(bound.diagnosticRef, undefined, "successful normal results must not expose diagnostics");
    const diagnosticRef = String(unbound.diagnosticRef);
    assert.match(diagnosticRef, /^jlink:\/\/operation\/[0-9a-f-]+$/i);
    const detail = await compact.client.readResource({ uri: diagnosticRef });
    const detailText = (detail.contents[0] as { text?: string }).text;
    assert.ok(detailText);
    assert.equal((JSON.parse(detailText) as { error: { code: string } }).error.code, "PROJECT_NOT_BOUND");
    assert.deepEqual((await compact.client.listResourceTemplates()).resourceTemplates.map(({ uriTemplate }) => uriTemplate), [
      "jlink://operation/{operationId}",
    ]);

    const listed = parseEnvelope(await compact.client.callTool({ name: "capture", arguments: { action: "list" } }));
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    assert.deepEqual((listed.result as { captures: unknown[] }).captures, []);
  } finally {
    await compact.client.close();
  }

  for (const [profile, expected] of [
    ["advanced", [...ADVANCED_TOOL_NAMES]],
    ["legacy", [...AGENT_TOOL_NAMES]],
    ["acceptance", [...AGENT_TOOL_NAMES]],
  ] as const) {
    const connection = await connectClientWithEnvironment(
      root,
      `${profile}-surface`,
      profileEnvironment(join(root, `${profile}-queue`), profile),
    );
    try {
      const tools = (await connection.client.listTools()).tools;
      assert.deepEqual(tools.map(({ name }) => name).sort(), [...expected].sort());
      if (profile === "acceptance") {
        assert.ok(tools.find(({ name }) => name === "target_status")?.inputSchema.properties?.runId);
        const initialized = parseEnvelope(await connection.client.callTool({ name: "mcp_init", arguments: { projectRoot: root } }));
        assert.equal(initialized.ok, true, JSON.stringify(initialized.error));
        assert.equal(initialized.timestamps, undefined, "acceptance must not bypass the default normal result mode");
        assert.equal(initialized.diagnosticRef, undefined, "successful normal results do not expose diagnostics");
      }
    } finally {
      await connection.client.close();
    }
  }
});

test("standalone defers project directories until mcp_init and rejects nested initialization", async (context) => {
  const root = testDirectory(context, "deferred-project-init");
  const projectRoot = join(root, "project");
  const childRoot = join(projectRoot, "child");
  mkdirSync(childRoot, { recursive: true });
  const first = await connectClientWithEnvironment(
    childRoot,
    "deferred-project-init-first",
    queueOnlyEnvironment(join(root, "queue-first")),
  );
  try {
    assert.equal(existsSync(join(projectRoot, ".jlink-mcp")), false);
    assert.equal(existsSync(join(projectRoot, "test-output")), false);
    await first.client.listTools();
    assert.equal(existsSync(join(projectRoot, ".jlink-mcp")), false, "tools/list must not initialize project storage");
    assert.equal(existsSync(join(projectRoot, "test-output")), false, "tools/list must not initialize project output");

    const beforeInit = parseEnvelope(await first.client.callTool({ name: "target_status", arguments: { projectRoot } }));
    assert.equal(beforeInit.ok, false);
    assert.equal((beforeInit.error as { code?: string }).code, "PROJECT_NOT_INITIALIZED");
    assert.equal(existsSync(join(projectRoot, ".jlink-mcp")), false, "rejected project tools must not initialize storage");

    const initialized = parseEnvelope(await first.client.callTool({ name: "mcp_init", arguments: { projectRoot } }));
    assert.equal(initialized.ok, true, JSON.stringify(initialized.error));
    assert.equal(existsSync(join(projectRoot, ".jlink-mcp")), true);
    assert.equal(existsSync(join(projectRoot, "test-output")), false, "mcp_init must leave test-output lazy");
    assert.equal(existsSync(join(childRoot, ".jlink-mcp")), false);
    const repeated = parseEnvelope(await first.client.callTool({ name: "mcp_init", arguments: { projectRoot } }));
    assert.equal(repeated.ok, true, JSON.stringify(repeated.error));
    assert.equal((repeated.data as { stateRootCreated: boolean }).stateRootCreated, false);

    const otherRoot = join(root, "other-project");
    mkdirSync(otherRoot);
    const switched = parseEnvelope(await first.client.callTool({ name: "mcp_init", arguments: { projectRoot: otherRoot } }));
    assert.equal(switched.ok, false);
    assert.equal((switched.error as { code?: string }).code, "MCP_ALREADY_INITIALIZED");
    assert.equal(existsSync(join(otherRoot, ".jlink-mcp")), false);
    const mismatchedTool = parseEnvelope(await first.client.callTool({ name: "target_status", arguments: { projectRoot: otherRoot } }));
    assert.equal(mismatchedTool.ok, false);
    assert.equal((mismatchedTool.error as { code?: string }).code, "PROJECT_ROOT_MISMATCH");

    const listed = parseEnvelope(await first.client.callTool({ name: "capture_list", arguments: {} }));
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    assert.deepEqual((listed.data as { captures: unknown[] }).captures, []);
    assert.equal(existsSync(join(projectRoot, "test-output")), false, "read-only capture listing must not create test-output");
  } finally {
    await first.client.close();
  }

  const second = await connectClientWithEnvironment(
    childRoot,
    "deferred-project-init-second",
    queueOnlyEnvironment(join(root, "queue-second")),
  );
  try {
    const nested = parseEnvelope(await second.client.callTool({ name: "mcp_init", arguments: { projectRoot: childRoot } }));
    assert.equal(nested.ok, false);
    assert.equal((nested.error as { code?: string }).code, "PROJECT_NESTED_UNDER_INITIALIZED_ROOT");
    assert.equal(existsSync(join(childRoot, ".jlink-mcp")), false);
    assert.equal(existsSync(join(childRoot, "test-output")), false);
  } finally {
    await second.client.close();
  }
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
    assert.equal(client.getServerVersion()?.version, "2.2.0");
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name).sort(), EXPECTED_TOOLS);
    const tools = (await client.listTools()).tools;
    const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
    const initialized = parseEnvelope(await client.callTool({ name: "mcp_init", arguments: { projectRoot: root } }));
    assert.equal(initialized.ok, true, JSON.stringify(initialized.error));
    const sequenceDescription = tools.find((tool) => tool.name === "debug_sequence_execute")?.description ?? "";
    assert.match(sequenceDescription, /multiple.*at least one second/i);
    assert.match(sequenceDescription, /wait until completion/i);
    assert.match(sequenceDescription, /not.*single variable read or write/i);
    const hssStartDescription = toolByName.get("hss_start")?.description ?? "";
    assert.match(hssStartDescription, /dryRun=true/i);
    assert.match(hssStartDescription, /real variable set.*rate.*duration/i);
    assert.match(hssStartDescription, /background polling.*stop polling/i);
    assert.match(hssStartDescription, /without a device\/core allowlist/i);
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
      "gdb_open", "gdb_command", "gdb_breakpoint_list", "gdb_breakpoint_delete", "gdb_wait", "gdb_backtrace", "gdb_close",
      "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close", "diagnose_crash", "probe_command",
    ]) {
      assert.match(toolByName.get(name)?.description ?? "", /target_configure/i, `${name} must disclose target_configure prerequisite`);
    }
    for (const tool of tools) {
      if (tool.name === "mcp_init") continue;
      const runId = tool.inputSchema.properties?.runId as { description?: string } | undefined;
      assert.ok(runId, `${tool.name} must accept optional runId evidence routing`);
      assert.match(runId.description ?? "", /Acceptance evidence routing identifier/i, `${tool.name}.runId must explain evidence routing`);
      assert.match(runId.description ?? "", /not a general task ID/i, `${tool.name}.runId must reject task-ID semantics`);
    }
    assert.deepEqual([...AGENT_TOOL_NAMES].sort(), EXPECTED_TOOLS, "AGENT_TOOL_NAMES must remain the canonical 40-tool list");
    for (const name of ["target_control", "read_memory", "write_memory", "core_register_access", "peripheral_register_access", "flash", "erase", "gdb_open", "gdb_command", "gdb_breakpoint_list", "gdb_breakpoint_delete", "gdb_wait", "gdb_backtrace", "gdb_close", "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close", "diagnose_crash", "probe_command", "hss_start"] as const) {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties?.projectRoot, `${name} must expose projectRoot`);
      assert.ok(schema.required?.includes("projectRoot"), `${name} must require projectRoot`);
      const removedFields = ["challenge" + "Id", "nonce", "approval" + "Token", "plan" + "Id"];
      for (const removed of removedFields) assert.equal(schema.properties?.[removed], undefined, `${name} must not expose ${removed}`);
    }
    {
      const properties = tools.find((tool) => tool.name === "target_status")?.inputSchema.properties as Record<string, { default?: unknown; description?: string }>;
      assert.equal(properties.firmwareVerification?.default, "none");
      assert.match(properties.firmwareVerification?.description ?? "", /segger_verify_only.*without downloading, erasing, programming/i);
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
      assert.match(properties.gdbDevice?.description ?? "", /core-register snapshots/i);
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
      const properties = tools.find((tool) => tool.name === "core_register_access")?.inputSchema.properties as Record<string, { default?: unknown; description?: string }>;
      assert.equal(properties.verificationConnection?.default, "same_session");
      assert.match(properties.verificationConnection?.description ?? "", /independent_session.*cross-connection GPR persistence/i);
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
      assert.equal(properties.userConfirmed, undefined, `${name} must not expose a duplicate authorization token`);
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
      ["gdb_breakpoint_list", { projectRoot: root }],
      ["gdb_breakpoint_delete", { projectRoot: root, breakpointId: 1 }],
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
      assert.equal(envelope.ok, false, `${name} must fail without a configured target`);
      assert.equal((envelope.error as { code?: string } | undefined)?.code, "TARGET_NOT_CONFIGURED", `${name} must enter its ordinary prerequisite checks without an authorization-token gate`);
    }
    assert.equal(existsSync(join(root, "evidence")), false, "operations without runId must not create the lazy evidence root");
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
    const initialized = parseEnvelope(await first.client.callTool({ name: "mcp_init", arguments: { projectRoot } }));
    assert.equal(initialized.ok, true, JSON.stringify(initialized.error));
    const configured = await first.client.callTool({ name: "target_configure", arguments: { projectRoot, device: "TEST", probeSerial: "123456", interface: "SWD", speed: 1000 } });
    const envelope = parseEnvelope(configured);
    assert.equal(envelope.ok, true);
    firstGeneration = ((envelope.data as { target: { generation: string } }).target.generation);
  } finally {
    await first.client.close();
  }

  const second = await connectClient(root, "target-persistence-second");
  try {
    const initialized = parseEnvelope(await second.client.callTool({ name: "mcp_init", arguments: { projectRoot } }));
    assert.equal(initialized.ok, true, JSON.stringify(initialized.error));
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
  return connectClientWithEnvironment(cwd, name, childEnvironment(join(cwd, "queue")));
}

async function connectClientWithEnvironment(cwd: string, name: string, env: Record<string, string>): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(__dirname, "standalone.js")], cwd, stderr: "pipe", env });
  const client = new Client({ name, version: "1" });
  await client.connect(transport);
  return { client, transport };
}

function queueOnlyEnvironment(queueRoot: string): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    JLINK_MCP_QUEUE_ROOT: queueRoot,
    JLINK_MCP_PROFILE: "legacy",
    JLINK_MCP_RESULT_MODE: "full",
  };
}

function childEnvironment(queueRoot: string): Record<string, string> {
  const localRoot = dirname(queueRoot);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    JLINK_INSTALL_DIR: join(localRoot, "missing-jlink-install"),
    JLINK_MCP_QUEUE_ROOT: queueRoot,
    JLINK_MCP_STORAGE_ROOT: join(localRoot, "storage"),
    JLINK_MCP_EVIDENCE_ROOT: join(localRoot, "evidence"),
    JLINK_MCP_PROFILE: "legacy",
    JLINK_MCP_RESULT_MODE: "full",
  };
}

function compactEnvironment(queueRoot: string): Record<string, string> {
  const result = childEnvironment(queueRoot);
  delete result.JLINK_MCP_PROFILE;
  delete result.JLINK_MCP_RESULT_MODE;
  return result;
}

function profileEnvironment(queueRoot: string, profile: "compact" | "advanced" | "legacy" | "acceptance"): Record<string, string> {
  const result: Record<string, string> = { ...childEnvironment(queueRoot), JLINK_MCP_PROFILE: profile };
  delete result.JLINK_MCP_RESULT_MODE;
  return result;
}

function parseEnvelope(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((item) => item.type === "text");
  assert.ok(text?.text);
  return JSON.parse(text.text) as Record<string, unknown>;
}

function testDirectory(_context: TestContext, name: string): string {
  const systemTemp = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "Temp")
    : process.env.TEMP ?? process.cwd();
  const root = join(systemTemp, `jlink-mcp-surface-${name}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
