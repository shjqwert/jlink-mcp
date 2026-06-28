# HSS-first Backend Capability Matrix

| Backend | Priority | Validation result | Reason | Target code change | Expected use |
| --- | ---: | --- | --- | --- | --- |
| `jlink-hss` | 1 | HSS_SAFETY_FAIL | `JLink_x64.dll` contains HSS exports and connect-preflight succeeds, but target is halted; JScope is preflight-only | no | highest-rate host-side streaming |
| `direct-rtt-channel` | 2 | real-board write path partially passed; stream quality failed | AI_TRACE/AI_CMD rings found and `guwWdgFlg` 1/0 writes verified by readback; 30s stream has CRC/gap loss in DLL polling smoke | no, RTT already exists | RTT ring read/write and TraceAgent |
| `memory-poll-rsp` | 3 | available | low-rate fallback warning emitted | no | low-rate fallback |
| `external-import` | 4 | available offline-only | not selected for realtime capture | no | CSV/JSON/ExperimentRecord import |

Priority proof:

- Default local probe keeps `jlink-hss` first in priority but reports it as unavailable/blocked, then falls back with explicit reason.
- Fake HSS adapter test selects `jlink-hss` over RTT/RSP.
- Explicit `JLINK_HSS_ENABLED=0` disables HSS and allows RTT/RSP fallback tests.
- `external-import` is selected only with offline import mode.

HSS blocker:

JScope/HSS exists as historical GUI context, but it is superseded as availability evidence. Experimental DLL preflight found HSS exports and base API connect-preflight succeeded, but the target is halted, so HSS benchmark is safety-blocked. Fallback success is not HSS success.

Safety proof:

- MCU source modified: no.
- `bMotorStarted` written: no.
- Motor started: no.
- `capture_control start` called: no.
