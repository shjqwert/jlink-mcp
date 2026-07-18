## ADDED Requirements

### Requirement: Hot Variables cache validated runtime layouts

Jlink_MCP SHALL allow a debug session to cache selected resolved variables for repeated read, write, and HSS planning operations.

#### Scenario: add Hot Variable

- **GIVEN** a variable has been resolved from the current Artifact generation
- **WHEN** it is added as a Hot Variable
- **THEN** the cache stores its logical identity, layout hash, Artifact hash, policy state, and validation time.

### Requirement: Fast paths avoid repeated whole-project resolution

When the Artifact generation and layout remain valid, fast read/write/capture lookup SHALL use the cached Hot Variable without rescanning all artifacts or symbols.

#### Scenario: repeated debug write

- **GIVEN** a valid Hot Variable and unchanged Artifact generation
- **WHEN** the Agent creates another write plan for that variable
- **THEN** the cached layout is used
- **AND** only lightweight policy, budget, TTL, ownership, and readback checks are performed.

### Requirement: Hot Variables become stale after build output changes

A Hot Variable SHALL become stale when its Artifact, paired MAP, symbol layout, policy, or session generation changes.

#### Scenario: build output changes

- **GIVEN** a Hot Variable resolved before an incremental build
- **WHEN** the Artifact hash changes
- **THEN** a fast operation is rejected with `hot_variable_stale`
- **AND** the Agent is offered a targeted refresh of referenced variables.

### Requirement: MCP does not own the project build

Jlink_MCP SHALL detect Artifact changes but SHALL NOT require or trigger a full project build.

#### Scenario: source changed but Artifact did not

- **GIVEN** source files changed without a new debug Artifact
- **WHEN** Jlink_MCP checks the session
- **THEN** it continues to identify the existing Artifact generation as the running/debug data source
- **AND** does not claim the source changes are present on target.
