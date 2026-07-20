# jcap-v1-store Specification

## Purpose
Define the authoritative four-file JCAP v1 package, Raw integrity, lifecycle, and atomic derived database rebuild.

## Requirements

### Requirement: JCAP v1 packages contain exactly four durable files

A terminal capture package SHALL use `formatVersion: 1` and contain only:

```text
<captureId>.jcap/
  capture.json
  raw/samples.bin
  raw/events.bin
  capture.db
```

Temporary files MAY exist only during atomic publication and SHALL be removed after success or failure. CSV and analysis exports SHALL remain outside the package.

#### Scenario: clean completed package
- **WHEN** a capture completes and finalization succeeds
- **THEN** its directory contains the four specified durable files and no export directory
- **AND** `capture.json` and `capture.db` describe the same capture ID and Raw identities.

#### Scenario: explicit CSV export
- **WHEN** `capture_export_csv` succeeds
- **THEN** it creates a bounded CSV under the owning `test-output/.../exports/` directory
- **AND** leaves the JCAP package file list unchanged.

### Requirement: Capture metadata is authoritative and atomically updated

`capture.json` SHALL contain format version, capture/Target/Probe/Artifact identity, variable descriptors, record size, timebase, lifecycle state, sample/quality counts, events identity, Raw byte counts, and Raw SHA-256 values. Active captures SHALL mark final hashes pending and update metadata by atomic replacement.

#### Scenario: active capture metadata
- **WHEN** HSS is actively appending Raw frames
- **THEN** `capture.json` reports `active`, current durable counts, and pending final hashes
- **AND** readers never observe partially written JSON.

#### Scenario: terminal metadata
- **WHEN** Raw writers close normally or through recovery
- **THEN** `capture.json` records final file byte counts and hashes
- **AND** later rebuild verifies them before publishing a DB.

### Requirement: Raw records are append-only and integrity checked

`raw/samples.bin` and `raw/events.bin` SHALL append independently framed records with kind, payload length, and payload integrity. Finalization and rebuild SHALL preserve Raw bytes and hashes.

#### Scenario: valid Raw rebuild
- **WHEN** `capture.db` is absent and both Raw files match `capture.json`
- **THEN** rebuild reads complete ordered records and publishes an equivalent index
- **AND** Raw hashes before and after are identical.

#### Scenario: truncated interrupted tail
- **WHEN** an interrupted writer leaves an incomplete final frame
- **THEN** recovery preserves the original Raw file, indexes only the complete validated prefix, and records tail offset/length diagnostics
- **AND** capture state remains `interrupted`.

#### Scenario: corruption before terminal tail
- **WHEN** Raw integrity fails in a way that prevents a trustworthy ordered prefix
- **THEN** the capture/index reports `failed`
- **AND** no DB is presented as ready.

### Requirement: Lifecycle and index status are independent

Capture lifecycle SHALL use `active`, `finalizing`, `completed`, `stopped`, `interrupted`, and `failed`. Index status SHALL independently report absent, building, ready, rebuild-required, or failed.

#### Scenario: automatic duration completion
- **WHEN** HSS reaches its requested duration and Raw closes cleanly
- **THEN** capture state becomes `completed`
- **AND** a ready DB may be published.

#### Scenario: explicit early stop
- **WHEN** the Agent calls `hss_stop` before requested duration
- **THEN** capture state becomes `stopped`
- **AND** clean Raw remains queryable after indexing.

#### Scenario: recover interrupted capture
- **WHEN** `hss_recover` produces a DB from a trustworthy complete Raw prefix
- **THEN** index status may become ready
- **AND** capture state remains `interrupted` rather than pretending completion.

### Requirement: Per-capture DB is derived and atomically published

`capture.db` SHALL preserve the existing schema version 1 tables and query-compatible row semantics. Rebuild SHALL create a temporary DB, use a transaction, run integrity check, fsync it, revalidate unchanged Raw identities, and atomically replace the final DB only after success.

#### Scenario: rebuild replaces a damaged DB
- **WHEN** Raw and metadata are valid but `capture.db` is missing or damaged
- **THEN** `capture_index_rebuild` constructs a new valid DB from metadata and Raw
- **AND** summary, series, and event-window results match the pre-damage results.

#### Scenario: temporary DB fails
- **WHEN** schema population, integrity check, fsync, or final Raw revalidation fails
- **THEN** the temporary DB is removed
- **AND** an existing valid `capture.db` is not overwritten.

### Requirement: JCAP v0 has no compatibility path

JCAP v1 readers SHALL reject experimental v0 packages and SHALL NOT migrate or guess missing `capture.json` metadata.

#### Scenario: old package selected
- **WHEN** a package lacks valid v1 `capture.json` or reports format version 0
- **THEN** query/rebuild returns `JCAP_VERSION_UNSUPPORTED`
- **AND** leaves the old package unchanged.
