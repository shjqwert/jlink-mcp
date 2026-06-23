## 1. Contracts and Build Boundary

- [x] 1.1 Define the versioned helper IPC messages, capture states, binary file header/frame/event records, metadata schema, and `.jlink-mcp.json` schema; verify representative payloads round-trip in Node tests.
- [x] 1.2 Add the Windows x64 CMake/MSVC RSP helper skeleton and `npm run build:capture` without SEGGER SDK dependencies; verify the existing `npm run build` remains unchanged.
- [x] 1.3 Implement GDB RSP packet framing, checksum/ack handling, capability negotiation, timeouts, and explicit protocol errors; verify it never loads private J-Link DLL exports.
- [x] 1.4 Implement helper process JSON IPC framing, parent-handle monitoring, and clean startup/shutdown; verify malformed messages fail closed and parent loss reaches the safety shutdown path.

## 2. ELF and Project Validation

- [x] 2.1 Implement offline `arm-none-eabi-gdb` resolution for standalone scalars and dot-separated fixed-offset scalar members rooted at global/static structures, including `source-file::symbol` disambiguation; verify `gstMotorDbg.fThetaRad`-style selectors resolve from ELF/DWARF.
- [x] 2.2 Validate little-endian ELF data, final scalar type, natural alignment, writable RAM membership, and forbidden peripheral/debug ranges; verify ambiguous, optimized-out, aggregate, pointer-traversal, array-index, caller-offset, and unsafe selectors reject the whole request.
- [x] 2.3 Implement versioned `.jlink-mcp.json` parsing for reviewed start/stop values, verification conditions, timeouts, `preStartMs`, and `postStopMs`; verify arbitrary commands, addresses, and values are rejected.
- [x] 2.4 Implement target Flash checksum comparison against ELF loadable sections and persist the ELF SHA-256; verify a stale ELF cannot arm a session.

## 3. Probe Preflight and Calibration

- [x] 3.1 Implement capture-owned `JLinkGDBServerCL.exe` lifecycle, explicit probe selection, server/target identity checks, target-voltage checks, and exclusive ownership detection; verify multiple probes without `JLINK_SERIAL` and externally occupied probes fail without killing processes.
- [x] 3.2 Probe RSP capabilities and verify target running state before and after background reads; reject unsupported live reads, halted/unknown state, or state changes without issuing run/reset/recovery commands.
- [x] 3.3 Implement safe address sorting and benchmark individual/coalesced RAM read plans using the configured SWD rate; verify calibration never changes speed, rate, variables, or backend.
- [x] 3.4 Compute calibration min/mean/max and percentiles and arm only when requested rate and frame-window P99.9 pass; verify failures return measured evidence and leave the target unchanged.

## 4. Native Sampling Engine

- [x] 4.1 Implement QPC absolute-deadline scheduling with `HIGH_PRIORITY_CLASS`, a high-priority worker, optional affinity, and no realtime priority; verify synthetic late frames are marked and skipped without catch-up.
- [x] 4.2 Implement preallocated locked-memory frame/event storage for 1–32 symbols and 1–1000 Hz over 1–600 seconds; verify allocation bounds and a synthetic seven-variable 60-second run.
- [x] 4.3 Implement typed, naturally aligned coalesced RSP memory reads and record frame index, scheduled/read start/end/midpoint timestamps, duration, flags, and raw values.
- [x] 4.4 Implement consecutive-read failure counting and terminate after three failures through the common safety shutdown path; verify partial frames are not reported as valid.
- [x] 4.5 Implement unique versioned binary persistence on normal stop and all handled failures, with no timing-loop disk writes or overwrite behavior.

## 5. Motor Control Safety

- [x] 5.1 Implement allowlisted `start` between frames, pre-start baseline collection, start-condition polling, event timestamps, and duration start only after verification.
- [x] 5.2 Implement allowlisted `stop`, stop-condition polling, post-stop collection, and safe handling from armed/capturing states and explicit capture stop.
- [x] 5.3 Implement timeout, duration expiry, parent/IPC loss, and Agent-stop routing through verified motor stop before capture termination.
- [x] 5.4 Implement per-session `resetOnFailure`, one hardware RESET-pin attempt after unverified stop, partial-data persistence, and no reconnect/resume/restart; verify preparation failures never reset.
- [x] 5.5 Record every control request/result, verification, timeout, read-failure threshold, reset attempt/result, motor-state transition, and termination reason in session events and metadata.

## 6. Node Capture Service and MCP Tools

- [x] 6.1 Implement the single-session Node capture state machine and helper supervisor for `preparing`, `armed`, `capturing`, and terminal states; verify invalid transitions and concurrent starts fail.
- [x] 6.2 Add a shared probe-ownership guard so all existing probe/GDB/flash tools reject operations while capture owns the probe, while status/stop/non-hardware queries remain available.
- [x] 6.3 Implement `capture_prepare`, `capture_start`, `capture_status`, `capture_stop`, and `capture_control` with exact session IDs, schemas, consent messaging, and state validation.
- [x] 6.4 Implement binary capture parsing, `capture_export` CSV/JSON output, and complete traceability metadata; verify raw integer/float values and special float values remain unscaled.
- [x] 6.5 Implement `capture_query` time/variable filtering and at-most-2000 ordered min/max/average buckets; verify spikes survive downsampling.
- [x] 6.6 Implement `capture_list` and single-session `capture_delete` in the default or explicit output directory; verify active sessions, wildcard deletion, path escape, and overwrite attempts are rejected.
- [x] 6.7 Update MCP prompts/tool descriptions so Agents prepare and arm first, start capture before an explicitly requested motor start, verify stop, query/export results, and never substitute repeated `gdb_command` sampling.

## 7. Verification and Documentation

- [x] 7.1 Add no-hardware Node tests for schemas, symbol/config validation, IPC, state transitions, probe conflicts, storage/export/query, parent loss, and stop/reset routing using the built-in test runner.
- [x] 7.2 Add native helper self-tests for timing, buffering, percentile calculation, binary format, read-plan selection, failure thresholds, and parent-loss shutdown without SEGGER hardware.
- [x] 7.3 Document official J-Link Software Pack and Arm GNU Toolchain prerequisites, MSVC/CMake build steps, capture workflow, project allowlist review, outputs, RSP limitations, and unverified hardware policy.
- [x] 7.4 Run `npm run lint`, `npm run build`, native self-tests, and Node tests; record commands and results before hardware testing.
- [ ] 7.5 On the safe bench, run the J-Link CE/Z20K146MC/SWD 4 MHz calibration and seven-variable 1 kHz/60-second acceptance capture; record rate, missed deadlines, frame-window percentiles, and artifact integrity.
- [ ] 7.6 With motor disabled/no load and an independent emergency stop available, disconnect SWD to verify three failed frames, stop attempt, hardware reset, partial-data persistence, and helper exit before any loaded test.
