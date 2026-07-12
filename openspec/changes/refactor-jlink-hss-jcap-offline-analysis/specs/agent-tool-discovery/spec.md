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

#### Scenario: normal verified RAM write is considered

- **WHEN** a policy-allowlisted RAM write has a current layout and `targetArtifactMatch=verified`
- **THEN** discovery identifies `variable_write_plan` as R2 with budget, old-value/readback, capture queue, event and audit requirements
- **AND** it does not request an R3 operation plan or user approval.

#### Scenario: CPU control is considered

- **WHEN** the Agent considers `halt`, `resume`, or `reset`
- **THEN** discovery identifies the unchanged tool as R3 and explains that its single call internally creates, revalidates, consumes and audits a deterministic plan
- **AND** `halt`/`reset` disclose the default active-capture conflict.

#### Scenario: R4 action is considered

- **WHEN** the Agent considers Flash/Erase, raw GDB, raw probe, or an unverified-target write exception
- **THEN** discovery directs it to the action-specific planning companion and retained execution tool (`flash_plan→flash`, `erase_plan→erase`, `gdb_command_plan→gdb_command`, `probe_command_plan→probe_command`, or `variable_write_plan→variable_write_execute`)
- **AND** states that only the trusted local host/CLI can obtain user confirmation and issue the approval token; the Agent and offline UI cannot self-approve.

#### Scenario: capture plan includes resetBeforeCapture

- **WHEN** a resolved HSS plan sets `resetBeforeCapture=true`
- **THEN** discovery identifies capture start as a composite R3 operation and exposes the reset binding, trusted ScriptFile identity, stabilization policy, expected reset/capture events, and failure modes
- **AND** it does not present the flow as ordinary read-only R1 capture or as permission for the ScriptFile selector/HSS path to issue Raw/general ExecCommand
- **AND** it separately preserves the existing explicit raw probe/GDB tools as R4 auxiliaries that HSS never invokes as fallback.
