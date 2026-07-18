import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DISCOVERY_TOOLS, RECOMMENDED_WORKFLOW } from "./discovery";
import { JCAP_V0_ANALYSIS } from "./jcap/golden-corpus";
import { rebuildJcapV0Index, writeJcapV0Raw } from "./jcap/jcap-v0";
import { JLinkMcpServer } from "./server";

test("real MCP client discovers one safe workflow, risk model, resource, prompt, and no legacy or approval surface", async () => {
  const root = await mkdtemp(join(tmpdir(), "jlink-discovery-"));
  const projectRoot = join(root, "project");
  const storageRoot = join(root, "storage");
  const evidenceRoot = join(root, "evidence");
  await mkdir(projectRoot);
  const instance = new JLinkMcpServer(undefined, undefined, undefined, { cwd: projectRoot, storageRoot, evidenceRoot });
  const server = (instance as unknown as { server: { connect(transport: InMemoryTransport): Promise<void> } }).server;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "discovery-conformance", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((entry) => [entry.name, entry]));
    for (const name of Object.keys(DISCOVERY_TOOLS)) {
      const entry = tools.get(name);
      assert.ok(entry, `${name} must be discoverable`);
      assert.match(entry.description ?? "", /Use:.*Preconditions:.*Hardware side effects:.*Risk:.*Approval:.*Output:.*Common next:/);
      assert.ok(entry.annotations, `${name} annotations missing`);
      assert.ok(entry._meta?.["jlinkMcp/discovery"], `${name} structured discovery metadata missing`);
    }
    for (const name of ["experiment_analyze", "experiment_compare", "evidence_for_codegraph"]) {
      assert.equal(tools.has(name), false);
      const rejected = await client.callTool({ name, arguments: {} });
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected), /not found/i);
    }
    assert.deepEqual([...tools.keys()].filter((name) => /approve|broker|secret|issue.*token/i.test(name)), []);

    const analysisSchema = tools.get("analysis_run")?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.deepEqual(Object.keys(analysisSchema.properties ?? {}).sort(), ["afterMs", "beforeMs", "captureId", "endTick", "eventId", "profile", "signalRoles", "startTick"]);
    assert.ok(analysisSchema.required?.includes("captureId"));
    assert.ok(analysisSchema.required?.includes("profile"));
    assert.ok(analysisSchema.required?.includes("signalRoles"));

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "jlink://discovery/catalog"));
    const catalogContent = (await client.readResource({ uri: "jlink://discovery/catalog" })).contents[0];
    assert.ok("text" in catalogContent);
    const catalog = JSON.parse(catalogContent.text);
    assert.deepEqual(catalog.recommendedWorkflow, RECOMMENDED_WORKFLOW);
    assert.match(catalog.riskModel.R2, /no R3 plan or user approval/);
    assert.match(catalog.riskModel.R3, /internally plans, revalidates, consumes and audits/);
    assert.match(catalog.riskModel.R4, /trusted local broker/);
    assert.match(catalog.riskModel.R5, /No execution tool exists/);
    assert.match(catalog.enforcement, /cannot guarantee.*third-party Agent/i);

    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.some((prompt) => prompt.name === "offline-jcap-analysis"));
    const prompt = await client.getPrompt({ name: "offline-jcap-analysis", arguments: {} });
    const promptText = prompt.messages.map((message) => message.content.type === "text" ? message.content.text : "").join("\n");
    assert.match(promptText, /artifact_probe.*symbol_search.*hss_capture_plan.*capture_summary.*analysis_run/s);
    assert.match(promptText, /HSS.*primary high-rate.*never replace.*raw GDB/s);
    assert.match(promptText, /R2.*no user approval.*R3.*R4.*trusted local broker.*R5/s);
    assert.match(promptText, /never invent or self-issue approval/i);

    const standaloneSource = await readFile(join(process.cwd(), "src", "mcp", "standalone.ts"), "utf8");
    assert.match(standaloneSource, /new JLinkMcpServer\(/);
    assert.doesNotMatch(standaloneSource, /registerTool|registerResource|registerPrompt/);
  } finally {
    await client.close();
    await instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("analysis surface calls the unique JCAP query owner through a real MCP client", async () => {
  const root = await mkdtemp(join(tmpdir(), "jlink-analysis-surface-"));
  const projectRoot = join(root, "project");
  const storageRoot = join(root, "storage");
  const evidenceRoot = join(root, "evidence");
  await mkdir(projectRoot);
  const packageDir = join(storageRoot, "captures", `${JCAP_V0_ANALYSIS.provenance.captureId}.jcap`);
  writeJcapV0Raw({ packageDir, ...JCAP_V0_ANALYSIS });
  await rebuildJcapV0Index(packageDir);
  const instance = new JLinkMcpServer(undefined, undefined, undefined, { cwd: projectRoot, storageRoot, evidenceRoot });
  const server = (instance as unknown as { server: { connect(transport: InMemoryTransport): Promise<void> } }).server;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "analysis-conformance", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const profiles = JSON.parse(text(await client.callTool({ name: "analysis_profiles", arguments: {} })));
    assert.deepEqual(profiles.profiles.map((profile: { name: string }) => profile.name), ["generic_control", "generic_state_machine"]);
    const result = JSON.parse(text(await client.callTool({
      name: "analysis_run",
      arguments: {
        captureId: JCAP_V0_ANALYSIS.provenance.captureId,
        profile: "generic_control",
        signalRoles: { command: "command", feedback: "feedback" },
        startTick: "0",
        endTick: "100000000",
      },
    })));
    assert.match(result.analysisRunId, /^[0-9a-f]{64}$/);
    assert.equal(result.profile.name, "generic_control");
    const bounds = JSON.parse(text(await client.callTool({
      name: "analysis_run",
      arguments: {
        captureId: JCAP_V0_ANALYSIS.provenance.captureId,
        profile: "generic_control",
        signalRoles: { command: "command", feedback: "feedback" },
        startTick: "01",
        endTick: "100000000",
      },
    })));
    assert.deepEqual(bounds, { status: "error", code: "bounds_error", message: "analysis tick window must be ordered decimal u64 startTick/endTick" });
  } finally {
    await client.close();
    await instance.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function text(result: unknown): string {
  assert.ok(result && typeof result === "object" && "content" in result && Array.isArray(result.content));
  const item = result.content.find((entry: unknown): entry is { type: "text"; text: string } => Boolean(entry && typeof entry === "object" && "type" in entry && entry.type === "text" && "text" in entry && typeof entry.text === "string"));
  assert.ok(item);
  return item.text;
}
