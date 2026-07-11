## ADDED Requirements

### Requirement: Completed captures use a JCAP directory package

Jlink_MCP SHALL store each capture under `<projectRoot>/.jlink-mcp/captures/<captureId>.jcap/` with `capture.db`, one or more `raw/capture_*.bin` sample segments, and a versioned append-safe `raw/events.bin` journal.

#### Scenario: capture finalizes

- **WHEN** an HSS capture completes or stops
- **THEN** the package contains `capture.db` and validated raw segments
- **AND** no capture JSON or JSONL is required in the final package.

### Requirement: Raw segments are authoritative and self-describing

Each raw sample segment SHALL contain a versioned header, variable descriptor block, fixed records, DLL/helper/adapter provenance, target/Artifact hashes, monotonic timebase definition, and integrity metadata sufficient to rebuild the capture index. JCAP v1 SHALL encode only 1/2/4-byte integer-like scalars and float32 as preserved `uint32` raw bits and SHALL reject unsupported types.

#### Scenario: database is deleted

- **GIVEN** valid raw segments remain but `capture.db` is missing
- **WHEN** `capture_index_rebuild` runs
- **THEN** variable-column mapping, capture identity, segment ranges, timing, quality, and rebuildable events are restored
- **AND** capture-local lifecycle, write, flag, and fault events are restored from `raw/events.bin`
- **AND** raw evidence is not modified.

### Requirement: Capture lifecycle controls query eligibility

JCAP SHALL represent `planned`, `active`, `finalizing`, `completed`, `stopped`, `recoverable`, and `failed` states and SHALL expose only data validated for the current state.

#### Scenario: helper exits with complete raw records

- **WHEN** capture cannot complete normal finalization
- **THEN** the package is marked `recoverable`
- **AND** rebuild is allowed without deleting raw evidence.

### Requirement: Sampling does not write SQLite or CSV

The HSS sampling loop SHALL append raw records only and SHALL not perform DB bucket generation, CSV formatting, or large metadata serialization.

#### Scenario: high-rate capture is active

- **WHEN** samples are received
- **THEN** records are appended to the active raw segment
- **AND** database finalization runs only after raw capture closes or in a separate non-sampling process.

### Requirement: Capture finalization is atomic

Jlink_MCP SHALL build and validate a temporary DB before publishing `capture.db`.

#### Scenario: finalizer crashes

- **GIVEN** raw capture data has closed
- **WHEN** DB finalization fails before atomic rename
- **THEN** raw data remains available
- **AND** the package is reported as recoverable rather than silently completed.

### Requirement: SQLite runtime selection is a prerequisite gate

The implementation SHALL select and verify one SQLite adapter compatible with supported Node 18, standalone MCP, local loopback Web, and packaging environments before implementing the JCAP database path.

#### Scenario: candidate adapter is evaluated

- **WHEN** the phase-zero runtime spike runs
- **THEN** schema creation, transactions, integrity checking, atomic finalization, and packaged loading are demonstrated
- **AND** no unsupported runtime assumption becomes part of the storage contract.

### Requirement: CSV is generated on demand

CSV SHALL be an export artifact, not a default capture artifact.

#### Scenario: no export requested

- **WHEN** a capture completes
- **THEN** no CSV file is created.

#### Scenario: CSV export requested

- **WHEN** `capture_export` is invoked
- **THEN** the selected variables and time range are written under `export/`
- **AND** existing exports are not silently overwritten.

### Requirement: Historical capture formats are offline-only inputs

Jlink_MCP SHALL NOT retain a long-term runtime compatibility path for historical BIN/JSON/JSONL capture formats. If an accepted test fixture requires migration, a one-time offline converter MAY produce JCAP input and SHALL remain outside the capture runtime.

#### Scenario: historical fixture is required

- **WHEN** a legacy fixture is used by a regression test
- **THEN** it is converted offline before JCAP query or analysis
- **AND** live capture does not write or read the legacy sidecar format.
