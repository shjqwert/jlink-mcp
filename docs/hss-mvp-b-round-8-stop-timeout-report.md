# HSS MVP-B Round 8: Stop Timeout Finalization Report

Date: 2026-07-03

## Scope

Closed the PR-B4/PR-B7 stop-timeout gap: `hss_capture_stop` must not return stale `capturing` metadata when the helper does not exit after a stop request.

## Changes

- `src/mcp/hss/hss-capture-service.ts`
  - Keeps the default stop timeout at 30000 ms.
  - Adds a test-only injectable `stopTimeoutMs`.
  - If stop times out, marks the active capture as timed out, kills the helper, waits for terminal finalization, releases the probe owner, and returns metadata from disk.
- `src/mcp/hss/hss-errors.ts`
  - Adds `HSS_CAPTURE_STOP_TIMEOUT`.
- `src/mcp/hss/hss-mvp-b-integration.test.ts`
  - Adds coverage for helper stop timeout finalization.

## Verification

- `npm.cmd run compile`: pass
- `node --test out\mcp\hss\hss-mvp-b-integration.test.js`: pass, 3/3
- `npm.cmd run test:hss-mvp-b`: pass, 37/37
- `npm.cmd run test:hss-mvp-a`: pass, 18/18

## Result

On stop timeout, capture metadata is finalized as `failed` with `HSS_CAPTURE_STOP_TIMEOUT` evidence instead of silently leaving the capture in a non-terminal state.

## Non-Goals

- No HSS experimental/env/capability gates were added.
- No policy, write allowlist, readback, recovery, or hardware acceptance rules were weakened.
- Node restart abandoned-session scanning remains a separate PR-B7 audit item.
