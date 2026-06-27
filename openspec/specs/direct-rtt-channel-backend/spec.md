# direct-rtt-channel-backend Specification

## Purpose
TBD - created by archiving change add-hss-first-multi-backend-runtime-capture. Update Purpose after archive.
## Requirements
### Requirement: Direct RTT channel access uses existing target RTT only

Jlink-MCP SHALL treat RTT as optional and SHALL NOT require MCU source changes to add RTT.

#### Scenario: RTT control block missing

- **GIVEN** no RTT control block is found
- **WHEN** direct RTT is probed
- **THEN** the backend returns `unavailable`
- **AND** the reason is `RTT control block not found`.

#### Scenario: requested channel missing

- **GIVEN** an RTT control block exists
- **AND** the requested channel name or index is absent
- **WHEN** direct RTT is probed
- **THEN** the backend returns `unavailable`
- **AND** the reason is `requested RTT channel not found`.

#### Scenario: ring buffers handle wrap-around

- **GIVEN** an RTT ring buffer whose read or write operation crosses the end of the buffer
- **WHEN** Jlink-MCP reads or writes the ring
- **THEN** bytes are returned or written in order
- **AND** the next offset is updated modulo the buffer size.

#### Scenario: legacy rtt_send remains compatible

- **GIVEN** `rtt_send` is called without channel or channelName
- **WHEN** RTT telnet is connected
- **THEN** Jlink-MCP uses the legacy channel-0 RTT send path.

#### Scenario: channel-specific rtt_send does not fall back to channel 0

- **GIVEN** `rtt_send` is called with channel or channelName
- **AND** no direct RTT transport is configured
- **WHEN** the tool runs
- **THEN** Jlink-MCP returns structured `unavailable`
- **AND** does not send the data through legacy channel 0.
