import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ProbeBackend } from "../probe/backend";
import { createProbeBackend, type ProbeFactoryConfig } from "../probe/factory";
import { log } from "../utils/logger";
import { ProcessManager } from "../utils/process-manager";
import { DirectMcuService, type CoreRegisterWriteInput, type FlashInput, type MemoryReadInput, type MemoryWriteInput } from "./runtime/direct-operations";
import { createOperationEnvelope, failEnvelope, finishEnvelope, type OperationEnvelope } from "./runtime/operation-envelope";
import { ProbeQueue } from "./runtime/probe-queue";
import { SessionOperations } from "./runtime/session-operations";
import { TargetRuntimeRegistry } from "./runtime/target-runtime";
import { TargetStore, type TargetConfigureInput } from "./runtime/target-store";

export interface JLinkMcpServerOptions {
  cwd?: string;
  storageRoot?: string;
  evidenceRoot?: string;
  queueRoot?: string;
}

export const AGENT_TOOL_NAMES = [
  "list_devices", "target_configure", "target_status",
  "artifact_probe", "symbol_search", "symbol_resolve", "hot_variable_add", "hot_variable_list", "hot_variable_refresh", "read_variable", "write_variable",
  "read_core_register", "read_core_registers", "write_core_register", "read_register", "read_registers", "write_register",
  "halt", "resume", "reset", "reset_halt", "read_memory", "write_memory", "flash", "erase", "gdb_command", "probe_command",
  "hss_capability", "hss_plan", "hss_start", "hss_status", "hss_stop", "hss_recover",
  "capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_index_rebuild", "capture_export_csv",
  "snapshot", "diagnose_crash", "gdb_server_start", "gdb_server_stop", "gdb_server_status", "gdb_connect", "gdb_wait", "gdb_backtrace", "gdb_disconnect",
  "rtt_connect", "rtt_disconnect", "rtt_read", "rtt_search", "rtt_clear", "rtt_channel_list", "rtt_channel_read", "analysis_profiles", "analysis_run",
] as const;

type AgentToolName = typeof AGENT_TOOL_NAMES[number];

const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  list_devices: "List connected J-Link probes without changing target state.",
  target_configure: "Persist one explicit Target configuration for a project root.",
  target_status: "Report persisted Target, Probe, Artifact, SVD, owner, and live state facts.",
  artifact_probe: "Discover and classify bounded Artifact, MAP, and flash-image candidates.",
  symbol_search: "Search the configured Artifact symbol catalog.",
  symbol_resolve: "Resolve one supported typed variable selector.",
  hot_variable_add: "Persist a logical Hot Variable for the current Artifact generation.",
  hot_variable_list: "List project Hot Variables and stale state.",
  hot_variable_refresh: "Refresh only selected stale Hot Variables.",
  read_variable: "Read one typed variable without implicit target-state changes.",
  write_variable: "Write one typed variable with optional old-value, verification, and restore steps.",
  read_core_register: "Read one CPU-core register without implicit halt.",
  read_core_registers: "Read available CPU-core registers without implicit halt.",
  write_core_register: "Write one CPU-core register with optional verification.",
  read_register: "Read one SVD peripheral register or field.",
  read_registers: "Read a bounded list of SVD peripheral registers or fields.",
  write_register: "Write one safe SVD peripheral register or field with optional verification.",
  halt: "Explicitly halt the configured target.",
  resume: "Explicitly resume the configured target.",
  reset: "Explicitly reset the configured target and leave it running.",
  reset_halt: "Explicitly reset the configured target and leave it halted.",
  read_memory: "Read a bounded explicit target memory range.",
  write_memory: "Write a bounded explicit target memory range with optional verification.",
  flash: "Program and verify an explicit HEX, SREC, or addressed BIN image.",
  erase: "Erase target flash with optional explicit blank verification.",
  gdb_command: "Execute one exact raw GDB command and report unknown effects.",
  probe_command: "Execute exact raw J-Link Commander commands and report unknown effects.",
  hss_capability: "Report actual J-Link HSS runtime and acquisition limits.",
  hss_plan: "Validate and calculate an HSS capture without granting execution authority.",
  hss_start: "Start a directly specified J-Link HSS capture.",
  hss_status: "Report an HSS capture lifecycle and quality counters.",
  hss_stop: "Stop an active HSS capture and finalize available data.",
  hss_recover: "Recover and index the trustworthy prefix of an interrupted HSS capture.",
  capture_list: "List bounded local JCAP v1 captures.",
  capture_summary: "Return bounded provenance, lifecycle, variables, quality, and counts for a capture.",
  capture_series: "Return bounded aggregate time-series buckets for selected variables and ticks.",
  capture_event_window: "Return one event and bounded neighboring series data.",
  capture_index_rebuild: "Atomically rebuild a derived capture DB from authoritative metadata and Raw files.",
  capture_export_csv: "Explicitly export a bounded CSV outside the JCAP package.",
  snapshot: "Collect available target state without implicit halt or recovery.",
  diagnose_crash: "Collect available crash evidence without implicit halt or recovery.",
  gdb_server_start: "Explicitly start J-Link GDB Server as the Probe owner.",
  gdb_server_stop: "Explicitly stop the owned J-Link GDB Server.",
  gdb_server_status: "Report J-Link GDB Server ownership and process state.",
  gdb_connect: "Connect the GDB client to an explicitly started server.",
  gdb_wait: "Wait for an already issued GDB run or step to stop.",
  gdb_backtrace: "Read a backtrace when the target state permits it.",
  gdb_disconnect: "Disconnect the GDB client without stopping the server.",
  rtt_connect: "Connect to an existing explicit RTT endpoint.",
  rtt_disconnect: "Disconnect the RTT client.",
  rtt_read: "Read bounded buffered RTT output.",
  rtt_search: "Search bounded buffered RTT output.",
  rtt_clear: "Clear only the local RTT buffer.",
  rtt_channel_list: "List channels from a caller-provided RTT control-block snapshot.",
  rtt_channel_read: "Read one caller-provided RTT up-channel ring snapshot.",
  analysis_profiles: "List deterministic bounded capture-analysis profiles.",
  analysis_run: "Run deterministic bounded analysis against one saved capture.",
};

