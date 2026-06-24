# Phase 5B final readiness

Date: 2026-06-24

## Changed files

- `src/mcp/experiment-store.ts`
- `src/mcp/experiment-store.test.ts`
- `src/mcp/server.ts`
- `docs/runtime-experiment-analysis.md`
- `README.md`
- `openspec/changes/add-runtime-experiment-analysis-and-codegraph-bridge/tasks.md`
- `openspec/changes/add-runtime-experiment-analysis-and-codegraph-bridge/acceptance/phase-5b-final-readiness.md`

Untracked local `.vscode/` files were left untouched and are not part of this change.

## Hardening fixes

- `experimentPath` now uses the same explicit file gate as capture metadata paths: absolute path, no wildcard, real file, and `.experiment.json` suffix.
- `fixturePath` remains restricted to relative paths under `src/mcp/fixtures`.
- Capture metadata `binaryFile` is still required to be an absolute `.jlcp` file.
- Capture metadata `binaryFile` must be in the same directory as the metadata file.
- Capture metadata `binaryFile` basename must match `metadata.sessionId` through `selectSessionArtifacts()`, preventing same-directory wrong-session artifacts.

## Documentation

- Added `docs/runtime-experiment-analysis.md`.
- Documented signal roles, `ExperimentRecord`, fixture/saved/capture-backed analysis, `signalRoles` overrides, Runtime Evidence, CodeGraph query suggestion workflow, generic control/state examples, and BLDC domain-specific usage.
- Added README pointer from continuous variable capture to the runtime experiment analysis guide.
- Documented RSP backend limitations and `maxSamples` decimation risk.

## Implemented MCP tools

- `analysis_profiles`
- `experiment_analyze`
- `experiment_compare`
- `evidence_for_codegraph`

Phase 5B only updated descriptions for analysis tools; tool semantics remain read-only.

## Verification

All commands exited with code 0:

- `npm run lint`
- `npm run build`
- `npm run test` - 35 tests passed
- `npm run test:capture-ipc` - 2 tests passed
- `npm run test:elf` - 1 test passed
- `openspec.cmd validate add-runtime-experiment-analysis-and-codegraph-bridge --type change --strict` - `Change 'add-runtime-experiment-analysis-and-codegraph-bridge' is valid`

`git diff --check` reported only Windows LF-to-CRLF conversion warnings and no whitespace errors.

## Deferred tasks

OpenSpec section 7 remains intentionally incomplete:

- `experiment_run` was not added.
- Existing capture lifecycle and control write logic were not modified.
- No new hardware orchestration was introduced.

Recommendation: defer archiving until web GPT review confirms whether 7.x should remain optional/out-of-scope or be implemented in a later phase. If 7.x is accepted as out-of-scope, this change is otherwise ready to archive after review.

## Hardware and CodeGraph safety

- No hardware commands were run.
- No J-Link, GDB server, RTT, capture lifecycle, reset, flash, halt, resume, or control write operation was invoked.
- No CodeGraph MCP tool, runtime API, or dependency was used or added.
- The bridge remains deterministic and inference-only from analysis results and selectors.

## Remaining risks

- Long capture analysis can miss short state/fault/counter events when `maxSamples` decimates samples; users should narrow `windowMs` or raise `maxSamples`.
- The RSP backend is not a J-Scope/HSS equivalent; rate claims must come from measured capture metadata.
- `experiment_run` remains a future orchestration decision, not part of Phase 5B.
