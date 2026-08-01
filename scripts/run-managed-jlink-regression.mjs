import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ManagedTransportGate,
  breakpointInsertionRequiresCleanup,
  breakpointStop,
  completeManagedBreakpointCleanup,
  parseMcpToolResult,
  recoverManagedBreakpointFailure,
} from "./managed-gdb-session-guard.mjs";

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--([^=]+)=(.*)$/.exec(argument);
  if (!match) throw new Error(`invalid argument ${argument}; use --name=value`);
  return [match[1], match[2]];
}));

if (options.execute !== "true") {
  throw new Error("hardware regression is disabled; pass --execute=true explicitly");
}

for (const name of ["project-root", "probe-serial", "artifact", "map", "flash-image", "jlink-dir", "gdb-path"]) {
  if (!options[name]) throw new Error(`missing --${name}=...`);
}

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = path.resolve(options["project-root"]);
const jlinkDir = path.resolve(options["jlink-dir"]);
const runId = `managed-regression-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const evidencePath = path.resolve(options.evidence ?? path.join(repositoryRoot, "outputs", `${runId}.json`));
const breakpointName = options.breakpoint ?? "JlinkTestFixtureTask1ms";
const transcript = [];
let transportClosed = false;
let outcome;
let breakpointAttempted = false;
let breakpointInserted = false;
let gdbExplicitlyHalted = false;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(repositoryRoot, "out", "mcp", "standalone.js")],
  cwd: repositoryRoot,
  env: {
    ...process.env,
    JLINK_DEVICE: options.device ?? "Z20K146M",
    JLINK_INSTALL_DIR: jlinkDir,
    JLINK_INTERFACE: options.interface ?? "SWD",
    JLINK_SPEED: options.speed ?? "4000",
    JLINK_SERIAL: options["probe-serial"],
    JLINK_GDB_PORT: options["gdb-port"] ?? "2331",
    JLINK_RTT_PORT: options["rtt-port"] ?? "19021",
    JLINK_SWO_PORT: options["swo-port"] ?? "2332",
  },
  stderr: "pipe",
});
const client = new Client({ name: "managed-jlink-regression", version: "1.0.0" }, { capabilities: {} });

async function callTool(name, args, timeoutMs = 180_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  const result = await Promise.race([
    client.callTool({ name, arguments: { ...args, runId } }),
    timeout,
  ]).finally(() => clearTimeout(timer));
  const parsed = parseMcpToolResult(result);
  transcript.push({ name, arguments: args, response: parsed.response });
  return result;
}

const gate = new ManagedTransportGate({
  client,
  transport,
  callTool: (name, args) => callTool(name, args, args?.timeoutMs ?? 180_000),
});

function targetState(response) {
  for (const candidate of [
    response?.after?.targetExecutionState,
    response?.after?.targetState,
    response?.data?.finalState,
    response?.data?.finalTargetState,
    response?.data?.targetExecutionState,
  ]) {
    const state = String(candidate ?? "").toLowerCase();
    if (state === "running" || state === "halted") return state;
  }
  return null;
}

function requireState(call, expected) {
  const actual = targetState(call.response);
  if (actual !== expected) throw new Error(`${call.name} expected ${expected}, observed ${String(actual)}`);
}

function requireResetFallback(call) {
  requireState(call, "running");
  const commandOutput = String(call.response?.data?.command?.output ?? call.response?.data?.command?.rawOutput ?? "");
  const fallbackExercised = commandOutput.includes("reset_no_halt_resume_fallback");
  if (options["require-reset-fallback"] === "true" && !fallbackExercised) {
    throw new Error("reset reached running without exercising the ResetNoHalt halted fallback");
  }
  return fallbackExercised;
}

function statusOwner(response) {
  for (const candidate of [
    response?.data,
    response?.data?.machine,
    response?.data?.target,
    response?.data?.runtime,
    response?.data?.ownership,
  ]) {
    if (candidate && Object.prototype.hasOwnProperty.call(candidate, "owner")) return candidate.owner;
  }
  return undefined;
}

async function verifyOnlyAndReset() {
  const halt = await gate.call("target_control", { projectRoot, action: "halt" });
  requireState(halt, "halted");
  const verify = await gate.call("target_status", { projectRoot, firmwareVerification: "segger_verify_only" });
  if (verify.response?.verification?.status !== "verified") throw new Error("SEGGER Verify-only was not confirmed");
  const reset = await gate.call("target_control", { projectRoot, action: "reset" });
  const fallbackExercised = requireResetFallback(reset);
  return { halt, verify, reset, fallbackExercised };
}

try {
  await client.connect(transport);
  const devices = await gate.call("list_devices", {});
  if (!JSON.stringify(devices.response).includes(options["probe-serial"])) {
    throw new Error(`probe serial ${options["probe-serial"]} was not enumerated`);
  }

  const configure = await gate.call("target_configure", {
    projectRoot,
    device: options.device ?? "Z20K146M",
    gdbDevice: options["gdb-device"] ?? "Cortex-M4",
    interface: options.interface ?? "SWD",
    speed: Number(options.speed ?? 4000),
    probeSerial: options["probe-serial"],
    artifactPath: path.resolve(options.artifact),
    mapPath: path.resolve(options.map),
    artifactFlashImages: [{ path: path.resolve(options["flash-image"]) }],
    jlinkPath: path.join(jlinkDir, "JLink.exe"),
    gdbServerPath: path.join(jlinkDir, "JLinkGDBServerCL.exe"),
    gdbPath: path.resolve(options["gdb-path"]),
    ports: {
      gdb: Number(options["gdb-port"] ?? 2331),
      rtt: Number(options["rtt-port"] ?? 19021),
      swo: Number(options["swo-port"] ?? 2332),
    },
    memoryRegions: [
      { kind: "flash", start: 0x00000000, length: 0x00040000, writable: false },
      { kind: "ram", start: 0x20000000, length: 0x00008000, writable: true },
    ],
  });

  const resetRegression = await verifyOnlyAndReset();
  const open = await gate.call("gdb_open", { projectRoot, restoreRunningStateAfterAttach: true });
  const prevention = open.response?.data?.client?.flashBreakpointPrevention
    ?? open.response?.data?.flashBreakpointPrevention;
  if (prevention?.success !== true || prevention?.commandDispatched !== true) {
    throw new Error("GDB flash-breakpoint prevention was not confirmed");
  }
  const interrupt = await gate.call("gdb_command", {
    projectRoot,
    command: "-exec-interrupt --all",
    timeoutMs: 30_000,
    userConfirmed: true,
  });
  let interruptWait;
  if (targetState(interrupt.response) !== "halted") {
    await new Promise((resolve) => setTimeout(resolve, 100));
    interruptWait = await gate.call("gdb_wait", { projectRoot, timeoutMs: 30_000 });
    requireState(interruptWait, "halted");
  }
  gdbExplicitlyHalted = true;
  breakpointAttempted = true;
  const breakpoint = await gate.call("gdb_command", {
    projectRoot,
    command: `break ${breakpointName}`,
    timeoutMs: 30_000,
    userConfirmed: true,
  });
  breakpointInserted = true;
  gdbExplicitlyHalted = false;
  const continueToBreakpoint = await gate.call("gdb_command", {
    projectRoot,
    command: "continue",
    timeoutMs: 30_000,
    userConfirmed: true,
  });
  requireState(continueToBreakpoint, "running");
  const wait = await gate.call("gdb_wait", { projectRoot, timeoutMs: 60_000 });
  const stop = breakpointStop(wait.response);
  if (!Number.isSafeInteger(stop.breakpointId) || stop.breakpointId < 1) {
    throw new Error("breakpoint ID was not confirmed from gdb_wait");
  }
  const cleanup = await completeManagedBreakpointCleanup(gate, {
    projectRoot,
    breakpointId: stop.breakpointId,
    timeoutMs: 30_000,
    resumeBeforeClose: false,
  });
  const postGdb = await verifyOnlyAndReset();
  await gate.closeIfSafe();
  transportClosed = true;
  outcome = {
    ok: true,
    runId,
    projectRoot,
    probeSerial: options["probe-serial"],
    noFlashOrErase: true,
    transportClosedAfterCleanup: true,
    configure,
    resetRegression,
    open,
    interrupt,
    interruptWait,
    breakpoint,
    continueToBreakpoint,
    wait,
    cleanup,
    postGdb,
    transcript,
  };
} catch (error) {
  let breakpointFailureCleanup;
  let preBreakpointCleanup;
  const breakpointCleanupRequired = breakpointInsertionRequiresCleanup({
    attempted: breakpointAttempted,
    succeeded: breakpointInserted,
    error,
  });
  if (gate.gdbOpened && breakpointCleanupRequired) {
    try {
      breakpointFailureCleanup = await recoverManagedBreakpointFailure(gate, {
        projectRoot,
        originalError: error,
      });
    } catch (cleanupError) {
      breakpointFailureCleanup = { error: { message: String(cleanupError), stack: cleanupError?.stack } };
    }
  } else if (gate.gdbOpened) {
    try {
      let resume;
      if (gdbExplicitlyHalted) {
        resume = await gate.call("gdb_command", {
          projectRoot,
          command: "continue",
          timeoutMs: 30_000,
          userConfirmed: true,
        });
        requireState(resume, "running");
        gdbExplicitlyHalted = false;
      }
      const close = await gate.call("gdb_close", { projectRoot });
      gate.gdbCloseConfirmed = true;
      const status = await gate.call("target_status", { projectRoot });
      if (statusOwner(status.response) !== null) throw new Error("target owner remained non-null after pre-breakpoint close");
      gate.ownerNullConfirmed = true;
      gate.preserveLiveTransport = false;
      preBreakpointCleanup = { resume, close, status };
    } catch (cleanupError) {
      const effects = error?.call?.response?.observedEffects;
      const openFailureCleanedUp = error?.call?.name === "gdb_open"
        && Array.isArray(effects)
        && effects.includes("gdb_server_stopped")
        && effects.includes("gdb_owner_released");
      if (openFailureCleanedUp) {
        gate.gdbCloseConfirmed = true;
        gate.ownerNullConfirmed = true;
        gate.preserveLiveTransport = false;
      }
      preBreakpointCleanup = {
        openFailureCleanedUp,
        error: { message: String(cleanupError), stack: cleanupError?.stack },
      };
    }
  }
  gate.preserveLiveTransport = gate.gdbOpened
    && !(gate.gdbCloseConfirmed && gate.ownerNullConfirmed)
    || gate.preserveLiveTransport;
  outcome = {
    ok: false,
    runId,
    projectRoot,
    probeSerial: options["probe-serial"],
    noFlashOrErase: true,
    preserveLiveTransport: gate.preserveLiveTransport,
    breakpointCleanupRequired,
    breakpointFailureCleanup,
    preBreakpointCleanup,
    error: { message: String(error), stack: error?.stack },
    transcript,
  };
} finally {
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
  if (!gate.preserveLiveTransport && !transportClosed) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

process.stdout.write(`${JSON.stringify({ ...outcome, transcript: undefined, evidencePath }, null, 2)}\n`);
if (!outcome.ok) process.exitCode = 1;
