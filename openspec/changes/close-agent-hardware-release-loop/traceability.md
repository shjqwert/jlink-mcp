# Phase 7 Traceability

| Phase 7 contract | Source capability | Tasks | Primary verification |
|---|---|---|---|
| Exact 36 daily-debug tools, no public stub/alias | `standalone-agent-mcp` | 2.1-2.5 | T01, T02, exact surface/handler test |
| Agent owns workflow and business analysis | `ai-debug-workflow`, `runtime-experiment-analysis` | 2.1, 2.4-2.5 | no-analysis-tool scan, Skill workflow fixtures |
| Portable Codex/Claude startup | `standalone-agent-mcp` | 2.4-2.5, 3.4 | clean stdio smoke, config consistency |
| Clean distribution contains HSS Helper | `hss-backend` | 3.1-3.4 | clean build, Helper self-test, package contents |
| CI invokes only current scripts | `standalone-agent-mcp` | 3.2-3.3 | workflow/package-script consistency |
| Variable writes default to old-read plus same-session verification | `artifact-symbol-variable-access` | 4.1-4.7 | T07, T08, session/restore tests |
| Raw memory write remains unverified by default | `direct-mcu-operations` | 4.4-4.6 | write-memory schema/behavior tests |
| Persistent owners serialize per Target generation | `target-context-and-serialization` | 4.1-4.6 | T10, contention/failure tests |
| HSS dry-run replaces public plan/capability | `hss-backend` | 5.1, 5.5 | dry-run no-side-effect/capability tests |
| HSS quality claims require a qualified source | `hss-backend` | 5.2, 5.5-5.6 | T14, T17, oracle/partial fixtures |
| Four-file JCAP and automatic atomic DB rebuild | `jcap-v1-store`, `capture-query-index` | 5.3-5.5 | T17-T19, Raw hash/rebuild parity |
| Artifact scan returns prioritized truncated candidates | `artifact-symbol-variable-access` | 6.1, 6.4 | T03 and truncation fixtures |
| Logical selector cache never reuses stale addresses | `artifact-symbol-variable-access` | 6.2, 6.4 | T04, T05, generation-change tests |
| Peripheral access requires configured exact SVD | `svd-register-access` | 6.3-6.4 | T09 SVD/missing-SVD fixtures |
| GDB/RTT lifecycle has explicit prerequisites and state reports | `direct-mcu-operations`, `direct-rtt-channel-backend` | 7.1-7.2, 7.5 | lifecycle/owner/no-hidden-effect tests |
| Crash diagnosis is complete only for an already halted Cortex-M | `direct-mcu-operations` | 7.3-7.5 | register/frame/fault/backtrace fixtures and hardware check |
| Tracked/package output is sanitized | `acceptance-evidence` | 8.1-8.3 | privacy and package gates |
| Final summary matches one tested commit | `acceptance-evidence` | 8.3, 9.3-9.6 | summary schema, commit check, T01-T20 index |
| Reviewer sees an immutable diff | Phase 7 review protocol | 9.1-9.5 | start/end diff hash equality or `STALE` |

Full hardware evidence and the issue ledger remain under ignored `test-output/`. This matrix maps requirements to verification; it does not convert incomplete, blocked, or stale hardware results into PASS.
