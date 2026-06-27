# TASK HM_C095 Real Hardware Smoke

## Status

Partially executed on real hardware; failed streaming acceptance.

## Gate

- User authorization: granted in chat for this session
- Device: `Z20K146MC`
- Flash: authorized
- Reset: authorized
- GDB safe symbol write fallback: authorized by user for this test objective

## Result

Real hardware baseline, IAR build, flash, GDB safe-symbol write/readback, RTT channel 1 streaming, ExperimentRecord conversion, analysis, and evidence generation ran.

Failed items:

- TraceAgent RTT write/readback path is blocked because current MCP RTT send path writes default channel 0, while HM_C095 TraceAgent command channel is RTT channel 1 (`AI_CMD`).
- GDB safe-symbol fallback completed write 1/readback 1 and write 0/readback 0.
- Streaming acceptance failed: sequence gaps were observed in the 30 s RTTLogger channel 1 capture, and the after-write capture had CRC failures.

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
