# hss-validation-state Specification

## MODIFIED Requirements

### Requirement: HSS availability requires benchmark evidence

The `jlink-hss` backend SHALL be selected only when HSS benchmark evidence has passed.

#### Scenario: JScope-only preflight

- **GIVEN** JScope GUI/project evidence exists
- **WHEN** backend probing runs
- **THEN** HSS is reported as preflight-only
- **AND** HSS is not selected as benchmark-ready.

#### Scenario: DLL exports only

- **GIVEN** `JLink_x64.dll` has `JLINK_HSS_*` exports
- **AND** no GetCaps/Read/Benchmark evidence passed
- **WHEN** backend probing runs
- **THEN** HSS state is `blocked_missing_adapter`
- **AND** fallback reasons are preserved.

#### Scenario: benchmark pass

- **GIVEN** an HSS adapter has benchmark capability
- **WHEN** backend probing runs
- **THEN** HSS may be selected
- **AND** the validation state is `experimental_benchmark_pass`.
