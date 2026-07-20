## MODIFIED Requirements

### Requirement: HSS exposes a direct lifecycle without execution tokens

Jlink-MCP SHALL expose only `hss_start`, `hss_status`, `hss_stop`, and `hss_recover`. `hss_start` SHALL resolve variables, validate current Artifact and backend capability, calculate layout/capacity, and revalidate all facts at execution time without plan IDs, challenge, or approval tokens. `dryRun=true` SHALL return that bounded preview without starting a Helper, acquiring a long-lived owner, or creating a JCAP package.

#### Scenario: dry-run preview
- **WHEN** `hss_start` receives schema-valid inputs with `dryRun=true`
- **THEN** it returns resolved variables, capability, frame layout, expected sample count, and estimated data size
- **AND** starts no capture and creates no output package.

#### Scenario: direct start
- **WHEN** `hss_start` receives valid direct variables, rate, duration, Target, and output context with `dryRun=false` or omitted
- **THEN** it repeats current-state validation and starts capture without a prior plan
- **AND** returns its capture ID and active package path.

### Requirement: HSS requires explicit SDK configuration and adapter proof

The `jlink-hss` backend SHALL require an available Helper/runtime whose version, architecture, ABI, SDK/DLL location, and capability can be validated internally at dry-run or start time. File hashes SHALL be reported but SHALL NOT require an approved trust profile.

#### Scenario: HSS runtime missing
- **WHEN** the configured J-Link HSS runtime or Helper cannot be located or loaded
- **THEN** `hss_start` returns `HSS_HELPER_MISSING` or the exact structured discovery failure
- **AND** no capture starts.

#### Scenario: ABI incompatible
- **WHEN** Helper architecture, exported API, protocol, or ABI is incompatible
- **THEN** `hss_start` returns a structured incompatibility error
- **AND** unknown or changed hash alone is not the blocking reason.

#### Scenario: fake adapter test is explicit
- **WHEN** a test injects the fake adapter
- **THEN** results identify the fake backend and report actual rate/success metrics
- **AND** no result is presented as real hardware evidence.

### Requirement: HSS capture planning enforces variable limits

HSS validation SHALL enforce at most ten synchronized scalar variables, a frame rate no greater than 1 kHz, and duration from 1 through 60 seconds for the current J-Link backend. Storage SHALL support future longer durations without a format change. A configured target quality counter SHALL occupy one of the ten variable slots.

#### Scenario: too many variables requested
- **WHEN** dry-run or start requests eleven variables including any quality counter
- **THEN** Jlink-MCP returns a structured bounds error
- **AND** no package or hardware capture starts.

#### Scenario: rate or duration exceeds current capability
- **WHEN** a request exceeds 1 kHz or 60 seconds
- **THEN** it is rejected with reported current limits
- **AND** MCP does not silently clamp the request.

#### Scenario: ten-variable frame
- **WHEN** ten valid variables are captured at 1 kHz
- **THEN** each sample frame uses one shared index/tick and fixed descriptor order
- **AND** quality status and counters follow the available qualified source rather than assuming zero loss.

## ADDED Requirements

### Requirement: Clean Windows distribution contains the HSS Helper

The supported Windows x64 build and package flow SHALL build the existing native HSS Helper from source and include it at the runtime path expected by the standalone MCP. The generated executable SHALL remain Git-ignored.

#### Scenario: clean source build
- **WHEN** the documented build runs on Windows x64 with CMake and a supported Visual Studio toolchain
- **THEN** it compiles the Helper before package validation
- **AND** `hss_start(dryRun=true)` no longer fails solely because the generated Helper is absent.

#### Scenario: packed distribution
- **WHEN** `npm pack` completes in CI
- **THEN** the packed file list contains the generated Helper and standalone JavaScript
- **AND** no local J-Link DLL, target binary, capture, or database is included.

### Requirement: HSS quality claims require a qualified source

Each capture SHALL record `qualityStatus` and `qualitySource`. Credible vendor loss/overflow counters MAY produce `qualityStatus=reported`. Otherwise an explicitly configured target counter oracle MAY produce `qualityStatus=reported`; without either qualified source, status SHALL be `partial`, loss/overflow counts SHALL remain null, and the capture SHALL NOT claim zero loss.

#### Scenario: no independent quality source
- **WHEN** the J-Link runtime exposes no documented loss counters and no target counter oracle is configured
- **THEN** capture metadata and summary report `qualityStatus=partial` and `qualitySource=none`
- **AND** dropped and overflow counts remain null even when all received frame indices are contiguous.

#### Scenario: credible vendor counters
- **WHEN** the runtime returns documented monotonic loss/overflow counters with validated semantics
- **THEN** metadata reports `qualityStatus=reported`, `qualitySource=jlink`, and the observed counts
- **AND** preserves the bounded vendor evidence needed to reproduce the claim.

### Requirement: Target counter oracle is explicit and bounded

`hss_start` MAY accept one `qualityOracle` that references a declared unsigned scalar capture variable and supplies a finite positive expected increment per frame, non-negative integer tolerance, and counter modulus derived from its width. Oracle evaluation SHALL handle one modular wrap and SHALL never infer across invalid samples, resets, write intervals, or ambiguous deltas.

#### Scenario: valid target counter evidence
- **WHEN** adjacent valid counter samples differ by the configured expected increment within tolerance, including one valid modular wrap
- **THEN** the capture reports `qualitySource=target_counter`, evaluated pair count, inferred missed-frame count, and oracle configuration
- **AND** quality can be `reported` when all required pairs are unambiguous.

#### Scenario: counter reveals a gap
- **WHEN** a valid adjacent delta exceeds the expected increment by an unambiguous whole-frame multiple within tolerance
- **THEN** the excess is counted as inferred missed frames
- **AND** the affected sample is marked with the existing dropped-before status flag.

#### Scenario: oracle becomes ambiguous
- **WHEN** the counter resets, changes during a write interval, lacks enough valid pairs, or produces a delta incompatible with its configured increment/tolerance
- **THEN** quality falls back to `partial` with an oracle diagnostic
- **AND** no zero-loss or exact-loss claim is retained.
