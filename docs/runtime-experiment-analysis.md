# Runtime experiment analysis

Jlink-MCP can analyze runtime data offline through `ExperimentRecord` inputs. The analysis tools do not start hardware sessions, call J-Link, call GDB, write controls, or call CodeGraph. They only read saved fixtures, saved `.experiment.json` records, or terminal capture artifacts.

Use `capture_prepare`, `capture_start`, `capture_stop`, and `capture_export` when you need to create capture artifacts. Use the tools below after data already exists.

## Signal roles

Every analysis depends on signal roles, not domain-specific names.

| Role | Meaning |
|------|---------|
| `command` | Requested value or mode that drives a response |
| `feedback` | Measured response to a command |
| `error` | Error term or residual signal |
| `state` | State-machine state value |
| `fault` | Fault/status code where transitions matter |
| `limit` | Saturation, clipping, or limit indicator |
| `counter` | Monotonic counter used to detect stalls or wraps |
| `timestamp` | Time-like signal when included as data |
| `event` | Event marker stored as a signal |
| `raw` | Captured value with no semantic role |
| `derived` | Calculated value produced outside the core capture |

The generic analysis core does not depend on names such as motor, iq, svm, duty, or rpm. Those can appear in selectors or aliases, but behavior is selected through roles.

## ExperimentRecord

An `ExperimentRecord` is the offline analysis unit:

- `experimentId`: stable id used by analysis and evidence output.
- `source`: `fixture`, `capture`, `imported`, or `synthetic`.
- `signals`: signal definitions with name, optional selector, type, unit, and role.
- `samples`: time-ordered values in milliseconds.
- `events`: optional runtime events such as command steps or faults.
- `timeWindowMs`: optional default analysis window.
- `capture`: optional capture backend and quality metadata.
- `artifacts`: optional raw/metadata file paths for traceability.
- `metadata`: non-contract extension data such as sample warnings.

Saved experiment files must be absolute paths ending in `.experiment.json`. Fixtures are loaded by id or by relative `fixturePath` under `src/mcp/fixtures`.

## Available tools

`analysis_profiles`

Lists implemented profiles. Current implemented profiles are `generic_control` and `generic_state_machine`.

`experiment_analyze`

Analyzes one experiment source:

- fixture id: `experimentId`
- fixture file under `src/mcp/fixtures`: `fixturePath`
- saved record: absolute `experimentPath`
- capture metadata: absolute `metadataFile`
- terminal capture lookup: `captureId` plus absolute `outputDir`

`experiment_compare`

Compares two experiment sources with one profile. Each side can use a fixture id, saved `.experiment.json`, or capture metadata file.

`evidence_for_codegraph`

Converts analysis output into Runtime Evidence and CodeGraph query suggestions. It does not call CodeGraph and does not parse source files. The Agent decides whether to call CodeGraph MCP with the suggested query text, symbols, and file hints.

## Examples

List profiles:

```json
{
  "tool": "analysis_profiles",
  "input": {}
}
```

Analyze a fixture:

```json
{
  "tool": "experiment_analyze",
  "input": {
    "experimentId": "generic-control-overshoot",
    "analysisProfile": "generic_control"
  }
}
```

Analyze a saved experiment:

```json
{
  "tool": "experiment_analyze",
  "input": {
    "experimentPath": "D:\\captures\\startup-step.experiment.json",
    "analysisProfile": "generic_control"
  }
}
```

Analyze capture metadata:

```json
{
  "tool": "experiment_analyze",
  "input": {
    "metadataFile": "D:\\captures\\2026-06-21T12-34-56-789Z-123e4567-e89b-42d3-a456-426614174000.metadata.json",
    "analysisProfile": "generic_control",
    "signalRoles": {
      "speed_ref": "command",
      "speed_rpm": "feedback",
      "fault_code": "fault"
    },
    "maxSamples": 20000
  }
}
```

Analyze by capture id and output directory:

```json
{
  "tool": "experiment_analyze",
  "input": {
    "captureId": "123e4567-e89b-42d3-a456-426614174000",
    "outputDir": "D:\\captures",
    "analysisProfile": "generic_state_machine",
    "signalRoles": {
      "requested_mode": "command",
      "active_state": "state",
      "fault_code": "fault",
      "loop_counter": "counter"
    }
  }
}
```

Generate Runtime Evidence and CodeGraph query suggestions from a previous `experiment_analyze` result:

```json
{
  "tool": "evidence_for_codegraph",
  "input": {
    "metadataFile": "D:\\captures\\2026-06-21T12-34-56-789Z-123e4567-e89b-42d3-a456-426614174000.metadata.json",
    "signalRoles": {
      "speed_ref": "command",
      "speed_rpm": "feedback"
    },
    "analysisResult": "<experiment_analyze output>"
  }
}
```

## signalRoles overrides

Capture metadata records symbols and aliases, but it cannot always know analysis intent. `signalRoles` lets the caller map captured names or selectors into roles for one analysis call.

