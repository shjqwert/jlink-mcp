# HM_C095 HSS MVP-A Validation

Run MCP from:

`D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config`

Target facts:

- IAR project: `Appl\FOC_SCM.ewp`
- Artifact: `FOC_SCM.out`
- Map fallback: `FOC_SCM.map`
- Device: `Z20K146MC`
- Interface: `SWD`
- FOC ISR: 16000 Hz

Required variables:

- `g_hssDbgCounterFocIsr`
- `g_hssDbgSawFocIsr`
- `g_hssDbgToggleFocIsr`
- `g_hssDbgPatternFocIsr`
- `g_hssDbgRawAdcM1U`
- `g_hssDbgRawAdcM1V`
- `g_hssDbgRawAdcM2U`
- `g_hssDbgRawAdcM2V`
- `g_hssDbgOffsetM1U`
- `g_hssDbgOffsetM1V`

Validation matrix:

| Case | Expected |
|---|---|
| 1 var @100Hz/2s | counter delta about 160 |
| 1 var @1000Hz/3s | counter delta about 16 |
| 4 core vars @1000Hz/3s | counter delta about 16, saw follows low 16 bits, pattern changes |
| 4 core vars @8000Hz/3s | counter delta about 2 |
| 4 core vars @16000Hz/2s | attempted; pass if actual rate >=15000 and delta about 1, otherwise capability-limited result |
| 10 vars @4000Hz/5s | all decode and counter validation passes |
| 10 vars @8000Hz/5s | pass if capability allows, otherwise structured capability-limited result |

Commands after `npm run compile`:

- `node scripts/hss-hm-c095-smoke.mjs 1000 3`
- `node scripts/hss-hm-c095-smoke.mjs core4 1000 3`
- `node scripts/hss-hm-c095-smoke.mjs core4 8000 3`
- `node scripts/hss-hm-c095-smoke.mjs core4 16000 2`
- `node scripts/hss-hm-c095-smoke.mjs full10 4000 5`
- `node scripts/hss-hm-c095-smoke.mjs full10 8000 5`
- `node scripts/hss-validate-capture.mjs <captureId>`

Safety metadata in every `capture.json` must keep `targetReset`, `targetWritten`, `flashIssued`, `resetIssued`, and `haltIssued` false.
