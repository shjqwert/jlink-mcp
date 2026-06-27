# HSS Headless And Fallback Hardening

Change: `harden-hss-headless-backend-and-fallback-preflight`

- [x] Create working branch.
- [x] Run baseline and record initial blockers.
- [x] Move tests/native/coverage temp usage to repo `.tmp/jlink-mcp`.
- [x] Fix TraceAgent regression test so clean offline decoder coverage is not real-board PASS evidence.
- [x] Search SEGGER install paths for typed `JLINK_HSS_*` prototypes.
- [x] Check JScope help flags for headless export evidence.
- [x] Mark HSS preflight-only as `available-if-configured`, not benchmark-ready.
- [x] Add backend fallback reason and RSP low-rate warning output.
- [x] Harden RSP monitor `OK` parsing with exact OK, O-packet, timeout, and malformed tests.
- [x] Add repo temp preflight helper and tests.
- [x] Record RTT ACK/stream quality as NOT_PASS with current artifacts.
- [x] Add OpenSpec change.
- [x] Run final regression set.
