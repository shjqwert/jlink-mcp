# HSS MVP-B Round 4 Helper IPC Report

Date: 2026-07-03

## Scope

Replace the temporary J-Link Commander rejection path with a native helper IPC path for active HSS capture-time scalar RAM writes.

## Changes

- `src/mcp/hss/hss-capture-service.ts`
  - Creates per-capture `write.request.json` and `write.response.json` paths under the capture output directory.
  - Uses `HelperHssVariableMemoryIo` for active capture writes when no injected test memory IO is supplied.
  - Keeps native helper writes limited to scalar targets for this first safe path.
- `src/mcp/hss/hss-memory-io.ts`
  - Added `HelperHssVariableMemoryIo`.
  - Sends internal read/write requests to the active helper and waits for matching responses by request id.
  - Publishes request JSON via temporary-file rename to avoid partial reads.
- `native/hss-helper/hss_helper.cpp`
  - Polls the active capture's write request file inside the HSS capture loop.
  - Executes `JLINKARM_ReadMem` / `JLINKARM_WriteMem` in the same helper process/session as HSS capture.
  - Rejects malformed IPC requests, mismatched `captureId`, and non-scalar write widths.
  - Reports `targetWritten=true` only after a helper write succeeds.
- `src/mcp/hss/hss-artifact.ts`
  - Final metadata now preserves helper safety flags, including `targetWritten`.
- `src/mcp/hss/hss-mvp-b-integration.test.ts`
  - Replaced the unsafe-backend rejection regression with a helper IPC scalar write regression.
  - Keeps non-scalar active capture writes rejected on the real helper path.

## Verification

| Command | Result |
| --- | --- |
| `npm.cmd run build:hss` | Pass |
| `native\hss-helper\build\Release\hss_helper.exe self-test` | Pass |
| `npm.cmd run test:hss-dll` | Pass: 8/8 |
| `npm.cmd run test:hss-mvp-a` | Pass: 18/18 |
| `npm.cmd run test:hss-mvp-b` | Pass: 36/36 |

## Hardware Status

HM_C095 hardware validation was not executed in this round. This report only proves the native helper IPC path builds and passes local integration tests with the fake helper. Real hardware acceptance still needs a safe allowlisted scalar RAM variable in `policy.json`.

## Result

Round 4 passed for software validation. Active HSS capture-time scalar writes now have a native helper path and no longer require the unsafe J-Link Commander reconnect path.
