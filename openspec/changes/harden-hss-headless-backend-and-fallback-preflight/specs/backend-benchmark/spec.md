# backend-benchmark Specification

## MODIFIED Requirements

### Requirement: Backend benchmarks report measured quality

Backend benchmark reports SHALL distinguish measured benchmark success from preflight and fallback availability.

#### Scenario: HSS benchmark is blocked

- **GIVEN** no typed HSS adapter benchmark is available
- **WHEN** fallback backend validation succeeds
- **THEN** HSS benchmark status remains blocked or missing evidence
- **AND** fallback success is not counted as HSS success.
