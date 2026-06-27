# HSS-first Backend Capability Matrix

| Backend | Priority | Validation result | Reason | Target code change | Expected use |
| --- | ---: | --- | --- | --- | --- |
| `jlink-hss` | 1 | preflight available; benchmark blocked | JScope project opens in asynchronous/HSS mode and `JLink_x64.dll` exports HSS APIs; no verified headless export/benchmark path yet | no | highest-rate host-side streaming |
| `direct-rtt-channel` | 2 | real-board write path partially passed; stream quality failed | AI_TRACE/AI_CMD rings found and `guwWdgFlg` 1/0 writes verified by readback; 30s stream has CRC/gap loss in DLL polling smoke | no, RTT already exists | RTT ring read/write and TraceAgent |
| `memory-poll-rsp` | 3 | available | low-rate fallback warning emitted | no | low-rate fallback |
| `external-import` | 4 | available offline-only | not selected for realtime capture | no | CSV/JSON/ExperimentRecord import |

Priority proof:

- Default local probe selects `jlink-hss` first: `reports/hss-default-backend-probe.json`.
- Fake HSS adapter test selects `jlink-hss` over RTT/RSP.
- Explicit `JLINK_HSS_ENABLED=0` disables HSS and allows RTT/RSP fallback tests.
- `external-import` is selected only with offline import mode.

HSS blocker:

JScope/HSS exists and can be opened against the HM_C095 project, but automated benchmark/export is blocked because no supported start/stop/export CLI and no local typed HSS SDK header were found.

Safety proof:

- MCU source modified: no.
- `bMotorStarted` written: no.
- Motor started: no.
- `capture_control start` called: no.
