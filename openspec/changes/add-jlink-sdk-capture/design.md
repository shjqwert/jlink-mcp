## Context

The MCP currently performs one-shot probe operations, persistent GDB commands, and RTT text buffering. Those paths cannot guarantee bounded, source-code-free acquisition of several motor-control variables. The required workload is seven fixed-address RAM variables sampled at 1 kHz for 60 seconds on Windows x64 with a J-Link CE, Z20K146MC, and SWD at 4 MHz. Values in one frame may be read sequentially, but the measured first-to-last read window must have P99.9 at or below 100 microseconds. Windows provides soft real-time scheduling only, so the requirement is an empirical acceptance criterion rather than a hard real-time guarantee.

The sampler also participates in a physical motor workflow. The Agent must start acquisition before commanding motor start, verify start and stop through project-specific state variables, stop automatically on timeout or control loss, and use a hardware reset as a final fallback when explicitly enabled. An independent hardware emergency-stop path remains mandatory.

The installed official J-Link Software Pack provides `JLinkGDBServerCL.exe` but not the separately sold SDK development package. The capture backend therefore uses the documented GDB Remote Serial Protocol over a persistent local TCP connection and MUST NOT call private J-Link DLL exports.

## Goals / Non-Goals

**Goals:**

- Capture 1–32 ELF-resolved fixed-address scalar RAM values, including scalar members of fixed-address global/static structures, at a requested rate of 1–1000 Hz.
- Pass the current hardware acceptance test with seven variables, 1 kHz, 60 seconds, zero missed deadlines, and a frame read-window P99.9 no greater than 100 microseconds.
- Preserve target execution during sampling and detect any unexpected halt or state change.
- Provide calibrated acquisition, session lifecycle, durable export, bounded Agent queries, and complete timing/error metadata.
- Coordinate allowlisted and verified motor start/stop commands without exposing arbitrary writes.
- Stop safely on timeout, Agent loss, sampling failure, or explicit stop.
- Keep the existing TypeScript build and use only installed official J-Link command-line software plus the native helper.

**Non-Goals:**

- Firmware instrumentation, RTT binary acquisition, hard real-time guarantees, or sampling above 1 kHz.
- Live waveform rendering in the first release.
- Local variables, pointer chains, arrays, bitfields, enums, whole aggregate values, `float64`, arbitrary addresses, or big-endian targets.
- Automatic SWD speed changes, GDB sampling fallback, probe recovery loops, or automatic restart of the motor.
- Performance guarantees for probes, targets, J-Link Software versions, RSP capability sets, or operating systems outside the validated configuration.

## Decisions

### Native sampler boundary

A standalone Windows x64 C++ helper SHALL own one persistent TCP connection to an MCP-managed `JLinkGDBServerCL.exe` process and the timing-critical loop. Node.js SHALL spawn it and exchange versioned JSON messages over standard input/output. The helper sends raw RSP packets directly rather than launching repeated GDB/JLink.exe commands, avoiding process and text-command overhead while keeping JavaScript timers out of the acquisition path.

The helper SHALL use `QueryPerformanceCounter`, a preallocated locked-memory buffer, `HIGH_PRIORITY_CLASS`, and a high-priority worker thread. It MAY use configured core affinity but SHALL NOT use `REALTIME_PRIORITY_CLASS` or modify the Windows power plan. Frames use absolute deadlines; a late frame is recorded and skipped rather than followed by catch-up sampling.

### Official GDB Server/RSP integration

The existing J-Link installation path resolves `JLinkGDBServerCL.exe`; no SDK environment variable, header, import library, or private DLL entry point is required. The server is started for the selected device, probe serial, interface, configured SWD speed, localhost-only transport, and single-client lifetime. The helper negotiates RSP capabilities, uses packet checksums and acknowledgements, and issues coalesced memory-read packets over one connection.

`npm run build` remains the existing TypeScript build. `npm run build:capture` uses MSVC and CMake and has no SEGGER development-package dependency. Runtime verifies the installed GDB Server version and required RSP behavior through capability negotiation and calibration.

Preparation MUST prove that the selected server can read memory while the CPU remains running. If the server halts the target, rejects running-state reads, or cannot meet timing, preparation fails. The system does not switch to a private DLL API, J-Scope GUI automation, or repeated `gdb_command` calls.

### Symbol resolution and target validation

`capture_prepare` requires absolute paths for the ELF and `.jlink-mcp.json`. Existing `arm-none-eabi-gdb` loads the ELF offline and resolves addresses, sizes, and types, then exits before the helper acquires the probe. A selector may name a standalone global/static scalar or a dot-separated, fixed-offset scalar member path rooted at a global/static structure, such as `AppMotorDbg.c::gstMotorDbg.fThetaRad`. Duplicate static roots require `source-file::symbol`; ambiguity fails the whole preparation. Member resolution MUST use ELF/DWARF layout information and MUST NOT dereference pointers, index arrays, or accept caller-computed offsets. Any missing, unsupported, optimized-out, unaligned, non-writable, non-RAM, peripheral, unmapped, or non-scalar final value fails the whole preparation.

