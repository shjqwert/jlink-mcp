# Agent Routing Evaluation

This suite checks whether an Agent selects the correct J-Link MCP tools, preserves required ordering, avoids forbidden tools, and obtains causal user confirmation for high-impact operations.

## Two evaluation modes

`npm run test:agent-routing` is deterministic and offline. It loads the tool catalog from the compiled MCP server, validates 20 routing cases, scores checked-in reference traces, and proves the scorer rejects negative controls. This command is suitable for CI and never contacts a model or a debug probe.

`npm run eval:agent-routing` runs the same cases through an external real-Agent adapter. It is opt-in because provider credentials, model selection, and host integration are environment-specific:

```text
npm run eval:agent-routing -- --adapter node --adapter-arg path/to/adapter.mjs --output agent-routing-report.json
```

The evaluator launches the compiled MCP server only to obtain the live `listTools` catalog. It does not execute target tools. The adapter must intercept tool calls and use the harness policy; it must never forward an evaluation call to a real probe.

The adapter executable is trusted code and inherits the evaluator environment. The evaluator cannot prevent a malicious adapter from accessing local hardware or credentials, so only run reviewed adapters.

The checked-in Codex CLI adapter defaults to `read-only`. Codex CLI currently requires trusted MCP execution to invoke the simulation shim, so a real routing run must explicitly opt in to its `danger-full-access` host mode:

```powershell
$env:JLINK_ROUTING_ALLOW_DANGER_FULL_ACCESS = "1"
npm run eval:agent-routing -- --adapter node --adapter-arg scripts/codex-agent-routing-adapter.mjs --output agent-routing-report.json
Remove-Item Env:JLINK_ROUTING_ALLOW_DANGER_FULL_ACCESS
```

This opt-in relaxes the Codex host sandbox; it does not authorize real hardware access. The adapter runs in an empty temporary working directory, removes J-Link/SEGGER/probe environment variables, exposes only the simulated MCP shim, and instructs the Agent not to use shell or filesystem tools. These controls are defense in depth, not an OS isolation boundary.

The shim state, including `harnessPolicy`, is stored outside the Agent working directory but under the same temporary root. A same-user Agent with `danger-full-access` could deliberately read that file or other host files despite the prompt. Therefore this adapter does not provide a cryptographic or OS-enforced non-disclosure guarantee and marks such traces as `isolation: "process-local-not-os-isolated"`. Treat them as exploratory unless the entire Codex process runs inside an external OS/CI sandbox that cannot access the harness state, repository, credentials, or hardware.

## Adapter protocol

The evaluator writes one JSON request to adapter stdin. It contains:

```json
{
  "protocolVersion": 1,
  "evaluationId": "eval-001",
  "modelInput": {
    "userGoal": "user request",
    "tools": [{ "name": "tool", "description": "...", "inputSchema": {} }]
  },
  "harnessPolicy": {
    "scenario": {},
    "simulatedToolResults": {}
  }
}
```

Expected tools, ordering, forbidden tools, and confirmation answers are intentionally excluded. `evaluationId` is opaque. The adapter may use `harnessPolicy` to simulate the environment and user decisions, but must pass only `modelInput` to the model. The adapter returns one JSON trace on stdout:

```json
{
  "evaluationId": "eval-001",
  "agent": {
    "provider": "provider-name",
    "model": "model-name",
    "host": "host-name",
    "adapterVersion": "adapter-version"
  },
  "events": [
    { "type": "tool_call", "callId": "call-1", "tool": "list_devices", "arguments": {} },
    { "type": "tool_result", "callId": "call-1", "ok": true, "result": {} }
  ]
}
```

Supported event forms are:

- `tool_call`: `tool`, `arguments`, and, for confirmed operations, `operationId`.
- `tool_result`: the matching `callId`, `ok`, and a simulated `result`.
- `confirmation_request`: `operationId`, `tool`, exact `arguments`, and a concrete `impact`.
- `user_confirmation`: the same `operationId`, `source: "user"`, and `approved`.

A destructive or raw command passes only when the confirmation request precedes the call, the user approval precedes the call, the operation ID and arguments remain unchanged, and the executed call sets `userConfirmed=true`. A call after rejection fails.

The Codex adapter uses fixed host mediation for these operations: the Agent first calls with `userConfirmed=false`, the shim obtains the simulated explicit user decision without exposing it in the initial model input, and only an approval permits an exact retry with `userConfirmed=true`. A missing or non-boolean harness decision is treated as rejection.

For a new or changed HSS capture, the scorer requires a successful `dryRun=true` result before the live call. `projectRoot`, `variables`, `writeVariables`, `rateHz`, `durationSec`, and `qualityOracle` must remain unchanged. The live call may omit `dryRun` because its Schema default is `false`. Capability-only checks remain dry-run operations. A fresh matching preflight may be reused when the case explicitly provides that state.

## Case data

- `cases.json` defines user goals, simulated state, expected partial order, forbidden tools, confirmations, and HSS preflight relationships.
- `reference-traces.json` is deterministic scorer test data, not a model benchmark result.

Real-Agent reports retain provider, model, host, adapter version, isolation label, and a sanitized event trace for each case. Report serialization removes non-contract event fields and redacts structured project-root, path, probe-serial, and credential-like fields plus strings that are entirely absolute paths. It does not guarantee removal of secrets embedded inside arbitrary free-text messages; run `test:privacy` before sharing a report and prefer an externally isolated harness. Scoring always uses the original in-memory trace before redaction so unexpected calls remain detectable.