const projectRootInput = { projectRoot: z.string().min(1).describe("Existing absolute project root configured by target_configure") };
const uint32 = z.number().int().min(0).max(0xffff_ffff);
const accessWidth = z.union([z.literal(8), z.literal(16), z.literal(32)]);
const channel = z.object({
  index: z.number().int().min(0),
  name: z.string().optional(),
  direction: z.enum(["up", "down"]),
  size: z.number().int().positive().optional(),
});
const channelSnapshot = z.object({
  controlBlockAddress: z.string().optional(),
  upChannels: z.array(channel).max(64),
  downChannels: z.array(channel).max(64),
});

export class JLinkMcpServer {
  private readonly server: McpServer;
  private readonly discoveryProcesses = new ProcessManager();
  private readonly discoveryProbe: ProbeBackend;
  private readonly targets: TargetStore;
  private readonly queue: ProbeQueue;
  private readonly runtimes = new TargetRuntimeRegistry();
  private readonly direct: DirectMcuService;
  private readonly sessions: SessionOperations;
  private readonly implemented = new Set<AgentToolName>();

  constructor(probeConfig?: ProbeFactoryConfig, _rttPort?: number, _gdbPath?: string, options: JLinkMcpServerOptions = {}) {
    this.discoveryProbe = createProbeBackend(probeConfig ?? { type: "jlink" }, this.discoveryProcesses);
    const stateRoot = options.storageRoot ?? `${options.cwd ?? process.cwd()}${process.platform === "win32" ? "\\" : "/"}.jlink-mcp`;
    this.targets = new TargetStore(stateRoot);
    this.queue = new ProbeQueue(options.queueRoot);
    this.direct = new DirectMcuService(this.targets, this.queue, (target) => this.runtimes.get(target));
    this.sessions = new SessionOperations(this.targets, this.queue, (target) => this.runtimes.get(target));
    this.server = new McpServer({ name: "jlink-mcp", version: "0.3.2" });
    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    this.registerEnvelopeTool("list_devices", {}, async () => this.listDevices());
    this.registerEnvelopeTool("target_configure", {
      projectRoot: z.string().min(1),
      device: z.string().min(1),
      probeSerial: z.string().min(1),
      interface: z.enum(["SWD", "JTAG"]),
      speed: z.number().int().min(1).max(50_000),
      artifactPath: z.string().optional(),
      mapPath: z.string().optional(),
      svdPath: z.string().optional(),
      jlinkPath: z.string().optional(),
      gdbServerPath: z.string().optional(),
      gdbPath: z.string().optional(),
      ports: z.object({ gdb: z.number().int().min(1).max(65535).optional(), rtt: z.number().int().min(1).max(65535).optional(), swo: z.number().int().min(1).max(65535).optional() }).optional(),
      artifactFlashImages: z.array(z.object({ path: z.string().min(1), baseAddress: uint32.optional() })).max(64).optional(),
      memoryRegions: z.array(z.object({ start: uint32, length: z.number().int().positive().max(0x1_0000_0000), kind: z.enum(["ram", "flash", "rom", "peripheral", "unknown"]), writable: z.boolean() })).max(128).optional(),
    }, async (input) => {
      const result = await this.direct.configure(input as unknown as TargetConfigureInput);
      const previousGeneration = typeof result.before?.targetGeneration === "string" ? result.before.targetGeneration : undefined;
      if (result.ok && result.target && previousGeneration && await this.runtimes.invalidate(result.target.projectRoot, previousGeneration)) {
        result.observedEffects.push("process_local_target_runtime_disposed");
      }
      return result;
    });
    this.registerEnvelopeTool("target_status", projectRootInput, (input) => this.direct.status(String(input.projectRoot)));

    for (const tool of ["halt", "resume", "reset", "reset_halt"] as const) {
      this.registerEnvelopeTool(tool, projectRootInput, (input) => this.direct.control(tool, String(input.projectRoot)));
    }
    this.registerEnvelopeTool("read_memory", { ...projectRootInput, address: uint32, width: accessWidth, byteCount: z.number().int().min(1).max(4096) },
      (input) => this.direct.readMemory(input as unknown as MemoryReadInput));
    this.registerEnvelopeTool("write_memory", {
      ...projectRootInput,
      address: uint32,
      width: accessWidth,
      byteCount: z.number().int().min(1).max(4096),
      dataHex: z.string().min(2),
      captureOld: z.boolean().default(false),
      verify: z.boolean().default(false),
    }, (input) => this.direct.writeMemory(input as unknown as MemoryWriteInput));
    this.registerEnvelopeTool("read_core_register", { ...projectRootInput, name: z.string().min(1) },
      (input) => this.direct.readCoreRegister(String(input.projectRoot), String(input.name)));
    this.registerEnvelopeTool("read_core_registers", projectRootInput, (input) => this.direct.readCoreRegisters(String(input.projectRoot)));
    this.registerEnvelopeTool("write_core_register", { ...projectRootInput, name: z.string().min(1), value: uint32, verify: z.boolean().default(false) },
      (input) => this.direct.writeCoreRegister(input as unknown as CoreRegisterWriteInput));
    this.registerEnvelopeTool("flash", { ...projectRootInput, path: z.string().min(1), baseAddress: uint32.optional() },
      (input) => this.direct.flash(input as unknown as FlashInput));
    this.registerEnvelopeTool("erase", { ...projectRootInput, verifyBlank: z.boolean().default(false) },
      (input) => this.direct.erase(String(input.projectRoot), Boolean(input.verifyBlank)));
    this.registerEnvelopeTool("probe_command", { ...projectRootInput, commands: z.array(z.string().min(1)).min(1).max(100) },
      (input) => this.direct.probeCommand(String(input.projectRoot), input.commands as string[]));

    this.registerEnvelopeTool("gdb_server_start", projectRootInput, (input) => this.sessions.gdbServerStart(String(input.projectRoot)));
    this.registerEnvelopeTool("gdb_server_stop", projectRootInput, (input) => this.sessions.gdbServerStop(String(input.projectRoot)));
    this.registerEnvelopeTool("gdb_server_status", projectRootInput, (input) => this.sessions.gdbServerStatus(String(input.projectRoot)));
    this.registerEnvelopeTool("gdb_connect", { ...projectRootInput, symbolFile: z.string().optional() },
      (input) => this.sessions.gdbConnect(String(input.projectRoot), input.symbolFile as string | undefined));
    this.registerEnvelopeTool("gdb_command", { ...projectRootInput, command: z.string().min(1), timeoutMs: z.number().int().min(1).max(120_000).default(15_000) },
      (input) => this.sessions.gdbCommand(String(input.projectRoot), String(input.command), Number(input.timeoutMs)));
    this.registerEnvelopeTool("gdb_wait", { ...projectRootInput, timeoutMs: z.number().int().min(1).max(120_000).default(30_000) },
      (input) => this.sessions.gdbWait(String(input.projectRoot), Number(input.timeoutMs)));
    this.registerEnvelopeTool("gdb_backtrace", { ...projectRootInput, full: z.boolean().default(false) },
      (input) => this.sessions.gdbBacktrace(String(input.projectRoot), Boolean(input.full)));
    this.registerEnvelopeTool("gdb_disconnect", projectRootInput, (input) => this.sessions.gdbDisconnect(String(input.projectRoot)));

    this.registerEnvelopeTool("rtt_connect", projectRootInput, (input) => this.sessions.rttConnect(String(input.projectRoot)));
    this.registerEnvelopeTool("rtt_disconnect", projectRootInput, (input) => this.sessions.rttDisconnect(String(input.projectRoot)));
    this.registerEnvelopeTool("rtt_read", { ...projectRootInput, count: z.number().int().min(1).max(1000).default(50) },
      (input) => this.sessions.rttRead(String(input.projectRoot), Number(input.count)));
    this.registerEnvelopeTool("rtt_search", {
      ...projectRootInput,
      level: z.string().optional(),
      module: z.string().optional(),
      pattern: z.string().optional(),
      count: z.number().int().min(1).max(1000).default(100),
    }, (input) => this.sessions.rttSearch(String(input.projectRoot), input as { level?: string; module?: string; pattern?: string; count?: number }));
    this.registerEnvelopeTool("rtt_clear", projectRootInput, (input) => this.sessions.rttClear(String(input.projectRoot)));
    this.registerEnvelopeTool("rtt_channel_list", { ...projectRootInput, snapshot: channelSnapshot },
      (input) => this.sessions.rttChannelList(String(input.projectRoot), input.snapshot as never));
    this.registerEnvelopeTool("rtt_channel_read", {
      ...projectRootInput,
      snapshot: channelSnapshot,
      selector: z.union([z.string(), z.number().int().min(0)]),
      ring: z.object({ dataHex: z.string().min(2), rdOff: z.number().int().min(0), wrOff: z.number().int().min(0) }),
      maxBytes: z.number().int().min(1).max(4096).optional(),
    }, (input) => this.sessions.rttChannelRead(String(input.projectRoot), input as never));

    this.registerEnvelopeTool("snapshot", projectRootInput, async (input) => {
      const envelope = await this.direct.readCoreRegisters(String(input.projectRoot));
      envelope.tool = "snapshot";
      return envelope;
    });
    this.registerEnvelopeTool("diagnose_crash", projectRootInput, async (input) => {
      const envelope = await this.direct.readCoreRegisters(String(input.projectRoot));
      envelope.tool = "diagnose_crash";
      envelope.warnings.push("Fault-register expansion is deferred until typed Artifact/SVD integration; no target state was changed.");
      return envelope;
    });

    const targetPhaseStubs = [
      "artifact_probe", "symbol_search", "symbol_resolve", "hot_variable_add", "hot_variable_list", "hot_variable_refresh",
      "read_variable", "write_variable", "read_register", "read_registers", "write_register",
      "hss_capability", "hss_plan", "hss_start", "hss_status", "hss_stop", "hss_recover",
    ] as const;
    for (const name of targetPhaseStubs) this.registerStub(name, projectRootInput);
    this.registerStub("capture_list", { limit: z.number().int().min(1).max(100).default(50), cursor: z.string().optional() });
    for (const name of ["capture_summary", "capture_series", "capture_event_window", "capture_index_rebuild", "capture_export_csv"] as const) {
      this.registerStub(name, { captureId: z.string().uuid() });
    }
    this.registerStub("analysis_profiles", {});
    this.registerStub("analysis_run", { captureId: z.string().uuid(), profile: z.string().min(1) });

    for (const name of AGENT_TOOL_NAMES) {
      if (this.implemented.has(name)) continue;
      this.registerStub(name, {});
    }
  }

