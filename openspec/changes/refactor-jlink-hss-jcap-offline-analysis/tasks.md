## P0 — Baseline, runtime trust, and contracts

- [ ] 0.1 Record repository commit/worktree state, Node/TypeScript/J-Link DLL/helper/adapter identities, target artifact/MAP hashes, and reproducible compile/test commands.
- [x] 0.2 Implement and test the Windows x64 DLL resolver order: explicit `--jlink-dll`/`JLINK_DLL_PATH`, SEGGER registry, PATH `JLink.exe` directory, then common SEGGER directories; reject missing, non-x64, invalid-export, failed-`GetCaps`, and unvalidated identities.
- [x] 0.3 Resolve target identity from explicit parameter then supported project configuration; return a structured selection error for absent/ambiguous results and record `targetId`, source, and confidence.
- [ ] 0.4 Preserve accepted HSS fixtures and freeze the HM_C095 oracle as OUT/MAP-resolved `g_hssDbgCounterFocIsr`: record its one-increment-per-FOC-update formula, firmware-derived modular-delta/rate bounds, repeat/wrap tolerance, observation window and pass/fail rules; verify the full sample-index-0 capture, timebase and dropped flags without a fixed address.
- [x] 0.5 Collapse HSS availability, planning, and Start/Read/Stop behind one service; remove conflicting generic-router/direct-helper capability views.
- [x] 0.6 Implement adapter validation for required exports, `GetCaps`, lifecycle, decoder semantics, identity allowlist, and revalidation on DLL/helper/adapter/script-mode/cache-script change.
- [x] 0.7 Record SQLite compatibility constraints; select and prove the adapter with the P1 data path.
- [x] 0.8 Define the minimum experimental JCAP v0 contract for provenance, raw rebuild, lifecycle, query bounds and package structure; defer v1 byte-layout freezing.
- [x] 0.9 Implement `script.mode=none|file`: reject implicit default scripts; for file mode canonicalize/hash once, copy to the SHA-256-named cache and load that copy; prohibit Raw/general ExecCommand inside HSS.
- [ ] 0.10 Implement `resetBeforeCapture=true` as a single-use R3 reset operation bound to target/Artifact/layout/policy/session/TTL, followed by bounded target stabilization before HSS Start.
- [x] 0.11 Implement trusted local `jlink-mcp trust validate` for one Runtime Bundle/target/probe tuple and bounded HSS suite; display results, require one user confirmation and save a Trust Profile without exposing it as an MCP Tool.

Gate acceptance: compile and focused tests pass; Windows x64 resolver and project-config target resolution pass; production reloads a persistent Trust Profile and blocks unknown or changed DLL/helper/adapter/script-mode/target/probe/suite tuples before GetCaps/reset/capture; only the local `trust validate` CLI can save trust after confirmation; no default script is used; reset audit and stability failure are structured; the HM_C095 counter oracle proves the complete post-stability capture from sample index 0 under recorded rate bounds; SQLite packaging proof exists; no production module has been deleted.

## P1 — HSS → JCAP → Query

