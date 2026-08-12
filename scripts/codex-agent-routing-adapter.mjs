import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const adapterVersion = "codex-cli-1.1.0";
const provider = "openai";
const host = "codex-cli";
const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "--mcp-shim") {
    await runMcpShim(resolve(process.argv[3] ?? ""));
  } else {
    await runAdapter();
  }
}

async function runAdapter() {
  const input = await readStdinJson();
  validatePayload(input);
  const model = process.env.JLINK_ROUTING_CODEX_MODEL || "gpt-5.6-terra";
  const root = mkdtempSync(join(tmpdir(), "jlink-mcp-codex-routing-"));
  const statePath = join(root, "state.json");
  const eventsPath = join(root, "events.jsonl");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const state = {
    evaluationId: input.evaluationId,
    modelInput: input.modelInput,
    harnessPolicy: input.harnessPolicy,
    eventsPath,
  };
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

  try {
    const codexResult = await runCodex({ model, root, cwd, statePath });
    if (process.env.JLINK_ROUTING_DEBUG === "1") {
      process.stderr.write(`CODEX_STDOUT\n${codexResult.stdout}\nCODEX_STDERR\n${codexResult.stderr}\n`);
    }
    const events = readEvents(eventsPath);
    const trace = {
      evaluationId: input.evaluationId,
      agent: {
        provider,
        model,
        host,
        adapterVersion,
        isolation: codexSandboxMode(process.env) === "danger-full-access"
          ? "process-local-not-os-isolated"
          : "codex-read-only",
      },
      events,
    };
    if (codexResult.code !== 0 && events.length === 0) {
      throw new Error(`codex exited ${codexResult.code}: ${codexResult.stderr.trim() || "no diagnostics"}`);
    }
    process.stdout.write(`${JSON.stringify(trace)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runMcpShim(statePath) {
  if (!statePath) throw new Error("MCP shim requires a state path");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const tools = Array.isArray(state.modelInput?.tools) ? state.modelInput.tools : [];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const simulationCounts = new Map();
  let callSequence = 0;
  let hssActive;
  const nextCallId = () => `call-${callSequence++}`;
  const server = new Server(
    { name: "jlink-agent-routing-eval", version: adapterVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestedName = request.params.name;
    const name = resolveToolName(requestedName, toolMap);
    const args = isRecord(request.params.arguments) ? request.params.arguments : {};
    const configuredSimulation = state.harnessPolicy?.simulatedToolResults?.[name];
    if (!name || !hasSimulatedResult(configuredSimulation)) {
      const callId = nextCallId();
      const tool = name || requestedName;
      const result = { ok: false, error: `Unknown or unsimulated evaluation tool: ${requestedName}` };
      appendEvent(state.eventsPath, { type: "tool_call", callId, tool, arguments: args });
      appendEvent(state.eventsPath, { type: "tool_result", callId, ok: false, result });
      return toolResult(result);
    }
    let simulated = nextSimulatedResult(configuredSimulation, simulationCounts, name);
    if (name === "hss_status" && typeof hssActive === "boolean") {
      simulated = { ...simulated, active: hssActive };
    }
    const callId = nextCallId();
    appendEvent(state.eventsPath, { type: "tool_call", callId, tool: name, arguments: args });
    appendEvent(state.eventsPath, { type: "tool_result", callId, ok: simulated.ok !== false, result: simulated });
    if (simulated.ok !== false && name === "hss_start" && args.dryRun !== true) hssActive = true;
    if (simulated.ok !== false && name === "hss_stop") hssActive = false;
    return toolResult(simulated);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function hasSimulatedResult(configured) {
  return isRecord(configured)
    || (Array.isArray(configured) && configured.length > 0 && configured.every(isRecord));
}

async function runCodex({ model, root, cwd, statePath }) {
  const invocation = codexInvocation();
  const sandbox = codexSandboxMode(process.env);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    sandbox,
    "-m",
    model,
    "-C",
    cwd,
    "-c",
    `mcp_servers.jlink_eval.command=${tomlString(process.execPath)}`,
    "-c",
    `mcp_servers.jlink_eval.args=${tomlArray([scriptPath, "--mcp-shim", statePath])}`,
    "-c",
    `mcp_servers.jlink_eval.trust_level=${tomlString("trusted")}`,
    "-c",
    `approval_policy=${tomlString("never")}`,
  ];
  const prompt = readStateModelGoal(statePath);
  args.push([
    prompt,
    "Use only the provided J-Link MCP tools for this request. Do not use built-in shell or filesystem tools.",
  ].join("\n\n"));
  const environment = isolatedEnvironment();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => resolvePromise({ code: code ?? -1, signal, stdout, stderr }));
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ code: -1, signal: "SIGTERM", stdout, stderr: `${stderr}\nadapter timeout` });
    }, 100_000);
    child.once("exit", () => clearTimeout(timer));
    child.stdin.end();
  });
}

function nextSimulatedResult(configured, counts, name) {
  if (!Array.isArray(configured)) return configured;
  if (configured.length === 0) return undefined;
  const index = counts.get(name) ?? 0;
  counts.set(name, index + 1);
  return configured[Math.min(index, configured.length - 1)];
}

export function codexSandboxMode(environment = process.env) {
  return environment.JLINK_ROUTING_ALLOW_DANGER_FULL_ACCESS === "1"
    ? "danger-full-access"
    : "read-only";
}

function readStateModelGoal(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"))?.modelInput?.userGoal ?? "";
}

function codexInvocation() {
  if (process.platform !== "win32") return { command: "codex", args: [] };
  const appData = process.env.APPDATA;
  const candidate = appData ? join(appData, "npm", "codex.ps1") : "";
  const script = candidate && existsSync(candidate) ? candidate : "codex.ps1";
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return {
    command: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
  };
}

function isolatedEnvironment() {
  const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^JLINK_|^SEGGER_|^PROBE_/i.test(key)));
  safe.PATH = dirname(process.execPath);
  safe.JLINK_ROUTING_ISOLATED = "1";
  return safe;
}

function readEvents(eventsPath) {
  if (!existsSync(eventsPath)) return [];
  return readFileSync(eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendEvent(eventsPath, event) {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

function resolveToolName(requestedName, toolMap) {
  if (toolMap.has(requestedName)) return requestedName;
  const prefixes = ["jlink_eval__", "jlink_eval.", "mcp__jlink_eval__"];
  return prefixes.map((prefix) => requestedName.startsWith(prefix) ? requestedName.slice(prefix.length) : "")
    .find((candidate) => candidate && toolMap.has(candidate));
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: result.ok === false ? "ERROR simulated tool result" : "OK simulated tool result" }],
    structuredContent: result,
    isError: result.ok === false,
  };
}

function tomlString(value) {
  if (typeof value !== "string") return JSON.stringify(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(",")}]`;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validatePayload(payload) {
  if (payload?.protocolVersion !== 1) throw new Error("unsupported adapter protocolVersion");
  if (typeof payload.evaluationId !== "string" || !payload.evaluationId) throw new Error("evaluationId is required");
  if (!isRecord(payload.modelInput) || typeof payload.modelInput.userGoal !== "string") throw new Error("modelInput.userGoal is required");
  if (!Array.isArray(payload.modelInput.tools)) throw new Error("modelInput.tools is required");
  if (!isRecord(payload.harnessPolicy)) throw new Error("harnessPolicy is required");
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
