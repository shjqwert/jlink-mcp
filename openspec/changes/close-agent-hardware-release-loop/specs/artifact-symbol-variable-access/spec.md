## MODIFIED Requirements

### Requirement: Artifact discovery is content-driven and bounded

`artifact_probe` SHALL inspect a configured current Artifact first, then common build output directories including `Debug/Exe`, `Debug/List`, `Release/Exe`, and `Release/List`, then the remaining project tree within explicit file, depth, candidate, Artifact-byte, and hashed-byte bounds. It SHALL exclude source-control, dependency, generated output, cache, native-build, and evidence directories; classify files by content; distinguish typed debug Artifacts from flash inputs; and never silently select among multiple valid candidates.

#### Scenario: configured Artifact remains valid
- **WHEN** the current Target generation names an Artifact whose content still matches its stored identity
- **THEN** `artifact_probe` returns that candidate first without requiring a general scan
- **AND** reports it as configured rather than newly guessed.

#### Scenario: common build output exists
- **WHEN** no valid configured Artifact exists and a supported debug Artifact is present in a common build directory
- **THEN** that directory is scanned before the remaining project tree
- **AND** the candidate retains canonical path, format, size, hash, debug capabilities, and paired MAP candidates.

#### Scenario: scan reaches a bound
- **WHEN** discovery reaches any configured scan bound after inspecting one or more files
- **THEN** it returns every accumulated bounded candidate plus `scanTruncated=true`, scanned counts, and the reached bound
- **AND** it does not discard useful candidates or report a complete scan.

#### Scenario: multiple candidates
- **WHEN** more than one candidate satisfies discovery
- **THEN** the tool returns `ARTIFACT_SELECTION_REQUIRED` with the accumulated bounded candidate list and truncation state
- **AND** does not select by extension, name, timestamp, or directory order.

### Requirement: Artifact generation gates symbol operations

Each resolution result SHALL report Artifact generation and layout hash, but public variable and HSS requests SHALL accept logical selectors without requiring the Agent to echo either identity. MCP SHALL re-resolve or validate the selector against the current Target generation before target access. An unverified current generation SHALL allow warned `read_variable` but SHALL block `write_variable` and symbol HSS.

#### Scenario: unverified variable read
- **WHEN** the current layout is valid but target/Artifact match is unverified
- **THEN** `read_variable` may return the actual memory value with an `ARTIFACT_UNVERIFIED` warning
- **AND** it does not claim the symbol address is target-confirmed.

#### Scenario: unverified variable write
- **WHEN** `write_variable` is requested while match is unverified
- **THEN** it returns `ARTIFACT_NOT_VERIFIED`
- **AND** it does not issue a write.

#### Scenario: stale cached selector
- **WHEN** an Artifact hash or mapped layout changes after a selector was cached
- **THEN** MCP re-resolves the logical selector against the current layout or returns `STALE_ARTIFACT_REFERENCE`
- **AND** never reuses the old address silently.

### Requirement: Hot Variables persist logical identity, not trusted addresses

Hot Variable storage SHALL be an internal project-specific selector cache populated by successful `symbol_resolve` and symbol-based operations. It SHALL store logical name, requested type, Artifact/layout identity, and stale state across MCP restarts; no Hot Variable maintenance tool SHALL be public.

#### Scenario: Artifact changes
- **GIVEN** selectors were cached for one Artifact generation
- **WHEN** Target configuration selects a new generation
- **THEN** affected cache entries become stale
- **AND** their stored addresses cannot be used for target access.

#### Scenario: stale selector is used again
- **WHEN** `read_variable`, `write_variable`, or `hss_start` names a stale cached selector
- **THEN** MCP refreshes only that logical selector against the current typed Artifact before access
- **AND** returns its individual resolution error if refresh is not exact.

### Requirement: Structured writes share explicit verification options

`write_variable` SHALL default to `captureOld=true`, `verify=true`, and `restore=false`. Default verification SHALL use `verificationConnection=same_session` and the `exact` comparator. An explicit `independent_session` mode SHALL close the writing connection and verify through a new validated connection. Capture-aware writes SHALL verify through the active capture owner. Every result SHALL label the exact evidence source and SHALL NOT equate readback with target-program consumption.

#### Scenario: default variable write
- **WHEN** a verified writable RAM variable is written with default options
- **THEN** MCP reads the old bytes, encodes and writes the requested value, and performs exact same-session readback before closing the persistent connection
- **AND** returns old, requested, readback, encoded bytes, comparator, verification source, and pass/fail.

#### Scenario: default verification mismatch
- **WHEN** default same-session readback differs from requested encoded bytes
- **THEN** the operation returns `ok=false` with both byte sequences and `same_session_readback`
- **AND** does not fabricate write success or target consumption.

#### Scenario: independent-session verification
- **WHEN** `verificationConnection=independent_session` is requested
- **THEN** MCP closes the writing connection, opens a new validated connection, and performs readback there
- **AND** labels the evidence `independent_session_readback` and reports connection-close uncertainty truthfully.

#### Scenario: capture-aware verification
- **WHEN** HSS owns the Probe and `write_variable` targets a declared capture variable
- **THEN** the capture Helper performs old read, write, and readback through the capture-owner connection
- **AND** labels it `capture_owner_readback` and records the aligned event.

## ADDED Requirements

### Requirement: Readback and target consumption are separate evidence

A matching readback SHALL prove only the bytes observed by its named J-Link connection. Target-program consumption SHALL require a separate target response or behavior observation performed by the Agent through an existing read, HSS, register, memory, RTT, GDB, or capture-query tool.

#### Scenario: readback matches without response evidence
- **WHEN** requested bytes match same-session, independent-session, or capture-owner readback but no response variable or behavior is observed
- **THEN** the write may be reported as readback-verified
- **AND** target consumption remains `not_observed`.

#### Scenario: target response is observed
- **WHEN** a later operation observes the response variable or behavior satisfying the test expectation
- **THEN** acceptance evidence links the write and observation operation identities
- **AND** does not rewrite the original write result into a stronger claim.
