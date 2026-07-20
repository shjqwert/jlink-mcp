# artifact-symbol-variable-access Specification

## Purpose
Define bounded Artifact discovery and trustworthy typed symbol and variable access without hidden target state changes.

## Requirements

### Requirement: Artifact discovery is content-driven and bounded

`artifact_probe` SHALL scan within explicit bounds, classify files by content, distinguish typed debug Artifacts from flash inputs, and return bounded candidates without silent selection.

#### Scenario: supported debug Artifact
- **WHEN** an OUT, AXF, or ELF file has ELF content and readable debug information
- **THEN** it is a symbol-capable Artifact candidate
- **AND** its canonical path, format, size, hash, debug capabilities, and paired MAP candidates are returned.

#### Scenario: flash-only input
- **WHEN** a file has Intel HEX, SREC, or raw BIN content
- **THEN** it is classified only as a flash input
- **AND** it is never used for variable type/layout resolution.

#### Scenario: multiple candidates
- **WHEN** more than one candidate satisfies discovery
- **THEN** the tool returns `ARTIFACT_SELECTION_REQUIRED` with a bounded candidate list
- **AND** does not select by extension, name, timestamp, or directory order.

### Requirement: Typed symbols require trustworthy layout

Full variable resolution SHALL use ELF/DWARF type, size, scope, location, and member/array layout. A MAP entry alone SHALL remain an address/name candidate and SHALL NOT authorize typed write or symbol HSS.

#### Scenario: DWARF global scalar
- **WHEN** `symbol_resolve` targets a unique DWARF global scalar with a fixed address and supported type
- **THEN** it returns its logical identity, address, type, size, region, Artifact generation, and layout hash.

#### Scenario: MAP-only symbol
- **WHEN** a symbol exists only in MAP data without a trusted type and size
- **THEN** search may return it as a candidate
- **AND** resolution for typed write or HSS fails with `UNKNOWN_LAYOUT`.

#### Scenario: address conflict
- **WHEN** DWARF and MAP facts conflict for a selected symbol
- **THEN** resolution fails with structured conflicting evidence
- **AND** no hardware access occurs.

### Requirement: Supported selectors and scalar types are finite

