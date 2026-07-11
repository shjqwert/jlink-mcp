# ai-debug-workflow Specification

## Purpose
Define the MVP-C AI-oriented debug workflow that coordinates HSS capture, variable writes, post-capture evidence, SQL-backed lookup, and viewer handoff through stable MCP tools.

## Requirements

### Requirement: Bounded AI debug sessions

Jlink-MCP SHALL provide an AI debug workflow that coordinates capture planning, HSS capture, post-capture analysis, optional variable writes, and follow-up rounds under explicit bounds.

#### Scenario: start debug workflow

- **GIVEN** a debug objective, target metadata, candidate signals, and `maxRounds`
- **WHEN** an AI debug workflow starts
- **THEN** Jlink-MCP creates a session record
- **AND** stores the objective, selected variables, round limit, and safety settings.

#### Scenario: stop at round limit

- **GIVEN** an AI debug workflow has reached `maxRounds`
- **WHEN** analysis requests another capture round
- **THEN** Jlink-MCP stops the workflow
- **AND** returns the latest findings and the reason `round_limit_reached`.

### Requirement: MVP-C MCP tools are explicit by phase

Jlink-MCP SHALL expose stable MCP tools for the MVP-C workflow, capture index, viewer, and production variable write phases.

The MVP-C workflow tools SHALL include:

- `hss_debug_session_plan`
- `hss_debug_session_run`
- `hss_debug_session_status`
- `hss_debug_session_cancel`
- `hss_debug_session_report`

The capture index tools SHALL include:

- `capture_index_list`
- `capture_index_get`
- `capture_index_rebuild`
- `capture_index_query_series`
- `capture_index_query_events`
- `capture_index_query_event_window`

The viewer tools SHALL include:

- `viewer_start`
- `viewer_stop`
- `viewer_status`
- `viewer_open_capture`

The production variable write path SHALL continue through `variable_write_plan` and `variable_write_execute`, including scalar, fixed array element, and fixed contiguous array slice targets.

#### Scenario: AI requests one-shot debug run

- **GIVEN** a workflow input defines capture variables, optional write stimulus, event window, and SQL index behavior
- **WHEN** `hss_debug_session_run` is called
- **THEN** Jlink-MCP executes the bounded workflow through existing HSS capture, write, query, and export primitives
- **AND** returns a structured summary, artifacts, warnings, failure class, and SQL index update status.

#### Scenario: viewer opens indexed capture

- **GIVEN** a completed capture exists in the SQL index
- **WHEN** `viewer_open_capture` is called with its `captureId`
- **THEN** Jlink-MCP returns or opens a local viewer URL for that capture
- **AND** the viewer reads data through the capture index/query APIs.

### Requirement: Workflow input files are versioned and project-local

Jlink-MCP SHALL accept versioned JSON workflow input files for AI debug sessions.

A workflow input file SHALL:

- be JSON with `version: 1`;
- reside under the current project root;
- be referenced by `inputFile` or supplied inline, but not mixed with ambiguous override precedence;
- define objective, profile, artifact/map files, capture variables, sampling, event window, safety settings, SQL index behavior, and optional viewer behavior.

#### Scenario: input file accepted

- **GIVEN** `.jlink-mcp/workflows/hm-c095-write-probe.json` contains a valid version 1 workflow
- **WHEN** `hss_debug_session_plan` is called with `inputFile`
- **THEN** Jlink-MCP validates the file
- **AND** returns the planned capture, write, query, export, SQL index, and viewer steps without writing target memory.

#### Scenario: path outside project rejected

- **GIVEN** an `inputFile` path escapes `process.cwd()`
- **WHEN** any workflow tool loads the file
- **THEN** Jlink-MCP rejects the request with a structured validation error
- **AND** no hardware action is started.

### Requirement: Each round has a hypothesis and evidence plan

Each AI debug round SHALL record a hypothesis, selected variables, capture duration, expected observation, stop condition, and analysis profile before capture starts.

#### Scenario: missing round hypothesis

- **GIVEN** a workflow round request has no hypothesis
- **WHEN** Jlink-MCP validates the round
- **THEN** the request is rejected with a structured validation error
- **AND** no capture or write is started.

#### Scenario: BLDC first-round plan

- **GIVEN** the domain is `motor_bldc`
- **WHEN** the workflow plans a current-loop or speed-loop round
- **THEN** the plan may select current command, current feedback, speed command, speed feedback, Hall/encoder angle, Hall/encoder speed, state, and fault signals if those variables are available.

### Requirement: Workflow writes are symbol-derived experiments

The AI debug workflow SHALL execute variable writes only through variable-write planning and execution using ELF/MAP-resolved RAM variables.

#### Scenario: write plan accepted

- **GIVEN** a proposed write targets an ELF/MAP-resolved scalar RAM variable
- **AND** the write includes value rationale, expected observation, retry limit, and readback requirement
- **WHEN** the workflow validates the write
- **THEN** Jlink-MCP allows the write to proceed through the variable-write execution path.

#### Scenario: arbitrary address rejected

- **GIVEN** a proposed write targets a raw address without symbol resolution
- **WHEN** the workflow validates the write
- **THEN** Jlink-MCP rejects the write
- **AND** records the rejection in the session audit trail.

### Requirement: Workflow output is evidence-backed and dynamic

The AI debug workflow SHALL return findings based on captured evidence, session prompt, write events, and analysis results instead of a fixed report template.

#### Scenario: round completed

- **GIVEN** a capture round has completed and analysis has run
- **WHEN** the workflow returns the round result
- **THEN** the result includes conclusion, root-cause candidates, evidence signals, time windows, related write events, confidence, and recommended next action.

#### Scenario: insufficient evidence

- **GIVEN** analysis cannot support a root-cause conclusion
- **WHEN** the workflow returns the round result
- **THEN** the result states insufficient evidence
- **AND** proposes the next capture or write experiment if another round is allowed.
