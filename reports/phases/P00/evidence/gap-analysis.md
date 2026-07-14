# P00 Gap Analysis

## Baseline

- Frozen Rev1 contains 144 unique requirements. package.json is 0.3.2; this does not alter Spec v0.2.1.
- Current public surface is catalogued in `catalog-snapshot.json`; it is legacy-oriented and has no v0.2.1 discovery or envelope contract.

## Confirmed production coupling

| Coupling | Production locations | Required disposition |
|---|---|---|
| `FOC_SCM.out/.map` default discovery | `src/mcp/hss/debug-artifact.ts`, `src/mcp/hss/hss-write-layout.ts` | P02: remove defaults; require explicit/ambiguous artifact selection. |
| `g_hssDbg*` default variable set / semantic checks | `src/mcp/hss/hss-plan.ts`, `src/mcp/hss/hss-artifact.ts`, `src/mcp/hss/hss-capture-service.ts` | P05/P09: move project semantics to test fixtures; retain generic transport only. |
| HM_C095 wording in public HSS query | `src/mcp/server.ts` | P08/P09: remove from public description and workflow. |
| `Z20K146M` and `D:\\HM_C095\\...` | `src/mcp/hm-c095/hm-c095-capture-fixture.ts` | Fixture-only: retain with explicit test-only classification. |
| Absolute J-Link install paths | `src/utils/config.ts`, `src/probe/jlink.ts`, `src/mcp/capture-backends/jlink-hss-adapter.ts`, `src/mcp/hss-dll/hss-dll-adapter.ts` | P03: platform installation discovery is allowed; remove any target-project absolute path/default. |

## Corrected P01-P09 route

| Phase | Scope correction |
|---|---|
| P01 | Establish cwd-only project context, path containment, sessions, policy, audit, operation-plan and unified envelope before retaining legacy execution tools. |
| P02 | Build content-based artifact/catalog resolver; delete FOC_SCM defaults and reject unsupported selectors. |
| P03 | Add generic J-Link identity plus BMA/RSP routing; make RTT optional and hide direct channel/TraceAgent paths. |
| P04 | Deliver catalog-only RAM writes, allowlist/readback/restore evidence and HSS write queue; isolate array experiments. |
| P05 | Make generic single-session HSS/capture format primary; remove HM_C095 semantics from transport decisions. |
| P06 | Add SVD field-only flow and risk classification; no register-level default writes. |
| P07 | Govern CPU/Flash/raw with plan, audit, dry-run, R4 receipt and R5 prohibition. |
| P08 | Replace public discovery surface with mcu_capabilities/catalog/backend_status/risk_policy plus workflow resources/prompts. |
| P09 | Release gate: remove/hide all OOS public paths, eliminate target-specific production defaults, and pass a non-HM_C095 fixture contract. |

## Public-surface decisions

- Remove: TraceAgent, Runtime Evidence/CodeGraph Bridge, offline experiment diagnostics, and legacy capture-control APIs from the frozen public surface.
- Hide: raw memory/probe command and optional Direct RTT paths until governed by the R4/experimental boundary.
- Refactor: retained J-Link/HSS/CPU/Flash tools into the P01 envelope and risk plan model; no new capability is proposed.

