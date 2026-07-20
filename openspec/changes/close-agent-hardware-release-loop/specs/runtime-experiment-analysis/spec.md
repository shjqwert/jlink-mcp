## REMOVED Requirements

### Requirement: Generic Signal Definitions
**Reason**: Phase 7 removes MCP-owned business-analysis models; captured variable descriptors and optional user metadata remain sufficient for Agent analysis.
**Migration**: Use `symbol_resolve`, HSS descriptors, capture metadata, and bounded query results directly.

### Requirement: Experiment Records
**Reason**: JCAP captures and operation events are the authoritative runtime evidence; a second experiment-record model is not required.
**Migration**: Use `captureId`, JCAP provenance, write events, and Agent-maintained investigation context.

### Requirement: Analysis Profiles
**Reason**: `analysis_profiles` and all MCP-owned analysis profiles are removed from the public product.
**Migration**: The Agent selects analysis methods after reading bounded capture data and source code.

### Requirement: Generic Control Analysis
**Reason**: Control-response interpretation belongs to Codex or Claude, not the hardware execution MCP.
**Migration**: Query `capture_summary`, `capture_series`, and `capture_event_window`, then analyze the returned bounded evidence in the Agent.

### Requirement: Generic State Machine Analysis
**Reason**: State-machine interpretation belongs to the Agent and does not require a persistent MCP algorithm surface.
**Migration**: Query bounded state variables/events and correlate them with source code in the Agent.

### Requirement: Experiment Analysis Tool
**Reason**: No general experiment model or MCP-owned analyzer remains.
**Migration**: Use the five capture tools and Agent-side reasoning.

### Requirement: Experiment Comparison Tool
**Reason**: Comparison is a normal Agent task and no dedicated MCP comparison tool is required.
**Migration**: Query both captures with identical bounds and compare their returned evidence in the Agent.

### Requirement: Domain Profiles Are Optional
**Reason**: All domain and generic MCP analysis profiles are removed together.
**Migration**: Keep domain knowledge in Agent instructions, project source, or user-provided context.

### Requirement: Deterministic Fixture Testing
**Reason**: Analysis algorithm fixtures are obsolete when the corresponding MCP algorithms are removed.
**Migration**: Retain tests only for deterministic capture storage, bounded query, and export behavior.

### Requirement: Post-capture analysis returns actionable evidence
**Reason**: MCP returns evidence; the Agent produces findings and next actions.
**Migration**: Use bounded capture query output plus source/Artifact context.

### Requirement: BLDC analysis profile is optional and evidence-based
**Reason**: Motor-specific business analysis is outside the execution/data MCP boundary.
**Migration**: The Agent analyzes motor captures using project source and queried signals.

### Requirement: Analysis does not mutate hardware
**Reason**: The analysis operation itself is removed; capture queries remain hardware-independent and read-only except disclosed internal DB repair.
**Migration**: Use bounded capture queries, which never connect to target hardware.
