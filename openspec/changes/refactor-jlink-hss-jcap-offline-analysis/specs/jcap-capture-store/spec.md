## ADDED Requirements

### Requirement: Completed captures use a JCAP directory package

Jlink_MCP SHALL store each capture under `<projectRoot>/.jlink-mcp/captures/<captureId>.jcap/`, where `captureId` is a lowercase, hyphenated RFC-4122 UUID-v4. The runtime package SHALL contain `raw/events.bin`, sample segments named consecutively from `raw/capture_0001.bin` through at most `raw/capture_9999.bin` after HSS Start succeeds, derived `capture.db` when `indexStatus=ready`, and `export/*.csv` only after explicit export. A capture that fails during trusted script selection, R3 reset, stabilization, or HSS Start MAY contain a valid event journal and no sample segment. A terminal capture whose index build failed SHALL retain complete immutable raw with `indexStatus=failed` in the current operation and `rebuild_required` after restart until a valid DB is published. Binary occurrences of `captureId` SHALL be the UUID's exact 16 RFC-4122 network-order bytes.

#### Scenario: capture finalizes

- **WHEN** an HSS capture completes or stops
- **THEN** the package contains validated terminal raw and either a valid source-bound `capture.db` or a structured rebuild-required index state
- **AND** no `capture.json`, `plan.json`, JSONL, CSV, or sidecar is required by capture, rebuild, query, or analysis at runtime.

### Requirement: JCAP v1 uses one frozen primitive encoding

All JCAP v1 multibyte integers SHALL be unsigned little-endian. The endian marker SHALL be `0x01020304`. UUIDs SHALL be 16 RFC-4122 network-order bytes and SHA-256 values SHALL be 32 raw digest bytes rather than hexadecimal text. An all-zero MAP hash SHALL mean no MAP is present and an all-zero audit digest SHALL mean no audit reference is present. Hash algorithm `1` SHALL mean SHA-256. CRC algorithm `1` SHALL mean CRC-32/ISO-HDLC/IEEE with `refin=true`, `refout=true`, reflected polynomial `0xEDB88320` (normal `0x04C11DB7`), init `0xFFFFFFFF`, xorout `0xFFFFFFFF`, stored as little-endian `u32`.

#### Scenario: a reader encounters an unknown primitive version

- **WHEN** a raw header declares an unsupported major version, endian marker, hash algorithm, CRC algorithm, descriptor format, scalar type version, or status-bits version
- **THEN** the reader rejects that raw unit as unsupported
- **AND** does not reinterpret it using host-native layout.

### Requirement: Raw segments are authoritative and self-describing

Each sample segment SHALL contain all capture, target, Artifact, runtime, variable, timebase, and integrity information needed to rebuild `capture.db` without any non-raw sidecar. `capture.db` SHALL be derived data with a schema version and source hashes; raw sample segments and `raw/events.bin` SHALL be authoritative.

#### Scenario: database is deleted

- **GIVEN** valid raw segments remain but `capture.db` is missing
- **WHEN** `capture_index_rebuild` runs
- **THEN** variable-column mapping, capture identity, segment ranges, timing, quality, and rebuildable events are restored
- **AND** capture-local lifecycle, target-control reset, write, flag, and fault events are restored from `raw/events.bin`
- **AND** raw evidence is not modified.

### Requirement: The sample segment header is byte-exact

Each sample segment SHALL begin with the following exact 512-byte header. Ranges and offsets are hexadecimal; all reserved bytes and non-v1 flags SHALL be zero.

