import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--([^=]+)=(.*)$/.exec(argument);
  if (!match) throw new Error(`invalid argument ${argument}; use --name=value`);
  return [match[1], match[2]];
}));

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = path.resolve(options["project-root"] ?? "");
if (!options["project-root"] || !existsSync(projectRoot)) throw new Error("missing or invalid --project-root=...");

const artifactPath = path.resolve(options.artifact ?? path.join(projectRoot, "Appl", "Debug", "Exe", "FOC_SCM.out"));
const mapPath = path.resolve(options.map ?? path.join(projectRoot, "Appl", "Debug", "List", "FOC_SCM.map"));
const flashPath = path.resolve(options["flash-image"] ?? path.join(projectRoot, "Appl", "Debug", "Exe", "FOC_SCM.S19"));
const jlinkDir = path.resolve(options["jlink-dir"] ?? "C:\\Program Files\\SEGGER\\JLink_V964");
const gdbPath = path.resolve(options["gdb-path"] ?? "C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi\\12.2 mpacbti-rel1\\bin\\arm-none-eabi-gdb.exe");
const standalonePath = path.resolve(options.standalone ?? path.join(repositoryRoot, "out", "mcp", "standalone.js"));
for (const required of [artifactPath, mapPath, flashPath, path.join(jlinkDir, "JLink.exe"), path.join(jlinkDir, "JLinkGDBServerCL.exe"), gdbPath, standalonePath]) {
  if (!existsSync(required)) throw new Error(`required hardware-test input does not exist: ${required}`);
}

