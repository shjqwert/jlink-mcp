## REMOVED Requirements

### Requirement: Bounded AI debug sessions
**Reason**: MCP no longer owns multi-round AI orchestration.
**Migration**: External Agents compose deterministic MCP tools and may group captures with optional session metadata.

### Requirement: MVP-C MCP tools are explicit by phase
**Reason**: Workflow-phase tools are replaced by capability, capture, query, and analysis tools.
**Migration**: Publish the recommended sequence through discovery resources and the reference Agent skill.

### Requirement: Workflow input files are versioned and project-local
**Reason**: MCP workflow files are no longer a runtime contract.
**Migration**: Keep policy and JCAP schemas versioned under their owning capabilities.

### Requirement: Each round has a hypothesis and evidence plan
**Reason**: Hypothesis management belongs to the external Agent.
**Migration**: Store only deterministic capture provenance and optional user/session labels.

### Requirement: Workflow writes are symbol-derived experiments
**Reason**: Writes are governed directly by Symbol Catalog and risk-policy contracts.
**Migration**: Use the R2 `variable_write_plan`/execute flow with policy, readback, event, and audit evidence for verified targets; only the explicit R4 unverified-target exception uses trusted user approval.

### Requirement: Workflow output is evidence-backed and dynamic
**Reason**: MCP does not produce semantic workflow conclusions.
**Migration**: External Agents reason over bounded query and deterministic analysis results.
