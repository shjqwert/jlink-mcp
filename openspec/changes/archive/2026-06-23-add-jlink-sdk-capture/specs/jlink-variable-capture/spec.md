## ADDED Requirements

### Requirement: Official native RSP capture runtime

The system SHALL implement timing-critical capture in a standalone Windows x64 C++ helper using the installed official `JLinkGDBServerCL.exe` and a persistent GDB Remote Serial Protocol connection. The system MUST NOT call private J-Link DLL exports or require the separately sold J-Link SDK.

#### Scenario: Required runtime is unavailable

- **WHEN** capture preparation is requested without the helper, official J-Link GDB Server, or `arm-none-eabi-gdb`
- **THEN** the system rejects preparation with a specific configuration error and does not fall back to a private DLL API or repeated command sampling

#### Scenario: Background RSP reads are unsupported

- **WHEN** capability probing or calibration shows that memory cannot be read while the CPU remains running
- **THEN** the system rejects preparation without halting or resuming the target

### Requirement: Explicit ELF scalar selection

The system SHALL resolve fixed-address global/static scalar symbols and fixed-offset scalar member paths rooted at global/static structures from an explicitly selected little-endian ELF using offline `arm-none-eabi-gdb` queries. Member offsets MUST come from ELF/DWARF layout information. Supported final types SHALL be `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, and `float32`. The system MUST NOT dereference pointers, index arrays, accept caller-computed offsets, or sample a whole aggregate.

#### Scenario: Valid standalone scalars are prepared

- **WHEN** the ELF matches target Flash and all requested standalone scalar symbols have unique, naturally aligned, writable RAM addresses and supported types
- **THEN** the system includes every requested scalar in calibration without modifying the target

#### Scenario: Valid structure members are prepared

- **WHEN** selectors such as `AppMotorDbg.c::gstMotorDbg.fThetaRad` resolve through ELF/DWARF to fixed-offset, naturally aligned, supported scalar members in writable RAM
- **THEN** the system includes the resolved member addresses and types in calibration without sampling the whole structure

#### Scenario: A selector is unsafe or ambiguous

- **WHEN** any selector is missing, ambiguous, optimized out, unsupported, unaligned, outside writable RAM, resolves to a peripheral/debug address, requires pointer/array traversal, uses a caller offset, or ends at a non-scalar value
- **THEN** the system rejects the entire preparation and reports every invalid selector

### Requirement: Probe and target preflight

The system SHALL use the configured probe serial and SWD speed, validate target identity and ELF Flash checksums, and confirm that the CPU is running before and after background memory reads.

#### Scenario: Multiple probes are present

- **WHEN** multiple J-Link probes are detected and `JLINK_SERIAL` is not set
- **THEN** the system rejects preparation and returns the candidate probes without selecting one

#### Scenario: Target state changes during preflight

- **WHEN** the target is halted, target state is indeterminate, Flash validation fails, or background reads alter the running state
- **THEN** preparation fails without issuing run, reset, speed-change, or recovery commands

### Requirement: Calibrated read plan

The system SHALL accept 1–32 requested symbols, benchmark safe individual and coalesced RAM reads, and select a read plan only when the requested rate and read-window limit pass calibration.

#### Scenario: Calibration passes

- **WHEN** the measured plan meets the requested 1–1000 Hz rate and has a frame read-window P99.9 no greater than 100 microseconds
- **THEN** the session enters `armed` and exposes its measured calibration results

#### Scenario: Calibration fails

- **WHEN** no safe plan meets the requested timing
- **THEN** preparation fails without changing the SWD rate, reducing variables, reducing sampling rate, or using GDB

### Requirement: Exclusive capture lifecycle

The system SHALL enforce the state sequence `idle`, `preparing`, `armed`, `capturing`, and a terminal `completed`, `stopped`, or `failed` state, with at most one active session per MCP server.

#### Scenario: Conflicting hardware operation

- **WHEN** an armed or capturing session owns the probe and another probe-touching MCP tool is called
- **THEN** the system rejects the conflicting call while allowing capture status, stop, and non-hardware queries

#### Scenario: Probe is already owned externally

- **WHEN** J-Scope, an external GDB Server, or another process owns the selected probe
- **THEN** preparation fails and the system does not terminate the external process

### Requirement: Bounded periodic acquisition

The helper SHALL sample using QueryPerformanceCounter absolute deadlines, high Windows scheduling priority without realtime priority, preallocated locked memory, and no timing-loop disk writes. Rates SHALL range from 1–1000 Hz and durations from 1–600 seconds.

#### Scenario: Successful acceptance capture

- **WHEN** seven supported variables are captured at 1 kHz for 60 seconds on the validated J-Link CE, Z20K146MC, SWD 4 MHz setup
- **THEN** the report contains zero missed deadlines, an actual rate of at least 1 kHz, and a frame read-window P99.9 no greater than 100 microseconds

#### Scenario: A frame deadline is missed

- **WHEN** a frame cannot start at its absolute deadline
- **THEN** the helper records `missed_deadline`, skips that frame, does not issue catch-up reads, and marks acceptance failed

### Requirement: Traceable frame data

The system SHALL record each frame's index, scheduled time, QPC read start/end/midpoint, read duration, flags, and raw typed values without engineering scaling.

#### Scenario: Capture completes

- **WHEN** acquisition terminates normally or through a handled failure
- **THEN** the helper writes a unique versioned binary artifact without overwriting an existing capture

### Requirement: Export and bounded analysis

The system SHALL export CSV data and same-name JSON metadata and SHALL support bounded time-range queries with at most 2000 buckets containing min/max/average per variable.

#### Scenario: Agent queries a long capture

- **WHEN** `capture_query` requests selected variables and a time range containing more than 2000 frames
- **THEN** the system returns at most 2000 ordered buckets while preserving per-bucket minima and maxima

#### Scenario: Capture is exported

- **WHEN** `capture_export` is called for a terminal session
- **THEN** the system writes CSV plus JSON containing ELF SHA-256, target/probe/GDB Server identity, negotiated RSP capabilities, symbol schema, timing metrics, control events, failures, resets, and termination reason

### Requirement: Safe capture file management

The system SHALL default output to `%TEMP%\jlink-mcp-captures`, accept an optional writable absolute output directory, generate unique session-based names, and delete only explicitly selected terminal sessions.

#### Scenario: Active capture deletion is requested

- **WHEN** `capture_delete` targets an armed or capturing session
- **THEN** deletion is rejected and no file is removed

#### Scenario: User removes files externally

- **WHEN** capture files are removed directly through the file system
- **THEN** `capture_list` no longer reports those files and no unrelated file is affected

### Requirement: Capture MCP tool surface

The system SHALL provide `capture_prepare`, `capture_start`, `capture_status`, `capture_stop`, `capture_control`, `capture_query`, `capture_export`, `capture_list`, and `capture_delete` and no arbitrary-address capture API.

#### Scenario: Session-scoped operation

- **WHEN** start, stop, control, query, export, or delete is requested
- **THEN** the caller must supply the exact session ID and the operation must be valid for that session state

### Requirement: Native capture build

The existing TypeScript build SHALL remain usable, while `npm run build:capture` SHALL build the RSP helper with MSVC and CMake without SEGGER SDK development files.

#### Scenario: Standard build runs

- **WHEN** `npm run build` runs on a supported development machine
- **THEN** the TypeScript build completes without checking for SEGGER SDK files
