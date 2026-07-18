## Context

The repository currently ships three coupled surfaces: a VS Code Extension, a standalone MCP server that stubs VS Code at runtime, and a separate Offline UI. Hardware operations pass through a mix of Probe methods, GDB, J-Link Commander, and the native HSS helper. Several paths add implicit halt/reset/recovery behavior, while destructive and raw operations depend on an R0-R5 approval system and two-stage plan tokens.

This change makes the standalone stdio server the only MCP surface. Agent clients own intent and sequencing; the MCP owns validation, deterministic hardware serialization, execution, truthful state/effect reporting, and durable capture data. The existing Offline UI remains a separate process and is not modified or accepted in this round.

The reference hardware is Z20K146M through J-Link V8.84, serial 69401227, SWD 4000 kHz. The helper ceiling is ten synchronized variables at 1 kHz for a current maximum duration of 60 seconds. The current Artifact has DWARF; an exact SVD is unavailable, so real SVD-register acceptance is blocked without weakening the contract.

## Goals / Non-Goals

**Goals:**

- Provide one standalone `jlink-mcp` stdio entry with an exact, breaking 57-tool Agent-oriented surface.
- Remove the VS Code Extension and the complete approval/trust/risk control plane.
- Require explicit `projectRoot` context and reuse only that project's persisted Target configuration.
- Serialize every physical J-Link operation by Probe serial across processes, with explicit HSS and GDB ownership.
- Execute only requested side effects and report unavoidable or unknown effects without inference.
- Support typed Artifact variables, raw memory, CPU-core registers, SVD peripheral registers, CPU control, flash/erase, raw commands, HSS, and bounded offline queries.
- Produce JCAP v1 packages whose Raw files are authoritative and whose per-capture DB is atomically rebuildable.
- Leave runnable automated checks and honest local acceptance evidence.

**Non-Goals:**

- Modifying, extending, migrating, or accepting the Offline UI.
- HTTP/SSE MCP transport, an embedded viewer lifecycle, or VS Code integration.
- Risk scoring, approval brokering, challenge/token flows, policy allowlists, or human confirmation inside MCP.
- Local variables, pointer dereference, dynamic arrays, unions, C bitfields, 64-bit values, double, enum/bool writes, or unknown typedef layouts.
- Automatic backend fallback, automatic target recovery, automatic project switching, or legacy MCP aliases.
- Migrating or reading experimental JCAP v0 packages.

## Decisions

### 1. One stdio entry and one explicit tool contract

`src/mcp/standalone.ts` becomes the sole MCP entry. It no longer imports or stubs `vscode`, starts approval IPC, or offers approval/trust CLI modes. The Offline UI remains available only through its existing separate script.

The exact tool surface is:

- Target: `list_devices`, `target_configure`, `target_status`.
- Artifact and variables: `artifact_probe`, `symbol_search`, `symbol_resolve`, `hot_variable_add`, `hot_variable_list`, `hot_variable_refresh`, `read_variable`, `write_variable`.
- Registers: `read_core_register`, `read_core_registers`, `write_core_register`, `read_register`, `read_registers`, `write_register`.
- Direct MCU: `halt`, `resume`, `reset`, `reset_halt`, `read_memory`, `write_memory`, `flash`, `erase`, `gdb_command`, `probe_command`.
- HSS: `hss_capability`, `hss_plan`, `hss_start`, `hss_status`, `hss_stop`, `hss_recover`.
- Capture query: `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `capture_index_rebuild`, `capture_export_csv`.
- Auxiliary: `snapshot`, `diagnose_crash`, `gdb_server_start`, `gdb_server_stop`, `gdb_server_status`, `gdb_connect`, `gdb_wait`, `gdb_backtrace`, `gdb_disconnect`, `rtt_connect`, `rtt_disconnect`, `rtt_read`, `rtt_search`, `rtt_clear`, `rtt_channel_list`, `rtt_channel_read`, `analysis_profiles`, `analysis_run`.

The discovery-catalog Resource and all embedded Prompts are deleted because they duplicate tool descriptions and encode the obsolete workflow. Only `rtt://output`, `probe://gdb-server-log`, and `probe://status` remain as read-only Resources.

