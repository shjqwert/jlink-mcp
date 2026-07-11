## ADDED Requirements

### Requirement: Agent clients can discover the recommended workflow

Jlink_MCP SHALL expose tool descriptions, resources, prompts, and catalog data sufficient for an Agent to select the correct tools without user reminders.

#### Scenario: new Agent connects

- **WHEN** the Agent lists capabilities and tools
- **THEN** it can discover the recommended sequence from Artifact probe through capture analysis
- **AND** it can distinguish core capture tools from auxiliary/high-risk debug tools.

### Requirement: Tool descriptions state preconditions and side effects

Each tool SHALL state when to use it, required prior state, hardware side effects, risk level, expected output, and common next actions.

#### Scenario: Agent compares HSS and GDB commands

- **WHEN** the Agent inspects descriptions for continuous variable capture
- **THEN** HSS is identified as the primary high-rate path
- **AND** looping raw GDB commands is not presented as an equivalent default.

### Requirement: MCP does not embed language-model reasoning

Jlink_MCP SHALL expose deterministic tools and evidence only and SHALL NOT embed an LLM, semantic diagnosis engine, or MCP-owned multi-round business workflow.

#### Scenario: user requests diagnosis

- **WHEN** a semantic diagnosis is required
- **THEN** the external Agent performs the reasoning using MCP evidence
- **AND** the MCP restricts itself to deterministic query, validation, access, storage, and analysis functions.

### Requirement: Agent automatically reviews risk metadata

The reference Agent skill/client SHALL review structured risk metadata before proposing a state-changing action. The server SHALL expose the facts and enforce policy, but SHALL NOT claim that every third-party MCP client performs this review.

#### Scenario: risky tool is considered

- **WHEN** an Agent plans a write, CPU control, flash, erase, or raw command
- **THEN** it reviews risk, policy, preconditions, reversibility, confirmation requirement, and validation steps before execution
- **AND** the user does not need to remind it to perform that review.
