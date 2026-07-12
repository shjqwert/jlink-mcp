# Repository Guidelines

## Project Structure & Module Organization

Source code lives in `src/`. `src/extension.ts` is the VS Code extension entry point, while `src/mcp/standalone.ts` starts the standalone MCP server. MCP tool registration is in `src/mcp/`; debug-probe implementations and their shared contract are in `src/probe/`. SEGGER-specific process wrappers live in `src/jlink/`, with GDB, RTT, and telnet support in their corresponding directories. Shared configuration, logging, and process helpers belong in `src/utils/`.

Generated JavaScript, declarations, and source maps are written to `out/`; do not edit or commit generated files. Root-level configuration includes `package.json`, `tsconfig.json`, `esbuild.mjs`, and MCP examples. `logo.png` is the extension asset.

 

## Shell & Encoding Guidelines

PowerShell may display UTF-8 files incorrectly when it uses the local code page. Read repository text files explicitly as UTF-8, for example `Get-Content -Raw -Encoding UTF8 AGENTS.md`, before editing or quoting content.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes, semicolons, and trailing commas in multiline structures. Keep `strict` TypeScript checks passing. Use `camelCase` for variables and functions, `PascalCase` for classes and interfaces, and kebab-case filenames such as `process-manager.ts`. Extend the existing probe backend interface instead of duplicating backend selection logic.