Alternative considered: compatibility aliases and deprecation. Rejected because the user explicitly accepts a breaking API and aliases would preserve ambiguous register and plan semantics.

### 2. Project-root Target context is mandatory

Every Target, Artifact, variable, HSS, or hardware request carries a canonical `projectRoot`. Capture queries use `captureId` because captures are immutable, globally UUID-addressed local artifacts.

`target_configure` persists an entry keyed by normalized real `projectRoot` in ignored `.jlink-mcp/targets.json`. Required fields are device, Probe serial, interface, and speed. Artifact, MAP, SVD, tool paths, and ports are optional but their absence is explicit. An optional `artifactFlashImages` list binds flash hashes to an Artifact generation without creating a default flash input.

Every explicit `target_configure` call creates a new Target generation and invalidates live Artifact verification even when values are identical. This represents an intentional board/configuration boundary. Configuration and valid verification evidence persist across normal MCP restarts, bound to project root, Target generation, Probe serial, and Artifact generation.

Automatic discovery stays inside `projectRoot`. Explicit absolute Artifact, MAP, SVD, and flash paths may be outside it after canonicalization, content validation, hashing, and `external=true` reporting. No file is copied into the target project.

Alternative considered: one mutable active Target or environment-variable Target defaults. Rejected because separate Agent clients and project switches could silently reuse the wrong board, Artifact, or SVD.

### 3. Cross-process per-Probe execution queue

All target-touching work uses one queue key derived from the configured Probe serial. Missing identity never selects among multiple probes; a single unavailable serial uses a unique documented default key. The queue combines an in-process FIFO with a machine-wide lock/lease and a monotonic `queueSequence`. Shared config and sequence updates use atomic replacement and their own small lock.

The lease records process identity and supports stale-owner recovery after verifying the owner no longer exists. A failed operation releases the queue without discarding later work. Different serials may run concurrently.

HSS and GDB Server are long-lived exclusive owners:

- Active HSS permits HSS status/stop/recover, capture-aware `write_variable` for variables declared by that capture, and non-hardware queries. Other hardware operations return `CAPTURE_ACTIVE`.
- Active GDB Server permits GDB, RTT, status, and offline queries. Commander, direct CPU/memory/register operations, flash/erase, Probe commands, and HSS return `GDB_SESSION_ACTIVE`.
- MCP never stops or restarts either owner as a hidden prerequisite.

Alternative considered: serialize only individual subprocess starts. Rejected because GDB Server and HSS retain the physical Probe beyond a single call.

### 4. One operation envelope and no hidden recovery

Schema-valid tool executions return structured content with this common envelope:

```text
ok
operationId / tool / timestamps
target / probe / queueSequence
artifact / svd / capture
before / after
requestedEffects / observedEffects
verification
data
outputFiles
warnings
error { code, stage, message, retryable, writeIssued, stateUnknown }
```

Protocol or schema parsing failures remain MCP protocol errors. Execution, connectivity, capability, and target failures return the envelope.

Ordinary reads and preflight checks never halt, reset, resume, or recover the target. When running-state core registers, backtrace, snapshot, diagnosis, RTT, or GDB preflight cannot be obtained without a state change, the tool returns partial data and `HALT_REQUIRED` or another structured prerequisite error. Vendor-imposed flash/erase effects and raw-command effects are reported, not normalized away.

CPU postconditions are explicit: `halt` ends halted, `resume` ends running, `reset` ends running, and `reset_halt` ends halted. Already-satisfied halt/resume calls are successful no-ops with observed state.

Alternative considered: retain automatic `recover()` and preflight reset/halt. Rejected because it changes the board after an unrelated read failure and hides the actual cause.

### 5. Typed writes are optional-verification operations

Structured writes share one executor for variables, raw memory, CPU-core registers, and SVD registers/fields. Defaults are `captureOld=false`, `verify=false`, `restore=false`; a successful call reports `executed_unverified`, not a confirmed value.

