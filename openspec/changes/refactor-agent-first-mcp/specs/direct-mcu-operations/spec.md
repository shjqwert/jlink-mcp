## ADDED Requirements

### Requirement: MCU operations return one structured envelope

Every schema-valid MCU operation SHALL return structured content containing `ok`, operation identity/timestamps, tool, Target, Probe, queue sequence, Artifact/SVD/Capture context, before/after observations, requested/observed effects, verification, data, output files, warnings, and a structured error when applicable.

The structured error SHALL contain code, stage, message, retryable, writeIssued, and stateUnknown fields.

#### Scenario: execution failure
- **WHEN** a valid tool request fails during connection, execution, readback, or final observation
- **THEN** the MCP call returns the operation envelope with `ok=false`
- **AND** reserves MCP protocol errors for malformed protocol or schema input.

#### Scenario: state cannot be observed
- **WHEN** a write may have been issued but final target state cannot be read
- **THEN** the envelope sets `writeIssued=true` and `stateUnknown=true`
- **AND** never reports confirmed success.

### Requirement: Preflight and read operations have no hidden state changes

Preflight, status, memory reads, variable reads, register reads, snapshot, diagnosis, GDB setup, and RTT setup SHALL NOT implicitly halt, reset, resume, recover, flash, erase, or write the target.

#### Scenario: running target cannot expose a core register
- **WHEN** a core-register, snapshot, diagnosis, or backtrace request cannot be fulfilled while the target runs
- **THEN** it returns available partial data and `HALT_REQUIRED`
- **AND** target running state remains unchanged.

#### Scenario: preflight connection fails
- **WHEN** a non-mutating preflight cannot connect or read its probe state
- **THEN** it returns the failure and suggested explicit next actions
- **AND** does not attempt reset-under-connect, halt, speed fallback, or power recovery.

### Requirement: CPU control has explicit final states

Jlink-MCP SHALL provide direct `halt`, `resume`, `reset`, and `reset_halt` tools. `halt` SHALL finish halted, `resume` SHALL finish running, `reset` SHALL finish running, and `reset_halt` SHALL finish halted.

#### Scenario: already satisfied CPU state
- **WHEN** `halt` is called on an already halted target or `resume` on an already running target
- **THEN** it succeeds as a no-op
- **AND** reports matching before/after observations and no unrequested effect.

#### Scenario: reset running
- **WHEN** `reset` executes
- **THEN** it explicitly requests reset and running final state
- **AND** reports every observed intermediate/final state without hiding vendor behavior.

### Requirement: Raw memory access is explicit and bounded

`read_memory` and `write_memory` SHALL require an explicit address, access width, and bounded byte count. The maximum request size SHALL be 4096 bytes. Structured memory writes SHALL default to no old read and no readback.

#### Scenario: known RAM write
- **WHEN** `write_memory` targets a known writable RAM range with valid width/alignment/data
- **THEN** it performs only that write
- **AND** leaves Artifact verification unchanged.

#### Scenario: known non-writable region
- **WHEN** `write_memory` targets known Flash, ROM, or another non-writable range
- **THEN** it rejects the request before issuing a write
- **AND** recommends the explicit `flash` tool when applicable.

#### Scenario: unknown region
- **WHEN** the Agent explicitly writes an otherwise valid unknown region
- **THEN** MCP may issue it with `regionStatus=unknown` and a warning
- **AND** lowers Artifact verification to `unverified` if a write was issued.

### Requirement: CPU-core registers are distinct from SVD registers

`read_core_register`, `read_core_registers`, and `write_core_register` SHALL address only supported CPU-core registers. They SHALL NOT accept SVD peripheral selectors.

#### Scenario: read all available core registers
- **WHEN** `read_core_registers` runs while the backend can read the current target state without changing it
- **THEN** it returns the available named core-register set
- **AND** reports omitted/unavailable registers explicitly.

#### Scenario: write core register without verification
- **WHEN** `write_core_register` succeeds with default options
- **THEN** it reports `executed_unverified`
- **AND** does not perform an implicit readback.

### Requirement: Flash formats and verification are strict

`flash` SHALL accept Intel HEX and SREC using embedded addresses and raw BIN only with explicit `baseAddress`. It SHALL reject ELF/OUT/AXF as flash inputs. Vendor flash verification SHALL be mandatory and not disableable.

#### Scenario: BIN address missing
- **WHEN** `flash` receives a BIN file without `baseAddress`
- **THEN** it fails before programming
- **AND** sets `writeIssued=false`.

#### Scenario: flash verify fails
- **WHEN** programming is issued and vendor verification fails
- **THEN** it returns `ok=false`, `writeIssued=true`, and `stateUnknown=true`
- **AND** does not reset or resume to hide the failure.

#### Scenario: flash completes with vendor side effects
- **WHEN** J-Link necessarily changes halt/reset state while programming
- **THEN** the response lists those observed effects
- **AND** MCP performs no additional recovery reset or resume.

### Requirement: Erase is direct and optional blank verification is explicit

`erase` SHALL execute directly without approval. It SHALL default to `executed_unverified`; `verifyBlank=true` SHALL request blank verification when the backend supports it.

#### Scenario: erase without blank verification
- **WHEN** `erase` completes with default options
- **THEN** it reports the vendor result as unverified
- **AND** does not flash, reset, or resume automatically.

#### Scenario: blank verification unsupported
- **WHEN** `verifyBlank=true` is requested but no trustworthy backend check exists
- **THEN** the response reports verification unsupported or failed
- **AND** does not fabricate a blank result.

### Requirement: Raw commands are recorded without semantic claims

`gdb_command` and `probe_command` SHALL execute the Agent's exact raw command payload after Target/ownership validation. MCP SHALL record exact command, output, exit status, and observable before/after state, but SHALL NOT interpret the command as side-effect-free.

#### Scenario: raw command succeeds
- **WHEN** a raw command process exits successfully
- **THEN** the operation may report command execution success
- **AND** reports side effects as `unknown` and invalidates live Artifact verification.

#### Scenario: raw command fails after issue
- **WHEN** a raw command may have partially executed and then fails or disconnects
- **THEN** the response preserves stdout/stderr/exit facts
- **AND** sets stateUnknown according to the observable result.

### Requirement: GDB and RTT helpers never auto-compose sessions

GDB Server, GDB client, and RTT tools SHALL require their explicit prerequisites and SHALL NOT start one another, load firmware, halt, reset, or resume implicitly.

#### Scenario: RTT connection without server
- **WHEN** `rtt_connect` cannot reach an explicitly started RTT endpoint
- **THEN** it returns a structured prerequisite/connection failure
- **AND** does not start GDB Server.

#### Scenario: GDB backtrace requires halt
- **WHEN** `gdb_backtrace` cannot safely inspect a running target
- **THEN** it returns `HALT_REQUIRED`
- **AND** does not issue a halt command.
