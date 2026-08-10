import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const workspace = resolve(process.cwd());
const defaultCasesPath = resolve(workspace, "evals", "agent-routing", "cases.json");
const hssPreflightFields = ["projectRoot", "variables", "writeVariables", "rateHz", "durationSec", "qualityOracle"];

export function readRoutingSuite(filePath = defaultCasesPath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export async function loadLiveToolCatalog(profile = "compact") {
  const standalone = resolve(workspace, "out", "mcp", "standalone.js");
  if (!existsSync(standalone)) throw new Error("agent routing eval requires a compiled standalone runtime; run npm run compile first");
  const root = mkdtempSync(resolve(tmpdir(), "jlink-mcp-agent-routing-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [standalone],
    cwd: workspace,
    stderr: "pipe",
    env: {
      ...process.env,
      JLINK_MCP_QUEUE_ROOT: resolve(root, "queue"),
      JLINK_MCP_STORAGE_ROOT: resolve(root, "state"),
      JLINK_MCP_EVIDENCE_ROOT: resolve(root, "evidence"),
      JLINK_MCP_PROFILE: profile,
    },
  });
  const client = new Client({ name: "jlink-mcp-agent-routing-eval", version: "1" });
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map(({ name, description, inputSchema }) => ({
      name,
      description: description ?? "",
      inputSchema,
    }));
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}

export function validateRoutingSuite(suite, tools) {
  const findings = [];
  if (suite?.schemaVersion !== 1) findings.push("suite schemaVersion must be 1");
  if (!Array.isArray(suite?.cases) || suite.cases.length < 15 || suite.cases.length > 20) {
    findings.push("suite must contain 15 to 20 cases");
    return findings;
  }
  const toolNames = new Set(tools.map(({ name }) => name));
  const caseIds = new Set();
  for (const entry of suite.cases) {
    if (typeof entry.id !== "string" || !entry.id) findings.push("case id must be non-empty");
    else if (caseIds.has(entry.id)) findings.push(`duplicate case id ${entry.id}`);
    else caseIds.add(entry.id);
    if (typeof entry.userGoal !== "string" || !entry.userGoal) findings.push(`${entry.id}: userGoal must be non-empty`);
    if (!isRecord(entry.scenario)) findings.push(`${entry.id}: scenario must be an object`);
    if (!isRecord(entry.simulatedToolResults)) findings.push(`${entry.id}: simulatedToolResults must be an object`);
    const expected = entry.expected;
    if (!isRecord(expected) || !Array.isArray(expected.steps) || expected.steps.length < 1) {
      findings.push(`${entry.id}: expected.steps must be non-empty`);
      continue;
    }
    const stepIds = new Set();
    for (const step of expected.steps) {
      if (!isRecord(step) || typeof step.id !== "string" || typeof step.tool !== "string") {
        findings.push(`${entry.id}: every expected step requires id and tool`);
        continue;
      }
      if (stepIds.has(step.id)) findings.push(`${entry.id}: duplicate step id ${step.id}`);
      stepIds.add(step.id);
      if (!toolNames.has(step.tool)) findings.push(`${entry.id}: unknown expected tool ${step.tool}`);
      if (step.arguments !== undefined && !isRecord(step.arguments)) findings.push(`${entry.id}/${step.id}: arguments must be an object`);
    }
    for (const pair of expected.order ?? []) {
      if (!Array.isArray(pair) || pair.length !== 2 || !stepIds.has(pair[0]) || !stepIds.has(pair[1])) {
        findings.push(`${entry.id}: invalid expected order ${JSON.stringify(pair)}`);
      }
    }
    for (const name of expected.forbiddenTools ?? []) {
      if (!toolNames.has(name)) findings.push(`${entry.id}: unknown forbidden tool ${name}`);
    }
    for (const name of expected.allowedExtraTools ?? []) {
      if (!toolNames.has(name)) findings.push(`${entry.id}: unknown allowed extra tool ${name}`);
    }
    for (const pair of expected.preflightPairs ?? []) {
      if (
        !isRecord(pair)
        || !stepIds.has(pair.dryRunStepId)
        || !stepIds.has(pair.liveStepId)
      ) findings.push(`${entry.id}: invalid preflight pair`);
    }
  }
  return findings;
}

export function scoreRoutingTrace(caseDefinition, trace, options = {}) {
  const findings = [];
  if (trace?.caseId !== caseDefinition.id) findings.push(`trace caseId must be ${caseDefinition.id}`);
  if (!Array.isArray(trace?.events)) findings.push("trace events must be an array");
  if (options.requireAgentMetadata && !validAgentMetadata(trace?.agent)) {
    findings.push("real Agent trace requires provider, model, host, and adapterVersion metadata");
  }
  if (findings.length) return { caseId: caseDefinition.id, pass: false, findings, matchedSteps: {} };

  const events = trace.events;
  const toolCalls = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.type === "tool_call");
  const toolSchemas = new Map((options.tools ?? []).map((tool) => [tool.name, tool.inputSchema]));
  for (const { event } of toolCalls) {
    const schema = toolSchemas.get(event.tool);
    if (schema) {
      for (const finding of validateJsonSchema(event.arguments ?? {}, schema, `${event.tool}.arguments`)) findings.push(finding);
    }
    if (caseDefinition.scenario?.acceptanceRunActive !== true && Object.hasOwn(event.arguments ?? {}, "runId")) {
      findings.push(`${event.tool} must omit runId outside an active Acceptance run`);
    }
  }
  const matchedSteps = {};
  const usedCallIndexes = new Set();
  for (const step of caseDefinition.expected.steps) {
    const match = toolCalls.find(({ event, index }) =>
      !usedCallIndexes.has(index)
      && event.tool === step.tool
      && matchesPartial(event.arguments ?? {}, step.arguments ?? {}));
    if (!match) {
      findings.push(`missing expected step ${step.id} (${step.tool})`);
      continue;
    }
    usedCallIndexes.add(match.index);
    matchedSteps[step.id] = match;
  }
  const allowedExtraTools = new Set(caseDefinition.expected.allowedExtraTools ?? []);
  for (const { event, index } of toolCalls) {
    if (!usedCallIndexes.has(index) && !allowedExtraTools.has(event.tool)) {
      findings.push(`unexpected tool call: ${event.tool}`);
    }
  }

  for (const [beforeId, afterId] of caseDefinition.expected.order ?? []) {
    const before = matchedSteps[beforeId];
    const after = matchedSteps[afterId];
    if (before && after && before.index >= after.index) findings.push(`step ${beforeId} must occur before ${afterId}`);
  }

  const forbidden = new Set(caseDefinition.expected.forbiddenTools ?? []);
  for (const { event } of toolCalls) {
    if (forbidden.has(event.tool)) findings.push(`forbidden tool called: ${event.tool}`);
  }

  for (const [tool, limit] of Object.entries(caseDefinition.expected.toolCallLimits ?? {})) {
    const count = toolCalls.filter(({ event }) => event.tool === tool).length;
    if (count > limit) findings.push(`${tool} called ${count} times; maximum is ${limit}`);
  }

  for (const pair of caseDefinition.expected.preflightPairs ?? []) {
    const dryRun = matchedSteps[pair.dryRunStepId]?.event;
    const live = matchedSteps[pair.liveStepId]?.event;
    if (!dryRun || !live) continue;
    if (dryRun.tool !== "hss_start" || dryRun.arguments?.dryRun !== true) findings.push(`${pair.dryRunStepId} must be hss_start with dryRun=true`);
    if (live.tool !== "hss_start" || live.arguments?.dryRun === true) findings.push(`${pair.liveStepId} must be a live hss_start`);
    for (const key of hssPreflightFields) {
      if (!deepEqual(dryRun.arguments?.[key], live.arguments?.[key])) {
        findings.push(`HSS preflight parameter ${key} changed before live start`);
      }
    }
    if (typeof dryRun.callId !== "string" || !dryRun.callId) {
      findings.push(`${pair.dryRunStepId} requires callId for its preflight result`);
    } else {
      const dryIndex = matchedSteps[pair.dryRunStepId].index;
      const liveIndex = matchedSteps[pair.liveStepId].index;
      const result = events.find((event, index) =>
        event?.type === "tool_result"
        && event.callId === dryRun.callId
        && index > dryIndex
        && index < liveIndex);
      if (!result || result.ok !== true) findings.push(`${pair.dryRunStepId} must succeed before live HSS start`);
    }
  }

  return { caseId: caseDefinition.id, agent: trace.agent, pass: findings.length === 0, findings, matchedSteps };
}

