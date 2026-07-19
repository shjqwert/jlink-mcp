## 1. Remove Legacy Control Planes and Establish Standalone MCP (Commit 2)

- [x] 1.1 Add characterization tests for the exact 57-tool contract, three retained Resources, zero Prompts, and standalone stdio startup.
- [x] 1.2 Remove `src/extension.ts`, VS Code contribution metadata, activation/configuration, VSIX packaging, extension-only dependencies, and extension documentation while leaving Offline UI source unchanged.
- [x] 1.3 Remove executable approval, trust, risk-level, challenge/nonce/token, consume/replay, approval CLI/IPC, and approval-only plan/execute code and tests.
- [x] 1.4 Remove deprecated tool aliases, `gdb_load`, MCP workflow Prompts, and the discovery-catalog Resource.
- [x] 1.5 Register the specified 57 direct tools and only `rtt://output`, `probe://gdb-server-log`, and `probe://status` from the standalone server.
- [x] 1.6 Clean package scripts, dependencies, configuration, tests, and current documentation, then pass build, lint, unit tests, tool-surface checks, and the scoped historical-control-plane scan.

## 2. Unify Target Context and Physical Execution (Commit 3)

- [x] 2.1 Implement canonical mandatory `projectRoot` handling and persistent `.jlink-mcp/targets.json` configuration with required Target fields.
- [x] 2.2 Implement Target generations, content hashes, explicit external-input validation, Artifact/flash/SVD bindings, and persistent live match state.
- [x] 2.3 Implement machine-wide cross-process FIFO/lease serialization keyed by unambiguous Probe serial, with independent execution for different Probes.
- [x] 2.4 Implement explicit HSS and GDB Server long-lived ownership, compatible-operation allowlists, and `CAPTURE_ACTIVE`/`GDB_SESSION_ACTIVE` failures without auto-stop or auto-recovery.
- [x] 2.5 Implement the common operation envelope, stable error codes, before/after observations, side-effect reporting, warnings, and output references.
- [x] 2.6 Implement direct `halt`, `resume`, `reset`, `reset_halt`, memory, and CPU-core-register operations without hidden target-state changes or default readback.
- [x] 2.7 Implement direct flash, erase, Probe-command, GDB-command, GDB Server, GDB, and RTT behavior with strict format/session rules and truthful Artifact-match invalidation.
- [x] 2.8 Add unit and simulated concurrent-process tests for Target persistence, queue order, owner exclusion, failure continuation, no-hidden-side-effect behavior, and direct MCU operations.

## 3. Implement Typed Artifact, Variable, and SVD Access (Commit 4)

- [x] 3.1 Implement bounded content-driven Artifact discovery and classification for typed ELF/DWARF, MAP-only symbols, and HEX/BIN/SREC flash images without silent candidate selection.
- [x] 3.2 Implement supported scalar, fixed-array-element, and nested fixed-layout symbol resolution with address-conflict and unsupported-layout rejection.
- [x] 3.3 Implement persistent logical Hot Variables, Artifact-generation staleness, targeted refresh, and verified/unverified/mismatch gates.
- [x] 3.4 Implement `read_variable` so reads preserve the running state and report when an explicit halt is required.
- [x] 3.5 Implement the shared structured-write pipeline with defaults `captureOld=false`, `verify=false`, `restore=false` and status `executed_unverified` when no confirmation is requested.
- [x] 3.6 Implement exact, tolerance, masked, and bounded-observe comparators plus forced old-value capture, main readback, restore attempt, restore readback, and `stateUnknown` reporting when restoration is uncertain.
- [x] 3.7 Implement explicit SVD loading/validation and conservative register/field reads and writes that honor width, access, read-action, W1C, reserved-bit, and read-modify-write safety semantics.
- [x] 3.8 Add unit and simulated integration tests for Artifact discovery, typed selectors, stale refresh, read-state preservation, all write options/failures, Artifact-match transitions, and SVD-unavailable behavior.

## 4. Implement Direct HSS and JCAP v1 Data Path (Commit 5)

