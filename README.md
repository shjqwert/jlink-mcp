# jlink-mcp

Standalone MCP server for Agent-driven MCU debugging through SEGGER J-Link.

The Agent decides which operation to request. The server executes that exact operation, serializes physical Probe access, and reports observed state and side effects. There is no embedded approval broker, risk tier, challenge/token flow, workflow Prompt, or required plan/execute handshake.

## Build and run

Requirements: Node.js 18+, SEGGER J-Link Software, and a supported J-Link Probe.

```powershell
npm install
npm run build
node out/mcp/standalone.js
```

Configure a Target with `target_configure` before project operations. One canonical `projectRoot` owns one persistent Target configuration; another project must be configured independently.

## MCP surface

The standalone server exposes 57 direct tools covering Target configuration, Artifact and symbol resolution, typed variables, SVD peripheral registers, core registers, memory, CPU control, flash/erase, raw GDB/Probe commands, HSS capture, JCAP queries, GDB Server, GDB, RTT, and deterministic analysis.

Only these Resources are exposed:

- `rtt://output`
- `probe://gdb-server-log`
- `probe://status`

No MCP Prompts are registered.

## Correctness rules

- Reads do not implicitly halt or reset the target.
- Preflight failures do not reset or halt the target.
- Writes default to no old-value capture, no readback, and no restore. The caller opts into confirmation.
- All physical operations for one Probe are serialized.
- SVD register operations require an explicitly configured, validated SVD. Raw memory tools are the fallback when no SVD can be supplied, but do not count as SVD coverage.
- HSS is capped at 10 synchronized variables, 1 kHz, and 60 seconds for the current hardware capability.

## Capture package

JCAP v1 uses four durable files:

```text
<captureId>.jcap/
  capture.json
  raw/samples.bin
  raw/events.bin
  capture.db
```

AI and local analysis consumers query `capture.db`. If it is damaged, it is rebuilt from `capture.json` and the append-only Raw files. CSV exists only when explicitly exported and is written outside the JCAP package.

## Offline UI

The existing local Offline UI source is retained for compatibility. It is intentionally outside the scope of the current Agent-first refactor: this change does not modify, extend, or accept it.

## Local evidence

Generated captures, exports, acceptance evidence, environment details, local project paths, Probe serial numbers, and Artifact hashes belong under ignored `test-output/` storage and must not be committed or pushed.

## License

MIT. See [LICENSE](LICENSE).
