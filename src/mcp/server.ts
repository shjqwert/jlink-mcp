import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProbeBackend } from "../probe/backend";
import { createProbeBackend, type ProbeFactoryConfig } from "../probe/factory";
import { RTTClient } from "../rtt/rtt-client";
import { log } from "../utils/logger";
import { ProcessManager } from "../utils/process-manager";

export interface JLinkMcpServerOptions {
  cwd?: string;
  storageRoot?: string;
  evidenceRoot?: string;
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

export class JLinkMcpServer {
  private readonly server: McpServer;
  private readonly processManager = new ProcessManager();
  private readonly probe: ProbeBackend;
  private readonly rttClient: RTTClient;

  constructor(probeConfig?: ProbeFactoryConfig, rttPort?: number, _gdbPath?: string, _options: JLinkMcpServerOptions = {}) {
    this.probe = createProbeBackend(probeConfig ?? { type: "jlink" }, this.processManager);
    const effectiveRttPort = rttPort ?? this.probe.getRTTPort();
    this.rttClient = new RTTClient("localhost", effectiveRttPort > 0 ? effectiveRttPort : 19021);
    this.server = new McpServer({ name: "jlink-mcp", version: "0.3.2" });
    this.registerTools();
    this.registerResources();
  }

  private registerTools(): void {
    for (const name of AGENT_TOOL_NAMES) {
      this.server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: {} }, async () => ({
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({
          ok: false,
          tool: name,
          error: {
            code: "NOT_IMPLEMENTED",
            stage: "dispatch",
            message: `${name} is registered but its Agent-first executor is not implemented yet`,
            retryable: false,
            writeIssued: false,
            stateUnknown: false,
          },
        }) }],
      }));
    }
  }

  private registerResources(): void {
    this.server.resource("rtt-output", "rtt://output",
      { description: "Bounded local RTT output", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "rtt://output", text: this.rttClient.getLines(200).join("\n"), mimeType: "text/plain" }] }));

    this.server.resource("gdb-server-log", "probe://gdb-server-log",
      { description: "Recent J-Link GDB Server output", mimeType: "text/plain" },
      async () => ({ contents: [{ uri: "probe://gdb-server-log", text: this.probe.getGDBServerOutput(200).join("\n"), mimeType: "text/plain" }] }));

    this.server.resource("probe-status", "probe://status",
      { description: "Current process-local Probe status", mimeType: "application/json" },
      async () => ({ contents: [{ uri: "probe://status", text: JSON.stringify({
        probe: this.probe.getStatus(),
        rtt: this.rttClient.getStats(),
        runningProcesses: this.processManager.listRunning(),
      }, null, 2), mimeType: "application/json" }] }));
  }

  async startStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
    log("MCP Server started on stdio");
  }

  async dispose(): Promise<void> {
    this.rttClient.disconnect();
    this.probe.dispose();
    this.processManager.killAll();
  }
}
