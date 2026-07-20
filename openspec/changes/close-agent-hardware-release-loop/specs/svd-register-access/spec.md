## MODIFIED Requirements

### Requirement: Peripheral register access requires an explicit validated SVD

`peripheral_register_access` SHALL accept bounded `read`, `read_many`, and `write` actions and resolve only `PERIPHERAL.REGISTER[.FIELD]` selectors from the SVD configured for the request's Target generation. MCP SHALL NOT guess a layout or silently fall back to raw memory.

#### Scenario: SVD unavailable
- **WHEN** `peripheral_register_access` is called without a configured valid SVD
- **THEN** it returns `SVD_NOT_CONFIGURED`
- **AND** performs no target access.

#### Scenario: Agent uses raw memory explicitly
- **GIVEN** no SVD is available
- **WHEN** the Agent separately calls `read_memory` or `write_memory` with an explicit address and width
- **THEN** that raw operation follows raw-memory rules
- **AND** is not reported as SVD register coverage.

### Requirement: Peripheral reads obey SVD width and access semantics

`peripheral_register_access` read actions SHALL derive address, width, field bit range, and readable access from SVD. `read_many` SHALL accept a bounded selector list and SHALL NOT mean CPU-core registers.

#### Scenario: read register field
- **WHEN** a readable field selector resolves uniquely with `action=read`
- **THEN** MCP reads the containing register at its declared width
- **AND** returns raw register bytes/value plus the extracted field value and SVD identity.

#### Scenario: read-action or unreadable register
- **WHEN** SVD declares write-only or read-action semantics that make a normal read unsafe or destructive
- **THEN** MCP rejects the structured read with the semantic reason
- **AND** performs no read.

### Requirement: SVD field writes require provably safe semantics

`peripheral_register_access(action=write)` SHALL permit whole-register or field writes only when declared access, width, bit range, reset/layout information, and required read-modify-write behavior are internally consistent and safe.

It SHALL reject write-only field RMW, read-action registers, W1C/W1S or other special modified-write semantics not explicitly implemented, missing access semantics, overlapping fields, and layout conflicts.

#### Scenario: safe field read-modify-write
- **WHEN** a readable/writable normal field has a valid mask in a normal readable/writable register
- **THEN** MCP may read the register, replace only masked field bits, and issue one declared-width write
- **AND** reports the implicit RMW read as a requested correctness step.

#### Scenario: W1C field
- **WHEN** a field uses one-to-clear semantics
- **THEN** `peripheral_register_access(action=write)` rejects the generic field write
- **AND** recommends an explicit whole-register or raw-memory operation only if the Agent understands the device semantics.

#### Scenario: default SVD write
- **WHEN** an allowed whole-register write executes with default options
- **THEN** it reports `executed_unverified`
- **AND** performs no verification readback unless requested.
