## Gate 0 — Baseline, adapter proof, and runtime decisions

- [ ] 0.1 Record repository commit/worktree state, Node/TypeScript/J-Link DLL/helper/adapter identities, target artifact/MAP hashes, and reproducible compile/test commands.
- [ ] 0.2 Implement and test the Windows x64 DLL resolver order: explicit `--jlink-dll`/`JLINK_DLL_PATH`, SEGGER registry, PATH `JLink.exe` directory, then common SEGGER directories; reject missing, non-x64, invalid-export, failed-`GetCaps`, and unvalidated identities.
- [ ] 0.3 Resolve target identity from explicit parameter then supported project configuration; return a structured selection error for absent/ambiguous results and record `targetId`, source, and confidence.
- [ ] 0.4 Preserve accepted HSS fixtures and add an independently predictable monotonic-counter, fixed-step, or known-waveform fixture that verifies values, order, timebase, and dropped-sample flags.
- [ ] 0.5 Collapse HSS availability, planning, and Start/Read/Stop behind one service; remove conflicting generic-router/direct-helper capability views.
- [ ] 0.6 Implement adapter validation for required exports, `GetCaps`, lifecycle, decoder semantics, identity allowlist, and revalidation on DLL/helper/adapter change.
- [ ] 0.7 Spike and select one SQLite adapter that works on supported Node 18, standalone MCP, local loopback Web, and packaged installation.
- [ ] 0.8 Freeze JCAP v1 binary layouts, supported scalar types, monotonic timebase, lifecycle states, query bounds, and final package structure.

Gate acceptance: compile and focused tests pass; Windows x64 resolver and project-config target resolution pass; unknown adapter identity blocks capture; the predictable semantic fixture proves values/order/timebase/drop flags; SQLite packaging proof exists; no production module has been deleted.

## Gate 1 — Offline JCAP minimal slice