| Offset | Width | JCAP v1 field |
|---|---:|---|
| `000` | 8 | magic bytes `4A 43 41 50 53 45 47 00` (`JCAPSEG\0`) |
| `008` | 2 | major = `1` |
| `00A` | 2 | minor = `0` |
| `00C` | 2 | headerBytes = `512` |
| `00E` | 2 | descriptorFormat = `1` |
| `010` | 4 | endian = `0x01020304` |
| `014` | 4 | flags = `0` |
| `018` | 4 | segmentIndex = `1..9999` |
| `01C` | 4 | statusBitsVersion = `1` |
| `020` | 4 | scalarTypesVersion = `1` |
| `024` | 4 | variableCount = `1..64` |
| `028` | 4 | descriptorOffset = `512` |
| `02C` | 4 | descriptorBytes |
| `030` | 4 | descriptorCrc32 over the entire descriptor block |
| `034` | 4 | recordBytes = `28 + 4 * variableCount` |
| `038` | 4 | recordDataBytes = `24 + 4 * variableCount` |
| `03C` | 4 | crcAlgorithm = `1` |
| `040` | 8 | timebaseHz = `1_000_000_000` |
| `048` | 8 | timeOriginTick = `0` |
| `050` | 8 | segmentStartSampleIndex |
| `058` | 8 | reserved = `0` |
| `060` | 16 | captureUuid |
| `070` | 32 | artifactSha256 |
| `090` | 32 | mapSha256; all zero when absent |
| `0B0` | 32 | symbolLayoutSha256 |
| `0D0` | 32 | dllSha256 |
| `0F0` | 32 | helperSha256 |
| `110` | 32 | adapterSha256 |
| `130` | 1 | targetArtifactMatch: `0` unverified, `1` verified, `2` mismatch |
| `131` | 1 | targetSource: `1` explicit, `2` supported project configuration |
| `132` | 1 | rawValueEncoding = `1` |
| `133` | 1 | reserved = `0` |
| `134` | 4 | hashAlgorithm = `1` |
| `138..1FB` | 196 | reserved zero bytes |
| `1FC` | 4 | headerCrc32 over bytes `[000,1FC)` |

The producer SHALL reject `targetArtifactMatch=2`. It SHALL write and sync the header and descriptor block before appending the first sample record.

#### Scenario: a header identity or CRC differs

- **WHEN** magic, version, constants, reserved bytes, segment index/name, UUID, timebase, descriptor CRC, or header CRC does not validate
- **THEN** the segment is reported as corrupt or unsupported
- **AND** records from that segment are not silently accepted.

### Requirement: The descriptor block is byte-exact and bounded

The descriptor block SHALL start at file offset `512`. Its relative prefix SHALL be `u32 blockBytes@000`, `u16 version=1@004`, `u16 entryCount=5+variableCount@006`, `u32 flags=0@008`, and `u32 reserved=0@00C`. Each following entry SHALL be `u16 kind`, `u16 flags=0`, `u32 payloadBytes`, exactly `payloadBytes` of payload, then zero padding to a 4-byte boundary. `blockBytes` SHALL include the 16-byte prefix, entries, and padding; the header's descriptor CRC SHALL cover exactly those `blockBytes`.

Entries SHALL appear once in the exact order CAPTURE (`kind=1`), TARGET (`2`), ARTIFACT (`3`), RUNTIME (`4`), SCRIPT (`6`), then VARIABLE (`5`) entries sorted by ascending `variableId`. V1 readers SHALL reject unknown kinds. Payloads SHALL be:

- CAPTURE: `u64 createdUnixNs` (`0` absent), `u16 sessionBytes`, `u16 groupBytes`, then session and group strings.
- TARGET: `u8 interface` (`1` SWD, `2` JTAG), `u8 source`, `u16 reserved=0`, `u32 speedKhz`, `u64 serial` (`0` absent), four `u16` byte lengths for targetId, requested device, resolved device, and config source, then those strings in that order.
- ARTIFACT: `u8 format` (`1` ELF, `2` OUT, `3` AXF), `u8 resolver` (`1` elf-dwarf, `2` iar-map, `3` mixed), `u16 flags` (bit 0 means MAP present), two `u16` byte lengths for artifact path and MAP path, then those strings.
- RUNTIME: `u8 os=1` (Windows), `u8 arch=1` (x64), `u16 reserved=0`, seven `u16` byte lengths for DLL path, DLL version, DLL resolution source, helper path, helper version, adapter path, and adapter version, then those strings.
- SCRIPT: `u16 flags` (bit 0 trusted approval validated, bit 1 no-default-fallback enforced), `u16 pathBytes`, `u32 getCapsSelectionReturnCode`, `u32 captureSelectionReturnCode`, `scriptSha256[32]`, `approvalSha256[32]`, then the effective canonical ScriptFile path. A completed/stopped capture SHALL set both flags and both return codes SHALL be `0`.
- VARIABLE: `u32 variableId`, `u8 physicalType`, `u8 logicalKind`, `u16 reserved=0`, `u32 targetAddress`, four `u16` byte lengths for qualified name, member path, display name, and unit, then those strings.

Strings SHALL be exact UTF-8 bytes with no NUL and no normalization. `blockBytes` SHALL be at most 1 MiB, `entryCount` at most 69, a path at most 4096 bytes, a target/device/version/identity string at most 512 bytes, session or group at most 256 bytes, and unit at most 64 bytes.

