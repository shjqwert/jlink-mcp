# HM_C095 HSS MVP-B Hardware Smoke Plan

Blocked unless a real HM_C095 target, J-Link, debug ELF/map, and reviewed `.jlink-mcp/policy.json` are present. Do not report hardware success from fake backend tests.

Safe target rules:
- Use only `Debug_*` or `Test_*` variables.
- Do not write motor start/stop, PWM, enable, direction, core state machine, flash, peripheral, or register targets.
- Start with one scalar or one array element.
- Run slice writes only after scalar/element readback passes.
- Use small bounded values.

Manual MCP sequence:
1. Confirm J-Link and HM_C095 are connected.
2. Confirm `Appl/Debug/Exe/FOC_SCM.out` and `Appl/Debug/List/FOC_SCM.map` exist.
3. Confirm `.jlink-mcp/policy.json` allowlists only safe debug/test RAM variables.
4. Call `hss_capture_start` with debug observation variables.
5. Call `variable_write_plan` for a scalar safe value.
6. Call `variable_write_execute`.
7. Call `variable_write_plan` for one fixed array element.
8. Call `variable_write_execute`.
9. Optionally call array slice plan/execute after element write passes.
10. Call `hss_capture_stop`.
11. Call `hss_capture_query` with `mode: "event_window"` and each returned `eventId`.
12. Call `hss_capture_export` with `eventAware: true`.
13. Validate `capture.events.jsonl`, `capture.flags.jsonl`, `capture.json.events[]`, `capture.json.flagIntervals[]`, readback, audit, and event-window summary.

Blocked output must include:
- Reason hardware was unavailable or unsafe.
- Exact device/artifact/policy required.
- Commands or MCP tool calls to reproduce.
- Expected pass criteria.
