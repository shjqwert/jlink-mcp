## ADDED Requirements

### Requirement: Standalone stdio is the only MCP entry

Jlink-MCP SHALL expose one `jlink-mcp` stdio server entry and SHALL NOT require VS Code APIs at build time or runtime.

#### Scenario: start outside VS Code
- **WHEN** an Agent starts the packaged `jlink-mcp` command in a normal Node.js process
- **THEN** the MCP server starts without loading or stubbing the `vscode` module
- **AND** all registered tools are available without a VS Code Extension.

#### Scenario: no alternate MCP transport
- **WHEN** the package is built
- **THEN** it contains no HTTP or SSE MCP server entry
- **AND** the Offline UI remains a separate non-MCP script.

### Requirement: The Agent tool surface is exact and direct

The standalone server SHALL register exactly these 57 tools and no deprecated aliases:

`list_devices`, `target_configure`, `target_status`, `artifact_probe`, `symbol_search`, `symbol_resolve`, `hot_variable_add`, `hot_variable_list`, `hot_variable_refresh`, `read_variable`, `write_variable`, `read_core_register`, `read_core_registers`, `write_core_register`, `read_register`, `read_registers`, `write_register`, `halt`, `resume`, `reset`, `reset_halt`, `read_memory`, `write_memory`, `flash`, `erase`, `gdb_command`, `probe_command`, `hss_capability`, `hss_plan`, `hss_start`, `hss_status`, `hss_stop`, `hss_recover`, `capture_list`, `capture_summary`, `capture_series`, `capture_event_window`, `capture_index_rebuild`, `capture_export_csv`, `snapshot`, `diagnose_crash`, `gdb_server_start`, `gdb_server_stop`, `gdb_server_status`, `gdb_connect`, `gdb_wait`, `gdb_backtrace`, `gdb_disconnect`, `rtt_connect`, `rtt_disconnect`, `rtt_read`, `rtt_search`, `rtt_clear`, `rtt_channel_list`, `rtt_channel_read`, `analysis_profiles`, and `analysis_run`.

#### Scenario: enumerate tools
- **WHEN** an MCP client requests the tool list
- **THEN** the returned names equal the specified 57-name set
- **AND** plan-token, extension-only, viewer-lifecycle, `gdb_load`, and old register aliases are absent.

### Requirement: Approval and risk control planes do not execute

Jlink-MCP SHALL NOT implement R0-R5 classification, policy allowlists, Approval Broker IPC/CLI, challenge IDs, nonces, approval tokens, replay/consume state, approved helper hashes, or approval-only plan/execute tools.

#### Scenario: direct destructive operation schema
- **WHEN** a client inspects `flash`, `erase`, `gdb_command`, or `probe_command`
- **THEN** its schema contains no challenge, nonce, approval token, or plan identifier
- **AND** a valid request proceeds directly to normal Target and queue validation.

#### Scenario: repository runtime scan
- **WHEN** executable source, scripts, configuration, tests, and current documentation are scanned
- **THEN** no approval/risk control-plane execution reference remains
- **AND** archived OpenSpec, immutable reports, generated output, dependencies, and ignored test output are excluded from this assertion.

### Requirement: Tool descriptions are the single workflow contract

Jlink-MCP SHALL remove all embedded MCP Prompts and the `jlink://discovery/catalog` Resource.

#### Scenario: list MCP auxiliary surfaces
- **WHEN** a client lists Prompts and Resources
- **THEN** no Prompt or discovery-catalog Resource is returned
- **AND** only `rtt://output`, `probe://gdb-server-log`, and `probe://status` remain as read-only runtime Resources.

### Requirement: Offline UI remains separate and unchanged

The build SHALL continue to produce the existing Offline UI entry without registering UI lifecycle MCP tools or changing UI source behavior in this change.

#### Scenario: build product entries
- **WHEN** the project build succeeds
- **THEN** it produces standalone MCP and Offline UI outputs
- **AND** it does not produce `out/extension.js` or a VSIX package.

#### Scenario: acceptance report
- **WHEN** this change's acceptance index is finalized
- **THEN** Offline UI modification and acceptance are reported as `NOT_TESTED`
- **AND** compatible `capture.db` data remains available for later UI use.
