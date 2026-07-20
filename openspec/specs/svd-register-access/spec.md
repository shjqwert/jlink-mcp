# svd-register-access Specification

## Purpose
Define exact SVD-bound peripheral register access without guessed layouts or hidden raw-memory fallback.

## Requirements

### Requirement: Peripheral register access requires an explicit validated SVD

`read_register`, `read_registers`, and `write_register` SHALL resolve only `PERIPHERAL.REGISTER[.FIELD]` selectors from the SVD configured for the request's Target generation. MCP SHALL NOT guess a layout or silently fall back to raw memory.

#### Scenario: SVD unavailable
- **WHEN** a peripheral-register tool is called without a configured valid SVD
- **THEN** it returns `SVD_NOT_CONFIGURED`
- **AND** performs no target access.

#### Scenario: Agent uses raw memory explicitly
- **GIVEN** no SVD is available
- **WHEN** the Agent separately calls `read_memory` or `write_memory` with an explicit address and width
- **THEN** that raw operation follows raw-memory rules
- **AND** is not reported as SVD register coverage.

### Requirement: SVD identity belongs to Target generation

SVD content SHALL be canonicalized, parsed, validated, hashed, and bound to the Target generation. Reconfiguration or content change SHALL invalidate prior register references.

#### Scenario: SVD file changes at same path
- **WHEN** the configured SVD hash changes
- **THEN** old register/field references are stale
- **AND** the Agent must explicitly call `target_configure` before new peripheral access.

#### Scenario: selector is ambiguous or missing
- **WHEN** an SVD selector cannot resolve exactly one peripheral/register/field
- **THEN** the tool returns a bounded candidate/error response
- **AND** does not guess by case, prefix, or address.

### Requirement: Peripheral reads obey SVD width and access semantics

`read_register` and `read_registers` SHALL derive address, width, field bit range, and readable access from SVD. Bulk reads SHALL accept a bounded list of selectors and SHALL NOT mean CPU-core registers.

#### Scenario: read register field
- **WHEN** a readable field selector resolves uniquely
- **THEN** MCP reads the containing register at its declared width
- **AND** returns raw register bytes/value plus the extracted field value and SVD identity.

#### Scenario: read-action or unreadable register
- **WHEN** SVD declares write-only or read-action semantics that make a normal read unsafe or destructive
- **THEN** MCP rejects the structured read with the semantic reason
- **AND** performs no read.

### Requirement: SVD field writes require provably safe semantics

`write_register` SHALL permit whole-register or field writes only when declared access, width, bit range, reset/layout information, and required read-modify-write behavior are internally consistent and safe.

It SHALL reject write-only field RMW, read-action registers, W1C/W1S or other special modified-write semantics not explicitly implemented, missing access semantics, overlapping fields, and layout conflicts.

#### Scenario: safe field read-modify-write
- **WHEN** a readable/writable normal field has a valid mask in a normal readable/writable register
- **THEN** MCP may read the register, replace only masked field bits, and issue one declared-width write
- **AND** reports the implicit RMW read as a requested correctness step.

#### Scenario: W1C field
- **WHEN** a field uses one-to-clear semantics
- **THEN** `write_register` rejects the generic field write
- **AND** recommends an explicit whole-register or raw-memory operation only if the Agent understands the device semantics.

#### Scenario: default SVD write
- **WHEN** an allowed whole-register write executes with default options
- **THEN** it reports `executed_unverified`
- **AND** performs no verification readback unless requested.

### Requirement: Peripheral writes report unknown system-level effects

Even when register-level bytes are known, Jlink-MCP SHALL report system-level effects as unknown unless directly observed. A structured SVD write SHALL not automatically invalidate Artifact verification solely because it is a peripheral write.

#### Scenario: control register write succeeds
- **WHEN** a validated peripheral write is issued
- **THEN** the response reports its exact selector/address/bytes and register-level verification state
- **AND** does not claim the wider MCU behavior was side-effect-free.