const runId = `compact-hardware-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const runRoot = path.resolve(options["run-root"] ?? path.join(repositoryRoot, "outputs", runId));
const evidencePath = path.resolve(options.evidence ?? path.join(runRoot, "result.json"));
const transcript = [];
const coverage = new Set();
const expectedTools = ["project", "inspect", "write", "control", "program", "debug", "trace", "capture", "diagnose_crash"];
const targetStatusBefore = gitStatus(projectRoot);
const inputHashesBefore = await inputHashes();
let configured = false;
let clientConnected = false;
let outcome;

await fs.mkdir(runRoot, { recursive: true });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [standalonePath],
  cwd: repositoryRoot,
  stderr: "pipe",
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    JLINK_INSTALL_DIR: jlinkDir,
    JLINK_MCP_STORAGE_ROOT: path.join(runRoot, "storage"),
    JLINK_MCP_EVIDENCE_ROOT: path.join(runRoot, "evidence"),
    JLINK_MCP_QUEUE_ROOT: path.join(runRoot, "queue"),
    JLINK_MCP_PROFILE: "compact",
  },
});
const client = new Client({ name: "compact-jlink-hardware", version: "2" }, { capabilities: {} });

async function callTool(name, args, { timeoutMs = 180_000, requireOk = true } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  const raw = await Promise.race([
    client.callTool({ name, arguments: args }),
    timeout,
  ]).finally(() => clearTimeout(timer));
  const response = parseEnvelope(raw);
  coverage.add(name);
  const entry = { name, arguments: args, response };
  transcript.push(entry);
  if (response.ok !== true) {
    if (typeof response.detailsUri === "string") {
      try {
        const details = await client.readResource({ uri: response.detailsUri });
        entry.details = parseResourceJson(details);
      } catch (detailsError) {
        entry.detailsError = detailsError instanceof Error ? detailsError.message : String(detailsError);
      }
    }
  }
  if (requireOk && response.ok !== true) {
    const error = new Error(`${name} failed: ${JSON.stringify(response.error ?? response)}`);
    error.call = entry;
    throw error;
  }
  return response;
}

function parseResourceJson(resource) {
  const text = resource.contents?.find((content) => typeof content.text === "string")?.text;
  if (typeof text !== "string") return resource;
  try { return JSON.parse(text); }
  catch { return text; }
}

try {
  await client.connect(transport);
  clientConnected = true;
  const tools = (await client.listTools()).tools.map(({ name }) => name).sort();
  if (JSON.stringify(tools) !== JSON.stringify([...expectedTools].sort())) {
    throw new Error(`compact tool catalog mismatch: ${tools.join(", ")}`);
  }

  const devices = await callTool("project", { action: "devices" });
  const probeSerial = selectProbeSerial(options["probe-serial"], devices);
  await callTool("project", { action: "bind", projectRoot });
  const configure = await callTool("project", {
    action: "configure",
    projectRoot,
    params: {
      device: options.device ?? "Z20K146M",
      gdbDevice: options["gdb-device"] ?? "Cortex-M4",
      interface: options.interface ?? "SWD",
      speed: Number(options.speed ?? 1000),
      probeSerial,
      artifactPath,
      mapPath,
      artifactFlashImages: [{ path: flashPath }],
      jlinkPath: path.join(jlinkDir, "JLink.exe"),
      gdbServerPath: path.join(jlinkDir, "JLinkGDBServerCL.exe"),
      gdbPath,
      ports: {
        gdb: Number(options["gdb-port"] ?? 2331),
        rtt: Number(options["rtt-port"] ?? 19021),
        swo: Number(options["swo-port"] ?? 2332),
      },
      memoryRegions: [
        { kind: "flash", start: 0x00000000, length: 0x00040000, writable: false },
        { kind: "ram", start: 0x20000000, length: 0x00008000, writable: true },
      ],
    },
  });
  configured = true;
  await callTool("project", { action: "status" });

  const program = await callTool("program", { action: "flash", params: { path: flashPath } }, { timeoutMs: 300_000 });
  const verify = await callTool("project", { action: "verify" }, { timeoutMs: 300_000 });
  await callTool("control", { action: "reset" });

  const symbol = await callTool("inspect", {
    action: "symbol_resolve",
    params: { selector: "g_jlinkTestWriteSlots[0]" },
  });
  await callTool("inspect", { action: "variable", params: { ref: "g_jlinkTestCounter" } });
  const write = await callTool("write", {
    action: "variable",
    params: {
      ref: "g_jlinkTestWriteSlots[0]",
      value: 0x5a5aa5a5,
      captureOld: true,
      verify: true,
      restore: true,
      verificationConnection: "independent",
    },
  });

  const trace = await callTool("trace", {
    action: "hss_window",
    params: {
      variables: [{ ref: "g_jlinkTestCounter" }, { ref: "g_hssDbgCounterTask1ms" }],
      rateHz: 100,
      durationSec: 2,
      qualityOracle: { ref: "g_jlinkTestCounter", expectedIncrement: 10, tolerance: 5 },
    },
  }, { timeoutMs: 120_000 });
  const captures = await callTool("capture", { action: "list", params: { limit: 10 } });
  const captureId = newestCaptureId(captures);
  const captureSummary = await callTool("capture", { action: "summary", params: { captureId } });

  await callTool("control", { action: "reset" });
  const timeoutDebug = await callTool("debug", {
    action: "run_to",
    params: { location: "main", timeoutMs: 500, full: false },
  }, { timeoutMs: 120_000, requireOk: false });
  if (timeoutDebug.ok === true || timeoutDebug.error?.code !== "DEBUG_RUN_TO_TIMEOUT") {
    throw new Error(`debug timeout regression returned an unexpected result: ${JSON.stringify(timeoutDebug)}`);
  }
  const timeoutEntry = transcript.at(-1);
  const timeoutEnvelope = timeoutEntry?.details ?? timeoutEntry?.response;
  const timeoutSteps = timeoutEnvelope?.details?.steps;
  if (!Array.isArray(timeoutSteps)) throw new Error("debug timeout details did not include managed cleanup steps");
  const timeoutAbort = timeoutSteps.find((step) => step.tool === "gdb_managed_breakpoint_abort");
  const timeoutClose = timeoutSteps.find((step) => step.tool === "gdb_server_stop");
  const timeoutAbortFinalState = timeoutAbort?.after?.targetExecutionState
    ?? timeoutAbort?.data?.restored?.observedTargetExecutionState;
  if (timeoutAbort?.ok !== true || timeoutAbortFinalState !== "running") {
    throw new Error(`debug timeout breakpoint abort did not restore the running target: ${JSON.stringify(timeoutAbort)}`);
  }
  if (timeoutClose?.ok !== true
      || timeoutClose.data?.status?.running !== false
      || timeoutClose.data?.serverExitObservation?.clean !== true
      || timeoutClose.data?.targetExecutionStateAfterClose !== "running") {
    throw new Error(`debug timeout session close did not release the GDB owner cleanly: ${JSON.stringify(timeoutClose)}`);
  }
  const postTimeoutReset = await callTool("control", { action: "reset" });
  const debug = await callTool("debug", {
    action: "run_to",
    params: { location: options.breakpoint ?? "JlinkTestFixtureTask1ms", timeoutMs: 60_000, full: false },
  }, { timeoutMs: 120_000 });
  await callTool("control", { action: "halt" });
  const crash = await callTool("diagnose_crash", {});
  const finalReset = await callTool("control", { action: "reset" });
  const finalStatus = await callTool("project", { action: "status" });

  const missing = expectedTools.filter((name) => !coverage.has(name));
  if (missing.length) throw new Error(`compact hardware coverage is incomplete: ${missing.join(", ")}`);
  const inputHashesAfter = await inputHashes();
  const targetStatusAfter = gitStatus(projectRoot);
  if (JSON.stringify(inputHashesAfter) !== JSON.stringify(inputHashesBefore)) throw new Error("target Artifact, MAP, or Flash image changed during hardware regression");
  if (targetStatusAfter !== targetStatusBefore) throw new Error("target project worktree changed during hardware regression");

  outcome = {
    ok: true,
    runId,
    serverVersion: client.getServerVersion(),
    standalonePath,
    projectRoot,
    probeSerial,
    toolCatalog: tools,
    coverage: expectedTools.map((tool) => ({ tool, status: "passed" })),
    targetProjectUnchanged: true,
    inputHashes: inputHashesAfter,
    program: compactEvidence(program),
    verify: compactEvidence(verify),
    symbol: compactEvidence(symbol),
    write: compactEvidence(write),
    trace: compactEvidence(trace),
    capture: { captureId, summary: compactEvidence(captureSummary) },
    debugTimeoutCleanup: {
      expectedError: compactEvidence(timeoutDebug),
      breakpointAbort: compactEvidence(timeoutAbort),
      sessionClose: compactEvidence(timeoutClose),
      ownerReleaseProbe: compactEvidence(postTimeoutReset),
    },
    debug: compactEvidence(debug),
    diagnoseCrash: compactEvidence(crash),
    finalReset: compactEvidence(finalReset),
    finalStatus: compactEvidence(finalStatus),
    configure: compactEvidence(configure),
    transcript,
  };
} catch (error) {
  const cleanup = [];
  if (configured && clientConnected) {
    for (const [name, args] of [
      ["trace", { action: "hss_stop", params: {} }],
      ["debug", { action: "close", params: {} }],
      ["control", { action: "reset" }],
    ]) {
      try { cleanup.push({ name, response: await callTool(name, args, { timeoutMs: 60_000, requireOk: false }) }); }
      catch (cleanupError) { cleanup.push({ name, error: String(cleanupError) }); }
    }
  }
  outcome = {
    ok: false,
    runId,
    standalonePath,
    projectRoot,
    coverage: [...coverage],
    error: { message: String(error), stack: error?.stack, call: error?.call },
    cleanup,
    transcript,
  };
} finally {
  const serialized = `${JSON.stringify(outcome, null, 2)}\n`;
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, serialized, "utf8");
  if (clientConnected) await client.close().catch(() => undefined);
  else await transport.close().catch(() => undefined);
}

process.stdout.write(`${JSON.stringify({ ...outcome, transcript: undefined, evidencePath }, null, 2)}\n`);
if (!outcome.ok) process.exitCode = 1;

function parseEnvelope(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP tool result did not contain an operation envelope");
  return JSON.parse(text);
}

function selectProbeSerial(requested, devices) {
  const output = JSON.stringify(devices.data ?? devices);
  const discovered = [...output.matchAll(/(?:Serial\s*(?:number|No\.?|Number)?|S\/N)\s*[:=]\s*(\d{6,})/gi)].map((match) => match[1]);
  const unique = [...new Set(discovered)];
  if (requested) {
    if (!output.includes(requested)) throw new Error(`requested Probe serial ${requested} was not enumerated`);
    return requested;
  }
  if (unique.length !== 1) throw new Error(`expected one connected Probe or --probe-serial, discovered ${unique.join(", ") || "none"}`);
  return unique[0];
}

function newestCaptureId(response) {
  const candidates = response.data?.captures ?? response.data?.items ?? [];
  const captureId = candidates.find((entry) => typeof entry?.captureId === "string")?.captureId;
  if (!captureId) throw new Error(`capture list did not expose a captureId: ${JSON.stringify(response)}`);
  return captureId;
}

function compactEvidence(response) {
  return {
    ok: response.ok,
    operation: response.operation,
    verification: response.verification,
    error: response.error,
    observedEffects: response.observedEffects,
    data: response.data,
    resource: response.resource,
  };
}

async function inputHashes() {
  const result = {};
  for (const file of [artifactPath, mapPath, flashPath]) {
    result[path.basename(file)] = createHash("sha256").update(await fs.readFile(file)).digest("hex");
  }
  return result;
}

function gitStatus(root) {
  const result = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-uall"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git status failed for ${root}: ${result.stderr}`);
  return result.stdout.replaceAll("\r\n", "\n");
}
