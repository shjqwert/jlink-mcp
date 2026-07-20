## ADDED Requirements

### Requirement: HSS exposes a direct lifecycle without execution tokens

Jlink-MCP SHALL expose `hss_capability`, optional read-only `hss_plan`, direct `hss_start`, `hss_status`, `hss_stop`, and `hss_recover`. Plan output SHALL be data only and SHALL NOT be required as an execution permit.

#### Scenario: start from direct input
- **WHEN** `hss_start` receives valid direct variables, rate, duration, Target, and output context
- **THEN** it starts capture without plan ID, challenge, or approval token
- **AND** returns its capture ID and active package paths.

#### Scenario: plan then start
- **WHEN** an Agent copies valid fields from `hss_plan` into `hss_start`
- **THEN** start revalidates current Target/Artifact/capability state
- **AND** does not trust stale plan output as authority.

## MODIFIED Requirements

### Requirement: HSS requires explicit SDK configuration and adapter proof

The `jlink-hss` backend SHALL require an available helper/runtime whose version, architecture, ABI, SDK/DLL location, and capability can be validated at runtime. File hashes SHALL be reported but SHALL NOT require an approved trust profile.

#### Scenario: HSS runtime missing
- **WHEN** the configured J-Link HSS runtime/helper cannot be located or loaded
- **THEN** `hss_capability` reports `unavailable` with exact discovery facts
- **AND** no capture starts.

#### Scenario: ABI incompatible
- **WHEN** helper architecture, exported API, protocol, or ABI is incompatible
- **THEN** `hss_start` returns a structured incompatibility error
- **AND** unknown or changed hash alone is not the blocking reason.

#### Scenario: fake adapter test is explicit
- **WHEN** a test injects the fake adapter
- **THEN** results identify the fake backend and report actual rate/success metrics
- **AND** no result is presented as real hardware evidence.

### Requirement: HSS capture artifacts expose query and event hooks

Terminal HSS captures SHALL produce JCAP v1 metadata, Raw samples/events, per-capture SQLite DB, variable definitions, lifecycle/quality events, and bounded query hooks for AI and UI consumers.

#### Scenario: completed HSS capture indexed
- **WHEN** an HSS capture completes or stops with valid Raw
- **THEN** Jlink-MCP atomically publishes its per-capture DB
- **AND** preserves metadata and Raw as the rebuild source of truth.

#### Scenario: write event captured during HSS capture
- **GIVEN** a declared capture variable is written through capture-aware `write_variable`
- **WHEN** the write completes or fails after issue
- **THEN** Jlink-MCP stores its operation interval, neighboring sample indices/ticks, requested/observed values, and verification facts
- **AND** missing optional old/readback fields are represented as null with `not_requested` state.

### Requirement: HSS capture planning enforces variable limits

HSS validation SHALL enforce at most ten synchronized scalar variables, a frame rate no greater than 1 kHz, and duration from 1 through 60 seconds for the current J-Link backend. Storage SHALL support future longer durations without a format change.

#### Scenario: too many variables requested
- **WHEN** a plan or start requests eleven variables
- **THEN** Jlink-MCP returns a structured bounds error
- **AND** no package or hardware capture starts.

#### Scenario: rate or duration exceeds current capability
- **WHEN** a request exceeds 1 kHz or 60 seconds
- **THEN** it is rejected with reported current limits
- **AND** MCP does not silently clamp the request.

#### Scenario: ten-variable frame
- **WHEN** ten valid variables are captured at 1 kHz
- **THEN** each sample frame uses one shared index/tick and fixed descriptor order
- **AND** quality counters report missing, dropped, and overflow frames explicitly.

### Requirement: HSS variable writes support production scalar and fixed-array targets

During HSS, direct writes SHALL support only capture-declared typed RAM variables whose terminal type is one supported scalar. The write SHALL use the active helper path and common optional verification/restore contract; it SHALL NOT require an allowlist or variable-write plan token.

#### Scenario: declared scalar write accepted
- **GIVEN** the capture is active, Artifact match is verified, and the variable is in its immutable descriptor
- **WHEN** `write_variable` requests a supported encoded value
- **THEN** the helper serializes the write with sampling and emits an event
- **AND** capture remains active unless a real failure interrupts it.

#### Scenario: array element declared in capture
- **GIVEN** a fixed array element was resolved to a supported scalar before start and appears in the descriptor
- **WHEN** it is written during capture
- **THEN** MCP uses that frozen logical identity/layout
- **AND** does not expand the array or accept a slice dynamically.

#### Scenario: unsupported or undeclared target
- **WHEN** the write targets a pointer, dynamic layout, slice, or variable absent from the descriptor
- **THEN** it fails before target access
- **AND** does not modify the active capture definition.