- `captureOld=true` reads and returns the prior encoded value.
- `verify=true` reads back and applies `exact`, `tolerance`, `masked`, or `observe` comparison.
- `restore=true` forces an old-value read, writes the requested value, attempts restoration even after main verification failure, and verifies the restored value.
- Old-value failure before a required restore prevents the write. Restore failure returns `ok=false`, `writeIssued=true`, and `stateUnknown=true`.

Comparators operate on encoded bytes (`exact`), numeric absolute/relative tolerance, selected mask bits, or a bounded observation window where any matching observation passes. `observe` never claims the final value persists.

Known RAM writes leave Artifact match unchanged. Known Flash/ROM raw writes are rejected in favor of `flash`. An issued unknown-region write lowers Artifact match to `unverified`. Structured peripheral writes preserve match but declare system-level effects unknown.

Alternative considered: always read old value and read back. Rejected because the Agent explicitly chose low-overhead writes as the default and some volatile variables cannot hold a value long enough for exact readback.

### 6. Artifact, symbol, Hot Variable, and SVD truth sources

Content, not extension, classifies files. ELF/OUT/AXF with readable DWARF supplies full scalar/array/member layout. MAP entries are symbol/address candidates only until a trusted typed Artifact supplies size/type. HEX/BIN/SREC are flash inputs only; BIN requires explicit base address, while HEX/SREC use embedded addresses.

Supported terminal values are `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, and `float32`. Supported selectors are global/static scalars, fixed array elements, and nested fixed-layout structure members. Unsupported or ambiguous layouts fail before hardware access.

Hot Variables persist logical identity, declared type, Artifact generation/layout hash, and stale state per project. A new Artifact generation marks them stale; only explicit targeted refresh can issue new references. Stored addresses are never trusted across generations.

Artifact match states gate only symbol-based operations: mismatch/stale blocks reads and writes; unverified permits warned `read_variable` but blocks `write_variable` and symbol HSS. CPU control, raw memory, registers, flash/erase, and raw commands remain available and report match state. Associated flash+verify or a manifest-bound firmware identity value can establish `verified`. Raw GDB/Probe commands, erase, unassociated flash, relevant connection identity failures, and unknown-region writes invalidate it according to their specified state.

SVD is an Agent-supplied explicit source. MCP loads and validates it but does not search the network. Register selectors use `PERIPHERAL.REGISTER[.FIELD]`. Field writes require provable access and safe read-modify-write semantics; write-only, read-action, W1C/W1S, missing, or conflicting semantics are rejected. Without an SVD, the Agent may explicitly use raw memory tools, but that is not SVD coverage.

Alternative considered: guess a device layout from headers or silently fall back from SVD to raw memory. Rejected because an incorrect peripheral write is worse than a clear missing-prerequisite error.

### 7. HSS has a direct bounded lifecycle

`hss_plan` is a read-only calculator and never returns an execution token. `hss_start` accepts direct validated configuration or equivalent fields copied from plan output. The current capability ceiling is ten synchronized variables, 1 kHz frame rate, and 60 seconds; the JCAP format does not encode 60 seconds as a permanent limit.

Only `verified` typed RAM variables are eligible. The helper reports runtime version, architecture, ABI, library/hash facts, and capability. Unknown helper hash is informational; actual ABI/version incompatibility blocks start. No trust profile or approved-script hash remains.

During capture, a declared variable may be written through the helper's capture-aware path. The event stores operation start/end ticks, uses end tick as the existing query center, and links the last pre-write and first post-write sample indices/ticks. It does not invent a single exact write sample. Sample gaps must agree with drop/overflow accounting.

Automatic duration completion produces `completed`; explicit early stop produces `stopped`; process/helper/connection loss produces `interrupted`; unrecoverable data produces `failed`. `hss_recover` retains `interrupted` while indexing the complete Raw prefix and reporting truncated/corrupt suffix bytes.

Alternative considered: automatic RTT/RSP fallback. Rejected because the named HSS tools must either execute HSS or report its real unavailability.

### 8. JCAP v1 is four durable files

Every capture package is exactly:

```text
<captureId>.jcap/
  capture.json
  raw/samples.bin
  raw/events.bin
  capture.db
