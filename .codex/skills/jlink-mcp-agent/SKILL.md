---
name: jlink-mcp-agent
description: Use J-Link MCP for explicit daily MCU debugging: target configuration, Artifact-backed variables, bounded Probe control, HSS capture, JCAP queries, GDB, RTT, and halted-target crash diagnosis.
---

# J-Link MCP Agent

Begin with `target_configure` for the exact absolute `projectRoot`; do not rely on environment defaults or another project's Target. Use `target_status` and `list_devices` for non-mutating context.

Use the smallest direct operation that establishes evidence:

1. Use `artifact_probe`, `symbol_search`, and `symbol_resolve` before typed access.
2. Use `read_variable` or `read_memory` for observation. Use `write_variable` only when a typed RAM write is intended; its default readback is connection evidence, not target-program consumption. Use `write_memory` only for explicit raw-memory work.
3. Use `core_register_access`, `peripheral_register_access`, and `target_control` as separate bounded operations. Do not substitute raw memory for an unavailable SVD.
4. Use `hss_start` with `dryRun=true` before capture when capacity is unknown, then `hss_status`, `hss_stop`, or `hss_recover` as needed. Query a completed capture with `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, and `capture_export_csv`.
5. Use `gdb_open` only for an explicit managed GDB session, then `gdb_command`, `gdb_wait`, `gdb_backtrace`, and `gdb_close`. Use `rtt_open`, `rtt_read`, `rtt_search`, `rtt_clear`, and `rtt_close` only against the explicitly available RTT endpoint; these sessions do not start one another.
6. Use `diagnose_crash` only for an already halted Cortex-M target. Use `flash`, `erase`, and `probe_command` only when their explicit effects are intended.

## Canonical Tool List

```text
list_devices, target_configure, target_status,
artifact_probe, symbol_search, symbol_resolve,
read_variable, write_variable, read_memory, write_memory, core_register_access, peripheral_register_access,
target_control, flash, erase,
hss_start, hss_status, hss_stop, hss_recover,
capture_list, capture_summary, capture_series, capture_event_window, capture_export_csv,
gdb_open, gdb_command, gdb_wait, gdb_backtrace, gdb_close,
rtt_open, rtt_read, rtt_search, rtt_clear, rtt_close,
diagnose_crash, probe_command
```

Interpret structured before/after state, requested and observed effects, verification source, warnings, and errors literally. Never claim that a matching J-Link readback proves target-program consumption without a separate observed response.
