# ai-debug-workflow Specification

## Purpose
Define the Agent-owned debugging workflow composed from direct bounded MCP primitives and evidence-backed analysis.

## Requirements

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
