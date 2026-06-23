# Design: Generic Runtime Experiment Analysis and CodeGraph Bridge

## Architecture

```text
src/mcp/
  experiment-contract.ts        # TypeScript types and validators
  experiment-store.ts           # Experiment metadata + capture reference storage
  analysis/
    profiles.ts                 # analysis profile registry
    generic-control.ts          # control-loop analysis
    generic-state-machine.ts    # state/fault/event analysis
    patterns.ts                 # shared pattern detectors
    evidence.ts                 # Runtime Evidence builder
  codegraph-bridge.ts           # CodeGraph-friendly query generation
```

The exact file layout may differ, but the dependency direction must remain:

```text
capture data / experiment record
  -> analysis core
  -> runtime evidence
  -> codegraph bridge output
```

The analysis core must not depend on J-Link hardware, GDB Server, CodeGraph, VS Code APIs, or native capture helper code.

## Core Data Model

### SignalDefinition

```ts
type SignalRole =
  | "command"
  | "feedback"
  | "error"
  | "state"
  | "fault"
  | "limit"
  | "counter"
  | "timestamp"
  | "event"
  | "raw"
  | "derived";

interface SignalDefinition {
  name: string;
  selector?: string;
  type: "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32";
  unit?: string;
  role: SignalRole;
  domain?: string;
  labels?: Record<string, string>;
  description?: string;
}
```

### ExperimentRecord

```ts
interface ExperimentRecord {
  experimentId: string;
  createdAt: string;
  source: "capture" | "imported" | "fixture" | "synthetic";
  target?: {
    device?: string;
    interface?: "SWD" | "JTAG";
    speedKhz?: number;
  };
  capture?: {
    captureId?: string;
    backend?: string;
    requestedRateHz?: number;
    actualRateHz?: number;
    recommendedRateHz?: number;
    durationMs?: number;
    quality?: Record<string, unknown>;
  };
  signals: SignalDefinition[];
  events: ExperimentEvent[];
  artifacts?: {
    raw?: string;
    csv?: string;
    report?: string;
  };
  metadata?: Record<string, unknown>;
}
```

### PatternFinding

```ts
interface PatternFinding {
  type:
    | "step_response"
    | "overshoot"
    | "undershoot"
    | "settling_time"
    | "steady_error"
    | "oscillation"
    | "saturation"
    | "state_transition"
    | "fault_transition"
    | "stuck_signal"
    | "discontinuity"
    | "counter_stall"
    | "counter_wrap";
  signal?: string;
  relatedSignals?: string[];
  startMs?: number;
  endMs?: number;
  value?: number | string | boolean;
  unit?: string;
  confidence: "low" | "medium" | "high";
  evidence: string;
}
```

### RuntimeEvidence

```ts
interface RuntimeEvidence {
  evidenceId: string;
  experimentId: string;
  summary: string;
  severity: "info" | "warning" | "error";
  timeWindowMs?: [number, number];
  signals: Array<{
    name: string;
    role: SignalRole;
    selector?: string;
    symbol?: string;
    fileHint?: string;
  }>;
  patterns: string[];
  codeHints: CodeHint[];
  questionsForCodeGraph: CodeGraphQuestion[];
  artifacts?: Record<string, string>;
}
```

## Analysis Profiles

### `generic_control`

Required MVP patterns:

- `step_response`
- `overshoot`
- `settling_time`
- `steady_error`
- `saturation`

The profile should operate on role-based signals:

- command
- feedback
- error
- limit
- fault

It must not require motor-specific names.

### `generic_state_machine`

Required MVP patterns:

- `state_transition`
- `fault_transition`
- `stuck_signal`
- `counter_stall`
- `counter_wrap`

It should operate on:

- state
- fault
- counter
- event

### `motor_bldc`

Optional plugin/profile. It may add:

- hall sequence checking
- commutation order checking
- sector timing imbalance detection

It must not be required by the generic profiles.

### `motor_foc`