export function adapterPayload(caseDefinition, tools, evaluationId = "eval-001") {
  return {
    protocolVersion: 1,
    evaluationId,
    modelInput: {
      userGoal: caseDefinition.userGoal,
      tools,
    },
    harnessPolicy: {
      scenario: caseDefinition.scenario,
      simulatedToolResults: caseDefinition.simulatedToolResults,
    },
  };
}

export function sanitizeTraceEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => {
    if (!isRecord(event) || typeof event.type !== "string") return [];
    const fields = {
      tool_call: ["type", "callId", "tool", "arguments"],
      tool_result: ["type", "callId", "ok", "result"],
    }[event.type];
    if (!fields) return [];
    return [Object.fromEntries(fields
      .filter((key) => Object.hasOwn(event, key))
      .map((key) => [key, sanitizeReportValue(event[key], key)]))];
  });
}

export function scoreRoutingReportResult(caseDefinition, trace, options = {}) {
  const score = scoreRoutingTrace(caseDefinition, trace, options);
  return { ...score, events: sanitizeTraceEvents(trace?.events) };
}

function sanitizeReportValue(value, key = "") {
  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey === "projectroot"
    || normalizedKey === "probeserial"
    || normalizedKey === "serialnumber"
    || normalizedKey.endsWith("path")
    || /(token|secret|password|credential|api_?key)/i.test(normalizedKey)
  ) return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => sanitizeReportValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      sanitizeReportValue(child, childKey),
    ]));
  }
  if (typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\//.test(value))) {
    return "<redacted>";
  }
  return value;
}

