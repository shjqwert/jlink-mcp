# HSS MVP-B Round 1 Validator Report

Date: 2026-07-03

## Scope

Fix MVP-B capture validation so a failed `variable_write` event no longer passes only because the event exists.

## Changes

- `scripts/hss-validate-mvp-b-capture.mjs`
  - Requires every `variable_write` event to have `ok=true`.
  - Requires every `variable_write` event to have `readbackOk=true`.
  - Requires capture state/transport/data quality to pass.
  - Requires all samples to be valid with no read errors, timeouts, or drops.
  - Rejects captures that were halted before capture, halted after resume, reset, halted, or flashed.
- `scripts/hss-validate-mvp-b-capture.test.mjs`
  - Adds one failing-write regression case.
  - Adds one clean successful-write pass case.

## Verification

| Command | Result |
| --- | --- |
| `node --test scripts\hss-validate-mvp-b-capture.test.mjs` | Pass: 2/2 |
| `node scripts\hss-validate-mvp-b-capture.mjs D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\.jlink-mcp\captures\30853ae7-2dc1-4d4b-9eb5-3d532af023c6\capture.json` | Expected fail: rejected failed write/readback and failed capture quality |
| `npm.cmd run test:hss-mvp-b` | Pass: 35/35 |

## Result

Round 1 passed. The validator no longer accepts the known failed hardware capture as a valid MVP-B write result.