Optional plugin/profile. It may add:

- Id/Iq trend checks
- Vd/Vq saturation trend checks
- angle continuity checks

For the current RSP backend, this profile must label high-frequency current-loop conclusions as limited by capture backend quality unless a high-speed backend is used.

## MCP Tool Contracts

### `analysis_profiles`

Input:

```json
{}
```

Output:

```json
{
  "profiles": [
    {
      "name": "generic_control",
      "domain": "generic",
      "status": "implemented",
      "patterns": ["step_response", "overshoot", "settling_time", "steady_error", "saturation"]
    }
  ]
}
```

### `experiment_analyze`

Input:

```json
{
  "experimentId": "exp_001",
  "captureId": "cap_001",
  "analysisProfile": "generic_control",
  "signals": ["speed_ref", "speed_rpm", "fault_code"],
  "windowMs": [0, 5000]
}
```

At least one of `experimentId` or `captureId` must be provided.

Output:

```json
{
  "summary": {
    "verdict": "warning",
    "mainFindings": [
      "feedback overshoot detected after command step",
      "fault state changed during the response window"
    ]
  },
  "patterns": [],
  "evidence": [],
  "quality": {
    "warnings": []
  }
}
```

This tool must be read-only. It must not connect to hardware, start capture, write memory, reset, halt, resume, or flash.

### `experiment_compare`

Input:

```json
{
  "baselineExperimentId": "exp_before",
  "candidateExperimentId": "exp_after",
  "analysisProfile": "generic_control",
  "metrics": ["overshoot", "settling_time", "fault_transition"]
}
```

Output:

```json
{
  "summary": {
    "verdict": "improved",
    "changes": []
  },
  "metricDiffs": []
}
```

### `evidence_for_codegraph`

Input:

```json
{
  "experimentId": "exp_001",
  "evidenceIds": ["ev_001"]
}
```

Output:

```json
{
  "codegraphQueries": [
    {
      "query": "Find writers of g_speedRpm and call chain to the control loop update",
      "symbols": ["g_speedRpm"],
      "fileHints": ["control.c"],
      "reason": "speed feedback overshoot after command step"
    }
  ]
}
```

This tool must not call CodeGraph MCP. It only prepares Agent-usable queries.

### `experiment_run` Optional Contract

If implemented, it must:

- use existing capture and control infrastructure;
- require an experiment profile from `.jlink-mcp.json`;
- reject control actions unless `allowControls=true`;
- reject unsafe controls unless they exist in the existing allowlist;
- record all actions and safety decisions in the experiment record;
- stop safely using existing stop semantics on failure;
- never bypass existing capture safety rules.

## Project Configuration Extension

`.jlink-mcp.json` may be extended as follows:

```json
{
  "signals": {
    "speed_ref": {
      "selector": "control.c::g_speedRef",
      "type": "float32",
      "unit": "rpm",
      "role": "command"
    },
    "speed_rpm": {
      "selector": "control.c::g_speedRpm",
      "type": "float32",
      "unit": "rpm",
      "role": "feedback"
    },
    "fault_code": {
      "selector": "fault.c::g_faultCode",
      "type": "uint32",
      "role": "fault"
    }
  },
  "experiments": {
    "startup_400hz": {
      "signals": ["speed_ref", "speed_rpm", "fault_code"],
      "rateHz": 400,
      "durationMs": 10000,
      "actions": [
        { "atMs": 500, "control": "start" },
        { "atMs": 9000, "control": "stop" }
      ],
      "analysisProfiles": ["generic_control", "generic_state_machine"]
    }
  }
}
```

## Test Strategy

Use synthetic fixtures first:

- ideal step response;
- overshoot step response;
- saturated response;
- stuck state;
- fault transition;
- counter stall;
- before/after experiment comparison.

Hardware tests are optional for this change unless `experiment_run` is implemented. If hardware tests are run, they must not claim sampling capabilities beyond measured backend quality.