async function runAdapter(executable, args, payload, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { cwd: workspace, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`adapter timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 5 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) child.kill();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`adapter exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (error) {
        rejectPromise(new Error(`adapter did not return one JSON trace: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.adapter) {
    throw new Error("Usage: npm run eval:agent-routing -- --adapter <executable> [--adapter-arg <value>] [--output <report.json>]");
  }
  const suite = readRoutingSuite(options.cases);
  const tools = await loadLiveToolCatalog("legacy");
  const suiteFindings = validateRoutingSuite(suite, tools);
  if (suiteFindings.length) throw new Error(suiteFindings.join("\n"));
  const results = [];
  for (const [index, entry] of suite.cases.entries()) {
    const evaluationId = `eval-${String(index + 1).padStart(3, "0")}`;
    const trace = await runAdapter(options.adapter, options.adapterArgs, adapterPayload(entry, tools, evaluationId), options.timeoutMs);
    if (trace?.evaluationId !== evaluationId) throw new Error(`adapter returned the wrong evaluationId for ${evaluationId}`);
    results.push(scoreRoutingReportResult(
      entry,
      { ...trace, caseId: entry.id },
      { requireAgentMetadata: true, tools },
    ));
  }
  const report = {
    schemaVersion: 1,
    suite: basename(options.cases),
    toolCount: tools.length,
    caseCount: results.length,
    passed: results.filter(({ pass }) => pass).length,
    failed: results.filter(({ pass }) => !pass).length,
    results: results.map(({ matchedSteps: _matchedSteps, ...result }) => result),
  };
  const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, encoded, "utf8");
  process.stdout.write(encoded);
  if (report.failed) process.exitCode = 1;
}

function parseArguments(args) {
  const options = {
    adapter: undefined,
    adapterArgs: [],
    cases: defaultCasesPath,
    output: undefined,
    timeoutMs: 120_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const value = args[index + 1];
    if (name === "--adapter" && value) options.adapter = value;
    else if (name === "--adapter-arg" && value) options.adapterArgs.push(value);
    else if (name === "--cases" && value) options.cases = resolve(value);
    else if (name === "--output" && value) options.output = resolve(value);
    else if (name === "--timeout-ms" && value && Number.isSafeInteger(Number(value)) && Number(value) >= 1_000) options.timeoutMs = Number(value);
    else throw new Error(`unknown or incomplete argument: ${name}`);
    index += 1;
  }
  return options;
}

function matchesPartial(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => matchesPartial(actual[index], value));
  }
  if (isRecord(expected)) {
    return isRecord(actual)
      && Object.entries(expected).every(([key, value]) => matchesPartial(actual[key], value));
  }
  return Object.is(actual, expected);
}

function validateJsonSchema(value, schema, path) {
  if (!isRecord(schema)) return [];
  for (const alternativesKey of ["anyOf", "oneOf"]) {
    if (!Array.isArray(schema[alternativesKey])) continue;
    const attempts = schema[alternativesKey].map((candidate) => validateJsonSchema(value, candidate, path));
    if (attempts.some((findings) => findings.length === 0)) return [];
    return [`${path} does not match ${alternativesKey}`];
  }
  const findings = [];
  if (schema.const !== undefined && !deepEqual(value, schema.const)) findings.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(value, candidate))) findings.push(`${path} is outside enum`);
  if (schema.type === "object") {
    if (!isRecord(value)) return [`${path} must be an object`];
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) findings.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (isRecord(schema.properties) && Object.hasOwn(schema.properties, key)) {
        findings.push(...validateJsonSchema(child, schema.properties[key], `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        findings.push(`${path}.${key} is not allowed`);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) findings.push(`${path} has too few items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) findings.push(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => findings.push(...validateJsonSchema(item, schema.items, `${path}[${index}]`)));
  } else if (schema.type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) findings.push(`${path} is too short`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) findings.push(`${path} is too long`);
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern).test(value))) findings.push(`${path} does not match pattern`);
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a number`];
    if (schema.type === "integer" && !Number.isInteger(value)) findings.push(`${path} must be an integer`);
    if (typeof schema.minimum === "number" && value < schema.minimum) findings.push(`${path} is below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) findings.push(`${path} is above maximum`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) findings.push(`${path} is at or below exclusive minimum`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) findings.push(`${path} is at or above exclusive maximum`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    findings.push(`${path} must be a boolean`);
  }
  return findings;
}

function deepEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function validAgentMetadata(value) {
  return isRecord(value)
    && ["provider", "model", "host", "adapterVersion"].every((key) => typeof value[key] === "string" && value[key].length > 0);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
