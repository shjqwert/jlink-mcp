# jlink-mcp

Standalone MCP server for explicit, Agent-driven SEGGER J-Link debugging.

The server serializes physical Probe access and reports observed state and side effects. The default compact profile binds one explicit workspace with `project`, then exposes nine task-level tools. It never infers a project or Target from the server working directory.

Current source keeps the original 40-tool protocol in the opt-in `legacy` and `acceptance` profiles while making `compact` the default. `advanced` adds one explicit raw-command escape hatch.

## v2.2.0 changes

- Default results are minimal receipts. Completed captures return only `captureId`, state, sample count, and anomaly codes; `full` and `text` remain explicit compatibility modes.
- Final captures are one verified SQLite JCAP v2 `.jcap` file. Full samples, descriptors, events, quality evidence, and integrity hashes stay local and are queried only on demand.
- `capture.series` supports raw, fixed-interval, and maximum-point resolutions, selected statistics, shared millisecond time axes, and explicit 128 KiB cursor pagination.
- The retained HSS tool names now select `hss`, `background_poll`, then `stop_poll` by observed capability. No device/core allowlist rejects a J-Link-connectable target; degraded rate and intrusive pause evidence are recorded.

## v2.1.0 changes

- MCP result modes now separate canonical structured output, full diagnostics, and text compatibility without limiting the available tool surface.
- HSS windows can serialize timestamped variable reads, variable writes, and capture-owner `resume`/`continue` actions in one workflow.
- Newly finalized captures retain metadata plus binary Raw facts and materialize the verified SQLite query index only when analysis is requested.

## v2.0.20 changes

- The default MCP surface is reduced from 40 direct tools to nine task tools: `project`, `inspect`, `write`, `control`, `program`, `debug`, `trace`, `capture`, and `diagnose_crash`.
- Common breakpoint, RTT-window, and HSS-window workflows are available as one-call actions, with bounded default results and full operation details available through a resource link.
- Project binding remains explicit and process-scoped; ordinary task calls no longer repeat `projectRoot` or acceptance `runId`.
- Hardware-action policy belongs to the Agent or client. The MCP request schema no longer adds a duplicate authorization token, while Target identity, bounds, ownership, verification, cleanup, and uncertainty reporting remain enforced.
- HSS now consistently uses the separately validated `gdbDevice` attach profile, so a Flash device script is never selected merely because the exact programming device is configured.
- HSS stop is idempotent after a successful natural completion, eliminating a capture-window race without masking failed or interrupted sessions.
- `debug.run_to` restores only a classified normal J-Link attach stop before running to the requested breakpoint; explicit breakpoints, watchpoints, fault handlers, and other signals remain fail-closed.
- `debug.run_to` now retains a classified attach halt long enough to insert its managed hardware breakpoint, then resumes explicitly, avoiding a second interrupt-classification round trip.
- Managed breakpoint cleanup reads the breakpoint number from the native MI `bkpt` result even when GDB emits no human-readable `Breakpoint N` line.
- `debug.run_to` rejects timeouts, unrelated stops, and mismatched breakpoint numbers; it aborts dispatched insertion failures, clears its managed breakpoint, restores a timed-out running target, and avoids a duplicate continue when attach never halted.
- Release builds use the repository's pinned Windows x64 Helper component; runtime selection verifies its version, protocol, architecture, and SHA-256 before first execution, while native source rebuilds remain explicit.
- The opt-in `legacy` and `acceptance` profiles retain the 40 direct tools for compatibility and full evidence workflows; `advanced` adds only the raw escape hatch to the compact surface.

## Install the current stable v2.2.0 release

- Windows x64 with Node.js 22 or 24.
- SEGGER J-Link Software and a connected supported J-Link Probe for hardware operations.
- A project-local ELF with DWARF for typed variables and crash source mapping; an SVD is required for peripheral register access.

