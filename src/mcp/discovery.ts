export interface DiscoveryTool {
  category: "artifact" | "capture" | "query" | "analysis" | "state-change";
  purpose: string;
  preconditions: string[];
  hardwareSideEffects: string;
  riskLevel: "R1" | "R1/R3" | "R2/R4" | "R3" | "R4";
  requiresUserApproval: boolean | "conditional";
  output: string;
  next: string[];
}

const tool = (category: DiscoveryTool["category"], purpose: string, preconditions: string[], hardwareSideEffects: string, riskLevel: DiscoveryTool["riskLevel"], requiresUserApproval: DiscoveryTool["requiresUserApproval"], output: string, next: string[]): DiscoveryTool => ({
  category, purpose, preconditions, hardwareSideEffects, riskLevel, requiresUserApproval, output, next,
});

export const RECOMMENDED_WORKFLOW = [
  "artifact_probe",
  "symbol_search",
  "symbol_resolve",
  "hot_variable_add",
  "hss_capture_plan",
  "hss_capture_start",
  "hss_capture_status",
  "hss_capture_stop",
  "capture_list",
  "capture_summary",
  "capture_series",
  "capture_event_window",
  "analysis_run",
] as const;

export const ANALYSIS_PROFILES = {
  profiles: [
    { name: "generic_control", version: 0, roles: ["command", "feedback"], status: "experimental" },
    { name: "generic_state_machine", version: 0, roles: ["state"], status: "experimental" },
  ],
} as const;

const noHardware = "no hardware access; deterministic local validation or Indexed JCAP access only";