  private registerStub(name: AgentToolName, inputSchema: Record<string, z.ZodType>): void {
    this.registerEnvelopeTool(name, inputSchema, () => failEnvelope(createOperationEnvelope(name), {
      code: "NOT_IMPLEMENTED",
      stage: "dispatch",
      message: `${name} is registered but its ordered implementation phase is not complete`,
      retryable: false,
      writeIssued: false,
      stateUnknown: false,
    }));
  }

  private registerEnvelopeTool(
    name: AgentToolName,
    inputSchema: Record<string, z.ZodType>,
    handler: (input: Record<string, unknown>) => OperationEnvelope | Promise<OperationEnvelope>,
  ): void {
    this.implemented.add(name);
    this.server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema }, async (input) => {
      let envelope: OperationEnvelope;
      try {
        envelope = await handler(input as Record<string, unknown>);
      } catch (error) {
        envelope = failEnvelope(createOperationEnvelope(name), {
          code: "INTERNAL_ERROR",
          stage: "dispatch",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          writeIssued: false,
          stateUnknown: false,
        });
      }
      return {
        isError: !envelope.ok,
        content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
        structuredContent: envelope as unknown as Record<string, unknown>,
      };
    });
  }

  private async listDevices(): Promise<OperationEnvelope> {
    const envelope = createOperationEnvelope("list_devices");
    try {
      envelope.before = { probe: this.discoveryProbe.getStatus() };
      const result = await this.discoveryProbe.listDevices();
      envelope.after = { probe: this.discoveryProbe.getStatus() };
      envelope.data = { output: result.output, rawOutput: result.rawOutput, error: result.error };
      envelope.verification = { status: "observed", method: "J-Link ShowEmuList" };
      if (!result.success) return failEnvelope(envelope, {
        code: result.errorCode ?? "PROBE_DISCOVERY_FAILED",
        stage: "discovery",
        message: result.error || result.output || "Probe discovery failed",
        retryable: true,
        writeIssued: false,
        stateUnknown: false,
      });
      return finishEnvelope(envelope, true);
    } catch (error) {
      return failEnvelope(envelope, { code: "PROBE_DISCOVERY_FAILED", stage: "discovery", message: error instanceof Error ? error.message : String(error), retryable: true, writeIssued: false, stateUnknown: false });
    }
  }

  private registerResources(): void {
    this.server.resource("rtt-output", "rtt://output",
      { description: "Bounded local RTT output", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "rtt://output", text: this.runtimes.entries().flatMap((runtime) => runtime.rtt.getLines(200)).slice(-200).join("\n"), mimeType: "text/plain" }] }));

    this.server.resource("gdb-server-log", "probe://gdb-server-log",
      { description: "Recent J-Link GDB Server output", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "probe://gdb-server-log", text: this.runtimes.entries().flatMap((runtime) => runtime.probe.getGDBServerOutput(200)).slice(-200).join("\n"), mimeType: "text/plain" }] }));

    this.server.resource("probe-status", "probe://status",
      { description: "Current process-local Probe status", mimeType: "application/json" },
      async () => ({ contents: [{ uri: "probe://status", text: JSON.stringify({
        discoveryProbe: this.discoveryProbe.getStatus(),
        targets: this.runtimes.entries().map((runtime) => ({ generation: runtime.targetGeneration, probe: runtime.probe.getStatus(), rtt: runtime.rtt.getStats() })),
        runningDiscoveryProcesses: this.discoveryProcesses.listRunning(),
      }, null, 2), mimeType: "application/json" }] }));
  }

  async startStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
    log("MCP Server started on stdio");
  }

  async dispose(): Promise<void> {
    for (const runtime of this.runtimes.entries()) {
      if (!this.runtimes.canSafelyDispose(runtime)) {
        log(`Skipping GDB Server shutdown for ${runtime.projectRoot}: target state is not explicitly running`);
        continue;
      }
      runtime.gdbServerStopping = true;
      try {
        await runtime.gdb.disconnect();
        runtime.rtt.disconnect();
        const token = runtime.gdbOwnerToken;
        await runtime.processManager.killAndWait("jlink-gdb-server");
        if (!token || runtime.gdbOwnerToken !== token) continue;
        try { this.queue.releaseOwner(runtime.probeSerial, token); } catch { /* owner belongs to another live process or is already gone */ }
        runtime.gdbOwnerToken = undefined;
      } finally {
        runtime.gdbServerStopping = false;
      }
    }
    await this.runtimes.dispose();
    this.discoveryProbe.dispose();
    this.discoveryProcesses.killAll();
  }
}
