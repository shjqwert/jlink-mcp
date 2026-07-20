## Why

The Agent-first runtime still exposes a bottom-up 57-tool surface, while its Codex Skill, Claude configuration, CI, HSS packaging, ordinary write semantics, crash diagnosis, and release evidence do not form one reproducible daily debugging path. Phase 7 closes those paths and presents the existing capabilities as explicit MCU debugging actions without adding MCP-owned analysis or workflow orchestration.

## What Changes

- **BREAKING** replace the current public surface with exactly 36 action-oriented tools grouped by Target, Artifact, access, control, HSS, capture, GDB, RTT, diagnostics, and advanced Probe access.
- **BREAKING** merge CPU/register/control/GDB/RTT lifecycle operations, internalize Hot Variables, HSS planning/capability, and capture DB rebuild, and remove `analysis_profiles`, `analysis_run`, `snapshot`, and direct RTT channel tools.
- Implement `diagnose_crash` as halted-target Cortex-M fault collection without implicit halt, reset, resume, Fault clearing, or GDB startup.
- Reuse one persistent J-Link memory connection per Target generation. `write_variable` defaults to `captureOld=true`, `verify=true`, `restore=false`; raw `write_memory` remains unverified by default.
- Keep the fixed current-backend HSS ceiling of ten variables, 1 kHz, and 60 seconds, with `hss_start(dryRun=true)`, source-qualified quality reporting, JCAP recovery, and automatic DB rebuild for DB-backed queries.
- Prioritize configured and common build outputs during bounded Artifact discovery; cache logical selectors internally and never silently reuse stale addresses.
- Replace stale Agent/Connector guidance, build/package the Windows HSS Helper, repair CI, and require the Skill/examples to match the real Tool List.
- Keep Offline UI source unchanged and retain only the four durable JCAP files; generated captures, databases, CSV exports, logs, and detailed hardware evidence remain ignored local output.
- Sanitize tracked release material and publish only a final-commit acceptance summary without local paths, Probe identifiers, private Artifact hashes, firmware, Raw, or DB files.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `standalone-agent-mcp`: Freeze the exact 36-tool daily-debug surface, portable Agent/Connector guidance, and clean CI/package startup path.
- `ai-debug-workflow`: Keep workflow and problem analysis with the Agent while MCP returns bounded source data and truthful hardware evidence.
- `artifact-symbol-variable-access`: Prioritize bounded Artifact discovery, internalize selector caching, and define verified persistent-session variable writes.
- `direct-mcu-operations`: Merge control/core-register/GDB operations and define complete no-hidden-side-effect crash diagnosis.
- `svd-register-access`: Replace separate peripheral register tools with one strict SVD-bound action tool.
- `target-context-and-serialization`: Bind persistent memory, HSS, and GDB owners to one project Target generation and Probe queue.
- `hss-backend`: Internalize capability/planning, add dry-run start, package the Helper, and freeze source-qualified quality reporting.
- `capture-query-index`: Remove public rebuild and rebuild the derived DB automatically before DB-backed queries.
- `jcap-v1-store`: Preserve the four-file JCAP package while making rebuild an internal atomic operation.
- `direct-rtt-channel-backend`: Expose only explicit RTT lifecycle/read/search/clear actions against an existing endpoint.
- `runtime-experiment-analysis`: Remove MCP-owned business analysis profiles and tools; the Agent analyzes bounded capture data and source code.
- `acceptance-evidence`: Require privacy scanning, immutable local issue recording, exact-surface acceptance, and one current-commit sanitized summary.

## Impact

Affected areas are standalone tool registration and schemas, direct MCU and register access, GDB/RTT lifecycle, crash diagnosis, Probe ownership/session code, HSS Helper and JCAP indexing, Artifact/symbol caching, Agent Skill/config examples, package scripts, GitHub Actions, README, release reports, and focused/full acceptance tests. Offline UI source, approval controls, J-Scope conversion, MCP business-analysis algorithms, broad directory restructuring, non-Windows HSS support, Git history, and remote publication remain out of scope.
