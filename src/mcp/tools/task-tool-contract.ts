import type { z } from "zod";
import type { OperationEnvelope } from "../runtime/operation-envelope";

export const COMPACT_TOOL_NAMES = [
  "project", "inspect", "write", "control", "program",
  "debug", "trace", "capture", "diagnose_crash",
] as const;

export const ADVANCED_TOOL_NAMES = [...COMPACT_TOOL_NAMES, "raw"] as const;

export type CompactToolName = typeof COMPACT_TOOL_NAMES[number];
export type TaskToolName = typeof ADVANCED_TOOL_NAMES[number];

export const TASK_TOOL_DESCRIPTIONS: Record<TaskToolName, string> = {
  project: "Bind one explicit workspace; no cwd fallback. Actions/params: bind {}; devices {}; configure {device,gdbDevice?,probeSerial,interface,speed,artifactPath?,mapPath?,svdPath?,memoryRegions?}; status {}; verify {}; artifacts {explicitArtifact?,explicitMap?}.",
  inspect: "Typed reads on the bound target. Actions/params: symbol_search {query,limit?}; symbol_resolve {selector}; variable {ref}; memory {address,width,byteCount}; core {name?}; peripheral {selector|selectors}.",
  write: "Typed bounded writes with existing verification/region guards. Actions/params: variable {ref,value,...}; memory {address,width,byteCount,dataHex,...}; core {name,value,...}; peripheral {selector,value,...}.",
  control: "Explicit target action: halt, resume, reset, or reset_halt.",
  program: "Target flash actions: flash {path,baseAddress?}; erase {verifyBlank?}.",
  debug: "Managed GDB actions: open {restoreRunningStateAfterAttach?}; run_to {location,timeoutMs?,full?}; breakpoints {}; delete_breakpoint {breakpointId}; wait {timeoutMs?}; backtrace {full?}; close {}. run_to owns the full lifecycle in one call.",
  trace: "Managed trace actions: rtt_window {durationMs?,count?,level?,module?,pattern?}; rtt_open/read/search/clear/close; hss_window {variables,writeVariables?,rateHz,durationSec,qualityOracle?,actions?[write_variable|read_variable|target_control(resume|continue)]}; hss_start/status/stop/recover retain their names but automatically select hss, background_poll, then stop_poll. Window actions are one call.",
  capture: "Local JCAP actions: list {limit?,cursor?}; summary {captureId}; series {captureId,variables,timeRange?,resolution?,statistics?,cursor?}; event_window adds eventId,beforeMs,afterMs. Legacy startTick/endTick/bucketCount remains accepted but cannot be mixed with new fields. Results paginate at 128 KiB; export_csv {captureId} explicitly creates a file.",
  diagnose_crash: "Collect bounded Cortex-M crash evidence from an already halted configured target, reusing a managed GDB owner when present.",
  raw: "Advanced escape hatch: gdb {command,timeoutMs?}; probe {commands}. Unknown effects remain reported inline.",
};

export type RegisterTaskTool = (
  name: TaskToolName,
  inputSchema: Record<string, z.ZodType>,
  handler: (input: Record<string, unknown>, signal?: AbortSignal) => OperationEnvelope | Promise<OperationEnvelope>,
) => void;