The SCRIPT descriptor is a pre-implementation re-freeze of JCAP v1 descriptor format 1. The fixed 512-byte header, sample records, footer, CRC algorithms, scalar codes and status bits remain unchanged. No released JCAP v1 writer/reader exists; any draft fixture using the earlier four-plus-variable descriptor count SHALL be rejected or converted offline rather than supported by a live dual-format path.

#### Scenario: the descriptor block exceeds a bound

- **WHEN** descriptor count, byte size, string length, order, padding, flags, or CRC violates the v1 contract
- **THEN** capture is rejected before sample append
- **AND** no partial descriptor-dependent capture is published.

### Requirement: Sample records preserve raw scalar bits and quality

For `N=variableCount`, every record SHALL be `u64 sampleIndex@0`, `u64 tick@8`, `u32 statusFlags@16`, `u32 reserved=0@20`, `u32 rawValue[N]@24`, and `u32 recordCrc32@24+4*N`. The record CRC SHALL cover bytes `[0,24+4*N)` and the total record size SHALL be `28+4*N`.

`sampleIndex` SHALL strictly increase across segments; a gap SHALL set status bit 4 `dropped_before_this_sample`. `tick` SHALL be nondecreasing operation-relative nanoseconds calculated with integer arithmetic as `floor((qpcNow-qpcEpoch)*1_000_000_000/qpcFrequency)`, never `Date.now()` or sample-rate estimation. For `resetBeforeCapture`, `qpcEpoch` SHALL be established before the `planned` event and reset; events and samples SHALL share it. The first post-stability sample SHALL use `sampleIndex=0`, MAY have a positive tick, and no pre-reset observation SHALL be emitted as a sample record.

Physical type codes SHALL be `1=u8`, `2=i8`, `3=u16`, `4=i16`, `5=u32`, `6=i32`, and `7=f32`. Logical kinds SHALL be `0=integer`, `1=enum`, and `2=boolean`; boolean SHALL use an unsigned physical type and zero SHALL mean false. One- and two-byte values SHALL occupy the low 8 or 16 bits with upper bits zero; signed values SHALL decode as two's complement; `u32`, `i32`, and IEEE-754 binary32 SHALL preserve all 32 bits. All other widths/types, pointers, bitfields, dynamic arrays, and float64 SHALL be rejected.

Status-bits version 1 SHALL define bit 0 `valid`, 1 `read_error`, 2 `timeout`, 3 `overflow`, 4 `dropped_before_this_sample`, 5 `target_halted`, 6 `write_nearby`, 7 `write_in_progress`, and 8 `backend_busy`. Writers SHALL zero bits 9..31; readers SHALL preserve and report unknown bits rather than assigning v1 meaning.

#### Scenario: a sample has a bad full-record CRC

- **WHEN** a parser encounters a complete record whose CRC is invalid
- **THEN** parsing stops before that record and the remaining suffix is reported corrupt
- **AND** the parser does not resynchronize or synthesize samples.

### Requirement: Segment closure and rollover are byte-exact

A cleanly closed segment SHALL append exactly one 64-byte footer: magic bytes `4A 43 41 50 45 4E 44 00` (`JCAPEND\0`) at `000`, `u16 version=1@008`, `u16 bytes=64@00A`, `u32 segmentIndex@00C`, `u64 sampleCount@010`, `u64 firstSampleIndex@018`, `u64 lastSampleIndex@020`, `u64 firstTick@028`, `u64 lastTick@030`, `u32 recordsCrc32@038`, and `u32 footerCrc32@03C`. `recordsCrc32` SHALL cover all complete record bytes including each record CRC; `footerCrc32` SHALL cover footer bytes `[000,03C)`.

Each segment SHALL be at most 128 MiB including its footer. Before a record would exceed that limit, the writer SHALL close and sync the current segment, create and sync the next self-describing segment, then append a segment-rollover event.

#### Scenario: capture crashes during a record or close

- **WHEN** the final bytes are shorter than `recordBytes`, a valid final footer is absent, or a footer does not leave an integral record area
- **THEN** the reader accepts only the preceding CRC-valid record prefix
- **AND** reports `partial_tail_bytes`, missing/bad footer, or corrupt range as applicable
- **AND** never rewrites raw, resynchronizes after corruption, or silently fills a sample-index gap.

