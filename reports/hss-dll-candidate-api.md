# HSS DLL Candidate API

Result: candidate only, not production-ready.

- Functions: `JLINK_HSS_GetCaps`, `JLINK_HSS_Start`, `JLINK_HSS_Read`, `JLINK_HSS_Stop`.
- `HssMemBlockDesc`: 16 bytes.
- `HssCaps`: 32 bytes.
- Calling convention: Windows x64 default ABI candidate, unverified.
- Official local SDK header found: no.
- Public prototype candidate: yes.
- Notice: `HSS_PUBLIC_PROTOTYPE_CANDIDATE_USED_FOR_EXPERIMENT`.

This is not official SEGGER SDK evidence. It is only allowed behind `JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API=1`.
