# capture-backend-routing Specification

## Purpose
Define explicit HSS backend selection without automatic acquisition fallback.

## Requirements

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
