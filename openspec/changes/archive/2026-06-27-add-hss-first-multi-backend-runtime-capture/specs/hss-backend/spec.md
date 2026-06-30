# hss-backend Specification

## ADDED Requirements

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
