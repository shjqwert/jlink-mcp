## MODIFIED Requirements

### Requirement: Agent orchestrates the debugging workflow

Jlink-MCP SHALL expose direct bounded daily-debug actions while the Agent determines objectives, hypotheses, tool order, retry decisions, explicit state changes, capture rounds, writes, source/code analysis, modifications, and stopping conditions.

#### Scenario: Agent executes a complete debug loop
- **WHEN** an Agent explicitly invokes Target configuration, Artifact discovery, variable resolution/read, HSS, capture-time write, bounded queries, Target control, GDB/RTT/diagnostics as needed, and flash in its chosen order
- **THEN** MCP executes each valid operation independently through shared Target/queue/status mechanisms
- **AND** creates no hidden MCP-owned workflow, analysis session, approval phase, or automatic source modification.

#### Scenario: Agent omits a prerequisite
- **WHEN** an Agent calls a direct tool without its required Target, Artifact verification, SVD, ownership, halt state, or endpoint
- **THEN** MCP returns a structured prerequisite error and suggested explicit next action
- **AND** does not satisfy the prerequisite automatically.

### Requirement: Debug conclusions remain evidence-backed

Jlink-MCP query, access, status, and diagnosis tools SHALL return bounded data derived from selected hardware, Artifact, operation, or capture evidence. Codex or Claude SHALL perform project-specific interpretation and source changes outside MCP. MCP SHALL NOT expose generic/domain business-analysis profiles or generate a fixed success narrative.

#### Scenario: evidence is insufficient
- **WHEN** bounded capture or target data cannot support the Agent's hypothesis
- **THEN** MCP returns the available facts, quality/readiness state, and missing prerequisites
- **AND** does not report a fabricated root cause or passing acceptance result.

#### Scenario: Agent compares two firmware runs
- **WHEN** an Agent queries equivalent bounded windows from two captures
- **THEN** MCP returns each source dataset and provenance independently
- **AND** the Agent, not MCP, decides whether behavior improved and what code to change.
