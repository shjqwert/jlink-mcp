# Proposal: harden-hss-headless-backend-and-fallback-preflight

## Summary

Harden HSS-first runtime capture acceptance so GUI/DLL preflight, fallback success, and offline tests cannot be reported as HSS headless benchmark success.

## Goals

- Require typed `JLINK_HSS_*` prototype evidence before any DLL adapter.
- Mark missing HSS prototypes as blocked/missing evidence.
- Keep JScope GUI preflight separate from headless benchmark.
- Report backend fallback reasons and RSP low-rate warning.
- Require RTT ACK and clean CRC/gap/discard metrics before RTT PASS.
- Use repo `.tmp/jlink-mcp` for default temp/artifact preflight.

## Non-Goals

- Do not modify MCU code.
- Do not add RTT firmware.
- Do not implement `experiment_run`.
- Do not start a motor or call `capture_control start`.
- Do not guess HSS function signatures.
- Do not add a CodeGraph runtime dependency.
