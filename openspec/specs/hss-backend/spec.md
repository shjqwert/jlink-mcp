# hss-backend Specification

## Purpose
TBD - created by archiving change add-hss-first-multi-backend-runtime-capture. Update Purpose after archive.
## Requirements
### Requirement: HSS requires explicit SDK configuration and adapter proof

The `jlink-hss` backend SHALL require:

- `JLINK_SDK_DIR`;
- an adapter that reports available.

#### Scenario: HSS SDK missing

- **GIVEN** HSS SDK configuration is missing
- **WHEN** HSS is probed
- **THEN** the backend returns `unavailable`
- **AND** the reason is `J-Link SDK/HSS not configured`.

#### Scenario: HSS adapter missing

- **GIVEN** HSS SDK configuration is present
- **AND** no HSS adapter is loaded
- **WHEN** HSS is probed
- **THEN** the backend returns `unavailable`
- **AND** no other backend is blocked.

#### Scenario: fake adapter benchmark is explicit

- **GIVEN** a test-only fake HSS adapter is injected
- **WHEN** HSS benchmark runs
- **THEN** the result reports `actualRateHz` and `successRate`.

---

### Requirement: HSS capture artifacts expose query and event hooks

Completed HSS captures SHALL expose raw data, metadata, variable definitions, event markers, flag intervals, and export/query hooks for downstream AI analysis and UI access.

#### Scenario: completed HSS capture indexed

- **WHEN** an HSS capture completes
- **THEN** Jlink-MCP records the capture in the local SQL query index
- **AND** the raw HSS data remains available in the capture directory.

#### Scenario: write event captured during HSS capture

- **GIVEN** a variable write occurs during an HSS capture
- **WHEN** the capture is finalized
- **THEN** Jlink-MCP stores a write event marker
- **AND** includes nearby flag intervals that can be queried by AI and UI consumers.

---

### Requirement: HSS capture planning enforces variable limits

HSS capture planning SHALL validate requested variable count, sample rate, and duration against the available backend capability before capture starts.

#### Scenario: too many variables requested

- **GIVEN** the backend supports ten variables
- **WHEN** a capture plan requests eleven variables
- **THEN** Jlink-MCP rejects the plan with a structured validation error
- **AND** no capture is started.

#### Scenario: future higher-rate backend

- **GIVEN** a backend reports a higher supported sample rate or longer duration
- **WHEN** capture planning validates a request within those reported limits
- **THEN** Jlink-MCP accepts the plan without changing the storage contract.

---

### Requirement: HSS variable writes support production scalar and fixed-array targets

HSS variable writes SHALL support allowlisted RAM scalar targets, fixed array element targets, and fixed contiguous array slice targets through the existing variable write planning and execution path.

#### Scenario: fixed array slice write accepted

- **GIVEN** policy allowlists a fixed RAM array with contiguous slice writes enabled
- **WHEN** `variable_write_plan` requests `targetRef.kind: "array_slice"` with a valid `startIndex` and value count
- **THEN** Jlink-MCP resolves the target from ELF/MAP symbols
- **AND** plans a bounded write with old values, new values, readback values, and event metadata.

#### Scenario: unsupported array shape rejected

- **GIVEN** a requested write targets a pointer, dynamic array, multi-dimensional array, or non-contiguous index list
- **WHEN** `variable_write_plan` validates the target
- **THEN** Jlink-MCP rejects the plan with a structured validation error
- **AND** no target memory is written.
