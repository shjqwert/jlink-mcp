# HSS MVP-B Round 5 HM_C095 Hardware Report

Date: 2026-07-03

## Scope

Run HM_C095 hardware MVP-B validation with a dedicated safe scalar write target.

## Target Inputs

- Project: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config`
- Artifact: `Appl\Debug\Exe\FOC_SCM.out`
- Map: `Appl\Debug\List\FOC_SCM.map`
- Policy: `.jlink-mcp\policy.json`
- Safe write target: `g_hssDbgWriteProbe`
- Observation variables:
  - `g_hssDbgCounterFocIsr`
  - `g_hssDbgSawFocIsr`
  - `g_hssDbgToggleFocIsr`
  - `g_hssDbgPatternFocIsr`

## Changes

- `scripts/hss-hm-c095-mvp-b-smoke.mjs`
  - Rejects policies that allow writing HSS observation variables.
  - Accepts `g_hssDbgWriteProbe` as the HM_C095 safe scalar write target.
  - Handles UTF-8 BOM in `policy.json`.
- `docs/hss-mvp-b-hm-c095.md`
  - Documents scalar-only helper-backed hardware validation.
  - Documents that observation variables must not be written.
- `src/mcp/hss/hss-policy.ts`
  - Handles UTF-8 BOM in `policy.json`.
- `src/mcp/hss/hss-capture-service.ts`
  - Fixes a dispose race when the helper exits while `dispose()` is waiting.
- `src/mcp/hss/hss-artifact.ts`
  - Keeps payload quality based on decoded sample records instead of helper read-attempt ratios.
- `native/hss-helper/hss_helper.cpp`
  - Uses `JLINKARM_ReadMemU8/U16/U32` and `JLINKARM_WriteU8/U16/U32` for scalar IPC memory operations, with the existing `ReadMem/WriteMem` path as fallback.

## Hardware Result

Capture: `3293a3f0-827c-4b1a-93b1-e0c306f30129`

| Check | Result |
| --- | --- |
| `variable_write_execute` | Pass |
| `readbackOk` | `true` |
| Capture state | `completed` |
| `transportStatus` | `pass` |
| `dataQualityStatus` | `pass` |
| Valid samples | `3000/3000` |
| Read errors / timeouts / drops | `0 / 0 / 0` |
| Reset / halt / flash issued | `false / false / false` |
| Query event window | Pass |
| Event-aware CSV export | Pass |
| MVP-B validator | Pass |

Artifacts:

- Metadata: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\.jlink-mcp\captures\3293a3f0-827c-4b1a-93b1-e0c306f30129\capture.json`
- CSV: `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\.jlink-mcp\exports\3293a3f0-827c-4b1a-93b1-e0c306f30129.csv`

## Verification

| Command | Result |
| --- | --- |
| `node scripts\hss-validate-mvp-b-capture.mjs <capture.json>` | Pass |
| `node scripts\hss-hm-c095-mvp-b-smoke.mjs` from HM_C095 cwd | Ready, safe target only |
| `npm.cmd run build:hss` | Pass |
| `native\hss-helper\build\Release\hss_helper.exe self-test` | Pass |
| `npm.cmd run test:hss-dll` | Pass: 8/8 |
| `npm.cmd run test:hss-mvp-a` | Pass: 18/18 |
| `npm.cmd run test:hss-mvp-b` | Pass: 36/36 |

## Notes

- The target policy was corrected outside this repository: observation variables were removed from `.jlink-mcp\policy.json`; the previous file was saved as `.jlink-mcp\policy.before-observation-split.json`.
- `semanticValidationStatus` remains `failed` because the HM_C095 counter-rate assumption does not match the observed firmware cadence. This did not affect the MVP-B transport/data-quality validator after sample-level payload quality was fixed.
