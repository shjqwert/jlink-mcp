# Backend Baseline Failure

- Date: 2026-06-27
- Branch: `feature/hss-first-multi-backend-runtime-capture`
- Scope: pre-feature baseline regression

## Failure

- `npm run test`: failed in sandbox because Windows temp was outside the writable workspace.
- Rerun with workspace-local `TMP/TEMP`: pass, 35 tests.
- `npm run test:capture-ipc`: failed in sandbox because native helper IPC was restricted.
- Rerun outside sandbox: one native self-test failed with `Engine self-test persistence/event mismatch`.

## Root Cause

`native/capture-helper/capture-engine.cpp` self-test used `GetTempFileNameW` for the main artifact and then wrote a sibling `.native.json` sidecar with `CREATE_NEW`. `GetTempFileNameW` only guarantees the main file name is unused. A previous failed self-test could leave `*.native.json`, so later self-tests could fail persistence before emitting `capture_complete`.

## Fix

The self-test now deletes the sibling sidecar before starting each scenario. Production capture persistence still uses `CREATE_NEW` and remains fail-closed for real output paths.

## Safety

- No MCU source modified.
- No hardware accessed.
- No flash/reset/halt/resume.
- No motor start.
- No `capture_control start`.
