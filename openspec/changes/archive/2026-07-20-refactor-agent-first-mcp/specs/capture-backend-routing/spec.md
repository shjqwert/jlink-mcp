## ADDED Requirements

### Requirement: HSS backend selection is explicit

The `hss_*` tool family SHALL target only the explicitly configured J-Link HSS backend. Unavailability SHALL be returned with exact capability facts and SHALL NOT trigger RTT, RSP polling, external import, rate reduction, variable reduction, or duration reduction.

#### Scenario: HSS unavailable
- **WHEN** `hss_start` cannot validate or acquire J-Link HSS
- **THEN** it returns the real unavailable/error reason
- **AND** no fallback capture starts.

#### Scenario: Agent chooses another observation path
- **GIVEN** HSS is unavailable
- **WHEN** the Agent explicitly invokes RTT, GDB, memory reads, or an offline import/analysis path that exists independently
- **THEN** that request follows its own tool contract
- **AND** is not reported as HSS capture.

## REMOVED Requirements

### Requirement: HSS-first backend routing
**Reason**: Automatic fallback lets MCP choose a materially different acquisition method, contrary to the Agent-first execution boundary.
**Migration**: Call `hss_capability` and select explicit HSS or another explicit tool from the returned facts.
