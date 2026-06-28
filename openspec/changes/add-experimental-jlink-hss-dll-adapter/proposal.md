# Proposal: add-experimental-jlink-hss-dll-adapter

## Summary

Add a gated experimental JLink HSS DLL path that records public `JLINK_HSS_*` candidate evidence without letting JScope GUI preflight or fallback success count as HSS benchmark success.

## Goals

- Keep HSS first in backend priority.
- Treat JScope GUI as historical/preflight-only evidence.
- Add explicit `JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API=1` gate before DLL calls.
- Record candidate API structs/functions without copying SEGGER headers or DLLs.
- Add isolated native helper for HSS DLL symbol/GetCaps calls.
- Report GetCaps, smoke, benchmark, fallback, and safety state as machine-readable artifacts.

## Non-Goals

- Do not modify MCU source.
- Do not add RTT firmware.
- Do not start the motor.
- Do not write `bMotorStarted`, `gstMotorDbg.*`, or `gstMotorCtrl.*`.
- Do not flash/reset/halt/resume.
- Do not claim HSS PASS from RTT/RSP fallback.
