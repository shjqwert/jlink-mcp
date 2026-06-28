# Design: Experimental JLink HSS DLL Adapter

The adapter is split into three small parts:

- TypeScript candidate metadata for the public, unverified HSS API.
- TypeScript wrapper/MCP tools that enforce the env gate and parse helper JSON.
- Windows native helper that isolates `LoadLibraryW`, `GetProcAddress`, and `JLINK_HSS_GetCaps`.

Only `preflight` and `getcaps` can touch the DLL. Target connect, Start/Read/Stop, and benchmark stop with `JLINK_BASE_API_PROTOTYPE_MISSING` until local official JLinkARM base API prototype evidence exists.

Backend routing remains synchronous. It only marks HSS available when an injected adapter has benchmark capability. JScope-only and exports-only states are blocked/candidate and fall through to RTT/RSP.
