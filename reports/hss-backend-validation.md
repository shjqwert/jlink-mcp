# HSS Backend Validation

Result: partial pass.

What passed:

- `JScope.exe` exists at `C:\Program Files\SEGGER\JLink_V884\JScope.exe`.
- `JLink_x64.dll` exists and exports `JLINK_HSS_GetCaps`, `JLINK_HSS_Start`, `JLINK_HSS_Read`, and `JLINK_HSS_Stop`.
- Existing project `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\FOC.jscope` is configured for J-Scope asynchronous/HSS mode: `IsRTTSession=0`, `TargetDevice=Z20K146MC`, `TargetInterface=SWD`, `InterfaceSpeed=4000`, `SamplingPeriod=50`.
- JScope GUI preflight opened `FOC.jscope` with `-openprj` and `-USB 69401227`, entered the sampling UI, and produced screenshot evidence at `reports/jscope-hss-preflight.png`.
- Default backend probe now keeps `jlink-hss` at priority 1 but marks it `available-if-configured`; it falls back with an explicit reason instead of selecting HSS as benchmark-ready. Evidence: `reports/hss-default-backend-probe.json`.

What is blocked:

- Headless HSS benchmark/export is not confirmed. JScope's observed CLI options are limited to `-openprj`, `-USB`, `-IP`, and `-RTTSearchRanges`; no verified start/stop/export CLI option was found.
- SEGGER SDK header/prototype files for `JLINK_HSS_*` were not present in the installed J-Link package, so a safe direct HSS adapter cannot be implemented from local headers in this run.
- JScope GUI automation can start the sampling UI, but it does not provide a machine-readable sample-rate/export artifact without further UI scripting.

Blocker:

`jlink-hss` is available only as local JScope/HSS preflight. Real headless benchmark remains blocked until a supported JScope export path or a typed `JLINK_HSS_*` adapter is implemented. RTT/RSP fallback is allowed only with this blocker recorded and must not be reported as HSS success.

Safety:

- MCU source modified: no.
- Motor start command used: no.
- `bMotorStarted` written: no.
- Only `guwWdgFlg` 1/0 smoke writes were performed in the RTT path.
