## MODIFIED Requirements

### Requirement: Raw capture artifacts are preserved

Jlink-MCP SHALL preserve JCAP v1 `capture.json`, `raw/samples.bin`, and `raw/events.bin` as the authoritative source for every terminal or interrupted HSS capture. `capture.db` SHALL be a derived index rebuilt only by internal validation/recovery logic.

#### Scenario: capture completed
- **WHEN** an HSS capture completes, stops, or is recovered
- **THEN** metadata records exact lifecycle, descriptors, timebase, quality, and Raw hashes
- **AND** Raw files remain unchanged during DB build and later query.

#### Scenario: DB-backed query finds a missing or invalid index
- **WHEN** a DB-backed query selects trustworthy metadata/Raw but `capture.db` is missing or invalid
- **THEN** MCP atomically derives a new DB from those three source files before executing the query
- **AND** verifies Raw hash stability and reports `indexRebuilt=true`.

### Requirement: Capture index supports AI and UI queries

Jlink-MCP SHALL expose only `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, and explicit `capture_export_csv`. Requests SHALL use `captureId` where a single capture is selected, require no target hardware, return lifecycle/index readiness distinctly, and never expose a public rebuild tool.

#### Scenario: list captures
- **WHEN** `capture_list` is called with a valid bounded page
- **THEN** it finds packages in normal and run-scoped capture directories and returns capture ID, owning run if any, state, index status, time range, variables, quality, and provenance summary
- **AND** duplicate capture IDs cause an ambiguity error.

#### Scenario: query capture summary
- **WHEN** `capture_summary` selects a known v1 capture
- **THEN** it returns bounded provenance, variables, sample/event counts, time range, quality, Raw identities, readiness, and any disclosed internal rebuild fact
- **AND** does not load or return all samples.

#### Scenario: internal rebuild cannot prove Raw integrity
- **WHEN** a DB-backed query finds a missing/damaged DB but metadata or Raw integrity is invalid
- **THEN** it returns the structured readiness/rebuild failure
- **AND** does not publish a replacement DB or return fabricated query data.
