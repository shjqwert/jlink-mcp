## ADDED Requirements

### Requirement: Agent orchestrates the debugging workflow

Jlink-MCP SHALL expose direct bounded primitives while the Agent determines objectives, hypotheses, tool order, retry decisions, explicit state changes, capture rounds, writes, analysis, and stopping conditions.

#### Scenario: Agent executes a complete debug loop
- **WHEN** an Agent explicitly invokes Target configuration, Artifact discovery, variable resolution/read, HSS, capture-time write, bounded queries, CPU control, and flash in its chosen order
- **THEN** MCP executes each valid operation independently through the shared Target/queue/status mechanisms
- **AND** creates no hidden MCP-owned workflow session or approval phase.

#### Scenario: Agent omits a prerequisite
- **WHEN** an Agent calls a direct tool without its required Target, Artifact verification, ownership, or halt state
- **THEN** MCP returns a structured prerequisite error and suggested explicit next action
- **AND** does not satisfy the prerequisite automatically.

### Requirement: Debug conclusions remain evidence-backed

Jlink-MCP analysis and query tools SHALL return bounded data derived from selected capture/operation evidence and SHALL NOT generate a fixed success narrative.

#### Scenario: evidence is insufficient
- **WHEN** bounded capture data cannot support the requested analysis
- **THEN** the result states the missing/insufficient evidence and available facts
- **AND** does not report a fabricated root cause or passing acceptance result.

## REMOVED Requirements

### Requirement: Bounded AI debug sessions
**Reason**: MCP-owned round/session orchestration conflicts with the Agent-first boundary.
**Migration**: The Agent owns round count and stopping conditions while invoking direct tools.

### Requirement: MVP-C MCP tools are explicit by phase
**Reason**: The listed workflow/viewer/plan-execute tools are replaced by the exact direct 57-tool surface.
**Migration**: Use `hss_*`, `capture_*`, `write_variable`, analysis, and separate Offline UI entry directly.

### Requirement: Workflow input files are versioned and project-local
**Reason**: No MCP-owned debug workflow or workflow-file schema remains.
**Migration**: Agents pass validated direct tool inputs with explicit `projectRoot`; explicit external input files follow Target path rules.

### Requirement: Each round has a hypothesis and evidence plan
**Reason**: Hypothesis and round planning belong to the Agent, not MCP state.
**Migration**: Record hypotheses in Agent/test evidence when a `runId` is used.

### Requirement: Workflow writes are symbol-derived experiments
**Reason**: Approval-style variable-write planning is removed and raw memory is intentionally available when the Agent explicitly chooses it.
**Migration**: Use direct `write_variable` for typed symbols or explicit `write_memory` under its region/verification rules.

### Requirement: Workflow output is evidence-backed and dynamic
**Reason**: There is no composite workflow output object after removal of MCP-owned sessions.
**Migration**: Compose direct operation envelopes, capture queries, and `analysis_run` results in the Agent.
