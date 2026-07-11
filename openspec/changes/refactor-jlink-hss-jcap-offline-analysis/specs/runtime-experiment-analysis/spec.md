## MODIFIED Requirements

### Requirement: Generic Signal Definitions

Jlink-MCP SHALL define generic role-based signals over normalized capture-query records, including stable variable identity, supported scalar type, role, optional unit/domain/labels, and quality state. Signal definitions SHALL not depend on motor-specific names.

#### Scenario: non-motor capture is mapped

- **WHEN** command and feedback roles are mapped for a power-supply capture
- **THEN** generic control analysis accepts them without a motor profile.

### Requirement: Analysis Profiles

Jlink-MCP SHALL expose implemented deterministic profiles, including `generic_control` and `generic_state_machine`, with input roles, analyzer version, status, and optional domain profiles.

#### Scenario: unknown profile is requested

- **WHEN** `analysis_run` receives an unknown profile
- **THEN** it returns a structured validation error.

### Requirement: Generic Control Analysis

The `generic_control` profile SHALL compute supported command-step, overshoot, settling, steady-state error, and saturation findings from bounded capture windows and quality-qualified evidence.

#### Scenario: required feedback is absent

- **WHEN** a metric cannot be computed from selected signals
- **THEN** the result reports insufficient evidence
- **AND** does not invent a conclusion.

### Requirement: Generic State Machine Analysis

The `generic_state_machine` profile SHALL detect supported state/fault transitions, stuck signals, counter stalls, and counter wraps from normalized capture records.

#### Scenario: fault transition is detected

- **WHEN** a quality-valid fault signal changes value
- **THEN** the finding includes old/new value, transition tick, evidence window, and confidence.

### Requirement: Domain Profiles Are Optional

Jlink-MCP SHALL keep domain-specific profiles separate from the generic analysis core and SHALL allow non-motor projects to use generic profiles without installing a motor profile.

#### Scenario: no domain profile is configured

- **WHEN** a generic state-machine capture is analyzed
- **THEN** generic analysis remains available.

### Requirement: Deterministic Fixture Testing

Jlink-MCP SHALL test analysis with deterministic fixtures for ideal/overshoot/saturated steps, fault transition, stuck state, counter stall/wrap, missing evidence, and invalid-quality ranges.

#### Scenario: golden fixture repeats

- **WHEN** the same capture window, profile, configuration, and analyzer version run twice
- **THEN** findings and metrics are equal within documented numeric tolerance.

### Requirement: Post-capture analysis returns actionable evidence

Post-capture findings SHALL include type, involved signals, capture-relative time window, supporting values, quality, confidence, explanation, analyzer/profile version, and bounded next-capture suggestions when evidence is insufficient.

#### Scenario: anomaly is supported

- **WHEN** an analysis finding is returned
- **THEN** its evidence can be retrieved through the capture query contract
- **AND** the result does not claim an unsupported root cause.

### Requirement: BLDC analysis profile is optional and evidence-based

Jlink-MCP SHALL keep `motor_bldc` optional and SHALL analyze current/speed tracking and Hall/encoder consistency only when required mapped signals and quality are present.

#### Scenario: BLDC signals are incomplete

- **WHEN** one BLDC check lacks required evidence
- **THEN** that check returns a quality warning
- **AND** independent supported checks may still run.

### Requirement: Analysis does not mutate hardware

Post-capture analysis SHALL use saved, bounded capture-query data only; it SHALL NOT connect to hardware, mutate raw evidence, write variables, control CPU state, flash, or start capture. Derived run metadata and findings MAY be written to `capture.db`.

#### Scenario: analysis is persisted

- **WHEN** `analysis_run` completes
- **THEN** raw sample and event BIN hashes remain unchanged.

## REMOVED Requirements

### Requirement: Experiment Records

**Reason**: The global experiment-store record is replaced by the JCAP capture package and normalized capture-query model.

**Migration**: Convert accepted historical fixtures offline when needed; do not keep a second runtime storage model.

### Requirement: Experiment Analysis Tool

**Reason**: `experiment_analyze` is replaced by bounded `analysis_run` over a JCAP capture/window.

**Migration**: Callers select `captureId`, time window, signals, and profile through `analysis_run`.

### Requirement: Experiment Comparison Tool

**Reason**: Cross-experiment comparison is outside the JCAP MVP and should not force retention of experiment-store.

**Migration**: Run deterministic analysis separately for two captures; add a future capture-comparison capability only with its own contract.
