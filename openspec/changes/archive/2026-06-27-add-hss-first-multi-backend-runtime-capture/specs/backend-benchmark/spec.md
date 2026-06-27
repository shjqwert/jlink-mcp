# backend-benchmark Specification

## ADDED Requirements

### Requirement: Backend benchmarks report measured quality

Jlink-MCP SHALL report benchmark quality using:

- variables;
- requested rate;
- actual rate;
- success rate;
- missed samples;
- read errors;
- jitter;
- duration;
- warnings.

#### Scenario: RSP benchmark warns about low-rate fallback

- **GIVEN** `memory-poll-rsp` benchmark is run
- **WHEN** requested rate exceeds low-rate capability
- **THEN** the result reports the capped actual rate
- **AND** includes a low-rate fallback warning.

#### Scenario: stable TraceAgent stream warning is accepted

- **GIVEN** a stable HM_C095 stream has no state, fault, or counter transitions
- **WHEN** `experiment_analyze` reports that warning
- **THEN** the backend validation treats it as a warning, not a failed capture.
