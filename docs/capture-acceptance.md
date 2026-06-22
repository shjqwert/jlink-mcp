# Capture acceptance record

Status: **FAILED CALIBRATION - validated hardware cannot meet the requested timing**

## No-hardware verification - 2026-06-22

- `npm run lint`: exit 0
- `npm run build`: exit 0
- `npm test`: exit 0, 8 passed, 0 failed, 0 skipped
- `npm run test:capture-ipc`: exit 0, 2 passed, 0 failed, 0 skipped
- `npm run test:elf`: exit 0, 1 passed, 0 failed, 0 skipped
- `native\capture-helper\build\Release\jlink-capture-helper.exe --self-test`: exit 0
- `openspec validate add-jlink-sdk-capture --type change --strict`: exit 0

## Required bench state

- Motor disabled or mechanically unloaded: user confirmed unloaded on 2026-06-21
- Power stage safe: user confirmed on 2026-06-21
- Independent emergency stop available: user confirmed on 2026-06-21
- User authorization to run the motor in the current session: not granted
- User-confirmed Git-tracked `.jlink-mcp.json`: `D:\AI_Project\Trunk\Jlink_mcp\.jlink-mcp.json`
- Exact target ELF: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\Appl\Debug\Exe\FOC_SCM.out`

## Bench preflight - 2026-06-21 to 2026-06-22

- `IarBuild.exe Appl\FOC_SCM.ewp -build Debug`: exit 0, 0 errors, 82 existing warnings
- J-Link Software Pack: V8.84
- Probe: J-Link CE, S/N 69401227, hardware V9.40
- Target voltage: 4.74-4.75 V
- Configured target/interface/rate: Z20K146MC / SWD / 4 MHz
- ELF/DWARF address resolution with `arm-none-eabi-gdb`: passed
- Candidate capture selectors: `gstMotorDbg.fThetaRad`, `gstMotorDbg.fIuPu`, `gstMotorDbg.fIvPu`, `gstMotorDbg.fIwPu`, `gstMotorDbg.uwDutyU`, `gstMotorDbg.uwDutyV`, `gstMotorDbg.uwDutyW`
- Candidate RAM span: `0x20006838` through `0x2000685d`
- User-confirmed mapping: `gstMotorCtrl.bRunEnable` (`int8`), start/verify `1`, stop/verify `0`
- User-confirmed bench state: unloaded motor, safe power stage, independent emergency stop, and `bRunEnable = FALSE` is a safe physical stop
- Background RSP protocol: `qSupported` and read-only DHCSR access passed through one persistent connection
- Authorized Flash operation: official J-Link Commander reported `Contents already match`, then reset and ran the target
- ELF SHA-256: `4c7497ea73aad748e3b474baf7861b1587f223529a5553331a84683ebcb3c94d`
- Initial tests used the abbreviated device setting `Z20K146M`; it produced changing Flash mismatches and, after IAR disconnected, set DHCSR `S_RESET_ST` within 250 ms
- The IAR project uses `Device="Z20K146MC"`; using this exact name removed the attach-time reset in three consecutive checks
- Running-target Flash reads can still contain transient single-read bit errors; helper validation now requires two matching reads and permits only bounded retries
- With `Z20K146MC`, 10,000 paced 38-byte RAM reads completed without an RSP failure or target reset
- The native helper calibration was corrected to run at the requested absolute period instead of an unpaced request burst
- Native seven-variable calibration at 1 kHz measured the best one-range plan at min 880.7 us, mean 1115 us, max 11992.2 us, and P99.9 2418.4 us
- The three-range plan measured min 1990.2 us, mean 2940.98 us, max 16995.2 us, and P99.9 9006.3 us
- The helper now enables advertised `QStartNoAckMode+`, uses `TCP_NODELAY`, and uses J-Link's advertised `binary-upload+` response for standard RSP `x` memory reads; native self-test covers negotiation and binary escaping
- With no-ack and binary reads, the production-mode one-range plan measured min 828.3 us, mean 1019.16 us, max 2911.8 us, and P99.9 2078.1 us
- A `-silent` diagnostic measured min 838.6 us and P99.9 2015 us, proving per-read server logging is not the dominant delay; silent mode was not adopted because it suppresses required startup identity and voltage evidence
- Calibration rejected the session because 2078.1 us exceeds the 100 us P99.9 limit and the mean read window exceeds the 1 ms period
- Capture was not armed because automatic SWD speed changes, rate reduction, variable removal, and backend changes are forbidden
- No halt, run, reset, motor start, or control write was issued during the final calibration

## Acceptance configuration

- Probe: J-Link CE
- Target MCU: Z20K146MC
- Interface: SWD
- SWD rate: 4 MHz
- Variables: 7 supported fixed-address RAM scalars
- Requested rate: 1 kHz
- Duration after verified start: 60 seconds

## Results

- Actual capture rate: not measured because calibration rejected arming
- Scheduled frames: not measured
- Collected frames: not measured
- Missed deadlines: not measured
- Calibration frame read-window P99.9: `2078.1 us` (failed; limit `100 us`)
- Artifact integrity: not measured
- Capture/report paths: not created

Pass requires actual rate at least 1 kHz, zero missed deadlines, P99.9 at most 100 microseconds, and valid raw/metadata/export artifacts.

## Disconnect/reset test

Status: **NOT RUN**

The disconnect test was not started because the required 1 kHz calibration failed before arming. The first test must use a disabled/unloaded motor and safe power stage with an independent emergency stop. Evidence must show three consecutive read failures, verified-stop attempt, exactly one hardware reset when enabled and stop is unconfirmed, partial-data persistence, no reconnect/resume/restart, and helper exit.
