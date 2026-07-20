## MODIFIED Requirements

### Requirement: Preflight and read operations have no hidden state changes

Preflight, status, memory reads, variable reads, register reads, crash diagnosis, GDB setup, and RTT setup SHALL NOT implicitly halt, reset, resume, recover, flash, erase, or write the target.

#### Scenario: running target cannot expose required state
- **WHEN** a core-register, crash-diagnosis, or backtrace request cannot be fulfilled while the target runs
- **THEN** it returns available partial data and `HALT_REQUIRED`
- **AND** target running state remains unchanged.

#### Scenario: preflight connection fails
- **WHEN** a non-mutating preflight cannot connect or read its Probe state
- **THEN** it returns the failure and suggested explicit next actions
- **AND** does not attempt reset-under-connect, halt, speed fallback, or power recovery.

### Requirement: CPU control has explicit final states

`target_control` SHALL accept exactly `halt`, `resume`, `reset`, and `reset_halt` actions. Halt SHALL finish halted, resume SHALL finish running, reset SHALL finish running, and reset-halt SHALL finish halted.

#### Scenario: already satisfied CPU state
- **WHEN** halt is requested on an already halted target or resume on an already running target
- **THEN** it succeeds as a no-op
- **AND** reports matching before/after observations and no unrequested effect.

#### Scenario: reset running
- **WHEN** `target_control(action=reset)` executes
- **THEN** it explicitly requests reset and running final state
- **AND** reports every observed intermediate/final state without hiding vendor behavior.

### Requirement: CPU-core registers are distinct from SVD registers

`core_register_access` SHALL accept bounded `read`, `read_all`, and `write` actions for supported CPU-core registers only. It SHALL NOT accept SVD peripheral selectors.

#### Scenario: read all available core registers
- **WHEN** `core_register_access(action=read_all)` runs while the backend can read the current target state without changing it
- **THEN** it returns the available named core-register set
- **AND** reports omitted or unavailable registers explicitly.

#### Scenario: write core register without verification
- **WHEN** `core_register_access(action=write)` succeeds with default options
- **THEN** it reports `executed_unverified`
- **AND** does not perform an implicit readback.

### Requirement: GDB and RTT helpers never auto-compose sessions

GDB and RTT tools SHALL require their explicit prerequisites and SHALL NOT start one another, load firmware, halt, reset, resume, or stop an existing owner implicitly.

#### Scenario: RTT open without endpoint
- **WHEN** `rtt_open` cannot reach an explicitly available endpoint for the configured Target
- **THEN** it returns a structured prerequisite or connection failure
- **AND** does not call `gdb_open`.

#### Scenario: GDB backtrace requires halt
- **WHEN** `gdb_backtrace` cannot safely inspect a running target
- **THEN** it returns `HALT_REQUIRED`
- **AND** does not issue a halt command.

## ADDED Requirements

### Requirement: GDB lifecycle is explicit and state-observed

`gdb_open` SHALL start J-Link GDB Server, load the current ELF as host-side symbols, connect one managed GDB client, and acquire the long-lived GDB owner. It SHALL NOT flash or intentionally change target execution state. `gdb_command`, `gdb_wait`, and `gdb_backtrace` SHALL require that managed session. `gdb_close` SHALL disconnect the client and stop its server without reset or auto-resume.

#### Scenario: GDB open succeeds
- **WHEN** the configured Target, current typed Artifact, ports, and Probe are available
- **THEN** `gdb_open` returns server/client process facts, symbol identity, ownership, and before/after target state
- **AND** no target image is loaded or programmed.

#### Scenario: GDB client connection fails after server start
- **WHEN** the server starts but the managed client cannot connect
- **THEN** the result reports each completed lifecycle step and remaining process/owner state
- **AND** does not hide the partial failure or restore MCU state automatically.

#### Scenario: GDB close observes a halted target
- **WHEN** `gdb_close` disconnects while the target is halted
- **THEN** it leaves the target halted unless vendor behavior proves otherwise
- **AND** reports the actual final state without auto-resume.

### Requirement: Crash diagnosis is complete only on an already halted Cortex-M target

`diagnose_crash` SHALL support an already halted Cortex-M target by collecting PC, LR, SP, xPSR, MSP, PSP, CFSR, HFSR, DFSR, AFSR, MMFAR, BFAR, SHCSR, and ICSR; decoding architectural Fault bits; validating and decoding an exception stack frame when provable; and mapping observed addresses through the current Artifact. It SHALL reuse an already-open managed GDB session for backtrace when available. It SHALL NOT halt, reset, resume, clear Fault state, start GDB, or guess unsupported architecture/layout.

#### Scenario: target is running
- **WHEN** `diagnose_crash` observes a running target
- **THEN** it returns `HALT_REQUIRED` with available non-intrusive facts
- **AND** performs no halt or register collection that requires halt.

#### Scenario: halted Cortex-M Fault
- **WHEN** the target is halted, its Cortex-M profile is supported, and Fault/system registers are readable
- **THEN** the result includes raw and decoded register evidence, candidate exception frame validation, Artifact/source mapping, warnings, and completeness state
- **AND** no Fault register is cleared.

#### Scenario: no managed GDB session
- **WHEN** hardware/core/Fault collection succeeds but no managed GDB session is open
- **THEN** diagnosis returns the collected evidence and marks backtrace unavailable with the explicit prerequisite
- **AND** does not start GDB internally.

#### Scenario: exception frame is not provable
- **WHEN** EXC_RETURN, stack pointer, memory bounds, alignment, or xPSR evidence cannot validate a frame
- **THEN** the result reports raw evidence and `frameStatus=unverified`
- **AND** does not fabricate stacked registers or a call stack.
