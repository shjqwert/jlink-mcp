## MODIFIED Requirements

### Requirement: Every target operation names its project root

Every Target, Artifact, symbol, variable, HSS, CPU, memory, register, flash, erase, GDB, Probe, RTT, and diagnosis request SHALL include an existing canonical `projectRoot`. Capture-only list, summary, series, event-window, and CSV requests MAY use `captureId` without Target context.

#### Scenario: project is not configured
- **WHEN** a target-touching tool receives a `projectRoot` with no persisted Target entry
- **THEN** it returns `TARGET_NOT_CONFIGURED`
- **AND** it does not reuse an active, last-used, environment-provided, or other project's Target.

#### Scenario: same project reuses configuration
- **GIVEN** `target_configure` has stored a Target for a canonical project root
- **WHEN** a later request supplies an equivalent normalized path
- **THEN** Jlink-MCP loads that project's configuration
- **AND** does not require repeated J-Link fields.

### Requirement: Long-lived owners exclude incompatible hardware access

HSS capture, J-Link GDB session, and persistent J-Link memory session SHALL hold explicit long-lived ownership of their Probe. Ownership SHALL remain bound to project root, Target generation, Probe serial, controller process identity, and native resource process identity.

#### Scenario: HSS owns Probe
- **GIVEN** an HSS capture is active
- **WHEN** an incompatible hardware tool is called
- **THEN** it returns `CAPTURE_ACTIVE`
- **AND** MCP does not stop the capture.

#### Scenario: capture-aware write
- **GIVEN** HSS is active and the requested variable is declared in the capture
- **WHEN** `write_variable` is called
- **THEN** it executes through the capture Helper and records an aligned event.

#### Scenario: GDB owns Probe
- **GIVEN** `gdb_open` has acquired the Probe
- **WHEN** Commander, direct MCU, memory-session, flash/erase, Probe command, or HSS access is requested
- **THEN** it returns `GDB_SESSION_ACTIVE`
- **AND** MCP does not stop or restart GDB.

#### Scenario: memory session belongs to this MCP process
- **GIVEN** a matching memory session owns the Probe in the current MCP process
- **WHEN** a memory or typed-variable operation is queued for the same Target generation
- **THEN** it executes through that owner connection under the normal queue sequence
- **AND** no second physical connection overlaps it.

#### Scenario: memory session belongs to another MCP process
- **GIVEN** another live MCP process owns the Probe with a memory session
- **WHEN** any incompatible operation is requested
- **THEN** it returns `MEMORY_SESSION_ACTIVE` with owner facts
- **AND** does not terminate or adopt that session.

## ADDED Requirements

### Requirement: Persistent memory sessions are Target-generation bound

Jlink-MCP SHALL maintain at most one local persistent J-Link memory session for a configured Target generation. The session SHALL validate Helper protocol, J-Link DLL identity, Probe serial, device, interface, speed, and target execution state before becoming usable.

#### Scenario: first memory operation
- **WHEN** the first read or write for a configured Target generation acquires the Probe queue
- **THEN** MCP starts one native memory session, claims the Probe owner using its live process identity, and executes the request
- **AND** retains the validated connection for later matching memory operations.

#### Scenario: matching later operation
- **WHEN** a later operation uses the same project root, Target generation, and Probe serial
- **THEN** MCP reuses the existing native connection
- **AND** returns a new queue sequence for that physical command.

#### Scenario: Target is reconfigured
- **WHEN** `target_configure` replaces a Target generation with a local memory session
- **THEN** MCP closes and releases that session before persisting the new generation
- **AND** never reuses the old connection for the new generation.

### Requirement: Memory-session closure is explicit transport evidence

The local memory session SHALL close on standalone shutdown, native transport failure, Target generation change, independent-session verification, or before an incompatible explicit hardware operation. Closure SHALL observe target execution state and SHALL NOT halt, reset, or resume it.

#### Scenario: incompatible local operation
- **GIVEN** the current MCP owns a matching memory session
- **WHEN** the Agent explicitly requests Target control, flash, erase, raw Probe/GDB command, `gdb_open`, or HSS start
- **THEN** MCP closes and releases the memory session before queuing that request
- **AND** records the transport transition without claiming an MCU side effect.

#### Scenario: close changes or loses target state
- **WHEN** target execution state changes or becomes unknown while the memory session closes
- **THEN** the requested incompatible operation does not start
- **AND** the result reports `HIDDEN_STATE_CHANGE` or unknown state without automatic recovery.

#### Scenario: native session exits unexpectedly
- **WHEN** the native memory-session process exits before a command completes
- **THEN** MCP releases ownership only after observing process termination and fails the operation
- **AND** marks a dispatched write as state unknown when its final outcome cannot be proven.
