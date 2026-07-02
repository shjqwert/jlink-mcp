# HSS MVP-B Round 12: Outside-Capture Hardware Write Report

Date: 2026-07-03

## Scope

Validate PR-B3 outside-capture `variable_write_execute` on connected HM_C095 hardware using the safe policy target `g_hssDbgWriteProbe`.

## Finding

The first hardware run failed with `READBACK_MISMATCH`: writing `1` read back `0`. Recovery restored the old value successfully.

Root cause: the direct probe IO path used separate J-Link Commander sessions for write and readback. On the running target, the firmware could clear the probe variable before the later readback session.

## Changes

- `src/mcp/hss/hss-memory-io.ts`
  - Direct outside-capture probe writes now issue the hardcoded `w4` and immediate `mem` readback in the same probe session.
  - The next readback consumes only that real immediate readback bytes.
- `scripts/hss-hm-c095-mvp-b-outside-write.mjs`
  - Adds a repeatable HM_C095 outside-capture write/readback smoke.
  - Writes an allowlisted scalar value and restores the old value when it changed.

## Hardware Result

Command run from:

`D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config`

```text
node D:\AI_Project\Trunk\Jlink_mcp\scripts\hss-hm-c095-mvp-b-outside-write.mjs g_hssDbgWriteProbe 1
```

Result:

```json
{
  "target": "g_hssDbgWriteProbe",
  "requestedValue": 1,
  "executeOk": true,
  "readbackOk": true,
  "oldValue": 0,
  "readback": 1,
  "restored": {
    "ok": true,
    "readbackOk": true,
    "readback": 0
  }
}
```

## Verification

- `npm.cmd run compile`: pass
- `node --test out\mcp\hss\hss-mvp-b-integration.test.js`: pass, 5/5
- `npm.cmd run build:hss`: pass
- `npm.cmd run test:hss-dll`: pass, 8/8
- `npm.cmd run test:hss-mvp-b`: pass, 39/39
- `npm.cmd run test:hss-mvp-a`: pass, 18/18
- `node scripts\hss-validate-mvp-b-capture.mjs <HM_C095 capture.json>`: pass

## Safety Notes

- The hardware write used only the policy allowlisted R2 RAM scalar `g_hssDbgWriteProbe`.
- The old value was restored and read back successfully.
- No arbitrary address write, Flash/peripheral/register write, raw user command, reset, halt, or step path was added.
- No HSS experimental/env/capability gate was reintroduced.
