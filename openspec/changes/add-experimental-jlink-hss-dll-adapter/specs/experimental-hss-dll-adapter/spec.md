# experimental-hss-dll-adapter Specification

## ADDED Requirements

### Requirement: Experimental HSS DLL calls are env-gated

Jlink-MCP SHALL NOT call `JLink_x64.dll` HSS functions unless `JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API=1`.

#### Scenario: env disabled

- **GIVEN** the experimental env variable is absent
- **WHEN** `hss_dll_getcaps` is requested
- **THEN** the result is `blocked`
- **AND** the DLL function is not called.

### Requirement: Candidate API is not official SDK evidence

Jlink-MCP SHALL label public `JLINK_HSS_*` prototypes as experimental candidate evidence.

#### Scenario: candidate recorded

- **GIVEN** HSS candidate metadata is reported
- **THEN** it includes function names, struct sizes, field layout, calling convention candidate, `officialSdkHeaderFound=false`, `publicPrototypeCandidate=true`, and `productionReady=false`.

### Requirement: Helper failures are structured

The native HSS helper SHALL return JSON for missing DLL, missing exports, timeout, and missing base API prototype states.

#### Scenario: base API prototype missing

- **GIVEN** smoke or benchmark is requested
- **AND** no local official JLinkARM connect API prototype evidence exists
- **THEN** the helper returns `JLINK_BASE_API_PROTOTYPE_MISSING`
- **AND** reports no reset, halt, flash, or write was issued.
