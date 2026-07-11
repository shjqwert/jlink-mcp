# post-capture-ui-api Specification

## Purpose
Define the post-capture local viewer API for browsing SQL-indexed captures and inspecting HSS timeline data without requiring target hardware.

## Requirements

### Requirement: Local UI API serves saved captures

Jlink-MCP SHALL provide local post-capture APIs that allow a UI to browse saved captures, inspect one capture, and load timeline data after capture completion.

#### Scenario: UI opens capture list

- **WHEN** the UI requests the capture list
- **THEN** Jlink-MCP returns saved captures from the SQL capture index without requiring target hardware to be connected.

#### Scenario: UI opens capture detail

- **GIVEN** a saved capture exists
- **WHEN** the UI requests capture detail
- **THEN** Jlink-MCP returns capture summary, variables, events, flags, exports, and analysis status.

### Requirement: Viewer lifecycle is controlled by MCP tools

Jlink-MCP SHALL expose MCP tools that start, stop, report, and open the local post-capture viewer.

#### Scenario: viewer starts

- **WHEN** `viewer_start` is called
- **THEN** Jlink-MCP starts a local viewer server bound to localhost
- **AND** returns port, base URL, SQL index path, and current status.

#### Scenario: viewer opens capture

- **GIVEN** a capture exists in `.jlink-mcp/index.sqlite`
- **WHEN** `viewer_open_capture` is called with `captureId`
- **THEN** Jlink-MCP returns a URL that opens that capture's detail page.

### Requirement: UI timeline operations are data-backed

The UI API SHALL support timeline zoom, variable selection, write-event markers, and vertical-scale data needs through query parameters and returned metadata.

#### Scenario: timeline zoom

- **GIVEN** the UI requests a selected time window
- **WHEN** Jlink-MCP returns series data
- **THEN** the data covers only that time window
- **AND** includes bucket min/max values needed to render transients.

#### Scenario: variable selection

- **GIVEN** the UI requests a subset of variables
- **WHEN** Jlink-MCP returns series data
- **THEN** only the requested variables are included
- **AND** omitted variables remain available for later requests.

#### Scenario: write markers

- **GIVEN** a capture contains variable write events
- **WHEN** the UI requests events for the capture
- **THEN** Jlink-MCP returns event timestamps, variable names, old values if available, new values, status, retry count, and readback status.

### Requirement: UI is post-capture only in MVP

The first UI API version SHALL serve completed captures and SHALL NOT require realtime streaming.

#### Scenario: active capture requested

- **GIVEN** a capture is still running
- **WHEN** the UI requests completed time-series data for that capture
- **THEN** Jlink-MCP returns a structured not-ready response
- **AND** does not expose partial realtime streaming as an MVP guarantee.
