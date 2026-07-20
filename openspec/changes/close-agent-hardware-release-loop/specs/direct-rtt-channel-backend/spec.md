## MODIFIED Requirements

### Requirement: Direct RTT channel access uses existing target RTT only

Jlink-MCP SHALL treat RTT as optional, SHALL NOT require MCU source changes, and SHALL expose only `rtt_open`, `rtt_read`, `rtt_search`, `rtt_clear`, and `rtt_close`. These tools SHALL use the request's Target context and an explicitly available RTT endpoint, obey long-lived Probe ownership, return structured availability/errors, and SHALL NOT start GDB, halt, reset, resume, write a target RTT channel, or expose caller-supplied ring-buffer parsing as public tools.

#### Scenario: RTT endpoint missing
- **WHEN** `rtt_open` cannot reach the configured existing RTT endpoint
- **THEN** it returns a structured unavailable or prerequisite result
- **AND** does not start GDB or alter the MCU.

#### Scenario: RTT opens against current endpoint
- **WHEN** the current Target has an available compatible RTT endpoint
- **THEN** `rtt_open` connects one managed RTT client and reports endpoint/session facts
- **AND** starts no other process or hardware owner.

#### Scenario: bounded RTT read and search
- **WHEN** `rtt_read` or `rtt_search` is called on an open session
- **THEN** it returns only the requested bounded MCP-side buffered output and cursor state
- **AND** performs no target write or fallback to another channel.

#### Scenario: RTT clear
- **WHEN** `rtt_clear` is called on an open session
- **THEN** it clears only the MCP-side accumulated buffer and reports the new cursor state
- **AND** does not clear or write target memory.

#### Scenario: RTT close
- **WHEN** `rtt_close` is called
- **THEN** it closes only the managed RTT client and reports completion or partial failure
- **AND** does not stop GDB, resume, reset, or otherwise alter the target.

#### Scenario: incompatible Probe owner
- **WHEN** RTT open is requested while HSS owns the Probe
- **THEN** it returns `CAPTURE_ACTIVE`
- **AND** does not disturb capture.
