# HM_C095 Backend Regression

Result: partial pass.

Offline and recorded evidence still pass:

- Existing HM_C095 direct RTT fixture decodes to 1240 frames.
- Fixture CRC failures: 0.
- Fixture sequence gaps: 0.
- Fixture duplicate sequences: 0.
- ExperimentRecord conversion from decoded stream works.
- TraceAgent write frame encoding matches HM_C095 `guwWdgFlg=1` and `guwWdgFlg=0` frames.
- `guwWdgFlg=2` is rejected before transport.
- `bMotorStarted`, `AppMotorDbg.c::gstMotorDbg.*`, and `AppMotorCtrl.c::gstMotorCtrl.*` are rejected before transport.

Real-board smoke performed:

- Target: `Z20K146MC`, SWD 4000 kHz, J-Link S/N 69401227.
- Firmware: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.out`, SHA256 `1EF9EA79BA8C34A4C32C26B0195B238B22F61E88125CC57183D10B9C58AAD8BE`.
- `_SEGGER_RTT`: `0x2000657c`.
- `AI_TRACE`: up channel 1, buffer `0x20005f88`, size 1024.
- `AI_CMD`: down channel 1, buffer `0x200067b8`, size 64.
- `guwWdgFlg`: `0x20006bf0`.

Real-board results:

- `guwWdgFlg=1` direct RTT write consumed by MCU and read back as 1.
- `guwWdgFlg=0` direct RTT write consumed by MCU and read back as 0.
- TraceAgent ACK frames were not observed.
- 30s direct RTT polling stream was captured, but failed quality due CRC failures, discarded bytes, and sequence gaps.
- JScope/HSS GUI preflight opened the HSS project and entered sampling UI; headless benchmark/export remains blocked.

Artifacts:

- `reports/hm-c095-real-hardware-csharp-smoke-io.json`
- `reports/hm-c095-real-hardware-csharp-decoded.json`
- `reports/hm-c095-real-hardware-csharp-stream-30s.bin`
- `reports/jscope-hss-preflight.png`
- `reports/jscope-hss-preflight.json`
- `reports/hss-default-backend-probe.json`

Safety:

- HM_C095 source modified: no.
- `bMotorStarted` written: no.
- Motor started: no.
- `capture_control start` called: no.
