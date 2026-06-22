# J-Link variable capture

This feature uses the installed official `JLinkGDBServerCL.exe` and one persistent local GDB RSP connection. It does not use private J-Link DLL exports, the separately sold J-Link SDK, J-Scope automation, firmware instrumentation, or repeated GDB commands.

## Prerequisites

- Windows x64.
- Official SEGGER J-Link Software Pack containing `JLinkGDBServerCL.exe` and `JLink.exe`.
- Arm GNU Toolchain containing `arm-none-eabi-gdb` for offline ELF/DWARF resolution.
- Visual Studio with the MSVC x64 toolchain and CMake.

Build and verify without hardware:

```powershell
npm ci
npm run lint
npm run build
npm test
npm run test:capture-ipc
npm run build:capture
native\capture-helper\build\Release\jlink-capture-helper.exe --self-test
```

Set `GDB_PATH` when `arm-none-eabi-gdb` is not on `PATH`. Set `JLINK_INSTALL_DIR` when SEGGER tools are not on `PATH`. `JLINK_CAPTURE_HELPER` may select a separately deployed helper executable.
`JLINK_CAPTURE_AFFINITY_MASK` optionally pins the sampling worker to a Windows processor mask; it never changes process realtime priority or the power plan.

## Reviewed project allowlist

`capture_prepare` requires the absolute path to a Git-tracked `.jlink-mcp.json`. The user must confirm the mapping before it is recorded or used and after every change. A valid version 1 file has this shape:

```json
{
  "version": 1,
  "preStartMs": 500,
  "postStopMs": 1000,
  "commands": {
    "start": {
      "selector": "Motor.c::gMotorCommand.enable",
      "type": "uint32",
      "value": 1,
      "verify": {
        "selector": "Motor.c::gMotorState.running",
        "type": "uint32",
        "operator": "eq",
        "value": 1
      },
      "timeoutMs": 1000
    },
    "stop": {
      "selector": "Motor.c::gMotorCommand.enable",
      "type": "uint32",
      "value": 0,
      "verify": {
        "selector": "Motor.c::gMotorState.running",
        "type": "uint32",
        "operator": "eq",
        "value": 0
      },
      "timeoutMs": 500
    }
  }
}
```

The names above are illustrative, not approved mappings. Commands accept no runtime address, offset, or replacement value.

## Workflow

1. Configure the exact device, fixed SWD speed, and probe serial. Multiple probes require `JLINK_SERIAL`.
2. Call `capture_prepare` with absolute ELF/config paths and 1–32 fixed-address scalar selectors.
3. Preparation verifies ELF endianness/types/RAM layout, target Flash, target running state before and after background reads, probe identity/voltage, RSP behavior, and timing. Failure does not run, halt, reset, change speed, remove variables, reduce rate, or switch backend.
4. Confirm `armed`, then call `capture_start`.
5. Call `capture_control start` only after the user explicitly requests motor operation in the current session. Sampling must already be active.
6. Call `capture_control stop` or `capture_stop`; the allowlisted stop is written and verified before the post-stop interval.
7. Use `capture_query` for at most 2000 min/max/average buckets and `capture_export` for CSV plus JSON.

The supported final types are `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, and `float32`. Pointer traversal, arrays, bitfields, whole aggregates, arbitrary addresses, caller offsets, and big-endian ELF files are rejected.

## Failure behavior

Three consecutive frame-read failures, parent/IPC loss, duration expiry, and explicit stop use the same verified stop path. A session performs at most one J-Link reset command only when `resetOnFailure=true`, capture has begun, and stop cannot be verified. Preparation never resets. After reset the helper persists partial data, closes RSP, and never reconnects, resumes capture, changes speed, or restarts the motor.

Before any hardware test, complete all no-hardware checks and confirm the motor is disabled or unloaded, the power stage is safe, and an independent emergency stop is available.

## Artifacts and limits

Raw version 1 `.jlcp` files default to `%TEMP%\jlink-mcp-captures`. Terminal sessions receive `.metadata.json`; export adds non-overwriting `.csv` and `.json` files. Metadata records ELF SHA-256, target/probe/server identity, RSP capabilities, symbol schema, timing, control/failure/reset events, and termination reason.

The only accepted performance claim is the recorded J-Link CE, Z20K146MC, SWD 4 MHz, seven-variable, 1 kHz, 60-second result. Windows timing is soft real-time. Other probes, MCUs, J-Link versions, RSP capability sets, and operating systems are usable but unverified until they pass the same procedure.
