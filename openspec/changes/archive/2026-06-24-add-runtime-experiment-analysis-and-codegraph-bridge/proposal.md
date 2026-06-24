# Proposal: add-runtime-experiment-analysis-and-codegraph-bridge

## Summary

Add a generic runtime experiment analysis layer to Jlink-MCP and a CodeGraph-friendly evidence bridge.

This change turns captured runtime data into structured experiment records, generic signal/state/control analysis results, and Runtime Evidence objects that an Agent can combine with CodeGraph MCP. Electric motor debugging remains a first-class profile, but the core system must remain domain-agnostic and usable for non-motor embedded projects.

## Motivation

Jlink-MCP currently focuses on giving AI access to embedded targets through J-Link, RTT, GDB Server, memory/register inspection, flashing, and capture tooling. The next step should not be a motor-only analyzer. The next step should be a reusable runtime experiment system:

- capture and control runtime behavior;
- describe signals, controls, actions, and events in a project contract;
- analyze generic behavior patterns such as steps, overshoot, faults, stuck states, and saturation;
- export structured evidence that another MCP, such as CodeGraph, can use for static code localization.

## Goals

- Add generic runtime concepts: Signal, Experiment, Pattern, Runtime Evidence, Analysis Profile.
- Add analysis tools that are read-only by default and do not require hardware access.
- Support generic control-loop and state-machine analysis for motor and non-motor projects.
- Add optional motor profiles as plugins/profiles rather than core assumptions.
- Generate CodeGraph-friendly questions and hints without directly depending on CodeGraph MCP.
- Preserve existing capture safety boundaries and current hardware limitations.
- Keep the implementation testable through synthetic fixtures before hardware tests.

## Non-Goals

- Do not replace CodeGraph MCP or implement a full static code graph engine in Jlink-MCP.
- Do not make Jlink-MCP depend on CodeGraph at runtime.
- Do not make motor analysis mandatory for generic experiment analysis.
- Do not claim 1 kHz or J-Scope-equivalent performance for the existing RSP backend.
- Do not add uncontrolled arbitrary memory writes.
- Do not run motors or send control actions without existing allowlist and explicit current-session authorization.
- Do not modify embedded firmware source as part of this change.

## High-Level Design

Jlink-MCP remains responsible for the runtime world:

```text
target runtime
  -> capture data
  -> experiment record
  -> generic analysis profiles
  -> runtime evidence
  -> CodeGraph-friendly hints/questions
```

CodeGraph MCP remains responsible for the static world:

```text
source files
  -> symbols
  -> writers/readers
  -> call graph
  -> dependencies
```

The Agent coordinates both systems:

```text
Agent
  -> asks Jlink-MCP for runtime evidence
  -> asks CodeGraph about symbols/functions suggested by runtime evidence
  -> combines both answers into a debugging hypothesis
```

## Proposed MCP Tools

### Required in MVP

- `analysis_profiles`
- `experiment_analyze`
- `experiment_compare`
- `evidence_for_codegraph`

### Optional after MVP

- `experiment_run`

`experiment_run` may be added only after the analysis layer and evidence bridge are stable. It must orchestrate existing capture/control functions rather than duplicating safety logic.

## Compatibility

This change is additive. Existing tools must continue working. Existing capture records should be convertible into experiment records, but old data files must remain readable.

## Risks

- Scope creep into a full data-science framework.
- Accidental coupling to motor-specific variables.
- Accidental duplication of CodeGraph.
- Over-promising hardware sampling performance.
- Unsafe control execution if experiment orchestration is implemented too early.

Mitigation: implement the generic read-only analysis MVP first, require fixtures and golden tests, then add optional experiment orchestration under the existing safety allowlist model.
