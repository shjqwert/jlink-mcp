---
name: jlink-mcp-agent
description: Use J-Link MCP for Artifact and Symbol discovery, high-rate HSS capture, indexed JCAP queries, deterministic offline analysis, and risk-aware target operations. Trigger when debugging embedded targets or analyzing .jcap captures through the J-Link MCP server.
---

# J-Link MCP Agent

Read `jlink://discovery/catalog` before selecting tools. Treat its facts as guidance while relying on server-side enforcement for policy and safety.

Follow this order:

1. Call `artifact_probe`, then `symbol_search` and `symbol_resolve`.
2. Add or refresh only needed Hot Variables.
3. Use `hss_capture_plan`, `hss_capture_start`, `hss_capture_status`, and `hss_capture_stop` for high-rate capture. Do not substitute raw GDB polling.
4. Use `capture_list`, `capture_summary`, `capture_series`, and `capture_event_window` against indexed JCAP data.
5. Call `analysis_profiles`, then `analysis_run` with one bounded event or tick window.

Before proposing a state change, inspect risk, preconditions, reversibility, approval, side effects, and verification metadata:

- Execute verified policy-allowlisted RAM writes as R2 through `variable_write_plan` and `variable_write_execute`; do not request R3 planning or user approval.
- Call `halt`, `resume`, or `reset` once as R3; let the server plan, revalidate, consume, and audit internally. Expect halt/reset to reject active-capture conflicts.
- For R4, call the action-specific `*_plan`, ask the trusted local host/CLI broker to obtain direct confirmation, then call the retained execute tool with its opaque token. Never mint, infer, expose, or self-assert approval.
- Reject R5 operations; no execution tool exists.

Use MCP evidence for diagnosis. Do not claim that server metadata guarantees every third-party Agent reviewed it, and do not seek broker secrets or hardware bypasses through tools, resources, prompts, or offline UI.