- [x] 4.1 Implement HSS capability and read-only planning with at most ten synchronized variables, at most 1 kHz, and at most 60 seconds for the current J-Link capability.
- [x] 4.2 Implement token-free `hss_start`, `hss_status`, `hss_stop`, and `hss_recover` with explicit lifecycle, helper ABI checks, quality counters, and no backend fallback.
- [x] 4.3 Route capture-aware `write_variable` through the Probe owner only for descriptor-declared variables and persist old/requested/readback/restore results with interval-aligned sample references.
- [x] 4.4 Implement JCAP v1 `capture.json`, append-only `raw/samples.bin`, append-only `raw/events.bin`, lifecycle states, hashes, CRC/integrity checks, and valid-prefix recovery.
- [x] 4.5 Implement atomic terminal `capture.db` publication and atomic rebuild from authoritative metadata and Raw files without modifying Raw hashes or overwriting a valid DB on failure.
- [x] 4.6 Implement compatible bounded capture list, summary, series, event-window, and explicit CSV-export operations, with CSV output outside the JCAP package.
- [x] 4.7 Add fake-helper and simulated integration tests for the HSS ceiling, ownership, capture-time writes, interrupted recovery, JCAP integrity, DB rebuild equivalence, and bounded queries.

## 5. Add the Agent-First Acceptance Suite (Commit 6)

- [ ] 5.1 Add ignored `test-output/` layout and output routing for no-run captures/exports and explicit immutable `runId` evidence directories.
- [ ] 5.2 Add environment, precondition, acceptance-index, issue-ledger, command, manifest, log, hash, and test-result schemas using only the fixed acceptance status vocabulary.
- [ ] 5.3 Automate software and simulated portions of T01-T11, including exact surface scans, Artifact/variable failures, no-hidden-side-effect checks, queue concurrency, and CPU control.
- [ ] 5.4 Automate simulated and package-format portions of T12-T19, including flash/erase failure paths, HSS smoke/full shapes, write events, interruption, Raw integrity, rebuild equivalence, and bounded CSV export.
- [ ] 5.5 Add the dependency-aware T20 Agent debugging-loop runner with project manifest preservation and full commit/Artifact/environment provenance.
- [ ] 5.6 Update current user and Agent documentation for direct tools, explicit prerequisites, JCAP v1, local evidence, and the deliberate Offline UI non-scope.
- [ ] 5.7 Pass install/build/lint/unit/simulated integration/acceptance-schema checks and verify generated evidence remains ignored before the Commit 6 push.

## 6. Execute Local Hardware Acceptance (No Commit 7)

- [ ] 6.1 Revalidate the frozen board, Probe, project, Artifact manifest, flash image association, recovery method, and explicit erase permission without mutating the target.
- [ ] 6.2 Execute T12 flash plus verify first to establish a verified live Artifact generation, recording all vendor side effects and final target state.
- [ ] 6.3 Execute applicable T03-T11 hardware cases in dependency order and record honest PASS, FAIL, BLOCKED, SKIPPED_WITH_REASON, or NOT_TESTED results.
- [ ] 6.4 Execute T14 Smoke at four variables, 100 Hz, 10 seconds and T14 Full at ten variables, 1 kHz, 60 seconds with at least 57,000 frames and explicit loss/overflow counts.
- [ ] 6.5 Execute T15 for 60 seconds, writing `0x13579BDF` near 20 seconds and restoring the captured old value near 40 seconds with verified interval events.
- [ ] 6.6 Execute T16-T20 recovery, integrity, rebuild, query, and end-to-end cases against local ignored evidence.
- [ ] 6.7 Execute T13 only with `allowErase=true`, immediately flash/verify the associated S19, and explicitly restore execution; otherwise record SKIPPED_WITH_REASON.
- [ ] 6.8 Keep exact-Z20K146M SVD cases BLOCKED until a validated SVD is configured, and never count raw memory access as SVD coverage.
- [ ] 6.9 Produce the local Acceptance Index and Issue Ledger and recommend merge only when every applicable T01-T20 case passes and no P0 remains open.
