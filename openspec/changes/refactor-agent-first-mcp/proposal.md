## Why

Jlink-MCP currently mixes a VS Code extension, an approval/risk control plane, plan-token execution, and hidden target-state changes with its actual debugging responsibilities. Agent clients need one standalone, truthful execution surface where the Agent chooses the operation and the MCP serializes hardware access, records observable effects, and returns real results.

## What Changes

- **BREAKING** Remove the VS Code Extension, its package metadata, build/package scripts, dependencies, runtime shim, commands, configuration, and current documentation; retain the separate Offline UI code without modifying or accepting it in this change.
- **BREAKING** Remove R0-R5 policy, Approval Broker, trust hashes, challenge/nonce/token state, approval CLI/IPC, and approval-only plan/execute tools.
- **BREAKING** Replace the current MCP surface with 57 direct Agent tools, remove deprecated aliases, remove `gdb_load`, and remove embedded workflow Prompts and the discovery-catalog Resource.
- Add persistent, project-keyed Target configuration, Artifact/flash-image manifests, Target generations, live match status, machine-wide per-Probe serialization, and explicit HSS/GDB exclusive sessions.
- Add direct CPU, memory, CPU-core register, SVD peripheral register, variable, flash, erase, GDB, Probe, HSS, query, RTT, diagnosis, and analysis operations with one structured status envelope and no hidden halt/reset/resume/readback.
- Add typed ELF/DWARF variable resolution, conservative MAP fallback, persistent Hot Variables, stale-layout handling, optional write verification/readback/restore, and capture-time variable-write events.
- Replace experimental JCAP v0 output with a JCAP v1 four-file package, per-capture SQLite index, recoverable interrupted captures, bounded queries, and explicit external CSV export.
- Add ignored local acceptance evidence, T01-T20 traceability, deterministic issue records, software/simulated tests, and dependency-ordered hardware acceptance.

## Capabilities

### New Capabilities

- `standalone-agent-mcp`: Single stdio MCP entry, exact 57-tool surface, removal of the VS Code and approval control planes, and read-only runtime Resources.
- `target-context-and-serialization`: Project-keyed Target generations, persistent configuration/match evidence, per-Probe cross-process FIFO serialization, and HSS/GDB exclusive ownership.
- `direct-mcu-operations`: Direct CPU, memory, core-register, flash, erase, GDB, and Probe operations with explicit side effects and a common operation envelope.
- `artifact-symbol-variable-access`: Artifact discovery, ELF/DWARF and MAP semantics, symbol/Hot Variable lifecycle, typed reads, and verified/restorable writes.
- `svd-register-access`: Explicit SVD loading and conservative peripheral register/field reads and writes without guessed layouts.
- `jcap-v1-store`: Four-file package, Raw integrity, lifecycle/recovery semantics, per-capture SQLite rebuild, and external CSV placement.
- `acceptance-evidence`: Git-ignored run evidence, T01-T20 acceptance matrix, issue ledger, hardware prerequisites, and merge criteria.

### Modified Capabilities

- `ai-debug-workflow`: Replace MCP-owned multi-round workflows and approval planning with Agent-orchestrated direct tools.
- `hss-backend`: Freeze the J-Link HSS limits and lifecycle, remove allowlist/plan-token writes, and add capture-time direct writes and truthful quality accounting.
- `capture-query-index`: Replace the project-global index and old tool names with per-capture DBs and the existing bounded query contract.
- `capture-backend-routing`: Remove automatic capture fallback selection; `hss_*` tools execute only the explicitly requested J-Link HSS backend.
- `direct-rtt-channel-backend`: Align RTT tools with Target context, GDB ownership, structured failures, and the final read-only channel surface.
- `post-capture-ui-api`: Keep the Offline UI separate from MCP lifecycle tools and consume the compatible per-capture DB without changing or accepting UI code in this round.

## Impact

- Affected code: `src/mcp/`, `src/probe/`, `src/jlink/`, GDB/RTT helpers, HSS native/helper integration, package/build configuration, current docs, and tests.
- Deleted code: `src/extension.ts`, approval/trust/policy modules and tests, VSIX packaging, approval-only plan tools, `gdb_load`, obsolete Prompts/Resource, and extension-only dependencies.
- Preserved code: Offline UI source and its separate launch script, analysis profiles, RTT helpers, HSS helper, Artifact/Hot Variable concepts, and bounded query result shapes.
- Persistent local state: ignored `.jlink-mcp/targets.json` plus ignored `test-output/`; target firmware project files remain untouched.
- Hardware: Z20K146M on J-Link V8.84, serial 69401227, SWD 4000 kHz. SVD hardware acceptance is blocked until an exact file is available.
