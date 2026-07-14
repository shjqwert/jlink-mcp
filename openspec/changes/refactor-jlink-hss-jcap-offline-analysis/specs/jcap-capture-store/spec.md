## ADDED Requirements

### Requirement: JCAP v0 is experimental and self-describing

JCAP v0 SHALL freeze only the package roles `capture.db`, `raw/samples.bin`, `raw/events.bin`, and optional on-demand `export/`. Each raw record SHALL carry a self-describing envelope containing `formatVersion=0`, experimental status, record kind, payload encoding, payload length, and payload checksum. Fixed header/footer sizes, byte offsets, CRC/TLV algorithms, scalar codes, and SQLite schema SHALL be deferred to a separate v1 change.

#### Scenario: a v0 package is opened

- **WHEN** a reader encounters a supported v0 envelope
- **THEN** it validates the declared version, kind, length, and checksum before accepting the payload
- **AND** it does not treat the current experimental encoding as a frozen v1 byte layout.

### Requirement: Raw samples and events are authoritative and rebuildable

`raw/samples.bin` SHALL contain self-describing sample payloads with increasing sample index, nondecreasing capture-relative tick, status flags, and named numeric values. `raw/events.bin` SHALL contain provenance plus lifecycle, reset, write, quality, and fault payloads in the same time domain. Provenance SHALL include capture, target, runtime, script mode/cache identity, and reset/stabilization facts required to rebuild the index without JSON/JSONL/CSV sidecars.

Readers SHALL accept only the contiguous length/checksum-valid prefix. A truncated tail or invalid envelope SHALL stop parsing, preserve every earlier record, and produce an explicit corrupt-suffix diagnostic. Rebuild SHALL never resynchronize after damage or modify raw bytes.

#### Scenario: raw ends during a record

- **WHEN** the final record is incomplete or fails its declared length/checksum
- **THEN** rebuild indexes only the earlier valid prefix
- **AND** records the damaged offset and suffix length without editing raw.

#### Scenario: script and reset provenance round-trips

- **WHEN** a capture using a trusted cached script and reset-before-capture is rebuilt
- **THEN** the same script identity, reset binding/result, target, runtime, and stabilization facts are available through the index
- **AND** Agent and UI consumers do not parse raw directly.

### Requirement: Capture lifecycle and index publication are independent

`captureState` SHALL be `planned | active | finalizing | completed | stopped | recoverable | failed`. `indexStatus` SHALL be `absent | building | ready | rebuild_required | failed`. A pre-start failure MAY transition from `planned` directly to `failed` with a valid event journal and no sample records. Terminal raw without a valid source-bound database SHALL report `rebuild_required`; index failure SHALL NOT rewrite a terminal capture state or append a new raw event.

#### Scenario: HSS fails before sampling

- **WHEN** trusted script selection, reset, stabilization, or HSS Start fails
- **THEN** raw records `planned -> failed` plus the structured failure and provenance
- **AND** summary remains rebuildable with zero samples.

#### Scenario: a terminal database is deleted

- **WHEN** terminal raw remains but `capture.db` is absent
- **THEN** `captureState` remains terminal and `indexStatus` becomes `rebuild_required`
- **AND** rebuilding adds no raw bytes.

### Requirement: SQLite rebuild and publication are source-bound and atomic

The selected adapter SHALL be `sqlite3@5.1.7` and SHALL support Node 18, standalone MCP, the local loopback query service, and the packaged Windows x64 installation. Rebuild SHALL create tables and indexes inside a transaction, store full final raw SHA-256 values plus validated-prefix lengths and corruption diagnostics, run `PRAGMA integrity_check`, close SQLite, fsync `capture.db.tmp`, revalidate raw identities, and atomically rename the temporary file to `capture.db` in the same directory.

The packaged installation SHALL retain the `sqlite3` JavaScript loader, Windows x64 native binding, `bindings`, and `file-uri-to-path`. Extension and standalone bundles SHALL treat `sqlite3` as the same external native dependency rather than bundling a second adapter.

#### Scenario: the initial database is rebuilt

- **WHEN** unchanged final raw is indexed repeatedly
- **THEN** integrity, source hashes, capture/events/provenance, and bounded query results are equivalent
- **AND** raw hashes remain unchanged and no `capture.db.tmp` remains after publication.

#### Scenario: raw changes after publication

- **WHEN** any final raw SHA-256 differs from the value stored in `capture.db`
- **THEN** the index reports `rebuild_required` or `failed`
- **AND** normal completed-series queries are withheld.

### Requirement: Sampling does not create SQLite or default exports

The HSS sampling loop SHALL append raw records only. SQLite rebuild SHALL occur after raw closure or in a separate non-sampling process. CSV SHALL be created only by an explicit export request, and capture completion SHALL NOT create JSON, JSONL, or CSV default artifacts.

#### Scenario: no export is requested

- **WHEN** a capture is finalized and indexed
- **THEN** the package contains raw plus `capture.db`
- **AND** no CSV, JSON, or JSONL output is created.

### Requirement: One golden corpus proves the v0 data path

The TypeScript raw writer, decoder, SQLite rebuild, and bounded query layer SHALL share one deterministic v0 corpus covering round-trip, script/reset provenance, pre-start failure, terminal event ordering, truncated tail, corrupt suffix, rebuild equivalence, and raw immutability. Hardware execution SHALL NOT be required for this corpus.

#### Scenario: the golden corpus is rebuilt twice

- **WHEN** the same raw corpus is indexed initially and after database removal or replacement
- **THEN** critical summary, series, event, provenance, integrity, and source-hash results are equivalent
- **AND** the raw bytes are identical before and after both builds.

### Requirement: Historical formats remain offline-only

JCAP v0 SHALL NOT add a live compatibility reader for legacy capture BIN/JSON/JSONL formats or a fallback to Direct RTT, RSP, or external import. A future v1 byte freeze and any one-time offline converter SHALL be separate changes.

#### Scenario: legacy capture input is presented

- **WHEN** a live JCAP query or rebuild receives a legacy format
- **THEN** it rejects the unsupported input
- **AND** does not route through a fallback capture backend.