### Requirement: The event journal header and frames are byte-exact

`raw/events.bin` SHALL begin with this exact 256-byte header: magic bytes `4A 43 41 50 45 56 54 00` (`JCAPEVT\0`) at `000`, `u16 major=1@008`, `u16 minor=0@00A`, `u16 headerBytes=256@00C`, `u16 frameVersion=1@00E`, `u32 endian=0x01020304@010`, `u32 flags=0@014`, `u32 crcAlgorithm=1@018`, `u32 reserved=0@01C`, `u64 timebaseHz=1_000_000_000@020`, `u64 timeOriginTick=0@028`, `captureUuid[16]@030`, `u64 createdUnixNs@040` (`0` absent), zero bytes `048..0FB`, and `u32 headerCrc32@0FC` covering `[000,0FC)`.

Each frame SHALL use this relative layout: `u32 magic=ASCII EVT1@000`, `u16 version=1@004`, `u16 headerBytes=96@006`, `u32 flags@008` (bit 0 means audit digest present), `u32 frameBytes=align8(96+payloadBytes+4)@00C`, `eventUuid[16]@010`, `u64 tick@020`, `u16 type@028`, `u16 payloadEncoding=1@02A`, `u16 payloadVersion=1@02C`, `u16 reserved=0@02E`, `u32 payloadBytes@030`, `u32 payloadCrc32@034`, `auditDigest[32]@038`, `u32 headerCrc32@058` covering `[000,058)`, and `u32 reserved=0@05C`. The payload SHALL start at `060`, be followed by zero padding, and end with a final `u32 frameCrc32` covering `[000,frameBytes-4)`.

The audit digest SHALL be all zero exactly when flag bit 0 is clear. Event UUIDs SHALL be UUID-v4 values. Payloads SHALL be at most 65536 bytes and frames SHALL be between 104 and 65640 bytes inclusive. Header, payload, and frame CRCs SHALL use algorithm 1; the payload CRC SHALL cover only the declared payload bytes. A frame SHALL become visible only after the final frame CRC validates.

#### Scenario: event append is interrupted

- **WHEN** the journal ends in an incomplete frame or a frame fails size, reserved-field, UUID, payload, header, or final CRC validation
- **THEN** that frame and its suffix are ignored and reported
- **AND** every earlier valid frame remains rebuildable.

### Requirement: Event payload TLV and event types are byte-exact

Payload encoding 1 SHALL be a sequence of at most 32 unique fields. Each field SHALL be `u16 fieldId`, `u8 wireType`, `u8 flags=0`, `u32 valueBytes`, exactly `valueBytes` of value, then zero padding to a 4-byte boundary. Wire types SHALL be `1=u8`, `2=u16`, `3=u32`, `4=u64`, `5=i64`, `6=bool` (one byte, `0` or `1`), `7=UTF-8`, `8=UUID` (16 bytes), `9=SHA256` (32 bytes), and `10=bytes`.

Event type and field contracts SHALL be:

- type `1` lifecycle: required `0001 state` (`u8`: planned=1, active=2, finalizing=3, completed=4, stopped=5, recoverable=6, failed=7); optional `0002 reasonCode` (`u32`), `0003 reasonText` (UTF-8), `0004 triggerEventUuid` (UUID), `0005 resetBeforeCapture` (bool), `0006 stabilizationElapsedMs` (`u32`), `0007 stabilizationCheckCount` (`u32`), and `0008 stabilityPolicySha256` (SHA256). For a reset-before-capture run, the `active` event is the capture-start event and SHALL link the successful reset event through `0004`.
- type `2` variable_write: required `0101 targetLogicalId` (UTF-8), `0102 address` (`u32`), `0103 physicalType` (`u8`), `0104 writeKind` (`u8`), `0105 result` (`u8`), `0106 startTick` (`u64`), `0107 endTick` (`u64`), and `0108 nearestSampleIndex` (`u64`); scalar writes use `0109 oldRaw`, `010A newRaw`, and `010B readbackRaw` (`u32`); non-scalar writes use `010C byteCount` (`u32`) and value digests; `0110 policySha256` and `0111 layoutSha256` use SHA256.
- type `3` quality_interval: required `0201 mask` (`u32`), `0202 startTick` (`u64`), `0203 endTick` (`u64`), and `0204 reason` (UTF-8); its mask is ORed onto samples in the interval.
- type `4` fault: required `0301 code` (`u32`) and `0302 message` (UTF-8), with optional `0303 segmentIndex` (`u32`) and `0304 sampleIndex` (`u64`).
- type `5` segment_rollover: required `0401 previousSegmentIndex` and `0402 nextSegmentIndex` (`u32`), with optional `0403 lastSampleIndex` (`u64`).
- type `6` target_control: required `0501 operation` (`u8`: halt=1, resume=2, reset=3), `0502 result` (`u8`: succeeded=1, rejected=2, failed=3), `0503 startTick` (`u64`), `0504 endTick` (`u64`), `0505 beforeState` (`u8`: unknown=0, running=1, halted=2), `0506 afterState` (same enum), `0507 operationDigest` (SHA256), `0508 targetId` (UTF-8), `0509 artifactSha256`, `050A layoutSha256`, `050B policySha256` (SHA256), `050C sessionUuid` (UUID), `050D planExpiresUnixNs` (`u64`), and `050E resetBeforeCapture` (bool); optional `050F reason` is UTF-8. Its frame audit digest SHALL reference the append-safe R3 audit record.

