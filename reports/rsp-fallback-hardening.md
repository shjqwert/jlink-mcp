# RSP Fallback Hardening

Result: pass.

- `RspMemoryIo.monitor()` checks exact `OK` before `O` output packets.
- Tests cover exact `OK`, O-packet output, timeout, malformed response, read error, short read, and write failure.
- `capture_backend_probe` now reports `fallbackFrom`, `fallbackReason`, unavailable backend reasons, and RSP low-rate warning.
- RSP remains a low-rate fallback and is not reported as HSS or RTT streaming success.
