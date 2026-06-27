# No-RTT Fallback Validation

Result: pass.

Scenario:

- HSS SDK is missing.
- RTT control block snapshot is missing.
- No MCU source modification is allowed.

Observed:

- `jlink-hss`: `available-if-configured`, `HSS preflight available, headless benchmark blocked: missing typed JLINK_HSS prototypes`.
- `direct-rtt-channel`: unavailable, `RTT control block not found`.
- `memory-poll-rsp`: selected as fallback.
- `fallbackFrom`: `jlink-hss`, `direct-rtt-channel`.
- `lowRateWarning`: `memory-poll-rsp is a low-rate fallback and may not satisfy motor-loop high-speed capture`.

Conclusion: projects without RTT firmware can still use the low-rate RSP fallback without modifying MCU code, but fallback success is not HSS success.