The frame audit digest SHALL reference the separate project-level append-safe audit entry and SHALL not copy that audit as mutable capture truth.

#### Scenario: a payload uses an unknown or duplicate field

- **WHEN** a v1 payload contains a duplicate field ID, unknown required event type, invalid wire width, nonzero field flags, bad padding, or more than 32 fields
- **THEN** the frame is rejected and reported
- **AND** prior valid frames remain available.

### Requirement: Capture lifecycle controls query eligibility

JCAP SHALL expose separate `captureState` and `indexStatus` values. `captureState` SHALL be `planned`, `active`, `finalizing`, `completed`, `stopped`, `recoverable`, or `failed`; it describes authoritative raw capture lifecycle. `indexStatus` SHALL be `absent`, `building`, `ready`, `rebuild_required`, or `failed`; it describes only the derived index and SHALL NOT be encoded by appending a post-terminal raw event.

The event journal SHALL begin with `planned` at tick 0. Allowed raw transitions SHALL be `planned -> active|failed`, `active -> finalizing|recoverable|failed`, `finalizing -> completed|stopped|recoverable|failed`, and `recoverable -> finalizing|failed`. During reset-before-capture, the target-control reset event occurs while `planned`; `active` SHALL be appended only after reset, bounded stabilization and HSS Start succeed. A clean user stop SHALL pass through `finalizing` before `stopped`. Once `completed`, `stopped`, or `failed` is appended and synced, the event journal SHALL be closed and no raw byte SHALL be mutated.

`indexStatus` SHALL be derived from the running finalizer and index evidence: `absent` before a terminal raw set exists, `building` while `capture.db.tmp` is being built, `ready` only when `capture.db` passes schema/integrity/source-hash checks, `failed` for the current failed build result, and `rebuild_required` after restart whenever terminal raw exists without a valid matching DB. Index build failure SHALL NOT rewrite a terminal `captureState` or append another raw event.

#### Scenario: reset or stabilization fails before sampling

- **WHEN** trusted script validation, the R3 reset, target-state observation, identity revalidation, stabilization, or HSS Start fails
- **THEN** the journal records the structured target-control/lifecycle failure and transitions from `planned` to `failed`
- **AND** no sample segment or `active` event is required
- **AND** capture summary and audit evidence remain rebuildable from `raw/events.bin`.

#### Scenario: helper exits with complete raw records

- **WHEN** capture cannot complete normal finalization
- **THEN** the package is marked `recoverable`
- **AND** rebuild is allowed without deleting raw evidence.

#### Scenario: finalization succeeds

- **WHEN** capture closes normally
- **THEN** the service closes and syncs every sample segment, appends and syncs `finalizing`, validates the complete raw prefix, appends and syncs `completed` or clean `stopped`, then closes `raw/events.bin`
- **AND** only after raw is immutable sets `indexStatus=building`, builds `capture.db.tmp` from the final raw set, runs DB integrity and all source-hash checks, syncs and atomically renames it in the same directory to `capture.db`
- **AND** the resulting `indexStatus` is `ready` and rebuilding from the unchanged raw yields equivalent capture/events/quality/provenance data.

#### Scenario: index build fails after raw terminal state

- **GIVEN** `completed`, `stopped`, or `failed` has been appended and the raw journal is closed
- **WHEN** DB build, validation, sync, or atomic rename fails
- **THEN** raw remains immutable and the current operation reports `indexStatus=failed`
- **AND** a later process reports `rebuild_required` and may rebuild from the same final raw without adding a lifecycle event.

