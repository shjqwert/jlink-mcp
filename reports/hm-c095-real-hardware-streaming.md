# HM_C095 Real Hardware Streaming

- Source: real HM_C095 board
- Device: `Z20K146MC`
- Interface: SWD
- Speed: 4000 kHz
- Channel: RTT channel 1, `AI_TRACE`
- Capture command: `JLinkRTTLogger.exe -Device Z20K146MC -If SWD -Speed 4000 -RTTChannel 1`
- Raw artifact: `reports/hm-c095-real-hardware-traceagent-channel1-30s.bin`
- Summary artifact: `reports/hm-c095-real-hardware-streaming.json`
- After-write raw artifact: `reports/hm-c095-real-hardware-traceagent-after-write-10s.bin`
- After-write summary artifact: `reports/hm-c095-real-hardware-after-write-streaming.json`

## Result

- `frames_total`: 1167
- `sample_frames`: 1166
- `invalid_frames`: 0
- `crc_failures`: 0
- `sequence_gaps`: 36
- `duplicate_sequences`: 11
- `duration_sec_by_agent_time`: 23.82
- `rate_hz`: 48.95

## Verdict

Partial fail.

CRC validation passed and real sample frames were decoded, but the acceptance gate requires `sequence_gaps == 0`; this run observed 36 missing sequence numbers.

This SEGGER RTTLogger result is superseded for the final smoke verdict by the direct RTT ring-read capture in `reports/hm-c095-real-hardware-direct-rtt-streaming.md`, which passed with `crc_failures=0` and `sequence_gaps=0`.

## After Write Observation

- `frames_total`: 347
- `sample_frames`: 346
- `invalid_frames`: 2
- `crc_failures`: 2
- `sequence_gaps`: 38
- `duplicate_sequences`: 13
- `duration_sec_by_agent_time`: 7.28
- `rate_hz`: 47.53

After-write streaming continued, but it failed the same acceptance gate and also had CRC failures.
