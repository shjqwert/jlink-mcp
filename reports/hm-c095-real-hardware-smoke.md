# HM_C095 Real Hardware Smoke

- Date: 2026-06-27
- Jlink-MCP branch: test/hm-c095-real-hardware-smoke
- Jlink-MCP commit before result updates: 516d81d
- HM_C095 branch: e8f80a2-mcal-config
- HM_C095 commit: e92215a
- HM_C095 worktree: dirty before test; not cleaned or modified by Jlink-MCP
- Workspace used: `Appl\FOC_SCM.eww`
- `FOC_SCM_832.eww` avoided: yes
- Device: `Z20K146MC`
- Speed: 4000 kHz

## Baseline

- `npm run lint`: pass
- `npm run build`: pass
- `npm run test`: pass, 35 tests
- `npm run test:capture-ipc`: pass, 2 tests
- `npm run test:elf`: pass, 1 test
- `npm run test:hm-c095`: pass, 10 tests
- `npm run test:write`: pass, 5 tests
- `npm run test:coverage`: pass; runtime 95.97%, write 99.03%, full repo 64.47%
- `openspec.cmd validate --strict`: returned `Nothing to validate`
- `openspec.cmd validate --all --strict`: pass, 2 specs

## IAR Build

- IARBuild: `C:\Program Files (x86)\IAR Systems\Embedded Workbench 8.3\common\bin\IarBuild.exe`
- First workspace command `FOC_SCM.eww Debug -build`: rejected by IARBuild CLI as illegal project path
- Build command used: `IarBuild.exe FOC_SCM.ewp -build Debug -log warnings`
- Reason: `FOC_SCM.eww` points to `FOC_SCM.ewp`
- Result: pass, 0 errors / 82 warnings
- Firmware artifact: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.out`
- Map artifact: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\List\FOC_SCM.map`

## Flash And Reset

- Flash authorized: yes
- Reset authorized: yes
- Tool: MCP `flash`
- Result: `Flashed D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.out`
- Note: MCP `flash` implementation runs `r`, `halt`, `loadfile`, `r`, `go`; this was executed only after reset authorization.

## Safe Write

- Write method intended: TraceAgent RTT write-var
- TraceAgent RTT write-var result: pass via direct RTT down-buffer write to channel 1 `AI_CMD`
- Direct write artifact: `reports/hm-c095-real-hardware-direct-rtt-write-readback.json`
- Fallback method: GDB safe-symbol write to `CddSbc.c::guwWdgFlg`
- Fallback target confirmation: `info variables guwWdgFlg`, `ptype guwWdgFlg`, `print &guwWdgFlg`
- Address: `0x20006bf0 <guwWdgFlg>`
- Type: `unsigned short`
- TC-WR-01 `guwWdgFlg=1`: pass, readback 1
- TC-WR-02 `guwWdgFlg=0`: pass, readback 0
- TC-WR-03 `guwWdgFlg=2`: pass, locally rejected; not sent to hardware
- Dangerous variable rejection: covered by `npm run test:write`; no dangerous write sent to hardware
- Debug variable rejection: covered by `npm run test:write`; no debug/control write sent to hardware
- Note: `TraceSignals.c::g_traceWdgFlg` is optimized out in this build because the registration macros are no-ops. The GDB fallback therefore used `CddSbc.c::guwWdgFlg`, the real variable read/written by `CddSbcWdgFlgSet/Get` from the TraceAgent write handler.

## Streaming

- Streaming source: SEGGER RTT channel 1 (`AI_TRACE`)
- Raw artifact: `reports/hm-c095-real-hardware-traceagent-channel1-30s.bin`
- After-write raw artifact: `reports/hm-c095-real-hardware-traceagent-after-write-10s.bin`
- Summary: `reports/hm-c095-real-hardware-streaming.json`
- After-write summary: `reports/hm-c095-real-hardware-after-write-streaming.json`
- Frames total: 1167
- Sample frames: 1166
- Invalid frames: 0
- CRC failures: 0
- Sequence gaps: 36
- Duplicate sequences: 11
- Agent-time duration: 23.82 s
- Approx rate: 48.95 Hz
- After-write frames total: 347
- After-write sample frames: 346
- After-write invalid frames: 2
- After-write CRC failures: 2
- After-write sequence gaps: 38
- Result: fail because sequence gaps were observed, and after-write capture had CRC failures

## Direct RTT Streaming

- Method: direct `JLink_x64.dll` read of RTT channel 1 ring buffer, advancing only host `RdOff`
- Raw artifact: `reports/hm-c095-real-hardware-direct-rtt-stream-30s-csharp.bin`
- Summary: `reports/hm-c095-real-hardware-direct-rtt-stream-30s-csharp.json`
- Frames total: 1240
- Sample frames: 1240
- Invalid frames: 0
- CRC failures: 0
- Sequence gaps: 0
- Duplicate sequences: 0
- Agent-time duration: 24.78 s
- Approx rate: 50.04 Hz
- Result: pass

## Analysis

- ExperimentRecord: `reports/hm-c095-real-hardware-direct-rtt-stream.experiment.json`
- Analysis result: `reports/hm-c095-real-hardware-direct-rtt-analysis.json`
- Analysis profile: `generic_state_machine`
- Analysis verdict: warning
- Evidence result: `reports/hm-c095-real-hardware-direct-rtt-evidence.json`
- CodeGraph MCP called: no
- `evidence_for_codegraph` output: empty evidence and empty queries because no analysis patterns were found

## Safety

- `bMotorStarted` written: no
- Motor started: no
- `capture_control` called: no
- Dangerous variable written: no
- `guwWdgFlg` written: yes, via GDB safe-symbol fallback
- Unauthorized flash/reset/halt/resume: no

## Remaining Risks

- TraceAgent RTT channel 1 write-var remains unsupported by the current MCP `rtt_send` path.
- SEGGER `JLinkRTTLogger.exe -RTTChannel 1` had sequence gaps and after-write CRC failures; direct RTT ring read passed the streaming gate.
- `experiment_analyze` MCP tool was not exposed by current tool discovery; the same repository handler was run directly via Node.

## Follow-Up Channel 1 Probe

- `JLinkRTTLogger.exe -RTTChannel 1` still reads real `AI_TRACE` data and reports 3 up-channels: `Terminal`, `AI_TRACE`, and an unnamed channel.
- `JLinkRTTClient.exe` did not expose an RTT channel selector in CLI help.
- J-Link Commander help listed no RTT read/write command.
- GDBServer with `-RTTTelnetPort 19031` opened local ports `19030`, `19031`, `2333`; raw reads showed `19031` as RTT telnet banner and `19030` as binary control data, not a usable `AI_CMD` channel write path.
- Direct `JLink_x64.dll` probing could open, select `Z20K146MC`, connect over SWD, and call `JLINK_RTTERMINAL_Control(START)`, but `JLINK_RTTERMINAL_Read` returned 0 bytes for channels 0, 1, and 2.
- Result: no existing minimal host path was found to send TraceAgent write-var commands to RTT down channel 1.

## Next Recommendation

Fix or expose RTT channel 1 bidirectional access in Jlink-MCP so the passing direct RTT method becomes a normal MCP tool path.