#### Scenario: finalization or rebuild sees corruption

- **WHEN** pre-terminal validation finds a raw suffix or range that cannot be validated
- **THEN** the capture becomes or remains `recoverable` instead of appending a false terminal event
- **AND** recovery/rebuild includes only validated prefixes and explicit corrupt-range diagnostics without editing or deleting raw.

#### Scenario: corruption is discovered after terminal closure

- **GIVEN** a terminal event has been synced and raw is closed
- **WHEN** a later index build or rebuild detects corruption or source-hash drift
- **THEN** Jlink_MCP does not rewrite the terminal `captureState` or append raw
- **AND** reports `indexStatus=failed|rebuild_required` plus explicit corruption diagnostics and withholds normal full-series queries.

### Requirement: Sampling does not write SQLite or CSV

The HSS sampling loop SHALL append raw records only and SHALL not perform DB bucket generation, CSV formatting, or large metadata serialization.

#### Scenario: high-rate capture is active

- **WHEN** samples are received
- **THEN** records are appended to the active raw segment
- **AND** database finalization runs only after raw capture closes or in a separate non-sampling process.

### Requirement: Capture finalization is atomic

Jlink_MCP SHALL close terminal raw before building, validating, syncing and atomically publishing `capture.db` from `capture.db.tmp`. A published DB SHALL bind the hashes of that final raw set, including the terminal event frame, and no raw append SHALL follow publication.

#### Scenario: finalizer crashes

- **GIVEN** raw capture data has closed
- **WHEN** DB finalization fails before atomic rename
- **THEN** raw data remains available
- **AND** the package reports failed/rebuild-required index status without changing its terminal raw capture state.

### Requirement: JCAP implementations share byte-golden vectors

Before native capture writes real HSS data, the implementation SHALL define one shared byte-golden corpus for the 512-byte header, descriptor ordering including SCRIPT, sample records, footer, event header/frames/TLV, CRCs, rollover, truncated tails and corrupt suffixes. The native/C++ writer, TypeScript decoder and SQLite rebuild path SHALL all consume or verify the same corpus in that order: golden vectors, writer, decoder, rebuild, then real HSS integration. Draft or historical bytes MAY be converted once offline but SHALL NOT create a live dual-format reader or writer.

#### Scenario: native and TypeScript layouts diverge

- **WHEN** any writer, decoder, or rebuild implementation produces or interprets bytes differently from the shared golden corpus
- **THEN** the JCAP implementation gate fails before real HSS integration
- **AND** the discrepancy is not hidden by a compatibility fallback.

### Requirement: SQLite runtime selection is a prerequisite gate

The implementation SHALL select and verify one SQLite adapter compatible with supported Node 18, standalone MCP, local loopback Web, and packaging environments before implementing the JCAP database path.

#### Scenario: candidate adapter is evaluated

- **WHEN** the phase-zero runtime spike runs
- **THEN** schema creation, transactions, integrity checking, atomic finalization, and packaged loading are demonstrated
- **AND** no unsupported runtime assumption becomes part of the storage contract.

The adapter choice and schema SHALL NOT alter the frozen raw byte contract. JCAP v1 SHALL remain limited to Windows x64 and Node 18 and SHALL not add provider or cross-platform abstractions. Project support for the DLL adapter SHALL not claim an official SEGGER SDK contract, and capture SHALL not automatically fall back to Direct RTT, RSP, or external import.

### Requirement: CSV is generated on demand

CSV SHALL be an export artifact, not a default capture artifact.

#### Scenario: no export requested

- **WHEN** a capture completes
- **THEN** no CSV file is created.

#### Scenario: CSV export requested

- **WHEN** `capture_export` is invoked
- **THEN** the selected variables and time range are written under `export/`
- **AND** existing exports are not silently overwritten.

### Requirement: Historical capture formats are offline-only inputs

Jlink_MCP SHALL NOT retain a long-term runtime compatibility path for historical BIN/JSON/JSONL capture formats. If an accepted test fixture requires migration, a one-time offline converter MAY produce JCAP input and SHALL remain outside the capture runtime.

#### Scenario: historical fixture is required

- **WHEN** a legacy fixture is used by a regression test
- **THEN** it is converted offline before JCAP query or analysis
- **AND** live capture does not write or read the legacy sidecar format.
