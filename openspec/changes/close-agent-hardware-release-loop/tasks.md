## 1. Freeze the revised Phase 7 contract

- [x] 1.1 Keep the completed Agent-first change archived without rewriting its evidence.
- [x] 1.2 Replace the Phase 7 proposal, design, delta specs, tasks, and traceability with the confirmed 36-tool daily-debug contract.
- [x] 1.3 Record the confirmed write defaults, fixed HSS ceiling, Offline UI exclusion, privacy boundary, and frozen-diff review protocol.

## 2. Close the public Agent surface

- [x] 2.1 Replace the exported surface with the exact 36 tools and remove every public alias, stub, `NOT_IMPLEMENTED` path, analysis tool, snapshot, direct RTT channel tool, and maintenance tool.
- [x] 2.2 Implement the bounded action schemas for `target_control`, `core_register_access`, and `peripheral_register_access` by routing to existing proven operations.
- [x] 2.3 Internalize Hot Variable caching, HSS capability/planning, and capture DB rebuild while reporting cache refresh, dry-run capability, and rebuild facts.
- [x] 2.4 Rewrite the active Codex Skill and portable Codex/Claude MCP examples from the canonical Tool List with no approval names, machine paths, or Target defaults.
- [x] 2.5 Extend surface/guidance checks to cover Skill, examples, README, and all 36 concrete handlers while excluding archived history from runtime assertions.

## 3. Close clean build and package paths

- [x] 3.1 Make the supported Windows x64 build/prepack flow compile the existing HSS Helper and retain generated binaries only in ignored output.
- [x] 3.2 Replace obsolete GitHub Actions commands with current build, lint, software, Helper, consistency, privacy, and package checks.
- [x] 3.3 Prove the package contains standalone output and Helper but excludes local evidence, J-Link DLLs, target binaries, and machine configuration.
- [x] 3.4 Document Windows, CMake, Visual Studio, J-Link, clean build, package, and startup prerequisites.
- [ ] 3.5 Update repository/homepage/bugs only after the public destination and publication authorization are supplied.

## 4. Close ordinary variable write semantics

- [x] 4.1 Add a bounded line-delimited native memory-session mode that opens one validated J-Link DLL/Probe connection and executes serialized read/write commands until explicit close or failure.
- [x] 4.2 Reuse the memory session for matching Target-generation variable/memory access and close it before incompatible explicit operations.
- [x] 4.3 Extend Probe ownership and Target lifecycle for a generation-bound `memory` owner, including shutdown, reconfigure, transport failure, and cross-process contention.
- [x] 4.4 Enforce `write_variable` defaults `captureOld=true`, `verify=true`, `restore=false` with same-session readback; keep `write_memory` defaults `captureOld=false`, `verify=false`.
- [x] 4.5 Label same-session, independent-session, and capture-owner readback separately from target-program consumption.
- [x] 4.6 Add focused native/TypeScript tests for reuse, verification-source separation, state preservation, write uncertainty, restore, and ownership failure.
- [x] 4.7 Rerun T07/T08 with a safe RAM variable and a separate target-response observation; restrict the public claim if repeatable holding semantics are not proven.

## 5. Complete HSS and capture storage contracts

- [x] 5.1 Fold capability and planning into `hss_start`, including `dryRun=true`, without starting a Helper or creating a package.
- [x] 5.2 Add optional target-counter quality oracle evaluation and persist source/configuration/diagnostics without fabricating dropped/overflow counts.
- [x] 5.3 Make DB-backed capture queries detect missing/damaged `capture.db`, atomically rebuild from verified metadata/Raw, and report `indexRebuilt=true`.
- [x] 5.4 Retain exactly the four durable JCAP files and keep explicit CSV exports outside the package.
- [x] 5.5 Add focused dry-run, quality, recovery, rebuild, bounded-query, and package-layout tests.
- [x] 5.6 Rerun T14 at the fixed ten-variable, 1 kHz, 60-second ceiling and record rate/duration capacity separately from qualified loss accounting.

## 6. Improve Artifact and strict register access

- [x] 6.1 Inspect the configured Artifact first, prioritize common Debug/Release output directories, exclude irrelevant trees, and return accumulated candidates with `scanTruncated=true`.
- [x] 6.2 Cache logical selectors internally, re-resolve them against current Artifact layout, and never require or trust an Agent-supplied stale address/generation.
- [x] 6.3 Route `peripheral_register_access` exclusively through the configured validated SVD and return `SVD_NOT_CONFIGURED` without guessed or implicit raw-memory fallback.
- [ ] 6.4 Add focused Artifact priority/truncation/staleness and SVD action tests, then rerun T03-T05 and applicable T09 cases.

## 7. Complete GDB, RTT, and crash diagnosis

- [x] 7.1 Implement `gdb_open` and `gdb_close` by composing existing server/client lifecycle with exact partial-failure ownership and target-state reporting.
- [x] 7.2 Implement `rtt_open` and `rtt_close` against an explicitly available endpoint; retain bounded read/search/clear and never start GDB implicitly.
- [x] 7.3 Implement halted-target Cortex-M `diagnose_crash` collection for core/Fault registers, Fault-bit decoding, provable exception frame, Artifact mapping, and optional existing-session backtrace.
- [x] 7.4 Return `HALT_REQUIRED` for running-target diagnosis and never halt, reset, resume, clear Fault state, or start GDB internally.
- [x] 7.5 Add focused lifecycle, partial-failure, no-hidden-side-effect, fault-decoding, frame-validation, and symbol-mapping tests.

## 8. Sanitize release engineering

- [x] 8.1 Add a non-echoing tracked-content privacy scanner and package filename/content gates.
- [x] 8.2 Remove or sanitize tracked machine paths, Probe identifiers, private Artifact hashes, approval-era active guidance, and hardware evidence while preserving unrelated user evidence recoverably.
- [x] 8.3 Generate schema-tested `reports/agent-first/acceptance-summary.md` and `acceptance-index.json` bound to the exact tested commit without local evidence paths.
- [x] 8.4 Record every implementation/test problem in the ignored Phase 7 Markdown issue ledger with reproduction, impact, fix, and regression status.

## 9. Review and final verification

- [x] 9.1 Complete each implementation batch and focused tests before freezing its affected files.
- [x] 9.2 Record the fixed diff hash, run a read-only Reviewer, and mark the review `STALE` if start/end hashes differ.
- [x] 9.3 Apply accepted findings only after Review completes; rerun focused/full build, lint, unit, surface, consistency, privacy, Helper, package, and strict OpenSpec checks.
- [ ] 9.4 Run applicable authorized hardware regressions on one final commit, including T07/T08/T14 and recovery-protected T12/T13 when prerequisites remain valid.
- [x] 9.5 Freeze the repaired diff and run one final hash-stable read-only review.
- [ ] 9.6 Recommend merge/release only when all applicable T01-T20 cases satisfy the revised contract and no core P0/P1 remains; do not rewrite history, commit, or push without the required explicit action/authorization.
