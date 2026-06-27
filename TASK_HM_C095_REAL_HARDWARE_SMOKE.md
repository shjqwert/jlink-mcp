# TASK HM_C095 Real Hardware Smoke

## Status

Executed on real hardware; final direct RTT validation passed.

## Gate

- User authorization: granted in chat for this session
- Device: `Z20K146MC`
- Flash: authorized
- Reset: authorized
- GDB safe symbol write fallback: authorized by user for this test objective

## Result

Real hardware baseline, IAR build, flash, GDB safe-symbol write/readback, RTT channel 1 streaming, ExperimentRecord conversion, analysis, and evidence generation ran.

Final passed items:

- TraceAgent channel 1 write/readback passed via direct RTT down-buffer injection to `AI_CMD`.
- GDB safe-symbol fallback completed write 1/readback 1 and write 0/readback 0.
- Direct RTT channel 1 streaming passed: 30 s raw capture decoded with `crc_failures=0` and `sequence_gaps=0`.
- Direct RTT ExperimentRecord conversion, `experiment_analyze`, and `evidence_for_codegraph` ran on the passing stream.

Remaining limitations:

- The current MCP `rtt_send` path still writes default channel 0, while HM_C095 TraceAgent command channel is RTT channel 1 (`AI_CMD`).
- SEGGER `JLinkRTTLogger.exe -RTTChannel 1` capture still has previous loss evidence and is superseded by direct RTT ring-read evidence for this smoke result.
- Follow-up channel-1 probe found no existing minimal host path for TraceAgent `AI_CMD`: `JLinkRTTLogger` can read `AI_TRACE` channel 1, `JLinkRTTClient`/GDBServer telnet remain channel-0 oriented, J-Link Commander has no RTT write command, and direct `JLink_x64.dll` RTT START/read returned zero channel data.

## Safety Record

- CodeGraph MCP called: no
- J-Link accessed: yes
- IAR build run: yes, `FOC_SCM.ewp` from `FOC_SCM.eww`, 0 errors / 82 warnings
- Flash/download: yes, MCP `flash` of `FOC_SCM.out`
- Reset: yes, via authorized MCP `flash` path
- Halt/resume: yes, via authorized MCP `flash` and GDB write path
- `capture_control start`: no
- `bMotorStarted` written: no
- Motor started: no
- Target variable write attempted: yes, only `guwWdgFlg`
- Extra RTT channel probing: read-only except existing authorized `guwWdgFlg` fallback; no TraceAgent down-channel write sent

## Artifacts

- `reports/hm-c095-real-hardware-failure.md`
- `reports/hm-c095-real-hardware-smoke.md`
- `reports/hm-c095-real-hardware-streaming.md`
- `reports/hm-c095-real-hardware-write-readback.md`
- `reports/hm-c095-real-hardware-write-readback.json`
- `reports/hm-c095-real-hardware-streaming.json`
- `reports/hm-c095-real-hardware-after-write-streaming.json`
- `reports/hm-c095-real-hardware-traceagent-channel1-30s.bin`
- `reports/hm-c095-real-hardware-traceagent-after-write-10s.bin`
- `reports/hm-c095-real-hardware-stream.experiment.json`
- `reports/hm-c095-real-hardware-analysis.json`
- `reports/hm-c095-real-hardware-evidence.json`
- `reports/hm-c095-real-hardware-direct-rtt-write-readback.md`
- `reports/hm-c095-real-hardware-direct-rtt-write-readback.json`
- `reports/hm-c095-real-hardware-direct-rtt-streaming.md`
- `reports/hm-c095-real-hardware-direct-rtt-stream-30s-csharp.bin`
- `reports/hm-c095-real-hardware-direct-rtt-stream-30s-csharp.json`
- `reports/hm-c095-real-hardware-direct-rtt-stream.experiment.json`
- `reports/hm-c095-real-hardware-direct-rtt-analysis.json`
- `reports/hm-c095-real-hardware-direct-rtt-evidence.json`
