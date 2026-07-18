## REMOVED Requirements

### Requirement: Raw capture artifacts are preserved
**Reason**: Raw preservation is replaced by the stronger JCAP authoritative sample/event BIN contract.
**Migration**: Preserve validated data under each `<captureId>.jcap/raw/` package.

### Requirement: Capture index uses project-local SQL
**Reason**: The global `.jlink-mcp/index.sqlite` model is replaced by per-capture `capture.db`.
**Migration**: Discover capture packages under the project and query each schema-versioned DB.

### Requirement: Capture index supports AI and UI queries
**Reason**: Query behavior moves to the `capture-query-analysis` capability.
**Migration**: Use the shared bounded capture query contract.

### Requirement: Time-series queries return bounded buckets
**Reason**: This contract is superseded by the more explicit bounded series requirement.
**Migration**: Use `capture_series` with required window, variable, point, byte, and time-unit bounds.

### Requirement: SQL schema has stable minimum tables
**Reason**: The old global schema does not model JCAP provenance, raw rebuild, lifecycle, or analysis runs.
**Migration**: Use the versioned `jcap-capture-store` schema.
