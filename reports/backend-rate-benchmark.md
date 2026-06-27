# Backend Rate Benchmark

Result: HSS benchmark blocked; RTT smoke benchmark failed quality gate.

HSS:

| Check | Result | Evidence |
| --- | --- | --- |
| JScope executable | present | `C:\Program Files\SEGGER\JLink_V884\JScope.exe` |
| JLink HSS DLL exports | present | `JLINK_HSS_GetCaps/Read/Start/Stop` in `JLink_x64.dll` |
| HM_C095 JScope project | present | `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\FOC.jscope` |
| GUI HSS preflight | pass | `reports/jscope-hss-preflight.png` |
| Headless benchmark/export | blocked | no verified JScope CLI export/start option and no local HSS SDK header |

Direct RTT real-board smoke, C# DLL tight loop:

| Source | Poll interval | Frames | Actual rate | CRC failures | Gaps | Discarded | Duplicate | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `hm-c095-real-hardware-csharp-stream-30s.bin` | 5 ms | 280 | 11.30 Hz | 498 | 1587 | 45794 | 0 | fail quality |
| `hm-c095-real-hardware-csharp-ladder-20ms.bin` | 20 ms | 107 | 25.98 Hz | 50 | 148 | 4900 | 0 | fail quality |
| `hm-c095-real-hardware-csharp-ladder-10ms.bin` | 10 ms | 162 | 37.27 Hz | 25 | 192 | 2032 | 0 | fail quality |
| `hm-c095-real-hardware-csharp-ladder-5ms.bin` | 5 ms | 43 | 10.24 Hz | 85 | 241 | 7778 | 1 | fail quality |

Write-path smoke:

| Command | Frame | Before | After | Down ring consumed | ACK |
| --- | --- | ---: | ---: | --- | --- |
| `guwWdgFlg=1` | `AA 55 01 04 08 00 03 00 00 00 03 00 0D 00 01 00 00 00 EA 47` | 0 | 1 | yes, rd/wr 0 -> 20 | not observed |
| `guwWdgFlg=0` | `AA 55 01 04 08 00 04 00 00 00 04 00 0D 00 00 00 00 00 0D FE` | 1 | 0 | yes, rd/wr 20 -> 40 | not observed |

Conclusion:

- HSS must remain first priority, but real benchmark is blocked until headless HSS adapter/export exists.
- RTT direct channel is usable for safe write/readback smoke, but current direct polling capture does not meet stream quality requirements on this board.
