# HSS MVP-B Round 2 Halted Start Report

Date: 2026-07-03

## Scope

Reject HSS capture start when preflight reports the target is already halted.

## Changes

- `src/mcp/hss/hss-capture-service.ts`
  - `captureStart` now fails with `HSS_TARGET_HALTED` when `targetWasHaltedBeforeCapture=true`.
  - Removed the previous warning-only path for this condition.
- `src/mcp/hss/hss-mvp-a.test.ts`
  - Updated the old expectation from "allows halted preflight" to "rejects halted preflight".

## Verification

| Command | Result |
| --- | --- |
| `npm.cmd run test:hss-mvp-a` | Pass: 18/18 |
| `npm.cmd run test:hss-mvp-b` | Pass: 35/35 |

## Notes

`targetWasHaltedAfterResume=true` is reported by the native helper after it attempts resume. This round does not fake that check in TypeScript before the helper has evidence. It remains for the helper/internal write round.

## Result

Round 2 passed. A halted target no longer enters a valid HSS capture from the TypeScript start path.
