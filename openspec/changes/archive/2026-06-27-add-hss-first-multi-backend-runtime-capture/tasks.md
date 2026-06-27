# Tasks

## 0. Pre-flight

- [x] Confirm branch and history include runtime-analysis archive and HM_C095 smoke evidence.
- [x] Run baseline regression before new backend work.
- [x] Fix and record baseline failure.

## 1. OpenSpec

- [x] Add proposal, design, tasks, and delta specs.
- [x] Validate change with `openspec.cmd validate add-hss-first-multi-backend-runtime-capture --type change --strict`.

## 2. Backend Router

- [x] Add CaptureBackend capability contract.
- [x] Add HSS-first router.
- [x] Add HSS adapter preflight using installed JScope/JLink DLL exports.
- [x] Add direct RTT channel backend probe.
- [x] Add memory-poll RSP low-rate fallback backend.
- [x] Add external import offline backend.
- [x] Add MCP backend list/probe/select/benchmark/import tools.

## 3. RTT Channel And TraceAgent

- [x] Add RTT channel discovery helpers.
- [x] Add RTT ring-buffer read/write helpers with wrap handling.
- [x] Add TraceAgent write-frame codec with HM_C095 frame parity.
- [x] Add TraceAgent stream decoder with CRC, gap, duplicate, and discard statistics.
- [x] Add TraceAgent write-signal allowlist policy.

## 4. Regression

- [x] Preserve legacy `rtt_send` channel-0 behavior when channel is omitted.
- [x] Return structured unavailable for channel-specific `rtt_send` when direct RTT transport is not configured.
- [x] Keep dangerous write rejection local before hardware send.
- [x] Keep Runtime Evidence CodeGraph bridge offline.

## 5. Validation

- [x] Add backend/router/HSS tests.
- [x] Add RTT channel tests.
- [x] Add TraceAgent tests using current HM_C095 real stream artifact.
- [x] Run HM_C095 real-board smoke for RTT write/readback and stream capture.
- [x] Run JScope/HSS GUI preflight and record headless benchmark blocker.
- [x] Rerun full validation command set after HSS preflight updates.
- [x] Produce final reports.
