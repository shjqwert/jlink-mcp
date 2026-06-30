# HSS MVP-A

HSS MVP-A is the read-only J-Link HSS capture path. It uses `process.cwd()` as the project root, writes under `.jlink-mcp`, and never performs reset, halt, step, resume, flash, erase, raw commands, or target-memory writes.

Tools:

- `hss_capability_probe`
- `hss_capture_plan`
- `hss_capture_start`
- `hss_capture_status`
- `hss_capture_stop`
- `hss_capture_query`
- `hss_capture_export`

Artifacts:

- `.jlink-mcp/captures/<captureId>/capture_0001.bin`
- `.jlink-mcp/captures/<captureId>/capture.json`
- `.jlink-mcp/exports/<captureId>.csv`
- `.jlink-mcp/audit/<sessionId>/audit.jsonl`

Every tool returns the shared JSON envelope with `ok`, `operation`, `data`, `risk`, `backend`, `artifacts`, `warnings`, and `message`. Failures include `error.code`, `error.message`, and `error.details`.

`hss_capture_start` requires `JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API=1` and `JLINK_MCP_REAL_HW_SMOKE=1` when only DLL export evidence is available. If HSS cannot run, the tools return structured errors and suggestions; they do not fall back to RSP as a fake HSS pass.
