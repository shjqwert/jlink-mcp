import type { z } from "zod";
import type { OperationEnvelope } from "../runtime/operation-envelope";

export const AGENT_TOOL_NAMES = [
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
] as const;

export type AgentToolName = typeof AGENT_TOOL_NAMES[number];

const configuredTarget = (description: string): string =>
  description + " Requires mcp_init and a current target_configure for this projectRoot before use.";
const repairingCaptureQuery = (description: string): string =>
  description + " Requires mcp_init for the engineering project that owns the capture. If the terminal JCAP v1 index is missing or invalid, this query may repair and atomically republish capture.db after Raw identity and SQLite integrity verification.";

export const TOOL_DESCRIPTIONS: Record<AgentToolName, string> = {
  mcp_init: "Initialize exactly one explicit canonical engineering project root for this MCP process and create its .jlink-mcp state directory. This does not create test-output or access J-Link hardware.",
  list_devices: "List connected J-Link probes without changing target state.",
  target_configure: "Persist one explicit Target configuration for the project root selected by mcp_init. Call mcp_init first, then repeat target_configure when the intended target configuration changes.",
  target_status: configuredTarget("Report persisted Target, Probe, Artifact, SVD, owner, and separated state layers without attaching to observe target execution. Optionally request SEGGER Verify-only for configured flash images."),
  artifact_probe: configuredTarget("Discover and classify bounded Artifact, MAP, and flash-image candidates."),
  symbol_search: configuredTarget("Search the configured Artifact symbol catalog."),
  symbol_resolve: configuredTarget("Resolve one supported typed variable selector."),
  read_variable: configuredTarget("Read one typed variable without implicit target-state changes."),
  write_variable: configuredTarget("Write one typed variable with optional old-value, verification, and restore steps."),
  read_memory: configuredTarget("Read a bounded explicit target memory range."),
  write_memory: configuredTarget("Write a bounded explicit target memory range with optional verification."),
  core_register_access: configuredTarget("Read, list, or write bounded CPU-core registers without implicit target control."),
  peripheral_register_access: configuredTarget("Read or safely write bounded SVD peripheral register selectors."),
  target_control: configuredTarget("Explicitly halt, resume, reset, or reset-and-halt the configured target."),
  flash: configuredTarget("Program and verify an explicit HEX, SREC, or addressed BIN image."),
  erase: configuredTarget("Erase target flash with optional explicit blank verification."),
  hss_start: configuredTarget("Validate or start a directly specified J-Link HSS capture. For a new or changed target, Artifact, variable set, writeVariables allowlist, rate, duration, or qualityOracle, first call hss_start with the same capture parameters and dryRun=true; start live capture only after that preflight succeeds. A capability-only request must remain dryRun=true and still provide at least one real variable plus valid rate and duration; never send an empty variables array."),
  hss_status: configuredTarget("Report an HSS capture lifecycle and quality counters."),
  hss_stop: configuredTarget("Stop an active HSS capture and finalize available data."),
  hss_recover: configuredTarget("Recover and index the trustworthy prefix of an interrupted HSS capture."),
  debug_sequence_execute: configuredTarget("Synchronously execute multiple HSS/read/write operations on fixed intervals over at least one second and wait until completion. Do not use for a single variable read or write."),
  capture_list: "List bounded local Capture packages for the engineering project selected by mcp_init and report whether each package is supported JCAP v1, legacy, or invalid.",
  capture_summary: repairingCaptureQuery("Return bounded provenance, lifecycle, variables, quality, and counts for a capture."),
  capture_series: repairingCaptureQuery("Return bounded aggregate time-series buckets for selected variables and ticks."),
  capture_event_window: repairingCaptureQuery("Return one event and bounded neighboring series data."),
  capture_export_csv: repairingCaptureQuery("Explicitly export a bounded CSV outside the JCAP package."),
  gdb_open: configuredTarget("Start one managed GDB Server and client using the current Artifact as symbols."),
  gdb_command: configuredTarget("Execute one exact raw GDB command and report unknown effects."),
  gdb_breakpoint_list: configuredTarget("Read the managed GDB breakpoint table through one fixed read-only command while preserving only consistently known target execution state."),
  gdb_breakpoint_delete: configuredTarget("Delete one numbered managed GDB breakpoint only while the target is known halted; preserve execution-state evidence and invalidate memory mutation trust."),
  gdb_wait: configuredTarget("Wait for an already issued GDB run or step to stop."),
  gdb_backtrace: configuredTarget("Read a backtrace when the target state permits it."),
  gdb_close: configuredTarget("Disconnect the managed GDB client and stop its server without target control."),
  rtt_open: configuredTarget("Connect to an explicitly available existing RTT endpoint."),
  rtt_read: configuredTarget("Read bounded buffered RTT output."),
  rtt_search: configuredTarget("Search bounded buffered RTT output."),
  rtt_clear: configuredTarget("Clear only the local RTT buffer."),
  rtt_close: configuredTarget("Close only the managed RTT client."),
  diagnose_crash: configuredTarget("Collect bounded, no-hidden-side-effect Cortex-M crash evidence from an already halted target."),
  probe_command: configuredTarget("Execute exact raw J-Link Commander commands and report unknown effects."),
};

export type RegisterEnvelopeTool = (
  name: AgentToolName,
  inputSchema: Record<string, z.ZodType>,
  handler: (input: Record<string, unknown>, signal?: AbortSignal) => OperationEnvelope | Promise<OperationEnvelope>,
) => void;
