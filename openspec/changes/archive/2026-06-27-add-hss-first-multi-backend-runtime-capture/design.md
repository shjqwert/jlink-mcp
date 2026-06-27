# Design: HSS-first Multi-Backend Runtime Capture

## CaptureBackend

Each backend exposes:

- `name`
- `priority`
- `requiresFirmware`
- `requiresTargetCodeChange`
- `requiresSDK`
- `requiresExternalTool`
- `supportsRead`
- `supportsWrite`
- `supportsStreaming`
- `supportsRunWhileTargetRunning`
- `supportsExperimentExport`
- `expectedUse`
- `probe()`
- `benchmark()`

## Priority

1. `jlink-hss`
2. `direct-rtt-channel`
3. `memory-poll-rsp`
4. `external-import`

## Backend Rules

- `jlink-hss` is available only when `JLINK_HSS_ENABLED=1`, `JLINK_SDK_DIR` is present, and an HSS adapter reports available.
- `direct-rtt-channel` is available only when an RTT control block and requested channel metadata exist.
- `memory-poll-rsp` is a low-rate fallback and must not be selected ahead of HSS or RTT.
- `external-import` is selected only for offline import.
- A preferred backend override can select an available backend, but an unavailable preferred backend returns warnings and no fake success.

## Safety

The router and protocol code do not flash, reset, halt, resume, write target memory, start capture, or call CodeGraph MCP. TraceAgent signal writes are allowlist-gated before any transport write can occur.
