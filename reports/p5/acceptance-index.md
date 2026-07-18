# P5 End-to-end Acceptance Index

State: `completed`

Review: `reviewOutcome=pass`
Registry observed at finalization: revision `518`

## Identities

- Project: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config` (non-Git, manifest `1813` files, digest `a366f917c6a2f46da86b5cc4e04d933ffdca4aaf69c4ced8e8817cfeeb911b93` before/after acceptance).
- Artifact: `Appl\Debug\Exe\FOC_SCM.out`, SHA-256 `0ab51e0520a7afc2ffe064ac75296670016879958f56842c0e7433270278d5d6`, generation `99b1212f878b34a13f0e0dd207ebf866b874ea763f5a8792bf6a08801b967066`.
- MAP: `Appl\Debug\List\FOC_SCM.map`, SHA-256 `f95d59de4b2b3dcc3ce296069ad5c7d167007d54dea43e01a6284bfdddb2bdaf`.
- Probe: serial `69401227`, target `Z20K146M`, `SWD`, `4000 kHz`.
- Runtime: SEGGER J-Link `V8.84`, DLL SHA-256 `1d53e8ba1ce09fd8719075bd24ba88b7e92192143e521d83a096991f4d6ee875`, helper SHA-256 `01749a6e158c604bb9842957bd3d011af3c67c8bf7efa57d61e082e87ac9c345`, script mode `none`.

## Exit-criteria mapping

### 6.1 Artifact, symbols, Hot Variables, plan

- Current OUT/MAP content discovery, exact identities, `g_hssDbgCounterFocIsr` and `g_hssDbgWriteProbe` resolution/cache, capability/type/rate/duration/bandwidth plan, and external roots: [v14 hardware evidence](hardware/runs/2026-07-18T14-30-00-000+08-00-v14-hss-r2-r4/evidence.json).
- The target is explicitly bound to `Z20K146M`; no address, filename, or target was selected from an ambiguous default.

### 6.2 HSS, R2, R4

- HSS/R2: capture `fa734840-f61e-4c00-9253-689bf996ef58` reached `stopped/ready`; `14` samples and `8` events; Artifact Gate compared all `213860` bytes. R2 write `wr_8b530013-ba29-44e1-bee7-a91e613f3e32`, event `cf013796-5e00-42ca-a970-9141e73c821c`, readback `1`, `readbackOk=true`. Evidence: [v14 hardware evidence](hardware/runs/2026-07-18T14-30-00-000+08-00-v14-hss-r2-r4/evidence.json).
- R4: missing approval returned `approval_required` with no executor call; current-session authorization retained one exact approval; read-only probe command executed through J-Link V8.84; replay returned `approval_replayed`. Challenge `757bb247-9e8b-45fe-974a-eaf312c011d2`, digest `c24d4a70a5501069606d0a2290c4db14c4ceec2c12d6685a3e2ed3d509f5666c`. Evidence: [v16 R4 evidence](hardware/runs/2026-07-18T14-50-00-000+08-00-v16-r4-only/evidence.json).
- v16 action counters: Flash/Erase/reset/halt/resume/R5 all `0`; project manifest unchanged.

### 6.3 JCAP rebuild, bounded queries, analysis, UI

- `capture.db` was removed from the package (with an external recovery backup), rebuilt from raw, and all summary/series/event-window/analysis results remained byte-equivalent at digest `8ca725ee5de97e48f346bce52e82736b0e6df82cdf44cb2029b1e930436ea2fb`.
- Raw hashes before/after: `samples.bin=f81a8720a41be76cb5abab0d593156c839d1b7dc48d255911649f76d81a534b1`; `events.bin=302dde660d10cbd8f6a2338545df7eb00db60c13b2023781d59931dc9fce0470`.
- Loopback UI: page `200`, API without token `401`, bounded summary with token `200`; explicit CSV export created; hardware calls `0`. Evidence: [offline JCAP evidence](offline/jcap-v14-evidence.json).

### 6.4 Artifact stale and targeted refresh

- External fixture generation changed from `2deb1373044321ff20a08d79c7ed2a897e66e6c5feda22c050caf1cbdfaeb4c7` to `4c06e7af0e5b5764e41a32a6adac9509c6d70c6edadf68d9959e8662c13e6fa4`.
- Both requested Hot Variables, the HSS plan, and write plan failed structurally stale; targeted refresh restored only the two requested refs with the new generation/layout. Target project manifest remained unchanged. Evidence: [preflight stale fixture](preflight/latest.json).

### 6.5 Commands and verification

- `node scripts/p5-hardware/run.mjs --r4-only --run-root reports/p5/hardware/runs/2026-07-18T14-50-00-000+08-00-v16-r4-only` — pass.
- `node scripts/p5-hardware/offline-acceptance.mjs` — pass.
- `npm.cmd run build` — pass.
- Focused Node test run covering approval broker/IPC, R4 risk/surfaces, discovery, UI, JCAP/analysis, HSS MVP-A/MVP-B/events/DLL, Probe and GDB risk — `107/107` pass.
- `native/hss-helper/bin/hss_helper.exe self-test` — pass; reset/halt/write/flash all false.
- `openspec validate refactor-jlink-hss-jcap-offline-analysis --strict --no-interactive` — valid.
- `git diff --check` — pass (line-ending warnings only).

## Aggregated targeted review

Reviewed the live approval broker and ephemeral current-session grant, R4 atomic consumption/replay behavior, J-Link installation selection and timeout handling, HSS QPC/artifact error fidelity and transient-read confirmation, runner risk-shape/cleanup/R4-only flow, and JCAP rebuild/UI evidence. The focused tests and live evidence support the intended failure-closed boundaries; no unresolved blocker was found.

## Limitations and deviations

- The original P5 contract prohibited Flash. The user later explicitly authorized a one-time Flash attempt. The successful V8.84 run reported `Skipped. Contents already match`, but J-Link `loadfile` still performed its inherent reset/halt/reset/go sequence. This historical deviation is preserved in [v10 Flash evidence](hardware/runs/2026-07-18T13-20-00-000+08-00-v10-flash/evidence.json); no subsequent Flash was performed.
- Earlier V8/V9 attempts selected the generic V9.52 installation, which lacks `Z20K146M`, causing the device-selection popup/timeouts. Production startup now derives `JLINK_INSTALL_DIR` from `JLINK_DLL_PATH`, and the acceptance runner pins `C:\Program Files\SEGGER\JLink_V884`; v16 proves the exact device connects without a selection dialog.
- v14 recorded `8` transient first-read nonvolatile mismatches while the target was running. Each was accepted only after three immediate byte rereads all matched the Artifact; any repeated mismatch or read failure remains fail-closed.
- Default production approval remains the protected interactive CLI. The non-interactive `--session-authorized` path is disabled unless the server was started with the same random 256-bit ephemeral grant; it exists solely for an explicitly authorized current-session run, is redacted from evidence, retains no token, and permits one exact execution.
