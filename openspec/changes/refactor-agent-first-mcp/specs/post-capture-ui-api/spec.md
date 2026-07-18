## MODIFIED Requirements

### Requirement: Local UI API serves saved captures

The existing separate Offline UI SHALL be able to browse terminal JCAP v1 captures and inspect one capture through the compatible per-capture `capture.db` schema without target hardware. UI source modification and UI acceptance are outside this change.

#### Scenario: UI is pointed at saved captures
- **WHEN** the unchanged Offline UI process is given a test-output capture root it already supports
- **THEN** it may read saved per-capture DB data without requiring target hardware
- **AND** MCP does not start, stop, or open the UI.

#### Scenario: DB contract remains compatible
- **WHEN** JCAP v1 finalization or rebuild publishes `capture.db`
- **THEN** the existing schema version 1 tables/columns used by current query and plotting code remain available
- **AND** no UI pass result is claimed by this change.

### Requirement: UI timeline operations are data-backed

The per-capture DB and bounded query layer SHALL retain timeline buckets, variable selection, write-event markers, and vertical-scale min/max/average/last data needed by the existing Offline UI.

#### Scenario: timeline range query
- **WHEN** a consumer requests a selected tick window and variable subset through the compatible query layer
- **THEN** returned buckets cover only that range and subset
- **AND** include min/max values needed to preserve transients.

#### Scenario: write marker
- **WHEN** a capture contains a variable-write event
- **THEN** its DB event includes operation interval, selector, old/requested/readback/restore fields when requested, verification state, and neighboring sample references
- **AND** unrequested optional values remain explicit null/not-requested values.

## REMOVED Requirements

### Requirement: Viewer lifecycle is controlled by MCP tools
**Reason**: The exact Agent MCP surface has no viewer lifecycle tools, and Offline UI remains an independent script.
**Migration**: Start or stop the Offline UI through its separate local command and point it at JCAP v1 data.
