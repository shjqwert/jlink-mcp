# runtime-experiment-analysis Specification

## Purpose
TBD - created by archiving change add-runtime-experiment-analysis-and-codegraph-bridge. Update Purpose after archive.
## Requirements
### Requirement: Generic Signal Definitions

Jlink-MCP SHALL support generic runtime signal definitions that are not tied to motor-specific names or semantics.

A signal definition SHALL include:

- stable signal name;
- supported scalar type;
- role;
- optional unit;
- optional domain tag;
- optional ELF selector or source reference;
- optional human-readable labels.

The supported MVP roles SHALL include:

- `command`
- `feedback`
- `error`
- `state`
- `fault`
- `limit`
- `counter`
- `timestamp`
- `event`
- `raw`
- `derived`

#### Scenario: non-motor project defines control-loop signals

- **GIVEN** a power-supply project defines `voltage_ref` as `command` and `vout` as `feedback`
- **WHEN** the configuration is validated
- **THEN** Jlink-MCP accepts the signals without requiring any motor-specific field.

#### Scenario: motor project defines motor-specific domain tags

- **GIVEN** a motor project defines `iq_ref`, `iq`, and `hall_state`
- **WHEN** the configuration includes `domain: "motor"`
- **THEN** Jlink-MCP stores the domain tag
- **AND** the generic analyzer can still operate on role-based fields.

#### Scenario: invalid role is rejected

- **GIVEN** a signal uses role `motor_feedback_magic`
- **WHEN** the configuration is validated
- **THEN** Jlink-MCP rejects the signal with a structured validation error.

---

### Requirement: Experiment Records

Jlink-MCP SHALL represent runtime observations as experiment records.

An experiment record SHALL include:

- `experimentId`;
- creation time;
- source type;
- signal definitions;
- events;
- optional target metadata;
- optional capture metadata;
- optional artifacts;
- optional free-form metadata.

Experiment records SHALL be usable for analysis without connecting to hardware.

#### Scenario: analyze saved capture without hardware

- **GIVEN** a saved capture record and its metadata
- **WHEN** `experiment_analyze` is called
- **THEN** Jlink-MCP analyzes the saved data
- **AND** does not connect to J-Link, GDB Server, RTT, or any hardware backend.

#### Scenario: preserve control and capture events

- **GIVEN** an experiment includes a capture start, a control action, a fault transition, and capture stop
- **WHEN** the experiment record is loaded
- **THEN** all events are preserved with timestamps and event types.

---

### Requirement: Analysis Profiles

Jlink-MCP SHALL expose available analysis profiles through an `analysis_profiles` MCP tool.

The MVP SHALL implement:

- `generic_control`
- `generic_state_machine`

Jlink-MCP MAY include optional domain profiles such as:

- `motor_bldc`
- `motor_foc`

Optional domain profiles SHALL NOT be required by generic analysis.

#### Scenario: list implemented profiles

- **WHEN** `analysis_profiles` is called
- **THEN** the response lists profile names, domains, status, and supported patterns.

#### Scenario: unknown profile is rejected

- **GIVEN** an analysis request for `unknown_profile`
- **WHEN** `experiment_analyze` is called
- **THEN** Jlink-MCP rejects the request with a structured validation error.

---

### Requirement: Generic Control Analysis

Jlink-MCP SHALL provide a `generic_control` profile for role-based control-loop analysis.

The MVP SHALL detect or compute:

- command step response;
- overshoot;
- settling time;
- steady-state error;
- saturation when a limit or clipping indicator is available.

The profile SHALL operate on signal roles rather than motor-specific names.

#### Scenario: overshoot is detected in a generic control loop

- **GIVEN** an experiment with a `command` signal and a `feedback` signal
- **AND** the feedback exceeds the final command by more than the configured threshold
- **WHEN** `experiment_analyze` runs with `generic_control`
- **THEN** the result contains an `overshoot` pattern finding
- **AND** the finding includes signal name, time window, value, unit, confidence, and evidence text.

#### Scenario: saturated response produces warning

- **GIVEN** an experiment has a `limit` signal indicating saturation
- **WHEN** the feedback does not settle after a command step
- **THEN** the analyzer reports a saturation-related finding or quality warning.

#### Scenario: no command signal is available

- **GIVEN** an experiment has only a feedback signal
- **WHEN** `generic_control` analysis is requested
- **THEN** Jlink-MCP returns a structured warning that command-response metrics are unavailable
- **AND** does not fail the entire analysis if other patterns can still be computed.

---

### Requirement: Generic State Machine Analysis

Jlink-MCP SHALL provide a `generic_state_machine` profile for state, fault, event, and counter analysis.

The MVP SHALL detect:

- state transitions;
- fault transitions;
- stuck signals;
- counter stalls;
- counter wraps.

#### Scenario: fault transition is detected

