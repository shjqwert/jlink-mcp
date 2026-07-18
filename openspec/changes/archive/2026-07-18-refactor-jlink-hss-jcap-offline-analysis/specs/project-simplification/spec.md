## ADDED Requirements

### Requirement: Replacement-first deletion is batched

Batch A SHALL remove Backend Router, Direct RTT Capture, External Import, legacy CaptureService, global capture index and old viewer lifecycle. Batch B SHALL remove OpenOCD, Black Magic Probe, Telnet Proxy, TraceAgent, Runtime Evidence, CodeGraph Bridge, `ai-debug-workflow` and dead docs/tests/scripts. Each completed batch SHALL run compile, affected tests, tool-catalog checking, import/reference scanning and HSS regression.

#### Scenario: a deletion batch finishes

- **WHEN** all named modules in one batch are removed after their replacements exist
- **THEN** the shared batch verification succeeds
- **AND** a per-module full hardware acceptance run is not required.

### Requirement: J-Link is the only production probe backend in this change

Jlink_MCP SHALL retain the generic `ProbeBackend` boundary but SHALL ship only `JLinkBackend` as the production probe implementation for this change.

#### Scenario: server creates probe backend

- **GIVEN** Jlink_MCP starts with its supported production configuration
- **WHEN** the probe backend is created
- **THEN** a J-Link backend is created
- **AND** OpenOCD and Black Magic are not accepted backend types.

### Requirement: Non-mainline modules are removed only after replacement

The implementation SHALL remove OpenOCD, Black Magic, Telnet Proxy, TraceAgent and legacy CaptureService implementation paths, and SHALL remove the capabilities `ai-debug-workflow`, `backend-benchmark`, `capture-backend-routing`, `capture-query-index`, `codegraph-runtime-bridge`, `direct-rtt-channel-backend`, and `post-capture-ui-api` after their replacements and required shared dependencies have been migrated.

#### Scenario: deletion gate

- **GIVEN** a module is scheduled for deletion
- **WHEN** its deletion batch begins
- **THEN** the replacement capability and dependency extraction are already complete
- **AND** compile and targeted regression tests pass after deletion.

### Requirement: Retained auxiliary debug tools remain discoverable

RTT, GDB, CPU control, Flash/Erase, and raw command tools SHALL remain registered and visible, with category and risk metadata that distinguish them from the HSS capture mainline. In particular, `halt`, `resume`, and `reset` SHALL remain formal auxiliary tools with their existing names, input schemas, and output contracts, SHALL execute through the J-Link main backend, and SHALL NOT depend on or be removed with a legacy backend or capture router.

#### Scenario: Agent lists tools

- **WHEN** an Agent lists MCP tools
- **THEN** retained auxiliary tools are present
- **AND** each indicates its category, risk, side effects, and recommended use.

#### Scenario: legacy routing is deleted

- **WHEN** backend and capture-router deletion completes
- **THEN** `halt`, `resume`, and `reset` remain registered with unchanged contracts
- **AND** their execution reaches the J-Link main backend directly.

### Requirement: SVD is out of implementation scope

This change SHALL NOT add partial SVD runtime functionality.

#### Scenario: implementation completes

- **WHEN** this change is accepted
- **THEN** no new SVD load/read/write runtime tool is required
- **AND** SVD remains a separately planned future capability.
