# target-context-and-serialization Specification

## Purpose
Define project-bound Target configuration, cross-process Probe serialization, long-lived ownership, and truthful Artifact verification.

## Requirements

### Requirement: Every target operation names its project root

Every Target, Artifact, symbol, variable, HSS, CPU, memory, register, flash, erase, GDB, Probe, RTT, snapshot, and diagnosis request SHALL include an existing canonical `projectRoot`. Capture-only query and analysis requests MAY use `captureId` without Target context.

#### Scenario: project is not configured
- **WHEN** a target-touching tool receives a `projectRoot` with no persisted Target entry
- **THEN** it returns `TARGET_NOT_CONFIGURED`
- **AND** it does not reuse an active, last-used, environment-provided, or other project's Target.

#### Scenario: same project reuses configuration
- **GIVEN** `target_configure` has stored a Target for a canonical project root
- **WHEN** a later request supplies an equivalent normalized path
- **THEN** Jlink-MCP loads that project's configuration
- **AND** does not require repeated J-Link fields.

### Requirement: Target configuration is persistent and generation-bound

`target_configure` SHALL persist ignored `.jlink-mcp/targets.json` entries keyed by canonical project root. It SHALL require device, Probe serial, interface, and speed; it SHALL accept optional Artifact, MAP, SVD, J-Link/GDB tool paths, ports, and Artifact-associated flash-image hashes.

#### Scenario: configure a new project
- **WHEN** `target_configure` receives a valid new project configuration
- **THEN** it atomically stores a new Target generation
- **AND** returns canonical paths, hashes, Probe identity, missing optional inputs, and the generation.

#### Scenario: reconfigure identical values
- **GIVEN** a project already has a Target entry
- **WHEN** `target_configure` is explicitly called again with identical values
- **THEN** it creates a new Target generation
- **AND** invalidates prior live Artifact verification so a same-parameter board replacement cannot inherit it.

#### Scenario: restart standalone MCP
- **GIVEN** a valid Target entry and Artifact verification evidence were persisted
- **WHEN** a new MCP process serves the same project, Target generation, Probe serial, and Artifact generation
- **THEN** it reuses them
- **AND** reports the persisted evidence source and timestamp.

### Requirement: Explicit external input files are allowed but never guessed

Automatic Artifact/SVD discovery SHALL remain inside `projectRoot`. Explicit absolute Artifact, MAP, SVD, and flash files outside the project SHALL be canonicalized, content-validated, hashed, and reported with `external=true`; MCP SHALL NOT copy or silently replace them.

#### Scenario: explicit pack SVD outside project
- **WHEN** `target_configure` receives an absolute SVD path in a local device-pack directory
- **THEN** it may accept the file after validation and hashing
- **AND** preserves its external canonical path.

#### Scenario: ambiguous automatic discovery
- **WHEN** automatic discovery finds multiple valid candidates
- **THEN** it returns a bounded candidate list and selection-required error
- **AND** does not choose by filename, directory, or timestamp.

### Requirement: Physical operations serialize by Probe serial across processes

All physical J-Link operations SHALL execute through an in-process FIFO and a machine-wide lease keyed by Probe serial. Each acquired operation SHALL receive a monotonically ordered `queueSequence`; operations on different serials MAY execute concurrently.

#### Scenario: concurrent same-Probe requests
- **WHEN** separate MCP processes concurrently request read, write, status, and control operations for one Probe serial
- **THEN** no two physical operations overlap
- **AND** their returned queue sequences and timestamps identify the actual execution order.

#### Scenario: queued operation fails
- **WHEN** one queued operation fails or times out
- **THEN** the lease is released safely
- **AND** later queued operations remain executable.

#### Scenario: multiple probes
- **WHEN** operations target two distinct configured serials
- **THEN** their machine-wide leases are independent
- **AND** they may execute in parallel.

#### Scenario: Probe identity cannot select uniquely
- **WHEN** multiple probes are visible and the request cannot resolve the configured serial
- **THEN** Jlink-MCP returns `PROBE_SELECTION_REQUIRED`
- **AND** does not use a shared default queue to guess a device.

### Requirement: Long-lived owners exclude incompatible hardware access

HSS capture and J-Link GDB Server SHALL hold explicit long-lived ownership of their Probe.

#### Scenario: HSS owns Probe
- **GIVEN** an HSS capture is active
- **WHEN** an incompatible hardware tool is called
- **THEN** it returns `CAPTURE_ACTIVE`
- **AND** MCP does not stop the capture.

#### Scenario: capture-aware write
- **GIVEN** HSS is active and the requested variable is declared in the capture
- **WHEN** `write_variable` is called
- **THEN** it executes through the capture helper and records an aligned event.

#### Scenario: undeclared capture variable
- **GIVEN** HSS is active
- **WHEN** `write_variable` targets a variable absent from that capture descriptor
- **THEN** it returns `VARIABLE_NOT_IN_CAPTURE`
- **AND** does not alter the active descriptor or target memory.

#### Scenario: GDB Server owns Probe
- **GIVEN** `gdb_server_start` has acquired the Probe
- **WHEN** Commander, direct MCU, flash/erase, Probe command, or HSS access is requested
- **THEN** it returns `GDB_SESSION_ACTIVE`
- **AND** MCP does not stop or restart GDB Server.

### Requirement: Artifact verification is bound and invalidated truthfully

Live `verified` status SHALL be bound to project root, Target generation, Probe serial, and Artifact generation. It SHALL be established only by an associated flash-image flash+verify or a manifest-bound firmware identity read.

#### Scenario: associated flash succeeds
- **WHEN** `flash` receives a file whose hash is associated with the selected Artifact and vendor verification succeeds
- **THEN** the matching Artifact becomes `verified`
- **AND** the evidence is persisted with the binding tuple.

#### Scenario: raw command executes
- **GIVEN** the current Artifact is verified
- **WHEN** `gdb_command` or `probe_command` executes
- **THEN** the status becomes `unverified`
- **AND** the response reports unknown side effects.

#### Scenario: erase executes
- **WHEN** erase is issued
- **THEN** Artifact status becomes `mismatch`
- **AND** it remains so until new verification evidence is established.

#### Scenario: configuration or identity changes
- **WHEN** Target generation changes, configured Probe serial does not match, or connection identity is abnormal
- **THEN** prior verification becomes invalid
- **AND** symbol writes and symbol HSS remain blocked.
