# Functional and Acceptance Traceability

This matrix is the frozen mapping from the Agent-first requirements to implementation tasks and T01-T20 evidence. Initial results describe the state before implementation; they are not predictions.

## T01-T20 Matrix

| Test | Acceptance intent | Primary capability / requirement | Tasks | Required evidence | Initial result |
| --- | --- | --- | --- | --- | --- |
| T01 | Install, build, lint, test, standalone stdio startup, exact surface | `standalone-agent-mcp` / Standalone stdio; exact direct surface | 1.1, 1.5, 1.6, 5.3 | Build/lint/test logs, initialize and list-tools/resources/prompts snapshots | NOT_TESTED |
| T02 | No executable VS Code or approval/risk control plane remains | `standalone-agent-mcp` / Approval and risk control planes do not execute | 1.2-1.4, 1.6 | Scoped source/package/document scan and deletion manifest | NOT_TESTED |
| T03 | Discover and classify Artifact/MAP/flash candidates without guessing | `artifact-symbol-variable-access` / Content-driven bounded discovery | 2.2, 3.1, 3.8 | Candidate JSON with kind, canonical path, hash, external flag, ambiguity cases | NOT_TESTED |
| T04 | Resolve global/static scalars, arrays, nested members, sizes and addresses | `artifact-symbol-variable-access` / Supported selectors and scalar types | 3.2, 3.8 | Resolution fixtures and frozen-Artifact hardware results | NOT_TESTED |
| T05 | Mark old logical references stale and refresh only selected Hot Variables | `artifact-symbol-variable-access` / Artifact generation; Hot Variables | 2.2, 3.3, 3.8 | Two-generation fixture, stale rejection, targeted refresh diff | NOT_TESTED |
| T06 | Read a stable variable without implicit halt/reset or state change | `artifact-symbol-variable-access` / Variable reads preserve target state | 2.5, 3.4, 3.8, 6.3 | Before/after target state and structured read result | NOT_TESTED |
| T07 | Write legal typed value and optionally confirm it truthfully | `artifact-symbol-variable-access` / Structured writes; deterministic comparators | 3.5, 3.6, 3.8, 6.3 | old/requested/readback fields according to options and operation envelope | NOT_TESTED |
| T08 | Restore the captured prior value and verify restoration | `artifact-symbol-variable-access` / Restore protects known prior value | 3.6, 3.8, 6.3 | Main write/readback and restore/readback results, including uncertainty path | NOT_TESTED |
| T09 | Reject type, bounds, float, address, access, and disconnect failures safely | `artifact-symbol-variable-access`; `direct-mcu-operations`; `svd-register-access` | 2.6, 3.2, 3.5-3.8, 5.3 | Negative fixtures, neighboring-memory sentinel, disconnect log, error codes | NOT_TESTED |
| T10 | Serialize same-Probe physical operations across processes and survive failure | `target-context-and-serialization` / Physical operations serialize by Probe | 2.3, 2.4, 2.8, 5.3 | Concurrent process trace with sequence IDs, owner state, continuation result | NOT_TESTED |
| T11 | Halt, resume, reset, and reset_halt report observed final CPU states | `direct-mcu-operations` / CPU control has explicit final states | 2.5, 2.6, 2.8, 6.3 | Per-command before/after state and side-effect envelope | NOT_TESTED |
| T12 | Flash associated S19, verify it, restore execution explicitly, establish match | `direct-mcu-operations` / Strict flash verification; `target-context-and-serialization` / Artifact match | 2.2, 2.7, 5.4, 6.2 | Frozen manifest, flash/verify logs, match transition, final state, source manifest | NOT_TESTED |
| T13 | Erase only when allowed and immediately recover with associated image | `direct-mcu-operations` / Direct erase and explicit blank verification | 2.7, 5.4, 6.7 | `allowErase`, erase/blank result, recovery flash/verify, final state | NOT_TESTED |
| T14 | Prove HSS lifecycle, Smoke profile, and declared ten-variable 1 kHz/60 s ceiling | `hss-backend` / Direct lifecycle; limits; `acceptance-evidence` / HSS ceiling | 4.1, 4.2, 4.7, 6.4 | Capability/plan/status, frame counts, drop/overflow counts, terminal package | NOT_TESTED |
| T15 | Write and restore during capture without corrupting samples | `hss-backend` / Capture events and writes; `acceptance-evidence` / Fixed timing | 3.5, 3.6, 4.3, 4.7, 6.5 | old/requested/readback/restore event intervals and pre/post sample references | NOT_TESTED |
| T16 | Preserve valid Raw prefix and report interrupted capture honestly | `jcap-v1-store` / Lifecycle, append-only Raw, recovery | 4.2, 4.4, 4.7, 6.6 | Helper-exit/MCP-restart cases, interrupted metadata, recovered DB status | NOT_TESTED |
| T17 | Validate JCAP metadata, record layouts, timebase, hashes/CRC, and events | `jcap-v1-store` / Four files; authoritative metadata; Raw integrity | 4.4, 4.7, 5.4, 6.6 | Package validator output and file/hash manifest | NOT_TESTED |
| T18 | Rebuild derived DB atomically with unchanged Raw and equivalent queries | `jcap-v1-store` / Derived atomic DB; `capture-query-index` / Raw preservation | 4.5, 4.7, 5.4, 6.6 | Before/after Raw hashes, canonical query comparison, failed-temp-DB case | NOT_TESTED |
| T19 | Bound summary, series, event-window, tick range, maxPoints, aggregates, CSV | `capture-query-index` / AI/UI queries and bounded buckets | 4.6, 4.7, 5.4, 6.6 | Query bounds/results, oversize rejection, external CSV path | NOT_TESTED |
| T20 | Complete direct Agent debugging loop with traceable truth and no approvals | `ai-debug-workflow` / Agent orchestration and evidence-backed conclusions | 1.5, 2.1-2.7, 3.1-3.7, 4.1-4.6, 5.5, 6.6 | Commands, envelopes, two capture comparisons, manifests, hashes, commit/environment IDs | NOT_TESTED |