```

`capture.json` is the authoritative v1 metadata: capture/Target/Artifact identity, variable descriptors, record size, timebase, lifecycle and quality, and Raw byte counts/hashes. While active it is atomically replaced with hashes marked pending. Raw files append complete framed records. `capture.db` is absent while active and is built as `capture.db.tmp`, integrity-checked, fsynced, compared against unchanged Raw identities, and atomically published after stop/completion/recovery.

The SQLite schema and bounded query result shapes remain compatible with the current Offline UI. The DB is a derived per-capture index; deleting it and rebuilding from `capture.json` plus Raw must preserve Raw hashes and query results. CSV is created only by explicit `capture_export_csv` outside the JCAP directory.

Capture and index states are separate. An interrupted capture can be queryable while still declaring incomplete quality. JCAP v0 is neither migrated nor read.

Alternative considered: retain project-global `.jlink-mcp/index.sqlite` or permanent CSV. Rejected because a self-contained per-capture DB is simpler for AI/UI transfer and Raw recovery, while permanent CSV duplicates data.

### 9. Local output and acceptance evidence stay out of Git

The repository ignores `test-output/`. Without `runId`, packages and CSV use `test-output/captures/` and `test-output/exports/`. With explicit `runId`, commands, tests, captures, manifests, logs, environment, acceptance index, and issue ledger live under `test-output/<runId>/`. Ordinary operations without `runId` return responses only; HSS still persists its package.

The acceptance runner uses statuses `PASS`, `FAIL`, `BLOCKED`, `SKIPPED_WITH_REASON`, and `NOT_TESTED`. T12 runs before symbol-write/HSS hardware tests to establish Artifact verification. T13 requires run-level `allowErase=true`. SVD hardware cases remain blocked. No hardware-summary Commit 7 is produced; Commit 1 through Commit 6 are pushed after their scoped verification.

Alternative considered: commit selected hardware reports. Rejected because the local desktop Agent and Offline UI can consume ignored evidence directly and large/duplicate artifacts must not enter Git.

## Risks / Trade-offs

- [Cross-process owner dies while holding the Probe] → Store PID/process-start identity, validate liveness, expose recovery state, and never steal a live lease.
- [Persisted Artifact verification is reused after an undeclared board swap] → Every explicit `target_configure` creates a generation; the operating rule requires reconfiguration on board replacement, and identity/config mismatches invalidate evidence.
- [Raw command changes unobservable state] → Record exact input/output, mark side effects unknown, and lower Artifact verification.
- [Running-state reads are unsupported by a vendor path] → Return partial data plus `HALT_REQUIRED`; never retry with halt.
- [Volatile write cannot satisfy exact readback] → Verification is optional and includes tolerance/masked/observe modes; default result remains unverified.
- [Interrupted Raw has a partial tail] → Preserve bytes unchanged, index only complete validated frames, record tail diagnostics, and keep capture state interrupted.
- [Current SVD is missing] → Complete fixture/parser tests but mark real peripheral cases blocked; raw memory remains an explicit alternative, not a fake SVD pass.
- [57 tools increase discovery surface] → Keep names unambiguous and descriptions authoritative; remove duplicate Prompts, catalogs, aliases, and phase wrappers.

## Migration Plan

1. Freeze and commit this OpenSpec plus the archived prior change.
2. Remove the VS Code and approval control planes while preserving standalone build/UI entry and getting compile/lint/unit tests green.
3. Introduce Target context, common envelope, cross-process queue, ownership, and the final direct tool surface.
4. Add typed variable/SVD access and shared optional verification/restore behavior.
5. Convert HSS persistence and writes to JCAP v1, then preserve bounded query/UI DB compatibility.
6. Add T01-T20 software/simulated acceptance and local evidence generation.
7. Run hardware acceptance in dependency order. Do not recommend merge while any applicable case fails or a P0 remains open; explicitly report blocked SVD cases.

Rollback is branch-level before merge. JCAP v1 has no v0 compatibility promise, so rollback uses pre-change code and pre-change captures rather than converting packages.

## Open Questions

None. Exact Z20K146M SVD availability is an external precondition recorded as `BLOCKED`, not an unresolved design decision.
