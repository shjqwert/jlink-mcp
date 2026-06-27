# hss-backend Specification

## MODIFIED Requirements

### Requirement: HSS requires explicit SDK configuration and adapter proof

The `jlink-hss` backend SHALL require typed API evidence before it is reported as benchmark-ready.

#### Scenario: HSS preflight exists but typed prototype is missing

- **GIVEN** JScope and JLink DLL preflight is available
- **AND** no trusted typed `JLINK_HSS_*` header/prototype is found
- **WHEN** HSS is probed
- **THEN** the backend returns `available-if-configured`
- **AND** `headlessBenchmark.status` is `blocked`
- **AND** `sdkPrototype.status` is `missing`
- **AND** the reason says the headless benchmark is blocked by missing typed prototypes.

#### Scenario: JScope GUI preflight is not a benchmark

- **GIVEN** JScope GUI can open a project
- **WHEN** HSS status is reported
- **THEN** GUI preflight is reported separately from headless benchmark
- **AND** the backend does not report HSS PASS.

#### Scenario: Typed adapter is required for benchmark-ready HSS

- **GIVEN** an HSS adapter with a benchmark implementation is configured
- **WHEN** HSS is probed
- **THEN** the backend may return `available`
- **AND** the reason identifies typed adapter benchmark availability.