The lookup order is:

1. captured signal name
2. original selector
3. capture alias
4. default `raw`

For saved `.experiment.json` and fixtures, roles already live in `signals`. Overrides are most useful for capture-backed analysis.

## Profile patterns

`generic_control` expects at least one `feedback` signal and optionally a `command` and `limit` signal. It can report:

- `step_response`
- `overshoot`
- `settling_time`
- `steady_error`
- `saturation`

`generic_state_machine` uses `state`, `fault`, `counter`, and optional `command` roles. It can report:

- `state_transition`
- `fault_transition`
- `stuck_signal`
- `counter_stall`
- `counter_wrap`

## Runtime Evidence to CodeGraph

Runtime Evidence contains:

- `evidenceId`
- `experimentId`
- `summary`
- `severity`
- `signals`
- `patterns`
- `codeHints`
- `questionsForCodeGraph`

Mapping is deterministic and inference-only:

| Runtime finding | Generated query intent |
|-----------------|------------------------|
| command plus feedback | control loop update path |
| fault transition | enum definition and assignment sites |
| overshoot | PI/PID loop and saturation/limit handling |
| stuck signal | update function and ISR/task path |

The bridge extracts symbol and file hints only from selectors such as `control.c::g_command` or `state.c::g_activeState`. It does not read source files and does not build a static analysis index.

Agent workflow:

1. Create or locate data with `capture_export`, saved capture metadata, fixture id, or saved `.experiment.json`.
2. Call `experiment_analyze`.
3. Call `evidence_for_codegraph` with the analysis result.
4. Agent calls CodeGraph MCP, if available, using the generated query suggestions.
5. Agent combines runtime evidence with code graph results in its answer.

## Project config snippets

The existing `.jlink-mcp.json` is still the reviewed capture/control contract used by `capture_prepare`. The following snippets show how project-owned config can describe signal intent for humans or future orchestration. Current `experiment_analyze` calls still pass `signalRoles` directly unless the `ExperimentRecord` already contains roles.

Generic control loop:

```json
{
  "signals": {
    "command": {
      "selector": "control.c::g_command",
      "type": "float32",
      "unit": "unit",
      "role": "command"
    },
    "feedback": {
      "selector": "sense.c::g_feedback",
      "type": "float32",
      "unit": "unit",
      "role": "feedback"
    },
    "clipped": {
      "selector": "limit.c::g_clipped",
      "type": "uint32",
      "role": "limit"
    }
  },
  "experiments": {
    "step_response": {
      "signals": ["command", "feedback", "clipped"],
      "analysisProfiles": ["generic_control"]
    }
  }
}
```

Generic state machine:

```json
{
  "signals": {
    "requested_mode": {
      "selector": "app.c::g_requestedMode",
      "type": "uint32",
      "role": "command"
    },
    "active_state": {
      "selector": "state.c::g_activeState",
      "type": "uint32",
      "role": "state"
    },
    "fault_code": {
      "selector": "fault.c::g_faultCode",
      "type": "uint32",
      "role": "fault"
    },
    "loop_counter": {
      "selector": "isr.c::g_loopCounter",
      "type": "uint32",
      "role": "counter"
    }
  },
  "experiments": {
    "mode_change": {
      "signals": ["requested_mode", "active_state", "fault_code", "loop_counter"],
      "analysisProfiles": ["generic_state_machine"]
    }
  }
}
```

BLDC motor project:

```json
{
  "signals": {
    "speed_ref": {
      "selector": "AppMotorDbg.c::gstMotorDbg.fSpeedRefRpm",
      "type": "float32",
      "unit": "rpm",
      "role": "command",
      "domain": "motor_bldc"
    },
    "speed_feedback": {
      "selector": "AppMotorDbg.c::gstMotorDbg.fSpeedRpm",
      "type": "float32",
      "unit": "rpm",
      "role": "feedback",
      "domain": "motor_bldc"
    },
    "fault_code": {
      "selector": "AppMotorDbg.c::gstMotorDbg.u32FaultCode",
      "type": "uint32",
      "role": "fault",
      "domain": "motor_bldc"
    }
  },
  "experiments": {
    "bldc_speed_step": {
      "signals": ["speed_ref", "speed_feedback", "fault_code"],
      "analysisProfiles": ["generic_control", "generic_state_machine"]
    }
  }
}
```

The BLDC names are project-specific labels. The core analysis still uses `command`, `feedback`, and `fault`.

## Capture backend limits

The RSP capture backend is useful for offline experiments, but it is not equivalent to J-Scope or HSS. Do not claim strict 1 kHz behavior for a target or variable set unless that exact setup has been measured and recorded in capture metadata.

`maxSamples` can decimate long captures before analysis. This is acceptable for broad control-shape checks, but state, fault, and counter analysis can miss short events when decimated. Use a narrower `windowMs` or a larger `maxSamples` when event ordering matters.