Ordinary users do not need Visual Studio, CMake, Python, or a database server. Download
`jlink-mcp-v2.2.0-windows-x64.zip` and `SHA256SUMS.txt` from the
[v2.2.0 GitHub Release](https://github.com/shjqwert/jlink-mcp/releases/tag/v2.2.0),
verify the checksum, and extract the ZIP. Then run:

```powershell
.\doctor.cmd
codex mcp add jlink -- D:\Tools\jlink-mcp-v2.2.0-windows-x64\jlink-mcp.cmd
```

The portable ZIP includes production npm dependencies, the SQLite native binding, and the
prebuilt `hss_helper.exe`. The only vendor runtime installed separately is SEGGER J-Link Software.

The Release also provides `jlink-mcp-2.2.0.tgz` for an online npm installation:

```powershell
npm install --global https://github.com/shjqwert/jlink-mcp/releases/download/v2.2.0/jlink-mcp-2.2.0.tgz
jlink-mcp-doctor
codex mcp add jlink -- jlink-mcp
```

The portable ZIP is the supported zero-build-tools path. The `.tgz` installer downloads the
prebuilt SQLite native binding; if that download is unavailable, npm may fall back to a local
native build. Use the portable ZIP when Visual Studio and CMake must never be required.

## Development and release builds

The ordinary Node build does not compile native code:

```powershell
npm ci
npm run build
npm test
```

Release packaging uses the repository's hash-verified prebuilt Windows x64 Helper and does not require Visual Studio. A maintainer rebuilding that component from source needs Visual Studio with the x64 C++ workload and CMake:

```powershell
npm run test:release
npm run pack:release
npm run build:hss:source
$env:JLINK_MCP_TEST_ROOT = "D:\User\Jlink_MCP_TEST"
npm run test:release-install
```

Hardware acceptance can force one backend with `JLINK_MCP_PROFILE=acceptance` plus `JLINK_MCP_TEST_CAPTURE_BACKEND=hss|background_poll|stop_poll`. The switch is rejected in every ordinary profile and is not a production routing option.

`build:release` verifies the pinned statically linked Windows x64 HSS Helper, its component and
protocol versions, runs its self-test, and builds the Node entry points. `pack:release` runs the
complete release gate, then creates the installable npm archive, portable ZIP, and SHA-256 manifest
under `release/v<package-version>/`. The package is marked private to prevent accidental npm Registry
publication; release artifacts are distributed only through GitHub Releases.

## Portable MCP configuration

For a source checkout, place this example in the repository root. It deliberately has no
machine-specific working directory or Target defaults.

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

The default is `JLINK_MCP_PROFILE=compact`. Set the environment variable to `advanced`, `legacy`, or `acceptance` only when that wider contract is required. A profile is fixed for the lifetime of one MCP process.

## Canonical Tool List

The default `compact` profile registers exactly nine task tools:

```text
project, inspect, write, control, program, debug, trace, capture, diagnose_crash
```

Each task uses a small `action` plus `params` contract. `project` binds the explicit root and handles `devices`, `configure`, `status`, `verify`, and `artifacts`; all other tools consume the bound root internally. `debug.run_to`, `trace.rtt_window`, and `trace.hss_window` each provide one-call managed workflows. With no result-mode override, every profile returns the bounded `normal` result; complete operation envelopes are returned only through explicit `full` mode.

The `advanced` profile exposes those nine tools plus `raw`. The raw `gdb` and `probe` actions keep unknown-effect and state-uncertainty reporting without adding a second authorization token to the request.

`JLINK_MCP_RESULT_MODE` controls only the returned representation, not which MCP tools may be called. `normal` is the default and returns the minimum sufficient structured result; capture completion is limited to `captureId`, state, sample count, and anomaly summary. `full` returns the complete audit envelope, and `text` preserves the original single JSON-text representation. `content.text` and `structuredContent` are generated from the same result object.

The `legacy` profile preserves these 40 direct tools and their schemas unchanged. `acceptance` uses the same direct surface so `runId` and full evidence envelopes remain available:

```text
mcp_init, list_devices, target_configure, target_status,
artifact_probe, symbol_search, symbol_resolve,
read_variable, write_variable, read_memory, write_memory, core_register_access, peripheral_register_access,
target_control, flash, erase,
hss_start, hss_status, hss_stop, hss_recover,
debug_sequence_execute,
capture_list, capture_summary, capture_series, capture_event_window, capture_export_csv,
gdb_open, gdb_command, gdb_breakpoint_list, gdb_breakpoint_delete, gdb_wait, gdb_backtrace, gdb_close,
rtt_open, rtt_read, rtt_search, rtt_clear, rtt_close,
diagnose_crash, probe_command
```

All profiles expose the read-only `rtt://output`, `probe://gdb-server-log`, and `probe://status` resources. Compact and advanced also expose the bounded operation-detail resource template. No MCP Prompts are registered.

## Operating rules

- Starting the MCP server and listing its tools are side-effect free for the engineering project. In compact/advanced, call `project` with an explicit `projectRoot`, or omit it only when the client declares exactly one file workspace root. In legacy/acceptance, call `mcp_init`. Binding rejects a different root in the same process and a subdirectory beneath an existing `.jlink-mcp` root.
- Reads and preflight do not implicitly halt, reset, resume, recover, flash, erase, or write the target.
- `target_control` is the explicit CPU-state operation. Core-register and SVD peripheral-register operations are separate bounded actions.
- RAM (`write_memory`) and typed-variable writes default to exact readback verification. SVD peripheral-register writes also default to verification. Readback proves bytes observed by its named J-Link connection, not target-program consumption.
- Hardware-action policy belongs to the Agent or MCP client. The server does not require a duplicate confirmation field; it still enforces exact Target identity, bounded inputs, Probe ownership, Artifact freshness, verification, cleanup, and explicit unknown-state reporting.
- If the target was halted before `flash`, the server verifies that it remains halted and issues a safety halt when the vendor tool leaves its state running or unknown. This recovery is reported explicitly and never resumes a target that was running before Flash.
- Typed-variable and trace-capture requests use logical selectors. The server resolves them against the current Artifact layout and never accepts a caller-supplied address as typed-symbol authority.
- Automatic trace capture is capped at ten synchronized variables, 1 kHz, and 60 seconds. It attempts HSS, running-state background polling, then short stop/read/resume polling. No device/core name is a support gate. Optional `writeVariables` do not consume sample slots; `trace.hss_window` accepts up to 30 typed read/write and `resume`/`continue` actions.
- Call the retained `hss_start` action with `dryRun=true` to validate the real variables, bounds, and automatic backend order without creating a capture. Falling below the requested rate does not discard data: real timestamps are retained and `RATE_DEGRADED` is reported.
- Capability probing, dry-run, start, and stop preserve observed target execution state. Stop polling records every actual pause and confirms resume after each read; an unconfirmed resume stops immediately with `stateUnknown=true`.
- `debug_sequence_execute` synchronously runs a prevalidated 1–30 second sequence of 2–32 trace, typed-variable, and capture-owner target-control operations. During an active capture only `resume`/`continue` is allowed; stop the capture before halt, pause, reset, or recover. It uses absolute monotonic timing and only executes declared RAM restore/capture-stop cleanup actions after failure, cancellation, or timeout.
- Use `read_variable` or `write_variable` for one variable operation. Use `debug_sequence_execute` only when multiple operations require fixed intervals over at least one second; the Agent waits until the complete sequence result is returned.
- Peripheral register access requires a configured, validated SVD. There is no inferred raw-memory substitute.
- GDB and RTT sessions are explicit and never start each other. Crash diagnosis inspects an already halted target only.

## Capture package

A newly finalized capture is exactly one read-only SQLite JCAP v2 file:

```text
<captureId>.jcap
```

The file contains `manifest`, `variables`, 64 KiB-bounded `sample_chunks`, `events`, `quality`, and `integrity` tables. Capture staging is private; completion is returned only after transaction, CRC, count, hash, and SQLite integrity checks succeed. The final directory contains no WAL, SHM, temporary database, CSV, JSON, or chart. Interrupted and failed captures retain their verified valid prefix.

`capture.summary` returns the variable catalog and valid time range. `capture.series` reads selected variables and an optional half-open millisecond range using `raw`, `interval`, or `points` resolution and selected `last`/`min`/`max` statistics. Arrays share one aligned time axis, missing values are `null`, and responses over 128 KiB return `nextCursor` instead of truncating. CSV is created only by explicit export.

Existing JCAP v1 packages remain readable and rebuildable for compatibility. Discoverable JCAP v0 packages remain untouched, appear as unsupported, and cannot be queried or exported.

The standalone executable is the MCP stdio CLI. It does not expose a public Node.js JCAP API.

## Local evidence

Generated captures, exports, acceptance evidence, J-Link DLLs, local project paths, Probe serials, and Artifact hashes belong in ignored local storage such as `test-output/`. Do not commit them.

## License

MIT. See [LICENSE](LICENSE).
