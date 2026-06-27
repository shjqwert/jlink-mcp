# HM_C095 Real Hardware Write Readback

## Intended Target

- Alias: `guwWdgFlg`
- Firmware selector in TraceAgent registration: `TraceSignals.c::g_traceWdgFlg`
- TraceAgent signal id: `TRACE_SIGNAL_GUW_WDG_FLG`
- Type: `uint16`
- Allowed values: 0 or 1

## Source Safety Evidence

- `TRACE_SIGNAL_GUW_WDG_FLG`: present
- `TRACE_REG_WRITABLE_EX(&g_traceWdgFlg, TRACE_U16, "guwWdgFlg", 0, 1, TRACE_MODE_STOP | TRACE_MODE_MAINT)`: present
- `TraceAgentPort_HandleWrite`: present
- `CddSbcWdgFlgSet`: present
- `CddSbcWdgFlgGet`: present

## Runtime Result

- TraceAgent RTT write-var: pass via direct RTT down-buffer write to channel 1 `AI_CMD`
- Direct RTT result artifact: `reports/hm-c095-real-hardware-direct-rtt-write-readback.json`
- Fallback: GDB safe-symbol write
- Target used: `CddSbc.c::guwWdgFlg`
- Address: `0x20006bf0 <guwWdgFlg>`
- Type: `unsigned short`
- Initial readback: 0
- TC-WR-01 `guwWdgFlg=1`: pass, readback 1
- TC-WR-02 `guwWdgFlg=0`: pass, readback 0
- TC-WR-03 `guwWdgFlg=2`: pass, local policy rejection; not sent to hardware
- Hardware write attempted: yes, only `guwWdgFlg`
- Readback obtained: yes

## Notes

TraceAgent uses RTT channel 1:

- up: `AI_TRACE`
- down: `AI_CMD`

Current MCP `rtt_send` writes through the default RTT telnet path, which exposes channel 0. SEGGER `JLinkRTTClient` also exposes only `-RTTTelnetPort` and no channel selector. The passing TraceAgent write/readback therefore used direct SEGGER DLL memory access to the RTT channel 1 down-buffer and parsed ACK frames from the up-buffer.

GDB fallback was used after the user granted full permissions for this test objective.

`TraceSignals.c::g_traceWdgFlg` was not present as a writable ELF symbol in the current build because registration macros compile to no-ops. The resolved safe backing variable was `CddSbc.c::guwWdgFlg`, which is the variable read and written by `CddSbcWdgFlgSet/Get` from `TraceAgentPort_HandleWrite`.
