# HSS MVP-B Round 11: Outside-Capture Variable Write Report

Date: 2026-07-03

## Scope

Closed the PR-B3 gap found in round 10: `variable_write_execute` must support controlled RAM variable writes outside an active HSS capture.

## Changes

- `src/mcp/hss/hss-write-plan.ts`
  - Allows `captureId` to be omitted for outside-capture plans.
  - Carries `artifactFile`, `mapFile`, and requested scalar `type`.
  - Marks outside-capture plans with `willEnterCaptureQueue=false`.
- `src/mcp/hss/hss-write-execute.ts`
  - Allows implicit execute input (`target`/`targetRef` + `value`) without a pre-created `writePlanId`.
- `src/mcp/hss/hss-capture-service.ts`
  - Adds outside-capture plan/execute path.
  - Reuses policy, map layout, read-old/write/readback/restore logic.
  - Rejects direct outside-capture writes while an HSS capture is active.
- `src/mcp/hss/hss-memory-io.ts`
  - Adds direct probe memory IO for outside-capture 32-bit scalar writes.
- `src/mcp/server.ts`
  - Updates MCP schemas for outside-capture `variable_write_plan` and `variable_write_execute`.
- `src/mcp/hss/hss-mvp-b-integration.test.ts`
  - Adds outside-capture plan/execute, implicit execute, and active-bypass rejection coverage.

## Verification

- `npm.cmd run compile`: pass
- `node --test out\mcp\hss\hss-mvp-b-integration.test.js`: pass, 5/5
- `npm.cmd run test:hss-mvp-b`: pass, 39/39
- `npm.cmd run test:hss-mvp-a`: pass, 18/18

## Safety Notes

- Outside-capture writes still require `policy.json`, map-backed RAM layout, range/type checks, old-value read, write, readback, and restore-on-failure.
- Active HSS capture ownership still blocks direct writes unless the write enters the capture queue.
- The default direct probe path supports 32-bit scalar writes only; this matches the HM_C095 safe write probe and avoids exposing arbitrary byte writes.

## Non-Goals

- No arbitrary address write was added.
- No Flash, peripheral, register, raw command, reset, halt, or step write path was added.
- No HSS experimental/env/capability gate was reintroduced.