Variable access SHALL support global/static scalars, fixed array elements, and nested fixed-layout structure members whose terminal type is `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, or `float32`.

It SHALL reject locals, pointer dereference, dynamic arrays, unions, C bitfields, 64-bit integers, double, enum/bool writes, multi-dimensional/dynamic slices, and unknown typedef layouts.

#### Scenario: fixed array element
- **WHEN** a selector names a valid element of a fixed DWARF array
- **THEN** its bounds, element offset, terminal type, address, and size are resolved
- **AND** the logical selector remains tied to the Artifact layout hash.

#### Scenario: nested structure member
- **WHEN** a selector names a supported nested fixed member
- **THEN** all member offsets are validated from DWARF
- **AND** the final address is derived without pointer traversal.

#### Scenario: unsupported selector
- **WHEN** a selector uses `->`, dereference, an out-of-range index, a bitfield, union, or dynamic layout
- **THEN** it fails before target access
- **AND** returns the unsupported construct and stage.

### Requirement: Artifact generation gates symbol operations

Each resolved reference SHALL contain Artifact generation and layout hash. Stale or mismatched references SHALL block all symbol-based operations. An unverified current generation SHALL allow warned `read_variable` but SHALL block `write_variable` and symbol HSS.

#### Scenario: unverified variable read
- **WHEN** the current layout is valid but target/Artifact match is unverified
- **THEN** `read_variable` may return the actual memory value with an `ARTIFACT_UNVERIFIED` warning
- **AND** it does not claim the symbol address is target-confirmed.

#### Scenario: unverified variable write
- **WHEN** `write_variable` is requested while match is unverified
- **THEN** it returns `ARTIFACT_NOT_VERIFIED`
- **AND** does not issue a write.

#### Scenario: stale reference
- **WHEN** an Artifact hash or mapped layout changes
- **THEN** prior references return `STALE_ARTIFACT_REFERENCE`
- **AND** no old address is silently reused.

### Requirement: Hot Variables persist logical identity, not trusted addresses

`hot_variable_add`, `hot_variable_list`, and `hot_variable_refresh` SHALL maintain project-specific logical names, requested types, Artifact/layout identity, and stale state across MCP restarts.

#### Scenario: Artifact changes
- **GIVEN** Hot Variables were resolved for one Artifact generation
- **WHEN** Target configuration selects a new generation
- **THEN** affected entries become stale
- **AND** their stored addresses cannot be used for target access.

#### Scenario: targeted refresh
- **WHEN** `hot_variable_refresh` names a subset of stale entries
- **THEN** only that subset is re-resolved against the current typed Artifact
- **AND** unresolved entries remain stale with individual errors.

### Requirement: Variable reads preserve target state

`read_variable` SHALL resolve the current typed layout, perform only the required bounded memory read, decode according to Artifact endianness/type, and return both bytes and typed value without implicit halt/reset.

#### Scenario: stable variable read while running
- **WHEN** a running target supports the required memory read
- **THEN** `read_variable` returns the observed bytes and typed value
- **AND** before/after running state is unchanged.

#### Scenario: read requires halt
- **WHEN** the backend cannot perform the requested read without halting
- **THEN** it returns `HALT_REQUIRED`
- **AND** does not issue a halt.

### Requirement: Structured writes share explicit verification options

`write_variable` and other structured write tools SHALL default to `captureOld=false`, `verify=false`, and `restore=false`. Successful default execution SHALL report `executed_unverified` and SHALL NOT claim the target value was confirmed.

#### Scenario: default variable write
- **WHEN** a verified writable RAM variable is written with default options
- **THEN** MCP encodes and issues the requested bytes
- **AND** performs no old-value read or readback.

#### Scenario: capture old and verify
- **WHEN** `captureOld=true` and `verify=true` are requested
- **THEN** the result includes old, requested, readback, encoded bytes, comparator, and pass/fail
- **AND** verification failure returns `ok=false` without fabricating success.

### Requirement: Verification comparators are deterministic

Verification SHALL support `exact`, `tolerance`, `masked`, and `observe` modes. Exact SHALL compare encoded bytes. Tolerance SHALL use `abs(actual-expected) <= absTolerance + relTolerance * abs(expected)`. Masked SHALL compare only selected mask bits. Observe SHALL pass if any bounded observation satisfies its nested comparator.

#### Scenario: exact volatile mismatch
- **WHEN** exact readback differs from requested encoded bytes
- **THEN** verification fails with both byte sequences
- **AND** does not reinterpret the result as a numeric near-match.

#### Scenario: bounded observe
- **WHEN** observe mode is requested with a valid duration and polling bound
- **THEN** it returns observation count, time range, first/last/min/max and match evidence
- **AND** a match does not claim the value persisted after the observation window.

### Requirement: Restore protects the known prior value

`restore=true` SHALL force a successful old-value read before the main write and a restore readback after the restore write. After a main write is issued, restoration SHALL be attempted even if main verification fails.

#### Scenario: old read fails
- **WHEN** the required old-value read fails
- **THEN** the operation returns `ok=false` and `writeIssued=false`
- **AND** no main write occurs.

#### Scenario: main verification fails but restore succeeds
- **WHEN** the main write was issued, main verification fails, and restore readback matches old bytes
- **THEN** the response reports final restoration success and main verification failure
- **AND** overall `ok` remains false.

#### Scenario: restore uncertain
- **WHEN** restore write or restore readback fails
- **THEN** the response sets `ok=false`, `writeIssued=true`, and `stateUnknown=true`
- **AND** preserves all successfully observed old/requested/readback/restore facts.
