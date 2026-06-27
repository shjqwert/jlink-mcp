# capture-backend-routing Specification

## ADDED Requirements

### Requirement: HSS-first backend routing

Jlink-MCP SHALL select runtime capture backends in this priority order:

1. `jlink-hss`
2. `direct-rtt-channel`
3. `memory-poll-rsp`
4. `external-import`

#### Scenario: HSS is selected when available

- **GIVEN** HSS SDK configuration is present
- **AND** the HSS adapter reports available
- **WHEN** backend routing runs
- **THEN** Jlink-MCP selects `jlink-hss`.

#### Scenario: RTT is selected when HSS is unavailable

- **GIVEN** HSS is unavailable
- **AND** an RTT control block and requested channel exist
- **WHEN** backend routing runs
- **THEN** Jlink-MCP selects `direct-rtt-channel`.

#### Scenario: RSP is last realtime fallback

- **GIVEN** HSS and RTT are unavailable
- **WHEN** backend routing runs for realtime capture
- **THEN** Jlink-MCP selects `memory-poll-rsp`
- **AND** the result warns that it is a low-rate fallback.

#### Scenario: unavailable preferred backend is not faked

- **GIVEN** a preferred backend is requested
- **AND** that backend is unavailable
- **WHEN** backend routing runs
- **THEN** Jlink-MCP returns an unavailable reason
- **AND** does not report fake success.
