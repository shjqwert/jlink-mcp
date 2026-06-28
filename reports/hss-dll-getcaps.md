# HSS DLL GetCaps

Result: `HSS_GETCAPS_TIMEOUT`.

`JLINK_HSS_GetCaps` was called only inside the isolated native helper with `JLINK_MCP_EXPERIMENTAL_HSS_UNVERIFIED_API=1`. It did not return before the 5 second wrapper timeout.

Safety:

- Target connected: no.
- Reset/halt/flash issued: no.
- Target write issued: no.

This is not HSS PASS.
