# HM_C095 Direct RTT Write Readback

- Device: `Z20K146MC`
- Method: direct SEGGER `JLink_x64.dll` memory access to RTT channel 1 ring buffers
- RTT control block: `0x2000657C`
- `AI_TRACE` up buffer: `0x20005F88`, size 1024
- `AI_CMD` down buffer: `0x200067B8`, size 64
- Target: `guwWdgFlg`, signal id 13, address `0x20006BF0`

## Result

- `guwWdgFlg=1`: pass; TraceAgent ACK status 0, ACK readback 1, memory readback 1
- `guwWdgFlg=0`: pass; TraceAgent ACK status 0, ACK readback 0, memory readback 0
- `bMotorStarted` written: no
- `capture_control start`: no
- Motor started: no

## Notes

The existing MCP `rtt_send` path still targets the default RTT telnet path and does not expose channel 1. This validation wrote only the RTT `AI_CMD` down-buffer and offsets, then parsed ACK frames from the `AI_TRACE` up-buffer.
