## ADDED Requirements

### Requirement: Core tool responses include structured risk facts

Jlink_MCP SHALL return risk level, user-approval requirement, policy result, side effects, target state implications, and recommended verification for operations that can alter target state.

#### Scenario: R3 variable write plan

- **WHEN** an allowlisted RAM variable write is planned
- **THEN** the response identifies R3, operation plan, range, remaining write budget, readback requirement, active capture ownership, and Artifact/layout/policy/session/TTL bindings.

### Requirement: Agent review does not replace MCP hard enforcement

Jlink_MCP SHALL independently enforce policy, ranges, budgets, ownership, target/Artifact match, approval binding, and forbidden operations regardless of Agent recommendations.

#### Scenario: Agent approves an unsafe R5 target

- **GIVEN** the Agent proposes a security, option-byte, reserved-bit, unknown-register, or forbidden-region write
- **WHEN** execution is requested
- **THEN** Jlink_MCP rejects the operation regardless of Agent recommendation.

### Requirement: R4 execution requires explicit user approval

R4 SHALL be reserved for an explicit policy exception on an unverified target, Flash/Erase, Raw commands, and equivalent high-risk operations. Its approval SHALL be issued by a trusted user-confirmation boundary and SHALL bind tool name, canonical arguments, target identity, Artifact/layout/policy hashes, operation digest, expiry, and a single-use nonce. Agent-provided text alone SHALL NOT satisfy approval.

#### Scenario: flash or raw command is executed

- **GIVEN** the Agent has reviewed and explained an R4 operation
- **WHEN** execution is requested without the current approval contract
- **THEN** Jlink_MCP returns `approval_required`
- **AND** does not alter hardware.

### Requirement: Risk operations are audited

Variable writes, CPU control, flash, erase, raw commands, policy changes, and capture lifecycle operations SHALL create append-safe audit records.

#### Scenario: write readback fails

- **WHEN** a write was issued but readback does not match
- **THEN** the audit records requested value, old value if known, readback, error, layout/policy hashes, session, capture, and timing
- **AND** the capture remains recoverable.

### Requirement: CPU control tools are R3 and capture-aware

`halt`, `resume`, and `reset` SHALL be classified as R3. Each invocation SHALL require an operation plan, check target state before execution, create an append-safe audit record, and return a structured outcome through its existing output contract without renaming the tool or changing its input schema.

#### Scenario: CPU control succeeds

- **WHEN** an R3 CPU control plan passes target-state checks and no capture conflict exists
- **THEN** the J-Link main backend executes the requested action
- **AND** the response and audit identify the operation, before/after target state, result, and audit reference.

#### Scenario: halt or reset conflicts with active HSS capture

- **GIVEN** an HSS capture is active
- **WHEN** `halt` or `reset` is requested
- **THEN** Jlink_MCP returns a structured `capture_conflict`
- **AND** does not halt, reset, silently stop, or silently invalidate the capture.

#### Scenario: future capture-disruption exception

- **GIVEN** a future policy explicitly allows halt or reset during an active capture
- **WHEN** the exception is executed
- **THEN** Jlink_MCP first explicitly stops or marks the capture state
- **AND** appends a capture event and audit record describing the disruption before returning the structured result.
