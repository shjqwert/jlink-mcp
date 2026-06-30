# Goal: HM_C095 HSS MVP-A

Implement and validate the read-only HSS MVP-A workflow for HM_C095.

Done:

- `hss_capability_probe` reports DLL/helper/HSS export status.
- `hss_capture_plan` resolves `g_hssDbgCounterFocIsr` from `FOC_SCM.out` or `FOC_SCM.map`.
- `hss_capture_start/status/stop` runs a read-only HSS session.
- `capture_0001.bin` and `capture.json` are generated under `.jlink-mcp/captures/<captureId>`.
- `hss_capture_query` validates HM_C095 counter progression.
- `hss_capture_export` writes `.jlink-mcp/exports/<captureId>.csv`.
- Safety fields remain false.
- `npm run compile`, `npm run build:hss`, `npm run test:hss-dll`, and `npm run test:hss-mvp-a` pass.
