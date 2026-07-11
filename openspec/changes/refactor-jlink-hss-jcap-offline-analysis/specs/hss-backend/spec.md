## ADDED Requirements

### Requirement: HSS uses one validated Windows x64 DLL path

The `jlink-hss` backend SHALL use the project's experimental adapter as its only supported HSS path for Windows x64 and `JLink_x64.dll`. It SHALL resolve the DLL in this order: explicit `--jlink-dll`, `JLINK_DLL_PATH`, SEGGER installation registry path, the directory of `JLink.exe` found on PATH, then common SEGGER installation directories. It SHALL NOT hard-code a machine-specific path or add cross-platform, 32-bit, or multi-DLL abstractions in the first version.

#### Scenario: validated DLL is resolved

- **GIVEN** the first matching DLL is x64 and its identity is validated
- **AND** required exports and `GetCaps` succeed
- **WHEN** HSS is probed
- **THEN** the single HSS service reports available capabilities
- **AND** capture provenance records DLL path/version/SHA-256 and adapter/helper versions and hashes.

#### Scenario: DLL is unusable

- **WHEN** no DLL is found, architecture is not x64, exports or `GetCaps` fail, or identity is unvalidated
- **THEN** HSS returns structured `unavailable`
- **AND** no Direct RTT, RSP, or external-import fallback starts automatically.

### Requirement: HSS semantic acceptance uses predictable evidence

HSS acceptance SHALL use an independently predictable monotonic counter, fixed-step sequence, or known waveform and SHALL verify decoded values, sample order, monotonic timebase, and dropped-sample flags rather than only proving that bytes were read.

#### Scenario: transport works but values are wrong

- **WHEN** samples arrive but any expected value, order, timebase, or dropped-sample indication is incorrect
- **THEN** semantic acceptance fails
- **AND** the DLL identity is not approved for the supported matrix.

## MODIFIED Requirements

### Requirement: HSS capture artifacts expose query and event hooks

Completed HSS captures SHALL expose JCAP raw sample segments, the raw event journal, DLL/helper/adapter provenance, target identity/source/confidence, variable definitions, quality, event markers, flag intervals, and bounded query/export hooks through `capture.db`.

#### Scenario: completed HSS capture indexed

- **WHEN** an HSS capture completes
- **THEN** its validated raw evidence remains under the `.jcap/raw` directory
- **AND** `capture.db` is atomically published for query consumers.

#### Scenario: database is rebuilt

- **GIVEN** `capture.db` is missing
- **WHEN** rebuild validates the raw sample and event files
- **THEN** capture metadata, variables, events, flags, quality, and indexes are reconstructed without JSON sidecars.

### Requirement: HSS capture planning enforces variable limits

HSS capture planning SHALL consume current Variable Catalog or Hot Variable references and validate requested scalar types, variable count, sample rate, duration, record bandwidth, target state, Artifact match, and segment bounds against capabilities reported by the validated adapter.

#### Scenario: capability is exceeded

- **WHEN** a plan exceeds a reported limit or contains an unsupported type
- **THEN** Jlink_MCP rejects it before hardware access
- **AND** returns structured lower-rate, fewer-variable, or supported-type alternatives.

#### Scenario: unverified read-only target

- **WHEN** a read-only plan uses `targetArtifactMatch: unverified`
- **THEN** the plan may proceed only with a persistent warning recorded in JCAP provenance.

#### Scenario: target mismatches

- **WHEN** a plan uses `targetArtifactMatch: mismatch`
- **THEN** capture is rejected before hardware access.

### Requirement: HSS variable writes support production scalar and fixed-array targets

HSS variable writes SHALL default to R3 and preserve allowlisted RAM scalar, fixed-array element, and fixed contiguous slice targets. Every plan SHALL include an operation plan and bind Artifact/layout/policy/session identity and TTL; execution SHALL enforce write budget and verified target identity, serialize through the capture owner, read back values, and append events to the authoritative raw event journal and audit log. An unverified target SHALL deny writes by default and MAY proceed only through an explicit R4 policy exception; a mismatch SHALL always reject the write.

#### Scenario: fixed array slice write accepted

- **GIVEN** policy allows a fixed RAM array slice and target identity is verified
- **WHEN** a valid R3 write plan executes
- **THEN** old, requested, and readback values are recorded
- **AND** the capture event is aligned to the common monotonic tick domain.

#### Scenario: stale or mismatched target is rejected

- **WHEN** Artifact/layout/policy/session identity is stale or `targetArtifactMatch` is `mismatch`
- **THEN** no target memory is written
- **AND** a structured rejection is audited.

## REMOVED Requirements

### Requirement: HSS requires explicit SDK configuration and adapter proof

**Reason**: The project does not depend on or claim support for the official SEGGER SDK; SDK configuration is not an HSS availability prerequisite.

**Migration**: Use the validated Windows x64 DLL resolution and identity contract defined above.
