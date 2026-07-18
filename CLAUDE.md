# J-Link MCP Server

Standalone stdio MCP server for Agent-driven SEGGER J-Link debugging.

## Build and test

```powershell
npm install
npm run build
npm test
```

`npm run build` emits only the standalone MCP bundle and the separate local Offline UI bundle. It does not build a VS Code Extension or VSIX.

## Runtime contract

- `src/mcp/standalone.ts` is the only MCP entry.
- `src/mcp/server.ts` registers exactly 57 direct tools, three read-only Resources, and zero Prompts.
- A caller must configure each canonical `projectRoot` with `target_configure` before target operations.
- Physical operations for one Probe serial are serialized.
- Reads and preflight never implicitly halt, reset, resume, recover, flash, erase, or write.
- There is no Approval Broker, challenge/token exchange, risk tier, or required plan/execute authorization flow.
- The existing Offline UI is separate and outside the current refactor's modification and acceptance scope.

## Local evidence

Use ignored `test-output/` for generated captures, exports, logs, issue ledgers, environment details, Probe serials, local project paths, and Artifact hashes. Do not commit or push those values.

The authoritative requirements are under `openspec/changes/refactor-agent-first-mcp/`.
