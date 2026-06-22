# Repository Guidelines

## Project Structure & Module Organization

Source code lives in `src/`. `src/extension.ts` is the VS Code extension entry point, while `src/mcp/standalone.ts` starts the standalone MCP server. MCP tool registration is in `src/mcp/`; debug-probe implementations and their shared contract are in `src/probe/`. SEGGER-specific process wrappers live in `src/jlink/`, with GDB, RTT, and telnet support in their corresponding directories. Shared configuration, logging, and process helpers belong in `src/utils/`.

Generated JavaScript, declarations, and source maps are written to `out/`; do not edit or commit generated files. Root-level configuration includes `package.json`, `tsconfig.json`, `esbuild.mjs`, and MCP examples. `logo.png` is the extension asset.

## Build, Test, and Development Commands

- `npm ci`: install the exact dependency versions from `package-lock.json`.
- `npm run compile`: type-check and compile TypeScript into `out/`.
- `npm run bundle`: bundle the extension and standalone server with esbuild.
- `npm run build`: run compilation followed by bundling; use before submitting changes.
- `npm run watch`: recompile TypeScript continuously during development.
- `npm run lint`: run strict TypeScript checking without emitting files.
- `npm run package`: build and create a VS Code extension package with `vsce`.

Hardware workflows require the relevant probe software, such as SEGGER J-Link tools, OpenOCD, or `arm-none-eabi-gdb`.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes, semicolons, and trailing commas in multiline structures. Keep `strict` TypeScript checks passing. Use `camelCase` for variables and functions, `PascalCase` for classes and interfaces, and kebab-case filenames such as `process-manager.ts`. Extend the existing probe backend interface instead of duplicating backend selection logic.

## Testing Guidelines

No automated test framework or coverage threshold is currently configured. For every change, run `npm run lint` and `npm run build`. For hardware-facing changes, document the probe, target MCU, backend, and manual command sequence used. Keep hardware access behind the existing process and probe abstractions so future tests can isolate parsing and lifecycle behavior.

## Commit & Pull Request Guidelines

Use Conventional Commit prefixes found in history, especially `feat:` and `fix:`, with an imperative, specific subject. Keep commits focused. Pull requests should explain the user-visible behavior, list verification commands, identify hardware tested, and link relevant issues. Include screenshots only for VS Code UI changes; include concise MCP request/response examples for tool behavior changes.
