## Context

Phase 6 produced a direct standalone MCP, but the public surface still mirrors backend primitives rather than normal MCU debugging actions. The checked-in Agent instructions and MCP examples are stale, CI and clean HSS packaging are broken, ordinary one-shot writes do not have repeatable holding semantics, HSS quality lacks a universal loss source, and `diagnose_crash` currently overstates its behavior. The current validated backend ceiling is ten variables at 1 kHz for 60 seconds. Offline UI source is retained but is not modified, expanded, or accepted in this phase.

The worktree contains unrelated user changes. Implementation must touch only Phase 7 files, keep detailed hardware evidence under ignored `test-output/`, and review only a frozen diff after focused tests.

## Goals / Non-Goals

**Goals:**

- Let Codex and Claude Code start the standalone MCP and follow the real daily debugging tool surface from a clean checkout.
- Expose exactly 36 concrete tools with no public stub, approval-era alias, or internal maintenance tool.
- Give variable writes repeatable persistent-connection semantics and truthful readback/target-consumption evidence.
- Provide explicit Target control, GDB, RTT, HSS, capture, strict SVD access, and real halted-target crash collection without hidden state changes.
- Build/package the Windows x64 HSS Helper, repair CI, improve bounded Artifact discovery, and publish sanitized current-commit acceptance results.

**Non-Goals:**

- Offline UI changes or acceptance, J-Scope RAW compatibility, MCP-owned business analysis, approval/risk controls, a universal workflow tool, dynamic HSS product profiles, non-Windows HSS support, mechanical source/test directory migration, Git history rewriting, remote repository creation, or external push.

## Decisions

### 1. The public surface is exactly 36 daily-debug actions

`AGENT_TOOL_NAMES` remains the canonical runtime list. It contains three Target tools, three Artifact tools, six access tools, three control tools, four HSS tools, five capture tools, five GDB tools, five RTT tools, one diagnostic tool, and one raw Probe tool. Surface tests, Skill checks, examples, and README assertions compare against this list. Generic stub registration is forbidden.

The surface merges closely related operations through bounded `action` enums: `target_control`, `core_register_access`, and `peripheral_register_access`. It does not introduce a universal command envelope or mechanically move directories in this phase.

### 2. Cache, planning, capability, and DB repair remain internal

`symbol_resolve` stores project-scoped logical selector cache entries. Variable and HSS requests accept logical selectors and revalidate current Artifact generation/layout internally; they never trust a stale cached address or require the Agent to echo generation tokens.

`hss_start(dryRun=true)` performs resolution, capability validation, layout calculation, capacity estimation, and returns a non-mutating preview. Normal start repeats the same current-state checks. DB-backed capture queries validate `capture.db` and automatically rebuild it from `capture.json` and immutable Raw when possible. Responses disclose `scanTruncated`, cache refresh, capability facts, or `indexRebuilt`; internal behavior is not hidden.

### 3. Persistent memory sessions define ordinary write semantics

The existing native Helper gains one bounded line-delimited memory-session mode. One process opens and validates the J-Link DLL/Probe once, executes FIFO read/write commands, and closes on shutdown, transport failure, Target generation change, independent-session verification, or before an incompatible explicit operation. Node keeps at most one session per Target generation and reuses the existing cross-process owner/heartbeat model with a `memory` owner kind.

`write_variable` defaults to `captureOld=true`, `verify=true`, `restore=false`, with same-session readback unless the Agent explicitly requests independent-session verification. `write_memory` defaults to `captureOld=false`, `verify=false`. A matching readback proves only bytes observed by the named connection; target-program consumption requires a separate response variable or behavior observation. Public ordinary writes are not accepted as complete until T07/T08 prove repeatable holding semantics on hardware.

### 4. Target, register, and raw actions stay explicit

`target_control(action)` accepts only `halt`, `resume`, `reset`, and `reset_halt`. `core_register_access(action)` accepts bounded `read`, `read_all`, and `write` requests for CPU registers. `peripheral_register_access(action)` accepts bounded `read`, `read_many`, and `write` requests and resolves only the configured validated SVD. Missing SVD returns `SVD_NOT_CONFIGURED`; raw address fallback occurs only when the Agent separately calls `read_memory` or `write_memory`.

`flash`, `erase`, `gdb_command`, and `probe_command` remain explicit direct tools. No read, preflight, diagnosis, session setup, or failure path implicitly halts, resets, resumes, flashes, erases, or recovers the target.

### 5. GDB, RTT, and crash diagnosis have explicit prerequisites

