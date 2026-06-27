# direct-rtt-channel-backend Specification

## MODIFIED Requirements

### Requirement: Direct RTT channel access uses existing target RTT only

Jlink-MCP SHALL treat RTT live streaming as PASS only when protocol quality evidence is clean.

#### Scenario: RTT stream quality is not clean

- **GIVEN** a TraceAgent stream has CRC failures, discarded bytes, sequence gaps, duplicate sequences, invalid frames, or missing ACK evidence
- **WHEN** validation is reported
- **THEN** RTT live streaming is not marked PASS
- **AND** the report records the failing counters.
