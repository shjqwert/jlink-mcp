# capture-backend-routing Specification

## MODIFIED Requirements

### Requirement: HSS-first backend routing

Jlink-MCP SHALL preserve backend priority while reporting fallback evidence explicitly.

#### Scenario: fallback success is not HSS success

- **GIVEN** HSS preflight is available but headless benchmark is blocked
- **AND** RTT is unavailable
- **WHEN** backend routing selects `memory-poll-rsp`
- **THEN** the report includes `fallbackFrom`
- **AND** the report includes `fallbackReason`
- **AND** unavailable HSS and RTT reasons are included
- **AND** RSP emits a low-rate fallback warning
- **AND** the report does not claim HSS success.
