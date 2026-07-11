# capture-query-index Specification

## Purpose
Define the SQL-backed local capture index used by AI workflow tools, query APIs, and the post-capture viewer.

## Requirements

### Requirement: Raw capture artifacts are preserved

Jlink-MCP SHALL preserve raw capture data and capture metadata for every completed HSS capture.

#### Scenario: capture completed

- **WHEN** an HSS capture completes
- **THEN** Jlink-MCP stores raw sample data, capture metadata, variable definitions, timing metadata, events, flags, and analysis references under the capture directory.

#### Scenario: index rebuild

- **GIVEN** the query index is missing or stale
- **WHEN** Jlink-MCP rebuilds the index for a capture
- **THEN** it derives indexed summaries from the preserved raw capture artifacts.

### Requirement: Capture index uses project-local SQL

Jlink-MCP SHALL maintain a project-local SQL index at `.jlink-mcp/index.sqlite`.

The SQL index SHALL:

- be treated as a derived cache, not the raw source of truth;
- be rebuildable from `.jlink-mcp/captures/*/capture.json` and sidecars;
- store capture metadata, variables, events, flag intervals, exports, analysis references, and bounded bucket summaries;
- track a metadata hash or equivalent stale marker for each capture;
- reject caller-provided index paths outside the project root.

#### Scenario: completed capture indexed

- **GIVEN** an HSS capture completes successfully or stops with terminal metadata
- **WHEN** indexing runs
- **THEN** `.jlink-mcp/index.sqlite` records the capture, variables, events, flags, exports, and summary fields
- **AND** raw capture files remain unchanged.

#### Scenario: stale index rebuilt

- **GIVEN** a capture metadata file has changed since it was indexed
- **WHEN** `capture_index_rebuild` runs
- **THEN** Jlink-MCP refreshes the SQL rows for that capture from raw artifacts
- **AND** updates the stored stale marker.

### Requirement: Capture index supports AI and UI queries

Jlink-MCP SHALL maintain a local SQL query layer that can list captures and return summary, variable, event, flag, and time-range metadata without reading full raw data into the caller.

#### Scenario: list captures

- **WHEN** a caller requests saved captures
- **THEN** Jlink-MCP returns capture identifiers, timestamps, duration, variable count, backend, target metadata, analysis status, and SQL stale status.

#### Scenario: query capture summary

- **GIVEN** a saved capture exists
- **WHEN** a caller requests its summary
- **THEN** Jlink-MCP returns variables, units if known, sample ranges, min/max/mean where available, events, flag intervals, exports, and available analysis artifacts.

### Requirement: Time-series queries return bounded buckets

Jlink-MCP SHALL expose time-series data as bounded buckets for selected variables and time windows.

#### Scenario: downsampled query

- **GIVEN** a caller requests variables, a time window, and bucket count
- **WHEN** Jlink-MCP serves the series
- **THEN** it returns buckets containing time range, min, max, average, and last value per variable.

#### Scenario: narrow query

- **GIVEN** a caller narrows the time window
- **WHEN** Jlink-MCP serves the series
- **THEN** the response is computed for that narrower window without changing the raw capture data.

### Requirement: SQL schema has stable minimum tables

Jlink-MCP SHALL maintain a minimum SQL schema for MVP-C capture lookup and viewer queries.

The minimum schema SHALL represent:

- captures;
- capture variables;
- capture events;
- capture flags;
- capture exports;
- capture buckets.

#### Scenario: capture list fields available

- **GIVEN** at least one terminal capture has been indexed
- **WHEN** `capture_index_list` is called
- **THEN** each row includes capture id, created time, session name, profile, state, backend, sample count, rate, duration, quality statuses, metadata file, artifact file, map file, updated time, and stale marker.

#### Scenario: event window query uses SQL and raw artifacts

- **GIVEN** a capture has a variable write event
- **WHEN** `capture_index_query_event_window` is called
- **THEN** Jlink-MCP returns the event, before/after summaries, deltas, related flags, and any raw-artifact warning needed for correctness.