export const DISCOVERY_TOOLS: Record<string, DiscoveryTool> = {
  artifact_probe: tool("artifact", "Select one bounded content-probed Artifact generation.", ["project or explicit artifact path"], noHardware, "R1", false, "Artifact generation and candidates", ["symbol_search"]),
  symbol_search: tool("artifact", "Search the current Symbol Catalog.", ["current artifactGeneration"], noHardware, "R1", false, "bounded stable Symbol refs", ["symbol_resolve"]),
  symbol_resolve: tool("artifact", "Resolve one qualified scalar identity and layout.", ["current artifactGeneration", "unambiguous qualified selector"], noHardware, "R1", false, "qualified identity, layout hash and eligibility", ["hot_variable_add"]),
  hot_variable_add: tool("artifact", "Cache one current Symbol ref for this process.", ["server-issued current Symbol ref"], noHardware, "R1", false, "Hot Variable identity and generation", ["hot_variable_list", "hss_capture_plan"]),
  hot_variable_list: tool("artifact", "List process-local Hot Variables and stale state.", [], noHardware, "R1", false, "current and stale refs", ["hot_variable_refresh", "hss_capture_plan"]),
  hot_variable_refresh: tool("artifact", "Refresh only requested stale Hot Variables.", ["current Artifact generation", "previous refs"], noHardware, "R1", false, "targeted refreshed refs", ["hss_capture_plan"]),
  hss_capability_probe: tool("capture", "Read J-Link HSS capability limits.", ["validated Runtime/Script/target selection"], "read-only J-Link connection; no reset, halt or writes", "R1", false, "capability and availability limits", ["hss_capture_plan"]),
  hss_capture_plan: tool("capture", "Validate the production high-rate HSS capture plan; raw GDB loops are not an equivalent default.", ["current Artifact and Symbol/Hot Variable refs", "capability limits"], "none while planning; resetBeforeCapture binds a later composite R3 reset", "R1/R3", false, "single-use planId, bounds and optional reset binding", ["hss_capture_start"]),
  hss_capture_start: tool("capture", "Start the planned high-rate HSS capture.", ["current unexpired planId", "Artifact/layout/policy/session still match"], "opens read-only HSS capture; resetBeforeCapture performs one internal R3 plan/revalidate/consume/audit reset before Start", "R1/R3", false, "captureId, lifecycle and reset/Artifact evidence", ["hss_capture_status", "hss_capture_stop"]),
  hss_capture_status: tool("capture", "Read bounded live or terminal HSS status.", ["captureId"], noHardware, "R1", false, "capture state, warnings and provenance", ["hss_capture_stop", "capture_summary"]),
  hss_capture_stop: tool("capture", "Stop and finalize the current HSS capture.", ["active captureId"], "stops HSS sampling and finalizes immutable raw plus capture.db", "R1", false, "terminal capture/index state", ["capture_summary"]),
  hss_capture_query: tool("query", "Read a bounded terminal compatibility view; prefer Indexed JCAP capture_series and capture_event_window.", ["terminal captureId"], noHardware, "R1", false, "bounded terminal capture data", ["capture_summary"]),
  hss_capture_export: tool("query", "Create an explicit bounded compatibility CSV export; prefer capture_export for JCAP.", ["terminal captureId"], "writes export only; no hardware access", "R1", false, "export path", ["capture_summary"]),
  hss_session_recover: tool("state-change", "Mark abandoned process-local capture metadata failed.", ["abandoned capture or all abandoned sessions"], "writes local recovery metadata only; no hardware access", "R1", false, "recovered session state", ["capture_list"]),
  capture_list: tool("query", "List bounded Indexed JCAP packages.", ["configured external captures root"], noHardware, "R1", false, "capture and index states", ["capture_summary"]),
  capture_summary: tool("query", "Read one bounded JCAP summary.", ["captureId"], noHardware, "R1", false, "provenance, variables, quality and readiness", ["capture_series", "capture_event_window", "capture_index_rebuild"]),
  capture_series: tool("query", "Read bounded indexed min/max/average/last/count/quality buckets.", ["ready capture.db", "explicit variables and tick window"], noHardware, "R1", false, "bounded transient-preserving series", ["capture_event_window", "analysis_run"]),
  capture_event_window: tool("query", "Read bounded indexed evidence around one event.", ["ready capture.db", "event UUID"], noHardware, "R1", false, "event, related events, nearest sample and series", ["analysis_run"]),
  capture_index_rebuild: tool("query", "Rebuild derived capture.db from validated immutable raw prefixes.", ["terminal or recoverable JCAP"], "writes derived capture.db only; never changes raw or hardware", "R1", false, "index state and diagnostics", ["capture_summary"]),
  capture_export: tool("query", "Create an explicit CSV export from ready capture.db.", ["ready capture.db"], "writes package export only; no hardware", "R1", false, "export path and row count", ["capture_summary"]),
  analysis_profiles: tool("analysis", "List implemented deterministic JCAP analysis profiles.", [], noHardware, "R1", false, "profile versions and required roles", ["analysis_run"]),
  analysis_run: tool("analysis", "Run bounded deterministic analysis over ready capture.db.", ["captureId", "profile and at most 16 signal roles", "one event or tick window"], "writes derived analysis rows only; never raw or hardware", "R1", false, "stable analysisRunId, quality, findings and warnings", ["capture_event_window"]),
  variable_write_plan: tool("state-change", "Plan a verified allowlisted RAM write or an explicit unverified-target exception.", ["current Artifact/layout/policy/session", "RAM scalar or fixed array target"], "none while planning", "R2/R4", false, "bound writePlanId, budget/readback facts or R4 challenge", ["variable_write_execute"]),
  variable_write_execute: tool("state-change", "Execute a bound variable write with old-value read and readback.", ["current writePlanId", "verified R2 or trusted-local R4 token for unverified exception"], "writes allowlisted target RAM; capture owner queues event and audit", "R2/R4", "conditional", "write/readback/audit outcome", ["capture_event_window"]),
  halt: tool("state-change", "Halt the target CPU through one internal deterministic plan.", ["configured current target", "no active capture conflict"], "halts CPU", "R3", false, "structured plan, state and audit outcome", ["resume"]),
  resume: tool("state-change", "Resume the target CPU through one internal deterministic plan.", ["configured current target"], "resumes CPU", "R3", false, "structured plan, state and audit outcome", ["capture_summary"]),
  reset: tool("state-change", "Reset the target through one internal deterministic plan.", ["configured current target", "no active capture conflict"], "resets target and may halt it", "R3", false, "structured plan, state and audit outcome", ["hss_capture_plan"]),
  flash_plan: tool("state-change", "Create a read-only R4 Flash challenge.", ["canonical firmware path and arguments"], "none while planning", "R4", false, "challenge for trusted local broker", ["flash"]),
  flash: tool("state-change", "Execute the exact approved Flash challenge.", ["matching unexpired challengeId", "retained approval from protected local CLI"], "programs target nonvolatile memory", "R4", true, "audited execution outcome", ["artifact_probe"]),
  erase_plan: tool("state-change", "Create a read-only R4 erase challenge.", ["current target binding"], "none while planning", "R4", false, "challenge for trusted local broker", ["erase"]),
  erase: tool("state-change", "Execute the exact approved erase challenge.", ["matching unexpired challengeId", "retained approval from protected local CLI"], "erases target nonvolatile memory", "R4", true, "audited execution outcome", ["artifact_probe"]),
  gdb_command_plan: tool("state-change", "Create a read-only R4 raw GDB challenge; this auxiliary is not the HSS capture default.", ["canonical GDB command"], "none while planning", "R4", false, "challenge for trusted local broker", ["gdb_command"]),
  gdb_command: tool("state-change", "Execute the exact approved raw GDB challenge.", ["matching unexpired challengeId", "retained approval from protected local CLI"], "arbitrary target/debug state effects", "R4", true, "audited GDB result", ["capture_summary"]),
  probe_command_plan: tool("state-change", "Create a read-only R4 raw probe challenge.", ["canonical probe commands"], "none while planning", "R4", false, "challenge for trusted local broker", ["probe_command"]),
  probe_command: tool("state-change", "Execute the exact approved raw probe challenge.", ["matching unexpired challengeId", "retained approval from protected local CLI"], "arbitrary target/probe state effects", "R4", true, "audited probe result", ["artifact_probe"]),
};

