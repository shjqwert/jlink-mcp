# Write Safety Decision

Decision: default validation is fake-memory only. Real HM_C095 writes are not performed.

Allowed offline policy target:

| Selector | Alias | Type | Range | Modes |
| --- | --- | --- | --- | --- |
| `TraceSignals.c::g_traceWdgFlg` | `guwWdgFlg` | `uint16` | `0..1` | `TRACE_MODE_STOP`, `TRACE_MODE_MAINT` |

Rejected by policy:

- `OsUserConfig.c::bMotorStarted`
- `AppMotorDbg.c::gstMotorDbg.*`
- `AppMotorCtrl.c::gstMotorCtrl.*`
- `TraceSignals.c::g_traceModPu`
- `TraceSignals.c::g_traceIuPu`
- `TraceSignals.c::g_traceIvPu`
- `TraceSignals.c::g_traceIwPu`
- `TraceSignals.c::g_traceMotorFault`

Validation evidence:

- `npm run test:write` passed.
- `src/mcp/write/write-contract.ts` rejects unknown type, out-of-range values, `NaN`, `Infinity`, pointer selectors, array selectors, empty selectors, non-allowlisted selectors, and dangerous HM_C095 selectors.
- `src/mcp/write/fake-memory-backend.ts` validates scratch write/readback, float write/readback, and trigger-driven observed/state updates.
- `src/mcp/write/write-verify.ts` reports verification mismatch/timeout and unknown-symbol failures.
- `src/mcp/fixtures/hm-c095-write-policy.json` contains the HM_C095 offline policy and fake-memory allowlist.

Optional hardware smoke: skipped. No explicit hardware smoke environment authorization was provided, and default validation must not access J-Link/GDB/RTT or write a real target.
