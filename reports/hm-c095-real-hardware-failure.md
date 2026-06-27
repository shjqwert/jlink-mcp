# HM_C095 Real Hardware Smoke Failure

- Date: 2026-06-27
- Jlink-MCP branch: test/hm-c095-real-hardware-smoke
- Jlink-MCP base commit: 516d81d
- Root cause: streaming_crc_error
- Failed test id: TC-STREAM-AFTER-WRITE
- Failed command/tool: SEGGER `JLinkRTTLogger.exe -RTTChannel 1`
- Exit code: n/a
- stdout/stderr summary: after-write RTT channel 1 capture decoded real frames but had `crc_failures=2` and `sequence_gaps=38`.
- Jlink-MCP tool input: `set_device("Z20K146MC")`, `flash(FOC_SCM.out)`, `start_debug_session`, `gdb_connect`, `gdb_command`, `halt`, `resume`, `evidence_for_codegraph`
- Jlink-MCP tool output: flash succeeded; GDB safe-symbol write/readback succeeded; evidence_for_codegraph returned empty evidence/queries; streaming after write failed acceptance.
- Hardware state: flashed, written, resumed, and streaming
- Target write attempted: yes, only `guwWdgFlg`
- Last successful step: GDB safe-symbol fallback wrote `guwWdgFlg=1`, read back 1, wrote `guwWdgFlg=0`, read back 0, and resumed CPU
- Follow-up result: current host tools still do not expose a usable RTT down-channel 1 write path for TraceAgent `AI_CMD`.

## Failure

FAILED: streaming after write did not satisfy `crc_failures == 0` and `sequence_gaps == 0`.

Also blocked: TraceAgent RTT write/readback over channel 1 is not executable with current host access. Follow-up probing confirmed `JLinkRTTLogger` can read channel 1, but `JLinkRTTClient`, J-Link Commander, GDBServer telnet ports, and direct `JLink_x64.dll` RTT START/read did not provide a working channel-1 downlink path.

## Safety Record

- CodeGraph MCP called: no
- J-Link accessed: yes
- IAR build run: yes
- Flash/download: yes
- Reset: yes, via authorized MCP `flash`
- Halt/resume: yes, via authorized MCP `flash` and GDB write path
- `capture_control start`: no
- `bMotorStarted` written: no
- Motor started: no
- `guwWdgFlg` written: yes, via GDB safe-symbol fallback

## Next Step

Implement or expose bidirectional RTT channel selection for channel 1, then rerun TraceAgent write/readback and streaming acceptance. Current evidence points to host-side RTTLogger attach/ring-buffer artifacts or channel capture loss for streaming, but the acceptance gate is not met by the captured data.
