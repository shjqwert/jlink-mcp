# Web GPT-5.5 Pro Acceptance Plan

Use this plan because implementation and hardware access happen locally in Codex, while review happens in the web UI.

## Phase 0 - Spec Gate

### Codex must provide

- Full contents of:
  - `proposal.md`
  - `design.md`
  - `tasks.md`
  - both capability specs
- `openspec validate add-runtime-experiment-analysis-and-codegraph-bridge --type change --strict` output
- `git status --short`
- List of any files modified outside `openspec/`

### Web GPT checks

- The change is additive.
- Motor logic is not in the core requirements.
- CodeGraph is not a runtime dependency.
- Hardware and control side effects are excluded from read-only analysis tools.
- Tasks are staged and testable.

### Pass condition

OpenSpec strict passes and no implementation starts before the spec is accepted.

## Phase 1 - Contracts and Fixtures Gate

### Codex must provide

- Changed files list
- New contract/validator files
- Fixture files
- Unit test output
- `npm run lint`
- `npm run build`
- `npm run test`

### Web GPT checks

- Signal roles are generic.
- Invalid inputs produce structured errors.
- Fixtures are deterministic.
- Analysis code has no hardware dependencies.

### Pass condition

Contracts and fixtures pass without touching hardware.

## Phase 2 - Generic Analysis Gate

### Codex must provide

- Implementation files for `generic_control` and `generic_state_machine`
- Fixture outputs for:
  - ideal step response
  - overshoot
  - saturation
  - fault transition
  - stuck state
  - counter stall
- Golden test assertions
- Test command outputs

### Web GPT checks

- Metrics are computed from data, not hard-coded.
- Conclusions contain quality warnings when data is insufficient.
- No motor-specific assumptions appear in generic profiles.

### Pass condition

Generic analysis works for both motor-like and non-motor fixtures.

## Phase 3 - MCP Tool Gate

### Codex must provide

- MCP tool registration diff
- Input/output examples for:
  - `analysis_profiles`
  - `experiment_analyze`
  - `experiment_compare`
  - `evidence_for_codegraph`
- MCP-level tests
- Full validation output

### Web GPT checks

- Tools are read-only unless explicitly marked optional.
- `experiment_analyze` does not connect to hardware.
- Error responses are structured.
- Old capture tests still pass.

### Pass condition

MCP tools work on saved data and fixtures only.

## Phase 4 - CodeGraph Bridge Gate

### Codex must provide

- Runtime Evidence sample
- `evidence_for_codegraph` sample output
- Tests proving CodeGraph is not imported or called
- Example Agent workflow

### Web GPT checks

- Generated queries are useful to CodeGraph.
- No source-code graph engine is duplicated.
- No nested MCP dependency exists.

### Pass condition

Bridge output is Agent-usable and independent of CodeGraph runtime availability.

## Phase 5 - Optional Experiment Run Gate

Only start this phase if Phases 0-4 pass.

### Codex must provide

- `experiment_run` design and implementation diff
- Mocked safety tests
- Evidence that existing capture/control allowlist is reused
- Explicit proof that control actions require `allowControls=true`
- Hardware operation log if hardware is touched

### Web GPT checks

- No arbitrary writes.
- No duplicated safety path.
- All actions are recorded as events.
- Failure behavior follows existing stop/reset safety rules.

### Pass condition

Experiment orchestration is safe and does not weaken the existing capture safety model.

## Phase 6 - Hardware / Motor Gate

This phase is optional and must not block the generic analysis MVP.

### Codex must provide

- Current-session safety authorization text
- Exact hardware model
- Target MCU
- SWD/JTAG speed
- Requested and measured capture rate
- Backend name
- Quality metrics
- Whether motor was started
- Whether stop/reset occurred
- Raw report and generated experiment record

### Web GPT checks

- Hardware claims match measured data.
- No 1 kHz strict claim is made unless actually measured.
- Motor operation was explicitly authorized in the same session.

### Pass condition

Hardware evidence is reported honestly and separated from generic analysis validation.
