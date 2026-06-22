## Why

The current MCP can inspect snapshots and consume RTT text, but it cannot record multiple firmware variables continuously with bounded timing while the motor runs. Motor-control debugging needs a source-code-free capture path that can collect seven variables at 1 kHz for 60 seconds and safely coordinate motor start and stop.

## What Changes

- Add a Windows x64 native sampler using the installed official J-Link GDB Server and a persistent GDB Remote Serial Protocol (RSP) connection.
- Add an MCP capture lifecycle for preparation, calibration, start, status, stop, querying, export, listing, deletion, and approved motor control.
- Resolve fixed-address global/static scalar symbols and scalar members of fixed-address global/static structures from an explicitly selected ELF through offline `arm-none-eabi-gdb` queries.
- Validate the ELF against target Flash, RAM addresses, target running state, probe availability, GDB Server/RSP capabilities, and measured acquisition performance before arming.
- Record up to 32 variables in preallocated memory, with the current hardware acceptance target of seven variables at 1 kHz for 60 seconds and a frame read-window P99.9 of at most 100 microseconds.
- Persist raw capture data plus CSV and JSON metadata, and provide bounded min/max/average queries for Agent analysis.
- Add a version-controlled project control allowlist for motor start/stop commands and verification conditions.
- Add failure handling that attempts an approved stop command first, then a single hardware reset when required and explicitly enabled.
- Add an explicit native capture build without introducing a licensed SDK dependency.

## Capabilities

### New Capabilities

- `jlink-variable-capture`: Source-code-free, calibrated J-Link GDB Server/RSP acquisition, capture lifecycle, persistence, export, and bounded result queries.
- `motor-control-safety`: Project-scoped motor command allowlisting, verified start/stop sequencing, failure stop/reset behavior, and probe exclusivity.

### Modified Capabilities

None.

## Impact

- Affects MCP tool registration and lifecycle coordination in `src/mcp/server.ts`.
- Adds a Windows x64 C++ helper process and Node-to-helper IPC.
- Adds offline ELF symbol resolution through the existing GDB dependency.
- Adds project configuration schema, capture storage, export/query logic, tests, and deployment/acceptance documentation.
- Requires the official J-Link Software Pack already installed on the host and `arm-none-eabi-gdb` for offline ELF symbol resolution; no private DLL API is used.
- Capture owns the probe while armed or sampling, so existing probe/GDB tools must reject conflicting operations.
