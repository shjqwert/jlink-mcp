# No-RTT Fallback Validation

Result: pass.

Scenario:

- HSS SDK is missing.
- RTT control block snapshot is missing.
- No MCU source modification is allowed.

Observed:

- `jlink-hss`: unavailable, `J-Link SDK/HSS not configured`.
- `direct-rtt-channel`: unavailable, `RTT control block not found`.
- `memory-poll-rsp`: selected as fallback.

Conclusion: projects without RTT firmware can still use the low-rate RSP fallback without modifying MCU code.