export function discoveryToolConfig(name: string): { description: string; annotations: Record<string, boolean>; _meta: Record<string, unknown> } {
  const facts = DISCOVERY_TOOLS[name];
  if (!facts) throw new Error(`missing discovery facts for ${name}`);
  const mutates = new Set(["hot_variable_add", "hot_variable_refresh", "hss_capture_plan", "hss_capture_start", "hss_capture_stop", "hss_capture_export", "hss_session_recover", "capture_index_rebuild", "capture_export", "analysis_run", "variable_write_execute", "halt", "resume", "reset", "flash", "erase", "gdb_command", "probe_command"]);
  return {
    description: `Use: ${facts.purpose} Preconditions: ${facts.preconditions.join("; ") || "none"}. Hardware side effects: ${facts.hardwareSideEffects}. Risk: ${facts.riskLevel}. Approval: ${facts.requiresUserApproval === "conditional" ? "none for verified R2; retained protected-local-CLI approval required for R4" : facts.requiresUserApproval ? "retained protected-local-CLI approval required" : "no user approval required for this call"}. Output: ${facts.output}. Common next: ${facts.next.join(", ") || "none"}.`,
    annotations: {
      readOnlyHint: !mutates.has(name),
      destructiveHint: facts.riskLevel === "R4" && facts.requiresUserApproval === true,
      idempotentHint: facts.category === "query" || facts.category === "analysis",
      openWorldHint: facts.category === "state-change" || facts.category === "capture",
    },
    _meta: { "jlinkMcp/discovery": facts },
  };
}

export const DISCOVERY_CATALOG = {
  schema: "jlink-mcp-discovery-v1",
  recommendedWorkflow: RECOMMENDED_WORKFLOW,
  riskModel: {
    R2: "Verified policy-allowlisted RAM variable_write uses plan, budget, old-value/readback, capture queue, event and audit; no R3 plan or user approval.",
    R3: "halt/resume/reset and resetBeforeCapture remain one call that internally plans, revalidates, consumes and audits; halt/reset reject active-capture conflict.",
    R4: "Use action *_plan, then a trusted local broker obtains confirmation and issues the retained execute token; Agent, MCP tools, resources, prompts and offline UI cannot issue it.",
    R5: "No execution tool exists; security, option-byte, reserved-bit, unknown-register and forbidden-region operations are always rejected.",
  },
  enforcement: "The server exposes facts and hard-enforces policy, bounds, ownership and approvals; it cannot guarantee that every third-party Agent reviews discovery metadata.",
  tools: DISCOVERY_TOOLS,
} as const;

export const OFFLINE_JCAP_PROMPT = `Follow the deterministic JCAP workflow: artifact_probe → symbol_search/symbol_resolve → hot_variable_add or hot_variable_refresh → hss_capture_plan → hss_capture_start → hss_capture_status → hss_capture_stop → capture_list → capture_summary → capture_series/capture_event_window → analysis_profiles/analysis_run.

Use HSS as the primary high-rate variable capture path; never replace it with a raw GDB polling loop. Read and explain each tool's risk metadata before state change. Verified allowlisted RAM variable_write is R2 and needs no user approval. halt/resume/reset and resetBeforeCapture are single-call R3 operations with internal plan/revalidate/consume/audit. R4 requires *_plan, direct confirmation through the trusted local broker, then the retained execute tool; never invent or self-issue approval. R5 has no execution tool and is always rejected. Use MCP evidence for reasoning, but do not claim the server can ensure every third-party Agent reviewed this metadata.`;
