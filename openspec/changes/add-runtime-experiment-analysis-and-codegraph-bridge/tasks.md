# Tasks

## 0. Pre-flight

- [x] 0.1 Confirm repository root and read `AGENTS.md`.
- [x] 0.2 Read existing capture-related OpenSpec changes and current implementation before editing.
- [x] 0.3 Run baseline checks and record results:
  - `npm run lint`
  - `npm run build`
  - `npm run test`
  - `npm run test:capture-ipc`
  - `npm run test:elf`
- [x] 0.4 Confirm this change is additive and does not modify embedded firmware source.

## 1. OpenSpec setup

- [x] 1.1 Add this change under `openspec/changes/add-runtime-experiment-analysis-and-codegraph-bridge/`.
- [x] 1.2 Add capability specs:
  - `runtime-experiment-analysis`
  - `codegraph-runtime-bridge`
- [x] 1.3 Run `openspec validate add-runtime-experiment-analysis-and-codegraph-bridge --type change --strict`.

## 2. Contracts and validators

- [x] 2.1 Add TypeScript contracts for:
  - `SignalDefinition`
  - `ExperimentRecord`
  - `ExperimentEvent`
  - `PatternFinding`
  - `AnalysisProfile`
  - `RuntimeEvidence`
  - `CodeHint`
  - `CodeGraphQuestion`
- [x] 2.2 Add validators for supported signal roles, signal types, profile names, metric names, and evidence severity.
- [x] 2.3 Add unit tests for valid and invalid contracts.
- [x] 2.4 Ensure invalid user input returns clear structured errors and does not access hardware.

## 3. Experiment records and fixture support

- [ ] 3.1 Add an experiment store abstraction that can load saved experiment metadata and referenced capture data.
- [ ] 3.2 Add conversion from existing capture metadata to `ExperimentRecord`.
- [x] 3.3 Add fixture loading for synthetic experiments used by tests.
- [ ] 3.4 Add tests for old capture compatibility.

## 4. Generic analysis engine

- [x] 4.1 Add `analysis_profiles` registry with at least:
  - `generic_control`
  - `generic_state_machine`
- [x] 4.2 Implement `generic_control` MVP:
  - step response detection
  - overshoot
  - settling time
  - steady-state error
  - saturation
- [x] 4.3 Implement `generic_state_machine` MVP:
  - state transition
  - fault transition
  - stuck signal
  - counter stall
  - counter wrap
- [x] 4.4 Add deterministic fixtures and golden assertions for each MVP pattern.
- [x] 4.5 Add quality warnings when sample rate, missing data, or backend quality limits the conclusion.

## 5. MCP tools

- [ ] 5.1 Add `analysis_profiles`.
- [ ] 5.2 Add `experiment_analyze`.
- [ ] 5.3 Add `experiment_compare`.
- [ ] 5.4 Add `evidence_for_codegraph`.
- [ ] 5.5 Ensure all analysis and bridge tools are read-only and do not start/stop/connect/reset/flash/halt/resume hardware.
- [ ] 5.6 Add MCP-level tests for input validation and outputs.

## 6. Runtime Evidence and CodeGraph bridge

- [ ] 6.1 Generate `RuntimeEvidence` from analysis findings.
- [ ] 6.2 Extract symbol and file hints from signal selectors and control names.
- [ ] 6.3 Generate CodeGraph-friendly questions without calling CodeGraph.
- [ ] 6.4 Add tests proving no CodeGraph runtime dependency is introduced.

## 7. Optional experiment orchestration

- [ ] 7.1 Add `experiment_run` only after tasks 1-6 are complete.
- [ ] 7.2 Use existing capture lifecycle and control allowlist; do not duplicate unsafe write logic.
- [ ] 7.3 Require explicit `allowControls=true` for any control action.
- [ ] 7.4 Record every capture event, control event, rejection, failure, and safety decision.
- [ ] 7.5 Add no-hardware tests using mocks before any hardware test.
- [ ] 7.6 Hardware tests, if performed, must report measured backend capability and must not claim unverified 1 kHz strict support.

## 8. Documentation

- [ ] 8.1 Document generic signal roles and experiment records.
- [ ] 8.2 Document how motor projects use profiles without making the core motor-specific.
- [ ] 8.3 Document the Agent + Jlink-MCP + CodeGraph workflow.
- [ ] 8.4 Add example `.jlink-mcp.json` snippets for:
  - generic control loop
  - generic state machine
  - BLDC motor profile

## 9. Final validation

- [ ] 9.1 Run `npm run lint`.
- [ ] 9.2 Run `npm run build`.
- [ ] 9.3 Run `npm run test`.
- [ ] 9.4 Run `npm run test:capture-ipc`.
- [ ] 9.5 Run `npm run test:elf`.
- [ ] 9.6 Run `openspec validate add-runtime-experiment-analysis-and-codegraph-bridge --type change --strict`.
- [ ] 9.7 Produce a final report containing:
  - changed files
  - implemented tools
  - tests run
  - skipped or deferred tasks
  - hardware operations performed, if any
  - remaining risks
