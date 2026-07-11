## ADDED Requirements

### Requirement: The UI is a post-capture analysis surface

The first UI SHALL be a local loopback Web application that opens and analyzes saved JCAP captures without connecting to target hardware. It SHALL NOT require VS Code integration or use a VS Code webview.

#### Scenario: UI opens offline

- **GIVEN** a completed `.jcap` package and no connected J-Link
- **WHEN** the UI is started with `--project` or `--open`
- **THEN** capture navigation, summary, timeline, events, quality, and analysis are available.

#### Scenario: hardware controls are inspected

- **WHEN** the offline UI is rendered
- **THEN** it contains no connect-probe, detect-artifact, start-capture, stop-capture, variable-write, flash, reset, or raw-command controls.

### Requirement: The UI follows the accepted analysis layout

The UI SHALL implement the key structure shown in `assets/ui/jlink-mcp-offline-analysis-wireframe.png`.

Project/session navigation SHALL treat session as optional capture-group metadata and SHALL NOT require an MCP-owned AI workflow or live hardware session.

#### Scenario: capture is selected

- **WHEN** a user selects a capture
- **THEN** the left pane shows project/session/capture navigation
- **AND** the center shows time-series and a horizontal brush
- **AND** the right pane shows channel and Y-axis controls
- **AND** the bottom pane shows events, audit facts, and quality markers.

### Requirement: Variables support independent visual channels

Each visible variable SHALL support visibility, color, line style, unit, scale, offset, auto-fit, reset, and independent/shared axis assignment.

#### Scenario: values have different magnitudes

- **GIVEN** current, speed, voltage, and state variables share a time window
- **WHEN** they are displayed
- **THEN** each may use an independent Y-axis scale
- **AND** adjusting one selected variable's Y scale does not rescale unrelated variables.

#### Scenario: selected variable is vertically zoomed

- **WHEN** the user invokes Y+ or Y- for one channel
- **THEN** only that channel's scale changes
- **AND** its scale and offset remain visible to avoid misleading comparison.

### Requirement: Timeline interaction is query-backed

Horizontal brush, zoom, variable selection, and event selection SHALL request bounded data from the local loopback capture query API. The browser SHALL NOT parse raw BIN.

#### Scenario: brush window changes

- **WHEN** the user narrows the brush range
- **THEN** the UI requests that time window at an appropriate bucket resolution
- **AND** does not load the entire raw capture into the renderer.

### Requirement: UI preferences are separate from capture evidence

The UI SHALL store colors, line styles, axis assignment, scale, offset, brush, and other view preferences outside authoritative JCAP raw evidence.

#### Scenario: user changes colors and scales

- **WHEN** visual preferences are saved
- **THEN** they are stored as UI-local preferences keyed by capture/variable
- **AND** raw BIN evidence is not modified.
