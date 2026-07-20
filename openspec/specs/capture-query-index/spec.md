# capture-query-index Specification

## Purpose
Define the bounded per-capture SQL query layer derived from authoritative JCAP v1 metadata and Raw files.

## Requirements

### Requirement: Raw capture artifacts are preserved

Jlink-MCP SHALL preserve JCAP v1 `capture.json`, `raw/samples.bin`, and `raw/events.bin` as the authoritative source for every terminal or interrupted HSS capture. `capture.db` SHALL be a derived index.

#### Scenario: capture completed
- **WHEN** an HSS capture completes, stops, or is recovered
- **THEN** metadata records exact lifecycle, descriptors, timebase, quality, and Raw hashes
- **AND** Raw files remain unchanged during DB build and later query.

#### Scenario: index rebuild
- **WHEN** `capture.db` is missing or invalid and metadata/Raw are trustworthy
- **THEN** `capture_index_rebuild` derives a new DB from those three source files
- **AND** verifies Raw hash stability before publication.

### Requirement: Capture index uses project-local SQL

Jlink-MCP SHALL maintain one `capture.db` inside each JCAP package under ignored repository-local `test-output/`. The DB SHALL be a derived cache, be rebuildable from `capture.json` plus Raw, use schema version 1, and never accept an arbitrary caller-provided index path.

#### Scenario: terminal capture indexed
- **WHEN** terminal Raw and metadata validate
- **THEN** the package's `capture.db` records provenance, Raw sources, samples, sample values, and events
- **AND** no project-global `.jlink-mcp/index.sqlite` is required.

#### Scenario: DB rebuild fails
- **WHEN** a temporary DB fails population, integrity, fsync, or Raw revalidation
- **THEN** it is removed
- **AND** any existing valid final DB remains unchanged.

### Requirement: Capture index supports AI and UI queries

Jlink-MCP SHALL expose `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `capture_index_rebuild`, and explicit `capture_export_csv`. Queries SHALL use `captureId`, require no hardware, and return lifecycle/index readiness distinctly.

#### Scenario: list captures
- **WHEN** `capture_list` is called with a valid bounded page
- **THEN** it finds packages in normal and run-scoped capture directories and returns capture ID, owning run if any, state, index status, time range, variables, quality, and provenance summary
- **AND** duplicate capture IDs cause an ambiguity error.

#### Scenario: query capture summary
- **WHEN** `capture_summary` selects a known v1 capture
- **THEN** it returns bounded provenance, variables, sample/event counts, time range, quality, Raw identities, and readiness
- **AND** does not load or return all samples.

### Requirement: Time-series queries return bounded buckets

`capture_series` SHALL accept at most 32 variables, 4096 buckets, 65,536 variable-bucket points, an explicit inclusive `startTick`/`endTick`, and an 8 MiB response limit. Each returned bucket SHALL contain bounds, count, min, max, average, last, and combined status flags.

#### Scenario: downsampled query
- **WHEN** a valid request selects variables, tick range, and bucket count
- **THEN** it returns only bounded aggregate buckets for that range
- **AND** preserves capture-relative nanosecond tick semantics.

#### Scenario: bound exceeded
- **WHEN** requested variables, buckets, product, range, or encoded response exceeds a limit
- **THEN** it returns `JCAP_BOUNDS`
- **AND** does not return an unbounded partial dataset.

#### Scenario: event window query
- **WHEN** `capture_event_window` selects a valid event, at most 16 variables, at most 2048 buckets, and at most 60 seconds before/after
- **THEN** it returns the event, at most 128 related events, nearest sample, and bounded series within 4 MiB
- **AND** the window uses the event's stored tick while retaining its operation interval.

### Requirement: SQL schema has stable minimum tables

The per-capture schema version 1 SHALL include `meta`, `provenance`, `raw_sources`, `samples`, `sample_values`, and `events`, with indexes needed for variable/tick windows. Existing Offline UI-compatible column and query-result semantics SHALL remain stable in this change.

#### Scenario: required schema available
- **WHEN** a DB is built successfully
- **THEN** all minimum tables, primary keys, tick ordering keys, Raw source hashes, and query indexes exist
- **AND** `PRAGMA integrity_check` returns `ok` before publication.

#### Scenario: explicit export bound
- **WHEN** `capture_export_csv` is requested
- **THEN** it exports at most 1,000,000 sample-value rows outside the package
- **AND** a larger export fails before creating a final CSV.
