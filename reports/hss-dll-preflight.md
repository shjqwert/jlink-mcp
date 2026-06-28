# HSS DLL Preflight

Result: candidate found, benchmark blocked.

Search paths:

- `C:\Program Files\SEGGER\JLink_V884\JLink_x64.dll`
- `C:\Program Files\SEGGER\JLink\JLink_x64.dll`

Evidence:

- Selected DLL: `C:\Program Files\SEGGER\JLink_V884\JLink_x64.dll`
- Required HSS exports: present.
- Experimental env enabled: yes.
- Native helper built: yes.
- JScope used: no.
- Base API candidate authorized: yes, unverified.
- Connect-preflight: connected to probe serial `69401227`.
- Safety: `HSS_SAFETY_FAIL` because `targetWasHalted=true`.
- Benchmark-ready: no.

Blocker: target is halted. The helper did not issue halt/reset/write/flash, but benchmark stops when halted state is detected.
