## REMOVED Requirements

### Requirement: No Runtime Dependency on CodeGraph
**Reason**: The entire CodeGraph bridge capability is removed from the mainline.
**Migration**: Keep capture analysis self-contained and export evidence through ordinary query results.

### Requirement: Runtime Evidence
**Reason**: Runtime Evidence storage is replaced by JCAP raw provenance, events, quality, and findings.
**Migration**: Persist capture-local evidence in raw BIN and derived query rows in `capture.db`.

### Requirement: CodeGraph-Friendly Query Generation
**Reason**: CodeGraph-specific output is outside the supported product path.
**Migration**: External clients may translate bounded query results without a server-side bridge.

### Requirement: Safety and Scope of Bridge Output
**Reason**: Removing the bridge removes its special safety contract.
**Migration**: Apply the common risk-policy contract to retained MCP operations.

### Requirement: Agent-Oriented Workflow Contract
**Reason**: Agent workflow belongs outside MCP and no longer depends on CodeGraph artifacts.
**Migration**: Use discovery resources plus capture query/analysis tools.
