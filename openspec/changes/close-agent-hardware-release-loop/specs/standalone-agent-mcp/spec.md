## MODIFIED Requirements

### Requirement: The Agent tool surface is exact and direct

The standalone server SHALL register exactly these 36 tools and no deprecated aliases:

`list_devices`, `target_configure`, `target_status`, `artifact_probe`, `symbol_search`, `symbol_resolve`, `read_variable`, `write_variable`, `read_memory`, `write_memory`, `core_register_access`, `peripheral_register_access`, `target_control`, `flash`, `erase`, `hss_start`, `hss_status`, `hss_stop`, `hss_recover`, `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `capture_export_csv`, `gdb_open`, `gdb_command`, `gdb_wait`, `gdb_backtrace`, `gdb_close`, `rtt_open`, `rtt_read`, `rtt_search`, `rtt_clear`, `rtt_close`, `diagnose_crash`, and `probe_command`.

Every listed tool SHALL have a concrete handler. The server SHALL NOT register a generic `NOT_IMPLEMENTED` fallback.

#### Scenario: enumerate tools
- **WHEN** a client requests the Tool List
- **THEN** the returned names equal the specified 36-name set
- **AND** approval-era, plan/execute, Hot Variable maintenance, HSS capability/plan, DB rebuild, snapshot, analysis, old register/control/GDB/RTT, direct RTT channel, extension-only, and viewer-lifecycle names are absent.

#### Scenario: exercise public handlers
- **WHEN** the surface consistency test invokes each public tool with its smallest schema-valid request or a controlled missing prerequisite
- **THEN** every response is produced by its concrete handler
- **AND** no response has error code `NOT_IMPLEMENTED`.

## ADDED Requirements

### Requirement: Agent instructions and Connector examples match the runtime

The active Codex Skill, Claude Code example, Codex example, README, and surface tests SHALL use the canonical exported Tool List and SHALL contain no removed Resource, approval workflow, plan/execute name, risk level, token, machine-specific path, or machine-specific Target default.

#### Scenario: clean checkout configuration
- **WHEN** a user copies the documented example for a clean checkout and supplies the checkout location required by the client
- **THEN** the client can start the packaged standalone stdio command
- **AND** device, Probe, Artifact, SVD, and flash facts remain unset until explicit `target_configure`.

#### Scenario: active guidance consistency scan
- **WHEN** CI scans active Agent instructions, MCP examples, README, and the runtime Tool List
- **THEN** every documented tool exists and every workflow-critical current tool is documented
- **AND** stale approval and removed tool names fail the check.

### Requirement: CI validates the current clean product path

The Windows CI workflow SHALL invoke only scripts present in `package.json` and SHALL validate clean install, build, lint, unit tests, standalone surface, active guidance consistency, legacy-control scanning, HSS Helper self-test, and packed-file contents.

#### Scenario: workflow command validation
- **WHEN** CI or a local test parses every `npm run` command in the workflow
- **THEN** each referenced package script exists
- **AND** removed MVP-era script names are absent.

#### Scenario: clean package smoke test
- **WHEN** the package is built and packed from a clean Windows checkout
- **THEN** its standalone MCP initializes and lists the exact 36-tool surface
- **AND** its packed files include the Helper required by `hss_start`.
