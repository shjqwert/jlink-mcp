## ADDED Requirements

### Requirement: Operation plans share the core contexts

An OperationPlan SHALL bind policy, readback, `maxWrites`, risk and applicable RuntimeContext/TargetContext facts once. It SHALL not create duplicate Runtime or Artifact approval state; existing R4 human confirmation remains required for R4 operations.

#### Scenario: an R2 write is planned

- **WHEN** a verified allowlisted RAM write is planned
- **THEN** its OperationPlan binds RuntimeContext, TargetContext, policy, budget and readback
- **AND** it still requires the existing R2 enforcement and audit.

### Requirement: Core tool responses include structured risk facts

Jlink_MCP SHALL return risk level, user-approval requirement, policy result, side effects, target state implications, and recommended verification for operations that can alter target state.

#### Scenario: R2 variable write plan

- **WHEN** an allowlisted RAM variable write is planned
- **THEN** the response identifies R2, `variable_write_plan`, verified target match, RAM/type/value range, remaining `maxWrites` budget, old-value/readback requirements, active capture queue ownership, and Artifact/layout/policy/session/TTL bindings
- **AND** it states that the normal flow requires neither an R3 operation plan nor user approval.

### Requirement: Agent review does not replace MCP hard enforcement

Jlink_MCP SHALL independently enforce policy, ranges, budgets, ownership, target/Artifact match, approval binding, and forbidden operations regardless of Agent recommendations.

#### Scenario: Agent approves an unsafe R5 target

- **GIVEN** the Agent proposes a security, option-byte, reserved-bit, unknown-register, or forbidden-region write
- **WHEN** execution is requested
- **THEN** Jlink_MCP rejects the operation regardless of Agent recommendation.

### Requirement: R4 execution uses a closed challenge and approval contract

R4 SHALL be reserved for an explicit policy exception on an unverified target, Flash/Erase, raw GDB, raw probe, and equivalent high-risk operations. Each R4 capability SHALL expose a read-only action-specific `*_plan` and a corresponding `*_execute`; it SHALL NOT execute from the planning call or from an internal immediate plan.

`*_plan` SHALL canonicalize the operation and return `challengeId`, `operationDigest`, a cryptographically unpredictable single-use `nonce`, `expiresAt`, and the exact human-readable operation summary. The local MCP host SHALL create an ephemeral signing/MAC secret at process start and expose it only to a private trusted local host/CLI approval broker outside the ordinary MCP tool catalog. That broker SHALL display the challenge directly to the user and, only after confirmation, issue an opaque server-authenticated `approvalToken`. The Agent, offline-analysis loopback UI, and any ordinary MCP tool SHALL NOT access the secret or issue, sign, or self-assert the token; tokens SHALL become invalid after server restart.

The token SHALL bind tool name, canonical arguments, target identity, Artifact/layout/policy hashes, session and connection generation, operation digest, expiry, challenge ID, and nonce. `*_execute` SHALL receive the token together with the canonical operation, revalidate every binding immediately before hardware access, and atomically consume the nonce before issuing the operation. The token SHALL remain consumed after success, failure, timeout, or indeterminate outcome, and every outcome SHALL be audited. Missing, expired, mismatched, forged, or replayed approval SHALL return `approval_required` or a structured approval error without hardware action.

For an unverified-target variable exception, Node SHALL create exactly one versioned Native envelope after lock, binding revalidation, durable intent audit and atomic approval consumption. The envelope SHALL use `schema=jlink-mcp-r4-native-exception`, `version=1`, `kind=unverified_variable_write`; bind approval-consumption evidence, operation/write-plan identities and digests, exact write bytes/readback, target/probe/runtime/Artifact/evidence/layout/policy/session/capture and reserved physical connection generation; and require `artifactMatch=unverified` plus `unverifiedWriteException=true`. Its `summarySha256` SHALL be SHA-256 of the envelope without `summarySha256`, serialized as UTF-8 JSON with recursively ordinal-sorted object keys, omitted `undefined`, retained array order and finite JSON values only.

The external session plan SHALL NOT persist the approval token, authority secret, signature or raw nonce. Node SHALL pass only that plan, its summary SHA-256 and the already-bound helper/runtime/Artifact/write arguments to the distinct `variable-write-r4` helper command. Native SHALL treat the envelope as consumed authorization evidence rather than derive or mint approval, and SHALL validate every field, canonical form and summary before DLL load, connect or write. Missing, noncanonical or inconsistent fields, summary mismatch, `verified|mismatch`, or absent policy exception SHALL fail closed. Until Native implements the command, structured unsupported with `writeIssued=false` is the only valid result; Node SHALL NOT retry through verified R2, ProbeDirect, legacy `variable-write` or another fallback.

V1 SHALL map the logical plan/execute pairs to the retained tool surface as `flash_plan → flash`, `erase_plan → erase`, `gdb_command_plan → gdb_command`, and `probe_command_plan → probe_command`; if direct `write_memory` remains, it SHALL use `write_memory_plan → write_memory`. The existing action tool is the execute endpoint and SHALL require `approvalToken` together with its original canonical arguments. An unverified-target variable exception SHALL use `variable_write_plan → variable_write_execute`, with the execute call requiring the R4 token in addition to its write plan reference. No legacy immediate-execute alias or token-free code path SHALL remain.

