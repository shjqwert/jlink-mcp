# direct-rtt-channel-backend Specification

## Purpose
Define explicit, read-only direct RTT channel snapshots and telnet RTT access without hidden target or session changes.

## Requirements

### Requirement: Direct RTT channel access uses existing target RTT only

Jlink-MCP SHALL treat RTT as optional, SHALL NOT require MCU source changes, and SHALL expose only `rtt_channel_list` and `rtt_channel_read` for caller-provided read-only channel snapshots plus explicit telnet RTT lifecycle/read/search/clear tools.

RTT tools SHALL use the request's Target context, obey GDB Server ownership, return structured availability/errors, and SHALL NOT start GDB Server, halt, reset, resume, write a channel, or fall back to channel 0.

#### Scenario: RTT endpoint missing
- **WHEN** `rtt_connect` cannot reach the configured existing RTT endpoint
- **THEN** it returns a structured unavailable/connection result
- **AND** does not start GDB Server or alter the MCU.

#### Scenario: requested channel missing
- **WHEN** a caller-provided channel snapshot lacks the requested name or index
- **THEN** `rtt_channel_read` returns `RTT_CHANNEL_NOT_FOUND`
- **AND** does not substitute another channel.

#### Scenario: ring buffer wraps
- **WHEN** a read-only up-channel snapshot crosses the end of its ring buffer
- **THEN** bytes are returned in logical order with the derived next offset modulo buffer size
- **AND** caller-provided data is not mutated.

#### Scenario: incompatible Probe owner
- **WHEN** RTT hardware access is requested while HSS owns the Probe
- **THEN** it returns `CAPTURE_ACTIVE`
- **AND** does not disturb capture.