- [ ] 1.1 Implement versioned sample segment header/descriptors/records with CRC, provenance, type rejection, rollover, and truncated-record detection.
- [ ] 1.2 Implement append-safe `raw/events.bin` for lifecycle, write, flag, and fault events in the sample timebase.
- [ ] 1.3 Implement capture lifecycle, recoverable failure handling, and atomic `capture.db.tmp` finalization.
- [ ] 1.4 Implement the minimum versioned SQLite schema, source hashes, integrity checks, buckets, and rebuild from sample/event raw files.
- [ ] 1.5 Implement bounded `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `capture_index_rebuild`, and on-demand CSV export.
- [ ] 1.6 Add round-trip, corruption, crash-recovery, rebuild-equivalence, response-limit, and no-default-JSON/CSV tests.

Gate acceptance: a fixture can be captured/finalized, queried, have its DB deleted and rebuilt with equivalent metadata/events/quality, while raw hashes remain unchanged.

## Gate 2 — Artifact, symbols, and read-only HSS

- [ ] 2.1 Implement bounded content-driven Artifact probing, candidate pairing, SHA-256 generations, exclusion rules, and `targetArtifactMatch`.
- [ ] 2.2 Implement Symbol Catalog search/resolve, stable logical identity, layout hash, region/type eligibility, and structured rejection of unsafe kinds.
- [ ] 2.3 Implement process-local Hot Variables with stale detection and targeted refresh; remove project-specific default symbol assumptions.
- [ ] 2.4 Build HSS plans from catalog references and enforce reported variable/rate/duration/bandwidth/type limits before hardware access.
- [ ] 2.5 Migrate HSS start/status/stop to JCAP raw/finalizer and record DLL/helper/adapter plus Artifact provenance.
- [ ] 2.6 Run targeted fixtures and read-only hardware acceptance against the named HM_C095 target project without modifying or rebuilding it automatically.

Gate acceptance: read-only HSS uses only the validated DLL path, produces a rebuildable JCAP, rejects mismatches/unsupported plans, and passes the independently known semantic fixture.

## Gate 3 — Controlled writes and audit

- [ ] 3.1 Make normal scalar, fixed-array element, and contiguous slice writes R3 with an operation plan and Artifact/layout/policy/session/TTL binding.
- [ ] 3.2 Enforce verified target identity for normal writes, explicit R4 policy exceptions for unverified identity, and hard reject mismatch.
- [ ] 3.3 Serialize active-capture writes through the capture owner; enforce allowlist/budget/readback and append aligned raw events plus audit references.
- [ ] 3.4 Implement trusted R4 approval tokens bound to canonical operation digest, target, hashes, expiry, and single-use nonce; keep R5 unconditional rejection.
- [ ] 3.5 Test stale plans, replay/expiry, forged Agent approval, failed readback, capture ownership, and event/sample alignment.
- [ ] 3.6 Keep `halt`, `resume`, and `reset` contracts unchanged; route them through J-Link only, enforce R3 plan/state/audit/result handling, and return `capture_conflict` for halt/reset during active HSS capture.

Gate acceptance: no write or CPU control bypasses policy or capture ownership; approval replay fails; active-capture halt/reset causes no hardware action; every attempted state change has deterministic result and append-safe audit evidence.

## Gate 4 — Analysis, UI, and discovery

- [ ] 4.1 Refactor generic control/state-machine analyzers to normalized bounded capture records and persist only derived runs/findings.
- [ ] 4.2 Add deterministic golden fixtures for supported metrics, transitions, missing evidence, and invalid-quality ranges.
- [ ] 4.3 Implement only the local loopback Web offline UI/query service and `npm run ui -- --project|--open`; do not add VS Code/webview integration, hardware controls, or raw parsing.
- [ ] 4.4 Implement timeline brush/events/quality and per-variable visibility, color, unit, line, independent axis, scale, offset, auto-fit, and reset with separate preferences.
- [ ] 4.5 Publish tool schemas, risk metadata, resources/prompts, and a reference Agent skill/client conformance test; state that third-party Agent review is not server-enforceable.

Gate acceptance: offline UI opens a completed capture without hardware; analysis is deterministic and raw hashes do not change; discovery exposes the intended workflow and risk boundary.

## Gate 5 — Replacement-first deletion

- [ ] 5.1 Extract shared ELF/GDB/process/CRC/typed-value logic from old owners before deletion.
- [ ] 5.2 Remove `ai-debug-workflow`, backend benchmark/routing, global capture query index, Direct RTT capture, old viewer lifecycle API, Runtime Evidence, and CodeGraph Bridge registrations and implementation.
- [ ] 5.3 Remove OpenOCD/BMP, Telnet Proxy, TraceAgent, legacy CaptureService/helper, external-import capture path, obsolete scripts/tests/docs/config, and dead exports.
- [ ] 5.4 After each deletion batch run compile, targeted tests, tool-catalog checks, import/reference search, and accepted HSS regression evidence.
- [ ] 5.5 Update README/examples/package metadata and resolve or close the superseded `add-ai-hss-debug-workflow` change separately.

Gate acceptance: no removed capability remains registered or documented; retained RTT/GDB/CPU/Flash/Raw tools remain risk-classified auxiliaries; `halt`/`resume`/`reset` contracts and J-Link execution remain intact; final capture path is HSS → JCAP → query/analysis/UI.

## Gate 6 — End-to-end acceptance

- [ ] 6.1 In the non-Git HM_C095 project root, probe the current `.out/.map`, resolve and cache variables, and create a validated HSS plan without guessing filenames.
- [ ] 6.2 Run read-only capture and one separately authorized policy-allowed RAM write with readback; stop/finalize and verify package contents and provenance.
- [ ] 6.3 Verify summary/series/event-window/analysis/UI, delete and rebuild the DB, and compare critical results and raw hashes.
- [ ] 6.4 Change the fixture Artifact generation and verify old Hot Variables/plans become stale and targeted refresh restores only referenced variables.
- [ ] 6.5 Run compile, focused/unit/integration/UI tests and the accepted hardware suite; publish exact commands, identities, results, limitations, and evidence locations.

Final acceptance: the project-supported experimental DLL adapter is the only HSS main path; it is identity-gated and semantically validated; Agent and UI consume bounded rebuildable JCAP evidence; writes remain policy/approval/readback/audit controlled; no official SEGGER SDK claim or dependency exists.
