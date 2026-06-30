# Experimental JLink HSS DLL Adapter Task

Status: blocked after DLL evidence.

Environment used for this run:

- `JLINK_DEVICE=Z20K146MC`

Done:

- Created branch `feature/experimental-jlink-hss-dll-adapter`.
- Added public prototype candidate metadata for `JLINK_HSS_*`.
- Added experimental native helper using `LoadLibraryW` / `GetProcAddress`.
- Added MCP tools `hss_dll_preflight`, `hss_dll_getcaps`, `hss_dll_smoke`, and `hss_dll_benchmark`.
- Downgraded JScope GUI evidence to `preflightOnly`, not benchmark-ready.
- Added tests for HSS state, wrapper errors, and safety symbol rejection.
- Built `native/hss-helper/bin/hss_helper.exe`.

Current blocker:

- Base API candidate was authorized and connect-preflight succeeded.
- Probe serial observed: `69401227`.
- Target is halted according to `JLINKARM_IsHalted`.
- Start/Read/Stop and benchmark are safety-blocked; HSS is not benchmark-ready and must not be reported as PASS.

Safety record:

- MCU source modified: no.
- Target write issued by HSS helper: no.
- Reset/halt/flash issued by HSS helper: no.
- Target halted state detected: yes.
- `bMotorStarted` written: no.
- `capture_control start` called: no.
- JScope used for HSS validation: no.
