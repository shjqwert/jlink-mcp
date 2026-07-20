# Repository Guidelines

## Project Structure & Module Organization

Source code lives in `src/`. `src/extension.ts` is the VS Code extension entry point, while `src/mcp/standalone.ts` starts the standalone MCP server. MCP tool registration is in `src/mcp/`; debug-probe implementations and their shared contract are in `src/probe/`. SEGGER-specific process wrappers live in `src/jlink/`, with GDB, RTT, and telnet support in their corresponding directories. Shared configuration, logging, and process helpers belong in `src/utils/`.

Generated JavaScript, declarations, and source maps are written to `out/`; do not edit or commit generated files. Root-level configuration includes `package.json`, `tsconfig.json`, `esbuild.mjs`, and MCP examples. `logo.png` is the extension asset.

 

## Shell & Encoding Guidelines

PowerShell may display UTF-8 files incorrectly when it uses the local code page. Read repository text files explicitly as UTF-8, for example `Get-Content -Raw -Encoding UTF8 AGENTS.md`, before editing or quoting content.

## Code Retrieval Routing

- Prefer Serena for symbol definitions, declarations, types, references, and symbol-level operations.
- Prefer CodeGraph for call chains, dependencies, module structure, architecture analysis, and change-impact analysis.
- When Serena and CodeGraph overlap, choose only the one that best fits the task to avoid duplicate queries.
- Use CodeGraph results mainly for relationship navigation and impact-scope assessment; verify key conclusions against the actual source code.
- Before modifying code, confirm the relevant symbols, references, call relationships, and test scope.
- If Serena or CodeGraph cannot provide reliable results, supplement them with Codex's available native search tools.

## Review Coordination

- Complex changes require a sub-agent code review. While that review runs, the main session must wait before modifying files in the reviewed scope; do not make concurrent edits that would make the review stale.
- Small, self-contained changes may skip sub-agent review.