- [x] 1.1 Select and prove one SQLite adapter for Node 18, standalone MCP, local loopback Web and packaged installation; implement the minimal JCAP v0 raw/rebuild corpus needed by the data path.
- [ ] 1.2 Integrate the experimental v0 self-describing sample envelope, provenance, type rejection, rollover policy, and valid-prefix/truncated-tail detection with the production HSS writer; defer byte-frozen headers/descriptors/records to a separate v1 change.
- [ ] 1.3 Implement append-safe `raw/events.bin` for lifecycle, target-control reset, write, flag, and fault events in the shared pre-reset QPC timebase against the same corpus.
- [ ] 1.4 Implement capture lifecycle and finalization in the order: sync/close samples → sync `finalizing` → validate raw prefix → sync terminal event (or transition to `recoverable`) → close immutable raw journal → build/validate/fsync/rename `capture.db.tmp`; keep `captureState` separate from `indexStatus` and make failed indexes rebuildable without raw mutation.
- [ ] 1.5 Implement the minimum versioned SQLite schema, final-raw source hashes, integrity checks, buckets, and rebuild from sample/event raw files.
- [ ] 1.6 Implement bounded `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `capture_index_rebuild`, and on-demand CSV export with explicit capture/index states.
- [ ] 1.7 Add round-trip, script/reset provenance, pre-start failure, terminal-event/source-hash ordering, corruption, crash-recovery, initial-vs-rebuild equivalence, response-limit, and no-default-JSON/CSV tests.

Gate acceptance: a fixture can record the trusted script and R3 reset before HSS Start, capture/finalize the full post-stability series, close terminal raw before DB build, be queried, have its DB deleted and rebuilt with equivalent metadata/events/quality/provenance, while raw hashes remain unchanged and no terminal event makes the first DB immediately stale.

## P2 — Artifact, symbols, and controlled writes

- [ ] 2.1 Implement bounded content-driven Artifact probing, candidate pairing and SHA-256 generations, then compute `targetArtifactMatch` by exact read-only comparison of every Artifact-defined nonvolatile load byte (`PT_LOAD.p_filesz` or OUT/AXF equivalent; excluding RAM/BSS/NOLOAD/gaps); bind evidence to target/probe/connection/runtime identities and invalidate it on reconnect, Artifact/target/probe changes, Flash/Erase, or possibly-Flash-modifying Raw.
- [ ] 2.2 Implement Symbol Catalog search/resolve, stable logical identity, layout hash, region/type eligibility, and structured rejection of unsafe kinds.
- [ ] 2.3 Implement process-local Hot Variables with stale detection and targeted refresh; remove project-specific default symbol assumptions.
- [ ] 2.4 Build HSS plans from catalog references and enforce reported variable/rate/duration/bandwidth/type limits before hardware access.
- [ ] 2.5 Migrate HSS start/status/stop to JCAP raw/finalizer and record DLL/helper/adapter/script-mode/cache-script plus Artifact provenance.
- [ ] 2.6 Run targeted fixtures and the authorized hardware sequence `GetCaps → state check → R3 resetBeforeCapture → bounded stability → HSS Start/Read/Stop` against the named HM_C095 target project without modifying or rebuilding it automatically; resolve `g_hssDbgCounterFocIsr` dynamically and enforce the recorded modular-delta/rate/window oracle over every post-stability record.

Gate acceptance: HSS uses only the validated DLL and trusted script-mode/cache identities, records reset and capture evidence in rebuildable JCAP, rejects mismatches/unsupported or expired plans, and passes the independently known semantic fixture without dropping any post-stability capture prefix.

### P2 continuation — Controlled writes and audit

- [ ] 3.1 Make verified, policy-allowlisted RAM scalar, fixed-array element, and contiguous slice writes R2 using `variable_write_plan` with RAM/type/value/range checks, `maxWrites`, Artifact/layout/policy/session/TTL binding, old-value read and readback; require no R3 operation plan or user approval.
- [ ] 3.2 Enforce verified target identity for normal writes, explicit R4 policy exceptions for unverified identity, and hard reject mismatch.
- [ ] 3.3 Serialize active-capture writes through the capture owner; enforce allowlist/budget/readback and append aligned raw events plus audit references.
- [ ] 3.4 Implement R4 planning companions and retained execution endpoints (`flash_plan→flash`, `erase_plan→erase`, `gdb_command_plan→gdb_command`, `probe_command_plan→probe_command`, optional `write_memory_plan→write_memory`, and `variable_write_plan→variable_write_execute` for unverified exceptions); require trusted local host/CLI confirmation and `approvalToken`, bind challenge/digest/arguments/target/hashes/session/connection/TTL/nonce, atomically consume once, remove token-free paths, and keep Agent/offline UI unable to issue approval and R5 unconditionally rejected.
- [ ] 3.5 Test R2 stale plans and failed readback; R4 missing/expired/mismatched/forged/replayed approvals; capture ownership/queue ordering; and event/sample alignment.
- [ ] 3.6 Keep `halt`, `resume`, and `reset` names, input schemas and required output semantics unchanged; route them through J-Link only and implement each R3 call as internal deterministic plan→preflight/revalidate→execute→consume→audit, returning `capture_conflict` for halt/reset during active HSS capture.

Gate acceptance: normal verified RAM writes execute only as R2 with readback and no user confirmation; unverified exceptions require R4; no write or CPU control bypasses policy or capture ownership; Agent self-approval and approval replay fail; active-capture halt/reset causes no hardware action; every attempted state change has deterministic result and append-safe audit evidence.

## P3 — Analysis, offline UI, and discovery

- [ ] 4.1 Implement only write-window comparison, peak/steady-state/overshoot, state transition and duration analyzers over bounded capture records.
- [ ] 4.2 Add deterministic fixtures for those metrics, transitions, missing evidence and invalid-quality ranges.
- [ ] 4.3 Implement only the local loopback Web offline UI/query service and `npm run ui -- --project|--open`; do not add VS Code/webview integration, hardware controls, or raw parsing.
- [ ] 4.4 Implement timeline brush/events/quality, variable visibility, multi-variable curves and basic auto-fit; defer colors, line styles, complex axes, unit editing and preference persistence.
- [ ] 4.5 Publish tool schemas, risk metadata, resources/prompts, and a reference Agent skill/client conformance test; state that third-party Agent review is not server-enforceable.

Gate acceptance: offline UI opens a completed capture without hardware; analysis is deterministic and raw hashes do not change; discovery exposes the intended workflow and risk boundary.

## P4 — Replacement-first deletion and final acceptance

- [ ] 5.1 Extract shared ELF/GDB/process/CRC/typed-value logic from old owners before deletion.
- [ ] 5.2 Remove `ai-debug-workflow`, backend benchmark/routing, global capture query index, Direct RTT capture, old viewer lifecycle API, Runtime Evidence, and CodeGraph Bridge registrations and implementation.
- [ ] 5.3 Remove OpenOCD/BMP, Telnet Proxy, TraceAgent, legacy CaptureService/helper, external-import capture path, obsolete scripts/tests/docs/config, and dead exports.
- [ ] 5.4 After each deletion batch run compile, targeted tests, tool-catalog checks, import/reference search, and accepted HSS regression evidence.
- [ ] 5.5 Update README/examples/package metadata and resolve or close the superseded `add-ai-hss-debug-workflow` change separately.

Gate acceptance: no removed capability remains registered or documented; retained RTT/GDB/CPU/Flash/Raw tools remain risk-classified auxiliaries; `halt`/`resume`/`reset` contracts and J-Link execution remain intact; final capture path is HSS → JCAP → query/analysis/UI.

### P4 continuation — End-to-end acceptance

- [ ] 6.1 In the non-Git HM_C095 project root, probe the current `.out/.map`, resolve and cache variables, and create a validated HSS plan without guessing filenames.
- [ ] 6.2 Run read-only capture and one verified policy-allowed R2 RAM write with readback; separately exercise one R4 approval rejection/authorization path without conflating it with the normal write; stop/finalize and verify package contents and provenance.
- [ ] 6.3 Verify summary/series/event-window/analysis/UI, delete and rebuild the DB, and compare critical results and raw hashes.
- [ ] 6.4 Change the fixture Artifact generation and verify old Hot Variables/plans become stale and targeted refresh restores only referenced variables.
- [ ] 6.5 Run compile, focused/unit/integration/UI tests and the accepted hardware suite; publish exact commands, identities, results, limitations, and evidence locations.

Final acceptance: the project-supported experimental DLL adapter is the only HSS main path; it is identity-gated and semantically validated; Agent and UI consume bounded rebuildable JCAP evidence; normal verified RAM writes remain R2 policy/readback/audit controlled while R4 remains trusted-user-approved; no official SEGGER SDK claim or dependency exists.
