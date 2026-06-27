# hss-backend Specification

## ADDED Requirements

### Requirement: HSS requires explicit SDK configuration and adapter proof

The `jlink-hss` backend SHALL require:

- `JLINK_HSS_ENABLED=1`;
- `JLINK_SDK_DIR`;
- an adapter that reports available.

#### Scenario: HSS SDK missing

- **GIVEN** HSS environment variables are missing
- **WHEN** HSS is probed
- **THEN** the backend returns `unavailable`
- **AND** the reason is `J-Link SDK/HSS not configured`.

#### Scenario: HSS adapter missing

- **GIVEN** HSS environment variables are present
- **AND** no HSS adapter is loaded
- **WHEN** HSS is probed
- **THEN** the backend returns `unavailable`
- **AND** no other backend is blocked.

#### Scenario: fake adapter benchmark is explicit

- **GIVEN** a test-only fake HSS adapter is injected
- **WHEN** HSS benchmark runs
- **THEN** the result reports `actualRateHz` and `successRate`.
