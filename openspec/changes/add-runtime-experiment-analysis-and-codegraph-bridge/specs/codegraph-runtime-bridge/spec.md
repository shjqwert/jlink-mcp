# codegraph-runtime-bridge Specification

## ADDED Requirements

### Requirement: No Runtime Dependency on CodeGraph

Jlink-MCP SHALL NOT depend on CodeGraph MCP at runtime.

Jlink-MCP SHALL NOT directly invoke CodeGraph MCP tools.

The Agent is responsible for orchestrating Jlink-MCP and CodeGraph MCP.

#### Scenario: CodeGraph is unavailable

- **GIVEN** CodeGraph MCP is not installed or not running
- **WHEN** Jlink-MCP starts
- **THEN** Jlink-MCP still starts normally
- **AND** analysis and evidence generation remain available.

#### Scenario: bridge tool does not call CodeGraph

- **WHEN** `evidence_for_codegraph` is called
- **THEN** Jlink-MCP returns suggested CodeGraph queries
- **AND** does not make a nested MCP call.

---

### Requirement: Runtime Evidence

Jlink-MCP SHALL generate Runtime Evidence objects from experiment analysis results.

A Runtime Evidence object SHALL include:

- `evidenceId`;
- `experimentId`;
- summary;
- severity;
- optional time window;
- involved signals;
- pattern names;
- code hints;
- questions for CodeGraph;
- optional artifact references.

#### Scenario: overshoot evidence contains signal and symbol hints

- **GIVEN** an overshoot finding on signal `speed_rpm`
- **AND** the signal selector is `control.c::g_speedRpm`
- **WHEN** Runtime Evidence is generated
- **THEN** the evidence includes `g_speedRpm` as a symbol hint
- **AND** `control.c` as a file hint.

#### Scenario: missing selector still creates evidence

- **GIVEN** a signal has no ELF selector
- **WHEN** Runtime Evidence is generated
- **THEN** the evidence still includes the signal name and pattern
- **AND** the CodeGraph questions avoid fabricating symbol names.

---

### Requirement: CodeGraph-Friendly Query Generation

Jlink-MCP SHALL provide an `evidence_for_codegraph` MCP tool that converts Runtime Evidence into Agent-usable CodeGraph query suggestions.

Generated queries SHALL include:

- natural-language query;
- relevant symbols when known;
- file hints when known;
- reason derived from runtime evidence;
- referenced experiment and evidence IDs.

#### Scenario: command-feedback issue generates writer/reader questions

- **GIVEN** a runtime finding involves a `command` signal and a `feedback` signal
- **WHEN** `evidence_for_codegraph` is called
- **THEN** the generated questions ask for writers/readers and call paths of those symbols.

#### Scenario: fault transition generates enum and assignment questions

- **GIVEN** a runtime finding involves a `fault` signal transition
- **WHEN** `evidence_for_codegraph` is called
- **THEN** the generated questions ask where the fault code is defined, assigned, and cleared.

---

### Requirement: Safety and Scope of Bridge Output

Jlink-MCP SHALL only generate bridge output from:

- experiment metadata;
- signal definitions;
- analysis findings;
- runtime evidence;
- known selectors and control definitions.

Jlink-MCP SHALL NOT read arbitrary source files for CodeGraph bridge generation.

#### Scenario: bridge generation avoids source-code duplication

- **GIVEN** a signal selector contains a symbol and file hint
- **WHEN** bridge output is generated
- **THEN** Jlink-MCP includes the hint
- **AND** does not copy source code into the bridge output.

---

### Requirement: Agent-Oriented Workflow Contract

Jlink-MCP SHALL document the intended workflow:

1. Agent calls Jlink-MCP to analyze runtime data.
2. Jlink-MCP returns Runtime Evidence.
3. Agent calls `evidence_for_codegraph`.
4. Agent sends generated queries to CodeGraph MCP.
5. Agent combines runtime evidence with static code graph results.

#### Scenario: workflow remains valid without CodeGraph

- **GIVEN** only Jlink-MCP is available
- **WHEN** the Agent analyzes an experiment
- **THEN** the Agent still receives runtime evidence
- **AND** the absence of CodeGraph only limits static localization, not runtime analysis.
