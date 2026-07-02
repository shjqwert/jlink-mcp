# HSS MVP-B Round 7: J-Link Memory Dump Parser Report

Date: 2026-07-03

## Scope

Fixed J-Link memory dump parsing for prompt-prefixed lines such as:

```text
J-Link>20006B30 = 00 00 00 00                                       ....
```

This keeps HSS readback and helper-adjacent memory parsing tolerant of real J-Link Commander output without changing the MVP-B write authorization model.

## Changes

- `src/probe/backend.ts`: accepts an optional `J-Link>` prompt prefix and trims CR line endings before parsing memory dump lines.
- `src/jlink/commander.ts`: applies the same parser compatibility for standalone J-Link Commander memory dump parsing.
- `src/probe/backend.test.ts`: covers prompt-prefixed J-Link memory dump parsing.

## Verification

- `npm.cmd run compile`: pass
- `node --test out\probe\backend.test.js`: pass, 1/1
- `npm.cmd run test:hss-mvp-b`: pass, 36/36
- `npm.cmd run test:hss-mvp-a`: pass, 18/18

## Non-Goals

- No HSS experimental/env/capability gates were added.
- No policy, risk, write queue, readback, recovery, or hardware acceptance rules were weakened.
- No hardware write test was rerun in this round; this was a parser compatibility fix.
