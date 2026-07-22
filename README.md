# jlink-mcp

Standalone MCP server for explicit, Agent-driven SEGGER J-Link debugging.

The server serializes physical Probe access and reports observed state and side effects. It does not infer a Target from an environment default: configure each canonical `projectRoot` with `target_configure` before target operations.

## Windows prerequisites

- Node.js 18 or later and `npm`.
- CMake and Visual Studio Build Tools with the x64 C++ workload, used to build the native HSS Helper.
- SEGGER J-Link Software and a connected supported J-Link Probe for hardware operations.
- A project-local ELF with DWARF for typed variables and crash source mapping; an SVD is required for peripheral register access.

Build a clean standalone package with:

```powershell
npm ci
npm run build
npm run test:ci
npm pack --ignore-scripts
```

`npm run build` rebuilds the ignored x64 HSS Helper at `native/hss-helper/bin/hss_helper.exe`, compiles TypeScript, and bundles the stdio entry at `out/mcp/standalone.js`. Start it from the installed package with `node out/mcp/standalone.js`.

## Portable MCP configuration

Place either example in the repository or installed package root; it deliberately has no machine-specific working directory or Target defaults.

```json
{
  "mcpServers": {
    "jlink": {
      "command": "node",
      "args": ["out/mcp/standalone.js"]
    }
  }
}
```

## Canonical Tool List

The standalone server registers exactly these 36 direct tools:

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

Only the read-only `rtt://output`, `probe://gdb-server-log`, and `probe://status` Resources are exposed; no MCP Prompts are registered.

## Operating rules

- Reads and preflight do not implicitly halt, reset, resume, recover, flash, erase, or write the target.
- `target_control` is the explicit CPU-state operation. Core-register and SVD peripheral-register operations are separate bounded actions.
- RAM (`write_memory`) and typed-variable writes default to exact readback verification. SVD peripheral-register writes also default to verification. Readback proves bytes observed by its named J-Link connection, not target-program consumption.
- Before `flash`, `erase`, `probe_command`, or `gdb_command`, the AI must explain the exact intended effects and obtain the user's explicit approval. It then retries the same call with `userConfirmed: true`; otherwise the server rejects the operation before accessing the target.
- Typed variable and HSS requests use logical selectors. The server resolves them against the current Artifact layout and never accepts a caller-supplied address as typed-symbol authority.
- HSS is capped at ten synchronized variables, 1 kHz, and 60 seconds. Call `hss_start` with `dryRun=true` to obtain capability and capacity facts without starting a Helper or creating a capture.
- Peripheral register access requires a configured, validated SVD. There is no inferred raw-memory substitute.
- GDB and RTT sessions are explicit and never start each other. Crash diagnosis inspects an already halted target only.

## Capture package

JCAP v1 retains exactly four durable files:

```text
<captureId>.jcap/
  capture.json
  raw/samples.bin
  raw/events.bin
  capture.db
```

Capture queries use `capture.db`; a verified package can rebuild a missing or damaged index from metadata and Raw files. Explicit CSV exports are written outside the package.

## Offline UI and local evidence

The existing Offline UI is retained for compatibility and is outside this Agent contract.

Generated captures, exports, acceptance evidence, J-Link DLLs, local project paths, Probe serials, and Artifact hashes belong in ignored local storage such as `test-output/`. Do not commit them.

## License

MIT. See [LICENSE](LICENSE).
