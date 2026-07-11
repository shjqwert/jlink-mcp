## ADDED Requirements

### Requirement: Artifact discovery is content-driven

Jlink_MCP SHALL perform a bounded discovery of debug and flash artifacts under `projectRoot`, exclude `.git`, `node_modules`, `.jlink-mcp` and configured caches, and classify ELF-like files by content rather than extension alone.

#### Scenario: IAR OUT contains ELF

- **GIVEN** a `.out` file begins with a valid ELF header
- **WHEN** `artifact_probe` scans the project
- **THEN** the file is returned as a debug artifact candidate
- **AND** its format, hash, path, generation, and supported operations are returned.

#### Scenario: raw BIN is discovered

- **GIVEN** a `.bin` firmware image exists
- **WHEN** `artifact_probe` scans the project
- **THEN** it is classified for flash/verify only
- **AND** it is not offered for variable resolution.

### Requirement: Artifact generations invalidate stale layouts

Jlink_MCP SHALL derive Artifact generation from content identity and SHALL not reuse symbol layouts across changed generations without re-resolution.

#### Scenario: incremental build updates MAP and ELF

- **GIVEN** a session resolved variables from one Artifact generation
- **WHEN** the debug Artifact or paired MAP content changes
- **THEN** prior symbol layouts are marked stale
- **AND** fast write or capture planning rejects them until refreshed.

### Requirement: Variable search returns logical candidates, not guessed addresses

Jlink_MCP SHALL provide `symbol_search` and `symbol_resolve` over global scalars, static scalars, and fixed struct members.

#### Scenario: duplicate static names

- **GIVEN** two source files define the same static symbol name
- **WHEN** the Agent searches that name
- **THEN** both qualified candidates are returned
- **AND** no arbitrary candidate is silently selected.

#### Scenario: fixed struct member

- **GIVEN** a DWARF-resolved fixed member selector
- **WHEN** it is resolved
- **THEN** the result includes root symbol, member path, byte offset, final address, type, size, region, and resolver source.

### Requirement: Unsafe symbol kinds are rejected

Local variables, bitfields, pointer auto-dereference, dynamic arrays, malloc objects, unknown layouts, and multi-image ambiguity SHALL be rejected in the first version.

#### Scenario: pointer selector requested

- **WHEN** a selector requires `->`, pointer dereference, or dynamic traversal
- **THEN** Jlink_MCP returns a structured unsupported-symbol error
- **AND** does not calculate or access a guessed address.

### Requirement: Target and Artifact match state gates operations

Jlink_MCP SHALL report `targetArtifactMatch` as `verified`, `unverified`, or `mismatch` and SHALL bind that state to capture and write plans.

#### Scenario: target identity is unverified

- **WHEN** a read-only capture is planned against an unverified target
- **THEN** the plan may proceed with a persistent warning
- **AND** a write requires verified identity or an explicit policy-approved higher-risk flow.

#### Scenario: target identity mismatches

- **WHEN** target and Artifact identity are known to mismatch
- **THEN** capture and write are rejected before hardware access.

### Requirement: Target identity comes from explicit or project configuration

Jlink_MCP SHALL resolve target identity from an explicit parameter first and supported project configuration files second. It SHALL return `targetId`, configuration source, and confidence, and SHALL NOT infer an MCU from directory name, project name, historical runs, or a built-in default.

#### Scenario: project configuration is ambiguous

- **WHEN** no explicit target is provided and project configuration does not identify exactly one target
- **THEN** Jlink_MCP returns a structured selection-required error
- **AND** does not probe hardware using a guessed MCU.