Supported final scalar types are `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, and `float32`, with natural alignment. The ELF must be little-endian. Preparation verifies ELF loadable Flash section checksums against the target, validates target/probe identity and voltage, confirms the CPU is already running, and verifies that background reads do not change its running state. A halted or indeterminate target is rejected; the sampler never issues `go`.

### Preparation, calibration, and read planning

Preparation is separate from capture so ELF validation and calibration cannot hide the beginning of motor startup. It acquires the configured probe serial number; multiple probes without `JLINK_SERIAL` cause an explicit failure. Probe use is exclusive. The server rejects preparation if J-Scope, an external GDB Server, or another process owns the probe and never kills an external process. The capture service starts and owns its dedicated GDB Server process; an existing MCP-owned debug server may be stopped only after explicit user approval.

Symbols are sorted by address. Calibration benchmarks individual reads and safe coalescing strategies that include unused bytes only inside validated RAM. It selects the fastest plan whose measured P99.9 frame window is at most 100 microseconds. Calibration uses the configured SWD rate without changing it. The API accepts at most 32 symbols, but only the seven-variable acceptance configuration is promised. Failure to meet rate or read-window requirements rejects preparation; there is no automatic rate reduction, variable removal, or GDB fallback.

The state machine is `idle -> preparing -> armed -> capturing -> completed|stopped|failed`. Only one preparing, armed, or capturing session is allowed. Active sessions cannot be deleted. Probe-touching MCP tools reject calls while a capture session owns the probe; capture status, stop, and non-hardware queries remain available.

### Sampling and timing semantics

Sampling rates range from 1 to 1000 Hz and default to 1000 Hz. Duration ranges from 1 to 600 seconds and defaults to 60 seconds. The duration clock starts only after motor-start verification succeeds; pre-start and post-stop intervals are extra. Every frame records index, scheduled time, read start/end/midpoint, read duration, flags, and decoded raw values. Engineering units and aliases are labels only; no scaling or offset is applied.

The acceptance report includes actual rate, scheduled and collected frame counts, missed deadlines, min/mean/max and percentile read windows, control events, read failures, reset events, and termination reason. Windows timing is explicitly soft real-time. The current pass criterion is zero missed deadlines, actual rate at least 1 kHz, and frame read-window P99.9 at most 100 microseconds for the seven-variable 60-second run.

### Capture storage and result access

The helper preallocates and locks sufficient RAM for the requested session. It writes the compact versioned binary artifact only after normal or abnormal termination. This avoids disk I/O in the timing loop; a helper process crash may lose the current capture and is an accepted trade-off.

Output defaults to `%TEMP%\jlink-mcp-captures`; `capture_prepare` may specify a writable absolute directory. File names use timestamps plus random session IDs and never overwrite. `capture_export` creates CSV data and a same-name JSON metadata file. Metadata includes session ID, ELF path and SHA-256, device, probe model and serial, SWD rate, J-Link GDB Server version, negotiated RSP capabilities, symbol names/addresses/types/labels, timing metrics, control events, failures, and resets.

`capture_query` selects variables and a time range and returns at most 2000 time buckets with min/max/average values so Agents can analyze long captures without loading every frame. `capture_list` discovers persisted sessions. `capture_delete` accepts one completed/failed/stopped session ID; users may also delete files directly. Wildcard or bulk deletion is excluded.

### Project-scoped motor control

The repository-tracked `.jlink-mcp.json` is a reviewed project debugging contract. It contains no probe serial, machine path, or secret. `capture_prepare` receives its absolute path explicitly. Multiple candidate config files require user selection.

The config schema is versioned and defines only named `start` and `stop` commands. Each command supplies an ELF scalar selector, supported scalar type, fixed value, verification selector/condition, and configurable timeout. Control and verification selectors use the same standalone-scalar or fixed-offset structure-member resolution rules as capture selectors. Default verification timeouts are 1000 ms for start and 500 ms for stop. `preStartMs` defaults to 500 ms and ranges from 0–5000 ms. `postStopMs` defaults to 1000 ms and ranges from 0–10000 ms. Agent-discovered mappings require user confirmation before first use and after any mapping change.

`capture_control` accepts only a session ID and allowlisted command name. It accepts no address or caller-supplied value. The helper resolves the control and verification symbols against the same validated ELF. Start is allowed only while capturing and only after the user explicitly requested motor operation in the current task. It first records the configured pre-start baseline, writes the allowlisted start value between frames, records the event timestamp, and verifies the start state. Failure sends stop; failure to verify stop invokes the configured reset fallback.

Stop is allowed while armed or capturing. It writes and verifies the allowlisted stop, continues sampling for `postStopMs`, then finishes. `capture_stop` first stops and verifies the motor if it is running. Natural duration expiry, Agent/control-channel loss, and task termination also attempt verified stop before ending. The Agent never infers arbitrary addresses, values, or commands.

### Failure and safety behavior

Sampling is read-only except for allowlisted motor-control writes and one approved hardware reset fallback. `resetOnFailure` defaults to false and must be explicitly true for each prepared session after informing the user. It applies only after capture begins, never during preparation.

Three consecutive frame read failures trigger termination. The helper first attempts verified stop when communication allows it. If stop cannot be confirmed and reset is enabled, it performs one reset through the J-Link hardware RESET pin, saves partial data, and exits. It never writes AIRCR, reconnects, changes SWD speed, continues sampling after reset, or restarts the motor. If reset fails, the session is marked critical and relies on the independently available hardware emergency stop.

If the MCP process exits or the IPC/parent handle closes during capture, the helper follows the same stop, optional reset, persist, and exit sequence. A user stop never resets a motor that is already verified stopped. All stop/reset attempts and results are persisted.

### MCP surface

The new surface contains exactly nine tools:

1. `capture_prepare`
2. `capture_start`
3. `capture_status`
4. `capture_stop`
5. `capture_control`
6. `capture_query`
7. `capture_export`
8. `capture_list`
9. `capture_delete`

`capture_prepare` accepts `elfFile`, `configFile`, `symbols[{name, alias?, unit?}]`, `rateHz`, `durationSec`, `resetOnFailure`, and optional `outputDir`, then returns a session ID. Start, stop, control, query, export, and delete require that ID. MCP prompts document the Agent sequence: prepare, confirm armed, start capture, collect baseline, start motor only on explicit user request, stop/verify motor, collect post-stop data, stop/export/query. They explicitly prohibit repeated `gdb_command` sampling.

### Testing and acceptance

The C++ helper includes a synthetic timing/buffering self-check. Node tests cover IPC framing, state transitions, validation, conflict rejection, storage, query aggregation, and safety routing without hardware. Hardware acceptance uses the current J-Link CE/Z20K146MC/SWD 4 MHz setup with seven supported variables for 60 seconds.

The disconnect/reset test is first performed with the motor disabled, no load, and the power stage safe. It verifies three consecutive failures, stop attempt, hardware reset, partial-data persistence, and process exit. Other probe/target combinations are documented as usable but unverified until they pass their own acceptance run.

## Risks / Trade-offs

- **Windows scheduling jitter** -> Use QPC, absolute deadlines, high process/thread priority, preallocated locked memory, no disk writes, and report every miss; do not claim hard real-time behavior.
- **J-Link CE throughput is insufficient** -> Fail calibration before motor start. Do not degrade silently. A faster validated probe is the upgrade path.
- **Variables are too dispersed for a 100 microsecond frame** -> Benchmark safe coalescing strategies and reject the requested symbol set if none passes.
- **Stale ELF reads incorrect addresses** -> Verify Flash section checksums and all symbol properties before arming.
- **GDB Server cannot perform background reads or meet latency** -> Detect this before arming and fail with measured evidence; do not halt the target or fall back to private DLL APIs.
- **Probe contention changes timing** -> Enforce exclusive ownership and reject conflicting tools/processes.
- **Control mapping starts/stops the wrong state** -> Require a reviewed project allowlist, explicit config path, ELF resolution, user confirmation, and read-back verification.
- **Communication loss leaves the motor running** -> Attempt verified stop, then one hardware reset if enabled, while retaining an independent physical emergency stop.
- **In-memory buffering loses data if the helper crashes** -> Accept the risk to protect timing; persist immediately on all handled termination paths.

## Migration Plan

1. Verify the official J-Link Software Pack and `arm-none-eabi-gdb` installations.
2. Build and self-test the standalone RSP helper without changing existing MCP behavior.
3. Add Node IPC and session-state integration behind the presence of the helper.
4. Add the nine MCP tools, probe exclusivity, project config validation, storage, export, and query paths.
5. Add `.jlink-mcp.json` to the motor project after the Agent identifies mappings and the user confirms them.
6. Run the no-hardware test suite and existing `npm run lint` / `npm run build`.
7. Run no-load hardware calibration and the seven-variable 1 kHz/60-second acceptance test.
8. Run the safe disconnect/reset test.
9. Enable the capture workflow in MCP prompts only after acceptance passes.

Rollback removes or disables the capture helper and tools. Existing one-shot probe, GDB, RTT, and VS Code commands remain unchanged. Capture files are standalone and remain readable/exportable by the versioned format tooling.

## Open Questions

None. The concrete project control symbols are deployment inputs resolved before hardware acceptance, not unresolved design choices.
