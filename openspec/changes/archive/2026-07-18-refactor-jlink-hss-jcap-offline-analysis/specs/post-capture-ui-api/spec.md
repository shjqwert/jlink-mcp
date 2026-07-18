## REMOVED Requirements

### Requirement: Local UI API serves saved captures
**Reason**: The old viewer-specific API is replaced by the shared capture query service.
**Migration**: Start the development UI with `npm run ui -- --project` or `--open` and use bounded query contracts.

### Requirement: Viewer lifecycle is controlled by MCP tools
**Reason**: `viewer_start/stop/status/open_capture` are not part of the new MCP surface.
**Migration**: Manage the local development UI through package scripts; MCP remains a data/query boundary.

### Requirement: UI timeline operations are data-backed
**Reason**: This behavior moves to the `offline-analysis-ui` and `capture-query-analysis` capabilities.
**Migration**: Use bounded series and event-window queries.

### Requirement: UI is post-capture only in MVP
**Reason**: This behavior is retained under the new offline UI capability rather than the old viewer API.
**Migration**: Follow `offline-analysis-ui`, which prohibits hardware controls and raw BIN parsing.
