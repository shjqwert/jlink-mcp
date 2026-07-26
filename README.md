# jlink-mcp

Standalone MCP server for explicit, Agent-driven SEGGER J-Link debugging.

The server serializes physical Probe access and reports observed state and side effects. It does not infer a Target from an environment default: configure each canonical `projectRoot` with `target_configure` before target operations.

## Install the current stable v1.1.1 release

- Windows x64 with Node.js 22 or 24.
- SEGGER J-Link Software and a connected supported J-Link Probe for hardware operations.
- A project-local ELF with DWARF for typed variables and crash source mapping; an SVD is required for peripheral register access.

Ordinary users do not need Visual Studio, CMake, Python, or a database server. Download
`jlink-mcp-v1.1.1-windows-x64.zip` and `SHA256SUMS.txt` from the
[v1.1.1 GitHub Release](https://github.com/shjqwert/jlink-mcp/releases/tag/v1.1.1),
verify the checksum, and extract the ZIP. Then run:

```powershell
.\doctor.cmd
codex mcp add jlink -- D:\Tools\jlink-mcp-v1.1.1-windows-x64\jlink-mcp.cmd
```

The portable ZIP includes production npm dependencies, the SQLite native binding, and the
prebuilt `hss_helper.exe`. The only vendor runtime installed separately is SEGGER J-Link Software.

The Release also provides `jlink-mcp-1.1.1.tgz` for an online npm installation:

```powershell
npm install --global https://github.com/shjqwert/jlink-mcp/releases/download/v1.1.1/jlink-mcp-1.1.1.tgz
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

Only the release maintainer needs Visual Studio with the x64 C++ workload and CMake:

```powershell
npm run test:release
npm run pack:release
$env:JLINK_MCP_TEST_ROOT = "D:\User\Jlink_MCP_TEST"
npm run test:release-install
```

`build:release` produces a statically linked Windows x64 HSS Helper, verifies its product and
protocol versions, runs its self-test, and builds the Node entry points. `pack:release` runs the
complete release gate, then creates the installable npm archive, portable ZIP, and SHA-256 manifest
under `release/v1.1.1/`. The package is marked private to prevent accidental npm Registry
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

## Canonical Tool List

The standalone server registers exactly these 37 direct tools:

```text
list_devices, target_configure, target_status,
artifact_probe, symbol_search, symbol_resolve,
read_variable, write_variable, read_memory, write_memory, core_register_access, peripheral_register_access,
target_control, flash, erase,
hss_start, hss_status, hss_stop, hss_recover,
debug_sequence_execute,
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
- If the target was halted before `flash`, the server verifies that it remains halted and issues a safety halt when the vendor tool leaves its state running or unknown. This recovery is reported explicitly and never resumes a target that was running before Flash.
- Typed variable and HSS requests use logical selectors. The server resolves them against the current Artifact layout and never accepts a caller-supplied address as typed-symbol authority.
- HSS is capped at ten synchronized capture variables, 1 kHz, and 60 seconds. Optional `writeVariables` are resolved before start and do not consume capture slots; sampled variables remain writable for compatibility.
- Call `hss_start` with `dryRun=true` to obtain capability, configured link speed, and capacity diagnostics without starting a Helper or creating a capture. The server reports requested and effective rates without automatically changing SWD speed or sample rate; falling below 95% is diagnostic, not by itself a corrupt-capture verdict.
- HSS capability, dry-run, start, and stop preserve the observed target execution state. An unexpected change from halted to running is restored with an explicit halt and the operation still fails; an initially running target is never resumed automatically to repair a mismatch.
- `debug_sequence_execute` synchronously runs a prevalidated 1–30 second sequence of 2–32 HSS and typed-variable operations. It uses absolute monotonic timing and only executes declared RAM restore/HSS stop cleanup actions after failure, cancellation, or timeout.
- Use `read_variable` or `write_variable` for one variable operation. Use `debug_sequence_execute` only when multiple operations require fixed intervals over at least one second; the Agent waits until the complete sequence result is returned.
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

JCAP v1 is the only supported Capture format. Discoverable legacy JCAP v0 packages remain untouched on disk, appear as unsupported in `capture_list`, and cannot be queried or exported.

The standalone executable is the MCP stdio CLI. It does not expose a public Node.js JCAP API.

## Local evidence

Generated captures, exports, acceptance evidence, J-Link DLLs, local project paths, Probe serials, and Artifact hashes belong in ignored local storage such as `test-output/`. Do not commit them.

## License

MIT. See [LICENSE](LICENSE).
