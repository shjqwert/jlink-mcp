# J-Link MCP Server

Standalone stdio MCP server for explicit, Agent-driven SEGGER J-Link debugging.

## Build and test

Windows development requires Node.js 18+, CMake, Visual Studio Build Tools with x64 C++, and SEGGER J-Link Software for real hardware.

```powershell
npm ci
npm run build
npm run test:ci
```

`npm run build` compiles the ignored x64 native HSS Helper, TypeScript, and the standalone stdio bundle. Package verification expects `out/mcp/standalone.js` and `native/hss-helper/bin/hss_helper.exe`, while rejecting local evidence, DLLs, target binaries, and machine configuration.

## Runtime contract

- `src/mcp/standalone.ts` is the stdio entry and `src/mcp/server.ts` registers the direct API.
- Each canonical `projectRoot` must be explicitly configured with `target_configure` before target operations.
- One physical Probe is serialized across direct, HSS, GDB, RTT, and memory-session operations.
- Reads and preflight never implicitly change target execution state.
- Typed selectors are resolved against the current Artifact; SVD peripheral access requires a configured validated SVD.
- The Offline UI is separate and outside this contract.

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

Local captures, exports, environment details, local paths, Probe serials, hashes, and issue ledgers stay under ignored `test-output/`; do not commit them. The authoritative Phase 7 requirements are under `openspec/changes/close-agent-hardware-release-loop/`.
