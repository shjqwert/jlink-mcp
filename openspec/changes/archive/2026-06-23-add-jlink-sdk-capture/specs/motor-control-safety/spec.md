## ADDED Requirements

### Requirement: Version-controlled control allowlist
The system SHALL load motor commands from an explicitly selected, repository-tracked `.jlink-mcp.json` and SHALL permit only reviewed `start` and `stop` commands.

#### Scenario: Control mapping is first discovered or changed
- **WHEN** an Agent identifies a control variable from project source or ELF, or the mapping changes
- **THEN** the Agent must obtain user confirmation before recording or using its symbol, type, value, and verification condition

#### Scenario: Multiple project configs are found
- **WHEN** more than one `.jlink-mcp.json` is a candidate
- **THEN** the Agent asks the user to select one and does not infer the nearest file

### Requirement: No arbitrary control writes
`capture_control` SHALL accept only a session ID and an allowlisted command name. It MUST NOT accept a caller-provided address or value.

#### Scenario: Arbitrary value is requested
- **WHEN** a caller attempts to supply an address, unlisted command, or replacement value
- **THEN** the system rejects the request without touching the target

#### Scenario: Allowlisted structure member control
- **WHEN** an allowlisted command or verification condition selects a fixed-offset supported scalar member rooted at a global/static structure
- **THEN** the system resolves that member through the validated ELF/DWARF using the same safety rules as capture selectors

### Requirement: Verified motor start
The system SHALL allow `start` only while capturing and only after the user explicitly requests motor operation in the current task. It SHALL collect `preStartMs` of baseline data, write the allowlisted start value between frames, and verify the configured running condition within `start.timeoutMs`.

#### Scenario: Start succeeds
- **WHEN** the verified running condition is reached before the timeout
- **THEN** the system records the command and confirmation timestamps and begins the configured duration clock

#### Scenario: Start verification fails
- **WHEN** the running condition is not confirmed before the timeout
- **THEN** the system sends the allowlisted stop command, uses the reset fallback if stop cannot be verified, terminates capture, and preserves collected data

### Requirement: Verified motor stop
The system SHALL allow stop while armed or capturing, verify the configured stopped condition within `stop.timeoutMs`, and continue capture for `postStopMs` after confirmation.

#### Scenario: Explicit capture stop while motor runs
- **WHEN** `capture_stop` is called while motor state is running
- **THEN** the system verifies motor stop before collecting the post-stop interval and terminating capture

#### Scenario: Stop verification fails
- **WHEN** the stopped condition is not confirmed before the timeout
- **THEN** the system executes one hardware reset if reset fallback is enabled, marks the session failed, and preserves collected data

### Requirement: Automatic safe termination
The system SHALL attempt verified stop when runtime duration expires, the Agent or MCP control channel disconnects, the parent process exits, or the task otherwise terminates unexpectedly.

#### Scenario: Runtime expires
- **WHEN** `durationSec` elapses after successful start verification
- **THEN** the system issues stop, verifies it, captures the configured post-stop interval, and completes the session

#### Scenario: Control channel disappears
- **WHEN** the helper detects parent or IPC loss during capture
- **THEN** it performs the same verified stop, optional reset, partial-data persistence, and exit sequence without restarting the motor

### Requirement: Read-failure reset policy
The system SHALL count consecutive frame read failures and, after three consecutive failures, terminate capture after attempting verified stop and any explicitly enabled reset fallback.

#### Scenario: Reset fallback is enabled
- **WHEN** three consecutive reads fail, stop cannot be verified, and `resetOnFailure` was explicitly true for the session
- **THEN** the helper performs exactly one reset through the J-Link hardware RESET pin, saves partial data, and exits without reconnecting or resuming sampling

#### Scenario: Reset fallback is disabled or fails
- **WHEN** stop cannot be verified and reset is disabled or the hardware reset fails
- **THEN** the system marks a critical failure, records the failed safety action, and relies on the independent hardware emergency stop

### Requirement: Reset requires per-session consent
`resetOnFailure` SHALL default to false and SHALL become active only when explicitly selected during preparation after the Agent informs the user. It SHALL NOT apply during preparation.

#### Scenario: Preparation connection fails
- **WHEN** target attachment fails during `capture_prepare`
- **THEN** preparation returns an error without resetting, reconnecting, changing speed, or modifying target state

### Requirement: Sampling remains minimally invasive
The sampler SHALL remain read-only except for allowlisted start/stop writes and the single approved hardware reset fallback. It MUST NOT write other memory/registers, halt/run the CPU, set breakpoints, flash firmware, write AIRCR, or automatically change SWD speed.

#### Scenario: Conflicting write is attempted
- **WHEN** any non-allowlisted target mutation is requested through the capture subsystem
- **THEN** the system rejects it and records no control event

### Requirement: Configurable physical timing
The project config SHALL support `preStartMs` from 0–5000 ms, `postStopMs` from 0–10000 ms, default start timeout 1000 ms, and default stop timeout 500 ms.

#### Scenario: Default timing is used
- **WHEN** the project config omits optional timing overrides
- **THEN** the system captures 500 ms before start, starts the duration clock after start verification, and captures 1000 ms after stop verification

### Requirement: Safety events are auditable
The capture output SHALL record every control request, write result, verification result, timeout, read-failure threshold, reset attempt/result, motor state transition, and termination reason with QPC timestamps.

#### Scenario: Partial capture ends through reset
- **WHEN** a safety failure causes hardware reset
- **THEN** export metadata identifies the triggering failures, stop attempt, reset result, final motor-state knowledge, and amount of valid data retained

### Requirement: Safe validation procedure
The first disconnect/reset acceptance test SHALL run with the motor disabled, no load, or the power stage otherwise made safe, and an independent emergency stop SHALL remain available during motor testing.

#### Scenario: Initial disconnect test is requested under load
- **WHEN** the reset path has not yet passed a safe no-load test
- **THEN** the test procedure rejects a first-time loaded disconnect test
