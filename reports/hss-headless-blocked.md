# HSS Headless Blocked

Status: `BLOCKED`.

Reason: typed `JLINK_HSS_*` header/prototype evidence is missing, and JScope headless start/stop/export CLI evidence is missing.

What exists:

- JScope executable exists.
- JLink DLL exists.
- HSS function-name strings exist in SEGGER DLLs.
- JScope GUI preflight evidence exists from the previous run.

What is missing:

- Typed function prototypes.
- Calling convention.
- HSS structs/enums.
- Machine-readable headless benchmark/export path.

Decision: do not implement or call a guessed HSS DLL adapter. RTT/RSP fallback must not be reported as HSS success.
