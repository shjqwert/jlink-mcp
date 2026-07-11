## ADDED Requirements

### Requirement: Capture queries use the index layer by default

Jlink_MCP SHALL provide capture list, summary, series, event-window, analysis, rebuild, and export operations without requiring the caller to parse raw BIN.

#### Scenario: Agent opens a saved capture

- **WHEN** `capture_summary` is called for a completed capture
- **THEN** the response includes variables, units, timing, backend, target, Artifact state, quality, events, flags, segments, and analysis availability
- **AND** no full raw file is returned.

### Requirement: Series responses are bounded and transient-preserving

`capture_series` SHALL require a bounded capture-relative time window, variable list and bucket count, enforce configured maximum points and response bytes, identify time units, and return buckets containing start/end, count, min, max, average, and last per selected variable.

#### Scenario: full capture overview

- **GIVEN** a long capture and a request for 1000 buckets
- **WHEN** series data is requested
- **THEN** at most the configured bounded response is returned
- **AND** bucket min/max preserve spikes that an average-only series would hide.

#### Scenario: narrow zoom

- **GIVEN** the caller narrows the time range
- **WHEN** series data is requested again
- **THEN** a finer level or relevant raw segment range is used
- **AND** unrelated capture ranges are not loaded into the caller.

### Requirement: Event-window queries align evidence with writes and faults

Jlink_MCP SHALL return selected variables, event metadata, flags, and samples/buckets around a specified event.

#### Scenario: variable write marker selected

- **GIVEN** a write event exists
- **WHEN** the caller requests 100 ms before and after the event
- **THEN** the response includes the event time, old/new/readback result, nearest sample, selected signals, and quality flags for that window.

### Requirement: Analysis is deterministic and read-only

`analysis_run` SHALL execute deterministic profiles against capture query data and SHALL not connect to hardware or mutate raw capture data.

#### Scenario: generic control analysis

- **GIVEN** command and feedback roles are mapped
- **WHEN** generic control analysis runs
- **THEN** supported step response, overshoot, settling, steady error, and saturation findings are returned with evidence windows and confidence.

### Requirement: Active captures are not presented as completed offline data

Jlink_MCP SHALL restrict active captures to status and bounded live-tail metadata. Completed-series, export, and analysis operations SHALL require a finalized query index.

#### Scenario: UI requests an active capture

- **GIVEN** capture finalization is incomplete
- **WHEN** a completed-series or analysis query is made
- **THEN** Jlink_MCP returns a structured `not_ready` state
- **AND** does not promise realtime UI streaming.
