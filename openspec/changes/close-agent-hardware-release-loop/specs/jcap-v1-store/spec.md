## MODIFIED Requirements

### Requirement: Per-capture DB is derived and atomically published

`capture.db` SHALL preserve the existing schema version 1 tables and query-compatible row semantics. Internal finalization/rebuild SHALL create a temporary DB, use a transaction, run integrity check, fsync it, revalidate unchanged Raw identities, and atomically replace the final DB only after success. No public tool SHALL expose rebuild as a maintenance action.

#### Scenario: query rebuilds a damaged DB
- **WHEN** a DB-backed capture query finds valid metadata/Raw but `capture.db` is missing or damaged
- **THEN** internal rebuild constructs and publishes a new valid DB before rerunning the bounded query
- **AND** summary, series, and event-window results match the pre-damage semantics and disclose that rebuild occurred.

#### Scenario: temporary DB fails
- **WHEN** schema population, integrity check, fsync, or final Raw revalidation fails
- **THEN** the temporary DB is removed
- **AND** an existing valid `capture.db` is not overwritten.

#### Scenario: Raw changes during rebuild
- **WHEN** either Raw identity changes between initial validation and publication
- **THEN** the replacement DB is not published
- **AND** the capture remains explicitly not ready or interrupted without changing Raw bytes.
