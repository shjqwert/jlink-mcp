# TASK HM_C095 Real Hardware Smoke

## Status

Blocked before hardware access.

## Gate

- Required: `JLINK_MCP_REAL_HW_SMOKE=1`
- Current: empty
- Required: `JLINK_DEVICE`
- Current: empty

## Result

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
- Target variable write attempted: no

## Artifacts

- `reports/hm-c095-real-hardware-failure.md`