The public MCP surface SHALL NOT expose `rtt_send`, `rtt_channel_write`, `traceagent_write_signal`, or down-ring/up-ring parameter variants that can mutate target RAM. Read-only RTT log, caller-provided snapshot parsing, and TraceAgent decode tools may remain, but the server SHALL NOT instantiate a direct RTT memory writer or advance target ring offsets on their behalf.

#### Scenario: flash or raw command is executed

- **GIVEN** the Agent has reviewed and explained an R4 operation
- **WHEN** `*_execute` is requested without a current token issued for the exact challenge and canonical operation
- **THEN** Jlink_MCP returns `approval_required`
- **AND** does not alter hardware.

#### Scenario: Agent attempts to self-approve

- **WHEN** an Agent supplies confirmation text, a caller-generated token, or a token issued for a different digest, target, session, connection generation, or nonce
- **THEN** Jlink_MCP rejects the execution before hardware access
- **AND** records the rejected attempt without consuming a valid unrelated approval.

#### Scenario: approved operation is replayed

- **GIVEN** a trusted local broker issued one valid token
- **WHEN** the bound execute attempt has consumed its nonce and the token is submitted again
- **THEN** the replay is rejected regardless of the first attempt's result.

#### Scenario: Native R4 variable exception is unsupported

- **GIVEN** Node has consumed a valid approval and persisted the canonical external-session envelope without token or secret material
- **WHEN** the installed Native helper does not implement `variable-write-r4`
- **THEN** it returns structured unsupported before hardware access and the approval remains consumed
- **AND** Node does not synthesize `verified` or invoke another write path.

#### Scenario: Native R4 exception envelope is invalid

- **WHEN** an envelope is missing a field, uses a noncanonical value, has a different summary, reports `verified|mismatch`, or lacks the explicit unverified-write policy exception
- **THEN** Node or Native rejects it before helper hardware access
- **AND** no token-free or legacy helper fallback executes.

### Requirement: Risk operations are audited

Variable writes, CPU control, flash, erase, raw commands, policy changes, and capture lifecycle operations SHALL create append-safe audit records.

For an active-capture variable write, plan claim/consumption, old-value read, write, readback, capture-relative event append/sync, and the same-`auditId` outcome audit append/fsync SHALL execute in one capture-owner queue segment. The queue SHALL enter `AUDIT_APPEND` and SHALL NOT admit the next accepted write until the outcome audit is durable. Success, failure, timeout, and indeterminate results SHALL produce exactly one outcome record for the consumed attempt.

#### Scenario: write readback fails

- **WHEN** a write was issued but readback does not match
- **THEN** the audit records requested value, old value if known, readback, error, layout/policy hashes, session, capture, and timing
- **AND** the capture remains recoverable.

#### Scenario: two writes are submitted concurrently during capture

- **WHEN** the first write reaches capture event sync and the second write is already waiting
- **THEN** the first write's outcome audit is appended and fsynced before the second write enters old-value read or hardware I/O
- **AND** the first consumed attempt has exactly one outcome audit even if execution failed or became indeterminate.

### Requirement: CPU control tools are R3 and capture-aware

`halt`, `resume`, and `reset` SHALL be classified as R3. The Agent SHALL see that risk and its side effects through discovery before choosing to invoke the existing tool. Each invocation SHALL remain one call with the existing name and input schema; inside that call Jlink_MCP SHALL create a deterministic operation plan, check target/runtime state, revalidate the binding, execute through the J-Link main backend, consume the plan once, create an append-safe audit record, and return a structured outcome.

Every internal CPU-control operation plan SHALL bind the tool name and canonical arguments, target identity, Artifact/layout/policy hashes, session, capture ID when present, issue time, expiry/TTL, and operation digest. Execution SHALL revalidate the binding immediately before hardware access and consume it once. The audit SHALL record the binding digest, DLL/helper/adapter/ScriptFile identities, before/after target state, start/end time, structured result, and capture event reference when present. Existing required output fields and meanings SHALL remain unchanged; the existing response envelope MAY add backward-compatible `planDigest` and audit-reference metadata.

#### Scenario: CPU control succeeds

- **WHEN** the internally created R3 CPU control plan passes target-state checks and no capture conflict exists
- **THEN** the J-Link main backend executes the requested action
- **AND** the response and audit identify the operation, before/after target state, result, and audit reference.

#### Scenario: halt or reset conflicts with active HSS capture

- **GIVEN** an HSS capture is active
- **WHEN** `halt` or `reset` is requested
- **THEN** Jlink_MCP returns a structured `capture_conflict`
- **AND** does not halt, reset, silently stop, or silently invalidate the capture.

#### Scenario: resetBeforeCapture executes as part of capture start

- **GIVEN** an HSS plan explicitly resolves `resetBeforeCapture=true` and contains a current single-use R3 reset binding
- **WHEN** capture start reaches the reset phase before HSS Start
- **THEN** the shared J-Link CPU-control executor performs the target-state check and reset
- **AND** the composite capture response advertises R3, appends the reset result to project audit and capture events, and continues only after bounded stabilization.

#### Scenario: resetBeforeCapture binding is invalid

- **WHEN** target/Artifact/layout/policy/session differs, TTL expires, operation digest differs, or the plan has already been consumed
- **THEN** capture start returns a structured R3 rejection
- **AND** no reset or HSS Start occurs.

#### Scenario: future capture-disruption exception

- **GIVEN** a future policy explicitly allows halt or reset during an active capture
- **WHEN** the exception is executed
- **THEN** Jlink_MCP first explicitly stops or marks the capture state
- **AND** appends a capture event and audit record describing the disruption before returning the structured result.
