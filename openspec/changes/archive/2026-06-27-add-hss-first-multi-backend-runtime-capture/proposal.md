# Proposal: add-hss-first-multi-backend-runtime-capture

## Summary

Add an HSS-first runtime capture backend router and formalize fallbacks for RTT channel capture, low-rate memory polling, and offline external imports.

This change also fixes the HM_C095 smoke follow-up: RTT channel 1 must be modeled as a first-class direct RTT channel path instead of forcing the legacy RTT telnet/channel 0 `rtt_send` path.

## Motivation

The previous HM_C095 real-board smoke proved that:

- legacy `rtt_send` targets default RTT telnet/channel 0;
- HM_C095 TraceAgent commands use RTT channel 1 `AI_CMD`;
- SEGGER RTTLogger channel 1 can show gaps/CRC failures;
- direct RTT ring-buffer access produced clean channel 1 stream evidence;
- stable smoke analysis may legitimately warn `no state/fault/counter transitions detected`.

Jlink-MCP needs backend routing that does not require MCU source changes and does not treat RTT as mandatory.

## Goals

- Prefer `jlink-hss` when J-Link SDK/HSS is configured and adapter-proven.
- Use `direct-rtt-channel` only when an RTT control block and requested channel already exist.
- Fall back to `memory-poll-rsp` only as a low-rate backend.
- Keep `external-import` offline-only.
- Preserve old runtime analysis, Runtime Evidence, ExperimentStore, HM_C095 offline, and write validation behavior.
- Report measured rates and success rates; do not claim unmeasured performance.

## Non-Goals

- Do not modify MCU source code.
- Do not require target projects to add RTT firmware.
- Do not implement `experiment_run`.
- Do not start a motor.
- Do not write `bMotorStarted`, `AppMotorDbg.c::gstMotorDbg.*`, or `AppMotorCtrl.c::gstMotorCtrl.*`.
- Do not call `capture_control start`.
- Do not add a runtime dependency on CodeGraph MCP.
- Do not fake HSS availability when SDK/adapter support is missing.

## Compatibility

This is additive. Legacy `rtt_send` without a channel argument remains the channel-0 RTT telnet path. Channel-specific RTT operations return structured unavailable results unless a direct RTT transport is configured.
