# Direct RTT Channel Backend Validation

Result: offline pass; no new hardware run.

Validated:

- Missing RTT control block returns `RTT control block not found`.
- Missing requested channel returns `requested RTT channel not found`.
- Channel lookup works by index and name.
- Up ring read handles no-wrap and wrap-around.
- Down ring write handles no-wrap and wrap-around.
- Insufficient down-buffer space fails closed.
- `rtt_send` without channel keeps legacy channel-0 telnet behavior.
- `rtt_send` with channel/channelName returns structured unavailable when no direct RTT transport is configured and does not fall back to channel 0.

HM_C095 recorded stream regression:

- File: `reports/hm-c095-real-hardware-direct-rtt-stream-30s-csharp.bin`
- Frames: 1240
- CRC failures: 0
- Sequence gaps: 0
- Duplicate sequences: 0
- Discarded bytes: 0
- Actual rate: 50.04 Hz

Remaining risk: direct RTT memory/DLL transport is still not wired to live MCP hardware access in this change.