## Explicit Scope and Prerequisite Results

| Item | Requirement | Evidence or unblock condition | Initial result |
| --- | --- | --- | --- |
| SVD-01 | Peripheral registers use a validated exact SVD; no guessed layouts | Configure and hash an exact Z20K146M SVD. Raw memory is an explicit alternative, not SVD coverage. | BLOCKED |
| UI-01 | Existing Offline UI code is retained, not modified, expanded, or accepted | No UI test is required in this change; DB compatibility is verified from the producer/query side only. | NOT_TESTED |
| MATCH-01 | Symbol writes and HSS hardware acceptance require a verified live Artifact generation | T12 associated flash plus verify must complete first. | BLOCKED |

`MATCH-01` changes from BLOCKED only after T12 provides the required evidence. A failed or skipped T12 cannot be converted into a pass by user confirmation alone.

## Delivery Gates

| Commit | Scope | Required gate before push |
| --- | --- | --- |
| 1 — `spec: redefine jlink-mcp as agent-first debugging tool` | Archive prior change; preconditions, proposal, design, delta specs, tasks, traceability | OpenSpec strict validation, exact tool-count check, Markdown/diff checks |
| 2 — `refactor: remove vscode extension and approval control plane` | Tasks 1.1-1.6 | Build, lint, unit, standalone surface and historical scan |
| 3 — `refactor: unify direct mcu operations and hardware queue` | Tasks 2.1-2.8 | Target, envelope, queue, ownership, direct-operation unit/simulated tests |
| 4 — `feat: add unified write readback restore and operation status` | Tasks 3.1-3.8 | Artifact, symbol, Hot Variable, SVD, write/readback/restore tests |
| 5 — `feat: align hss capture-time writes with jcap persistence` | Tasks 4.1-4.7 | HSS, event alignment, JCAP integrity, rebuild and bounded-query tests |
| 6 — `test: add agent-first mcp acceptance suite` | Tasks 5.1-5.7 | Complete software/simulated suite and ignored-output verification |

Hardware tasks 6.1-6.9 produce ignored local evidence under `test-output/`. There is no Commit 7; a later hardware summary is created or committed only if the user explicitly requests it.

## Merge Rule

Recommend merging to `main` only when every applicable T01-T20 case is PASS, all non-applicable cases are honestly BLOCKED or SKIPPED_WITH_REASON, and no P0 issue remains open. SVD remains a documented blocker for SVD-specific coverage, not a reason to fabricate equivalent coverage through raw memory operations.
