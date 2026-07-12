## ADDED Requirements

### Requirement: Capture queries use the index layer by default

Jlink_MCP SHALL expose `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `analysis_run`, `capture_index_rebuild`, and `capture_export` through the derived/indexed query layer. Agent and UI callers SHALL not parse raw BIN. The local loopback Web UI SHALL expose no probe, capture-control, write, flash, reset, or raw-command operation.

#### Scenario: Agent opens a saved capture

- **WHEN** `capture_summary` is called for a completed capture
- **THEN** the response includes `captureState`, `indexStatus`, variables, units, timing, backend, target, Artifact match/evidence generation, DLL/helper/adapter/ScriptFile identities, trusted script approval and selection results, reset/stabilization evidence, quality, events, flags, segments, and analysis availability
- **AND** no full raw file is returned.

### Requirement: Capture listing and summaries are bounded

`capture_list` SHALL inspect only `.jcap` names plus fixed raw headers/tails, use a default limit of 50 and maximum limit of 100, accept a cursor of at most 1024 bytes, and return at most 256 KiB encoded. `capture_summary` SHALL return at most 1 MiB encoded. Bounds SHALL be rejected explicitly rather than silently expanded.

#### Scenario: listing exceeds a fixed bound

- **WHEN** a caller requests more than 100 captures, supplies a cursor longer than 1024 bytes, or would exceed the response-byte limit
- **THEN** Jlink_MCP returns a structured bounds error
- **AND** does not scan or return unbounded capture data.

### Requirement: Series responses are bounded and transient-preserving

`capture_series` SHALL require an explicit capture-relative window expressed as decimal `u64` tick strings or integer milliseconds converted to ticks. It SHALL identify the returned timebase and unit and return bucket start/end, count, min, max, average, last, and quality flags per selected variable. A request SHALL contain 1..32 variables and 1..4096 buckets, `bucketCount * variableCount` SHALL be at most 65536 points, and the encoded response SHALL be at most 8 MiB. Violations SHALL be rejected rather than clamped or expanded.

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

#### Scenario: series request exceeds a product or byte bound

- **WHEN** variable count, bucket count, their product, time window, or encoded response exceeds a v1 bound
- **THEN** Jlink_MCP returns a structured bounds error
- **AND** does not silently change the requested resolution.

### Requirement: Event-window queries align evidence with writes and faults

`capture_event_window` SHALL require an event UUID and return selected variables, event metadata, flags, and indexed samples/buckets around that event. `beforeMs` and `afterMs` SHALL each be `0..60000`, variables SHALL be at most 16, buckets at most 2048, related events at most 128, and the encoded response at most 4 MiB. It SHALL read only indexed segment ranges and reject bound violations explicitly.

For a pre-capture target-control reset event, the window SHALL return the reset binding/result/audit reference and the linked lifecycle `active` event. It MAY return no earlier samples because pre-reset observations are not part of the new capture. The first returned post-stability sample SHALL remain sample index 0; the query layer SHALL NOT trim a prefix to make the semantic oracle pass.

#### Scenario: variable write marker selected

- **GIVEN** a write event exists
- **WHEN** the caller requests 100 ms before and after the event
- **THEN** the response includes the event time, old/new/readback result, nearest sample, selected signals, and quality flags for that window.

The event's QPC-relative tick SHALL be the time source; nearest sample SHALL be supplemental alignment metadata and SHALL NOT replace the event tick.

### Requirement: Analysis is deterministic and read-only

`analysis_run` SHALL execute deterministic profiles against capture query data and SHALL not connect to hardware or mutate raw capture data.

#### Scenario: generic control analysis

- **GIVEN** command and feedback roles are mapped
- **WHEN** generic control analysis runs
- **THEN** supported step response, overshoot, settling, steady error, and saturation findings are returned with evidence windows and confidence.

Analysis SHALL write only derived rows in `capture.db`. Missing signals or insufficient quality SHALL produce warnings rather than invented findings.

### Requirement: Active captures are not presented as completed offline data

Jlink_MCP SHALL report `captureState` and `indexStatus` independently. `planned` and `active` captures SHALL expose status, reset/stabilization progress, structured failure facts, and bounded live-tail metadata when samples exist. `finalizing` SHALL expose progress and structured `not_ready`. `completed` and clean `stopped` describe terminal raw capture but SHALL allow full query, export, and analysis only when `indexStatus=ready`. `indexStatus=building|failed|rebuild_required|absent` SHALL return structured `not_ready` plus rebuild/failure facts rather than pretending that capture lifecycle implies a valid DB. `recoverable` SHALL allow summary, diagnostics, raw validation, and rebuild but not normal series. `failed` SHALL allow summary and diagnostics and SHALL expose series only for explicitly partial, validated DB ranges.

#### Scenario: UI requests an active capture

- **GIVEN** capture finalization is incomplete
- **WHEN** a completed-series or analysis query is made
- **THEN** Jlink_MCP returns a structured `not_ready` state
- **AND** does not promise realtime UI streaming.

#### Scenario: raw capture is complete but index is missing

- **GIVEN** `captureState=completed|stopped` and terminal raw is immutable
- **WHEN** no valid source-bound `capture.db` exists
- **THEN** the query reports `indexStatus=rebuild_required` and offers `capture_index_rebuild`
- **AND** it does not append an event or otherwise modify raw.

### Requirement: Rebuild preserves the raw authority boundary

`capture_index_rebuild` SHALL reconstruct derived data only from the byte-valid prefixes of the self-describing sample segments and event journal, retain explicit corruption diagnostics, and never modify or delete raw. No query or rebuild path SHALL depend on capture JSON, JSONL, CSV, a legacy sidecar, external import, Direct RTT, or RSP fallback.

#### Scenario: capture.db is stale or absent

- **GIVEN** the raw headers, descriptors, records, and event frames contain a validated prefix
- **WHEN** `capture_index_rebuild` runs
- **THEN** `capture.db` is recreated with schema version and source hashes from that prefix
- **AND** UI and Agent queries resume through the same bounded index contract
- **AND** the UI never reads raw BIN directly.
