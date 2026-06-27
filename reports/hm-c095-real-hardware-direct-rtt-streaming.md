# HM_C095 Direct RTT Streaming

- Device: `Z20K146MC`
- Method: direct SEGGER `JLink_x64.dll` read of RTT channel 1 `AI_TRACE` ring buffer
- Host action: advance only the up-buffer `RdOff`
- Raw artifact: `reports/hm-c095-real-hardware-direct-rtt-stream-30s-csharp.bin`
- Summary artifact: `reports/hm-c095-real-hardware-direct-rtt-stream-30s-csharp.json`

## Result

- `bytes`: 121520
- `frames`: 1240
- `sample_frames`: 1240
- `invalid_frames`: 0
- `crc_failures`: 0
- `sequence_gaps`: 0
- `duplicate_sequences`: 0
- `duration_sec_by_agent_time`: 24.78
- `rate_hz`: 50.04

## Verdict

Pass for the direct RTT ring-read path: `crc_failures == 0` and `sequence_gaps == 0`.