- **GIVEN** an experiment has a `fault` signal changing from `0` to `3`
- **WHEN** `experiment_analyze` runs with `generic_state_machine`
- **THEN** the result contains a `fault_transition` pattern with old value, new value, and transition time.

#### Scenario: stuck state is detected

- **GIVEN** a `state` signal remains unchanged longer than the configured threshold during a period that contains command changes
- **WHEN** the state-machine profile is applied
- **THEN** the result contains a `stuck_signal` finding or warning.

---

### Requirement: Experiment Analysis Tool

Jlink-MCP SHALL provide an `experiment_analyze` MCP tool.

The tool SHALL:

- accept an `experimentId` or `captureId`;
- accept an analysis profile;
- optionally accept signal names and a time window;
- return summary, findings, evidence, and quality warnings;
- be read-only.

The tool SHALL NOT:

- connect to hardware;
- start or stop GDB Server;
- start or stop capture;
- write memory;
- halt, resume, reset, or flash the target;
- call CodeGraph MCP.

#### Scenario: read-only analysis

- **GIVEN** a saved experiment exists
- **WHEN** `experiment_analyze` is called
- **THEN** no hardware or control side effect occurs
- **AND** the output is derived only from saved experiment data and metadata.

#### Scenario: missing experiment is reported

- **GIVEN** no experiment exists for `exp_missing`
- **WHEN** `experiment_analyze` is called with `experimentId: "exp_missing"`
- **THEN** Jlink-MCP returns a structured not-found error.

---

### Requirement: Experiment Comparison Tool

Jlink-MCP SHALL provide an `experiment_compare` MCP tool.

The tool SHALL compare two experiments using a selected profile and metrics.

#### Scenario: improved response is reported

- **GIVEN** a baseline experiment has 30% overshoot
- **AND** a candidate experiment has 10% overshoot
- **WHEN** `experiment_compare` is called
- **THEN** the result reports reduced overshoot
- **AND** the summary verdict is `improved` or equivalent.

#### Scenario: incomparable experiments produce warnings

- **GIVEN** two experiments have incompatible signal sets
- **WHEN** `experiment_compare` is called
- **THEN** Jlink-MCP returns quality warnings
- **AND** does not fabricate metrics.

---

### Requirement: Domain Profiles Are Optional

Jlink-MCP SHALL keep domain-specific profiles separate from the generic analysis core.

Motor-specific logic SHALL NOT be required by:

- experiment records;
- generic control analysis;
- generic state-machine analysis;
- CodeGraph bridge generation.

#### Scenario: non-motor project runs without motor profile

- **GIVEN** no motor profile is enabled
- **WHEN** a power-supply or protocol-state-machine experiment is analyzed
- **THEN** generic analysis still works.

---

### Requirement: Deterministic Fixture Testing

Jlink-MCP SHALL include deterministic synthetic fixtures and golden assertions for MVP analysis profiles.

Fixtures SHALL cover:

- ideal step response;
- overshoot response;
- saturated response;
- fault transition;
- stuck state;
- counter stall;
- before/after comparison.

#### Scenario: golden fixture output is stable

- **WHEN** tests run on the synthetic overshoot fixture
- **THEN** the reported overshoot metric remains stable within the test tolerance.

---

### Requirement: Post-capture analysis returns actionable evidence

Jlink-MCP SHALL provide post-capture analysis output that includes dynamic findings, evidence windows, confidence, and recommended next actions.

#### Scenario: finding produced

- **GIVEN** a saved capture contains enough evidence for an anomaly
- **WHEN** post-capture analysis runs
- **THEN** the result includes the finding type, involved signals, evidence time window, supporting values, confidence, and explanation.

#### Scenario: next action recommended

- **GIVEN** analysis finds an unresolved root-cause candidate
- **WHEN** another workflow round is allowed
- **THEN** the result recommends the next capture variables, write experiment, or stop condition.

---

### Requirement: BLDC analysis profile is optional and evidence-based

Jlink-MCP SHALL provide an optional BLDC analysis profile for current-loop, speed-loop, and Hall/encoder angle and speed checks.

#### Scenario: BLDC profile runs

- **GIVEN** a saved capture has BLDC signal definitions
- **WHEN** analysis runs with the `motor_bldc` profile
- **THEN** Jlink-MCP analyzes current-loop tracking, speed-loop tracking, Hall/encoder angle consistency, Hall/encoder speed consistency, state, and fault signals where available.

#### Scenario: missing BLDC signals

- **GIVEN** a saved capture does not contain enough BLDC signals for one check
- **WHEN** analysis runs with the `motor_bldc` profile
- **THEN** Jlink-MCP returns a quality warning for that check
- **AND** still runs checks that have enough evidence.

---

### Requirement: Analysis does not mutate hardware

Post-capture analysis SHALL remain read-only with respect to hardware.

#### Scenario: analysis after capture

- **WHEN** post-capture analysis runs for a saved capture
- **THEN** it does not connect to hardware, write variables, reset, halt, resume, flash, or start a new capture.
