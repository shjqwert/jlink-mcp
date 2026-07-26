import type { z } from "zod";
import type { OperationEnvelope } from "../runtime/operation-envelope";

export const AGENT_TOOL_NAMES = [
  "list_devices", "target_configure", "target_status",
  "artifact_probe", "symbol_search", "symbol_resolve",
  "read_variable", "write_variable", "read_memory", "write_memory", "core_register_access", "peripheral_register_access",
  "target_control", "flash", "erase",
  "hss_start", "hss_status", "hss_stop", "hss_recover",
  "debug_sequence_execute",
  "capture_list", "capture_summary", "capture_series", "capture_event_window", "capture_export_csv",
  "gdb_open", "gdb_command", "gdb_wait", "gdb_backtrace", "gdb_close",
  "rtt_open", "rtt_read", "rtt_search", "rtt_clear", "rtt_close",
  "diagnose_crash", "probe_command",
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];

export const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  list_devices: "List connected J-Link probes without changing target state.",
  target_configure: "Persist one explicit Target configuration for a project root.",
  target_status: "Report persisted Target, Probe, Artifact, SVD, owner, and live state facts.",
  artifact_probe: "Discover and classify bounded Artifact, MAP, and flash-image candidates.",
  symbol_search: "Search the configured Artifact symbol catalog.",
  symbol_resolve: "Resolve one supported typed variable selector.",
  read_variable: "Read one typed variable without implicit target-state changes.",
  write_variable: "Write one typed variable with optional old-value, verification, and restore steps.",
  read_memory: "Read a bounded explicit target memory range.",
  write_memory: "Write a bounded explicit target memory range with optional verification.",
  core_register_access: "Read, list, or write bounded CPU-core registers without implicit target control.",
  peripheral_register_access: "Read or safely write bounded SVD peripheral register selectors.",
  target_control: "Explicitly halt, resume, reset, or reset-and-halt the configured target.",
  flash: "Program and verify an explicit HEX, SREC, or addressed BIN image.",
  erase: "Erase target flash with optional explicit blank verification.",
  hss_start: "Start a directly specified J-Link HSS capture.",
  hss_status: "Report an HSS capture lifecycle and quality counters.",
  hss_stop: "Stop an active HSS capture and finalize available data.",
  hss_recover: "Recover and index the trustworthy prefix of an interrupted HSS capture.",
  debug_sequence_execute: "Synchronously execute multiple HSS/read/write operations on fixed intervals over at least one second and wait until completion. Do not use for a single variable read or write.",
  capture_list: "List bounded local Capture packages and report whether each package is supported JCAP v1, legacy, or invalid.",
  capture_summary: "Return bounded provenance, lifecycle, variables, quality, and counts for a capture.",
  capture_series: "Return bounded aggregate time-series buckets for selected variables and ticks.",
  capture_event_window: "Return one event and bounded neighboring series data.",
  capture_export_csv: "Explicitly export a bounded CSV outside the JCAP package.",
  gdb_open: "Start one managed GDB Server and client using the current Artifact as symbols.",
  gdb_command: "Execute one exact raw GDB command and report unknown effects.",
  gdb_wait: "Wait for an already issued GDB run or step to stop.",
  gdb_backtrace: "Read a backtrace when the target state permits it.",
  gdb_close: "Disconnect the managed GDB client and stop its server without target control.",
  rtt_open: "Connect to an explicitly available existing RTT endpoint.",
  rtt_read: "Read bounded buffered RTT output.",
  rtt_search: "Search bounded buffered RTT output.",
  rtt_clear: "Clear only the local RTT buffer.",
  rtt_close: "Close only the managed RTT client.",
  diagnose_crash: "Collect bounded, no-hidden-side-effect Cortex-M crash evidence from an already halted target.",
  probe_command: "Execute exact raw J-Link Commander commands and report unknown effects.",
};

export type RegisterEnvelopeTool = (
  name: AgentToolName,
  inputSchema: Record<string, z.ZodType>,
  handler: (input: Record<string, unknown>, signal?: AbortSignal) => OperationEnvelope | Promise<OperationEnvelope>,
) => void;
