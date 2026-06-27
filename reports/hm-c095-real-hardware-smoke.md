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
- TraceAgent RTT write-var result: blocked by channel support; MCP `rtt_send` writes channel 0 while HM_C095 `AI_CMD` is channel 1
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

## Analysis

- ExperimentRecord: `reports/hm-c095-real-hardware-stream.experiment.json`
- Analysis result: `reports/hm-c095-real-hardware-analysis.json`
- Analysis profile: `generic_state_machine`
- Analysis verdict: warning
- Evidence result: `reports/hm-c095-real-hardware-evidence.json`
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

- TraceAgent RTT channel 1 write-var remains unsupported by the current MCP RTT send path.
- Streaming has sequence gaps and after-write CRC failures, so the streaming acceptance gate is not met.
- `experiment_analyze` MCP tool was not exposed by current tool discovery; the same repository handler was run directly via Node.

## Next Recommendation

Fix or expose RTT channel 1 bidirectional access in Jlink-MCP, then rerun TC-WR over TraceAgent and rerun streaming acceptance with `crc_failures == 0` and `sequence_gaps == 0`.
