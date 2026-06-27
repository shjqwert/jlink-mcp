# HM_C095 Real Hardware Smoke Failure

- Date: 2026-06-27
- Jlink-MCP branch: test/hm-c095-real-hardware-smoke
- Jlink-MCP commit: 730a3400350181495e38d86f4cbbc3da8d7deb73
- Root cause: environment_missing
- Failed test id: PRECHECK-AUTH-01
- Failed command/tool: PowerShell environment gate check
- Exit code: 0
- stdout/stderr summary: `JLINK_MCP_REAL_HW_SMOKE` was empty; `JLINK_DEVICE` was empty.
- Jlink-MCP tool input: none
- Jlink-MCP tool output: none
- Hardware state: not accessed
- Target write attempted: no
- Last successful step: read request and checked required authorization variables

## Blocker

BLOCKED: JLINK_MCP_REAL_HW_SMOKE is not set to 1. Real hardware write/read/streaming test is not authorized.

## Safety Record

- CodeGraph MCP called: no
- J-Link accessed: no
- IAR build run: no
- Flash/download: no
- Reset: no
- Halt/resume: no
- `capture_control start`: no
- `bMotorStarted` written: no
- Motor started: no
- `guwWdgFlg` written: no

## Required Before Retrying

Set at minimum:

```powershell
$env:JLINK_MCP_REAL_HW_SMOKE="1"
$env:JLINK_DEVICE="Z20K146M"
```

Use `Z20K146MC` only if that is the actual J-Link device string required for this board.