`gdb_open` starts J-Link GDB Server, loads the current ELF as host-side symbols, and connects a client without flashing firmware or intentionally changing MCU execution state. Partial startup/connection failure retains and reports exact owner/process/target facts. `gdb_close` disconnects the client and stops the server without auto-resume/reset.

`rtt_open` connects only to an explicitly available RTT endpoint owned by the current Target/GDB session; it does not start GDB. RTT read/search/clear operate on the MCP-side bounded buffer, and `rtt_close` closes only the RTT client.

`diagnose_crash` is Cortex-M-only in this phase. A running target returns `HALT_REQUIRED`. A halted target collects core registers, architectural Fault/System Control registers, decodes Fault bits, reconstructs a valid exception frame when provable, and maps PC/LR/frame addresses through the current Artifact. It reuses an already-open GDB session for backtrace; if none exists, it returns the remaining diagnosis with a bounded prerequisite warning. It never starts GDB, halts, resets, resumes, or clears Fault state.

### 6. HSS quality is source-qualified at the fixed backend ceiling

The fixed current-backend bounds remain ten synchronized scalar variables, 1 kHz, and 60 seconds. A validated vendor loss/overflow source may report exact counts. Otherwise one explicitly configured unsigned target counter may act as an oracle and occupies one variable slot. Without a qualified source, `qualityStatus=partial`, dropped/overflow counts remain null, and zero loss is never claimed.

JCAP retains exactly `capture.json`, `raw/samples.bin`, `raw/events.bin`, and `capture.db`. CSV exists only after explicit export and outside the package. Recovery preserves a trustworthy Raw prefix and never labels an interrupted capture complete.

### 7. Artifact discovery remains ordered and bounded

The configured Artifact is inspected first, common `Debug/Exe`, `Debug/List`, `Release/Exe`, and `Release/List` directories next, then the remaining bounded project tree. Source-control, dependency, generated output, cache, native-build, and evidence trees are excluded. Reaching a bound returns accumulated candidates plus `scanTruncated=true`; ambiguity remains explicit.

### 8. Clean Agent/build/release paths share one tested commit

The repository tracks portable Codex/Claude examples without Target defaults or machine paths. The active Skill contains only current names and direct workflows. The Windows build/prepack path compiles the existing HSS Helper, TypeScript, and bundle; CI validates current scripts, tool/Skill/config consistency, Helper self-test, and packed contents.

Raw commands, captures, DBs, local paths, Probe identifiers, private Artifact hashes, and target binaries stay ignored locally. Only a schema-tested current-commit summary/index is publishable. Repository URL changes, history changes, commits, and pushes remain separate explicit external actions.

## Risks / Trade-offs

- [Persistent Helper exits while owning the Probe] → Fail queued operations, mark dispatched write outcome unknown when required, and release ownership only after process death is observed.
- [Closing a memory session changes or obscures target state] → Stop the next operation, report `HIDDEN_STATE_CHANGE` or unknown state, and never auto-recover.
- [GDB open/close has vendor state effects] → Observe/report before and after state and fail rather than silently restoring it.
- [Crash frame cannot be proven] → Return raw registers and a partial diagnostic; never invent a frame or stack trace.
- [Target quality counter is ambiguous] → Downgrade to `partial` and retain diagnostics rather than infer loss.
- [Automatic DB rebuild fails] → Preserve Raw and any valid DB; return rebuild failure without overwriting valid data.
- [Building Helper makes the full product path Windows-only] → Declare Windows x64, CMake, Visual Studio, and J-Link prerequisites.
- [Public metadata has no confirmed destination] → Leave repository URL update and remote publication blocked.

## Migration Plan

1. Update and strictly validate this Phase 7 OpenSpec and its traceability matrix before further source edits.
2. Replace the public surface and active Agent/config guidance; remove obsolete analysis/stub paths.
3. Repair clean Helper build/package and CI.
4. Implement persistent memory sessions and rerun ordinary write acceptance.
5. Complete HSS dry-run/quality, automatic DB rebuild, bounded Artifact discovery, GDB/RTT consolidation, and crash diagnosis.
6. Run focused tests, freeze the affected-file diff hash, obtain read-only review, apply fixes only after review completes, and run one final hash-stable review.
7. Run applicable software and authorized hardware regressions on one final commit and generate sanitized acceptance output.

Rollback is a normal source revert of Phase 7 files; local ignored hardware evidence is never rewritten.

## Open Questions

- The public repository URL and permission to create/rewrite/push a public history remain unresolved external release inputs.
