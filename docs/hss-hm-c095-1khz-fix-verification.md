# HM_C095 HSS 1kHz Fix Verification

Run date: 2026-07-07

## Code Changes Verified

- Native HSS helper sends `SuppressGUI = 1` after `JLINKARM_Open`, before device/connect, to prevent J-Link DLL dialogs from blocking headless read-only runs.
- Native HSS helper flushes the capture segment after decoded HSS samples, so live `captureStatus` can observe samples during high-rate captures.
- Active-write events are anchored to the HSS segment sample timeline instead of Node host process start time. This fixes the previous 1000Hz false failure where `captureWriteStartUs` landed after the last captured sample.
- `captureStart` still rejects a halted target by default, but accepts explicit `resumeBeforeStart: true` for read-only recovery when the ECU is already stopped.
- `scripts/hss-hm-c095-mvp-b-active-write.mjs` supports `--pre-write-ms` and `--post-write-ms`; the 1kHz HM_C095 run used explicit waits to preserve a full before/after event window.

## Local Regression Evidence

| Command | Result |
|---|---|
| `npm run compile` | pass |
| `npm run build:hss` | pass |
| `npm run test:hss-mvp-a` | pass, 18/18 |
| `npm run test:hss-mvp-b` | pass, 44/44 plus fake active-write pass |
| `npm run test:hss-dll` | pass, 8/8 |

## HM_C095 1kHz Read-Only Evidence

Command:

```powershell
$env:JLINK_DEVICE='Z20K146M'
node D:\AI_Project\Trunk\Jlink_mcp\scripts\hss-hm-c095-smoke.mjs core4 1000 3 'C:\Program Files\SEGGER\JLink_V884\JLink_x64.dll' periodic resume
```

Result summary:

```json
{
  "captureId": "bc16fa4d-a1ac-4a13-b633-bc81118005fe",
  "requestedRateHz": 1000,
  "actualRateHz": 1000,
  "sampleCount": 3000,
  "validSamples": 3000,
  "readErrors": 0,
  "timeouts": 0,
  "overflows": 0,
  "droppedSamples": 0,
  "transportStatus": "pass",
  "dataQualityStatus": "pass",
  "payloadValidationStatus": "pass",
  "semanticValidationStatus": "failed"
}
```

Artifacts:

- `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\.jlink-mcp\captures\bc16fa4d-a1ac-4a13-b633-bc81118005fe\capture.json`
- `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\.jlink-mcp\exports\bc16fa4d-a1ac-4a13-b633-bc81118005fe.csv`

Interpretation:

- MVP-A read-only transport supports 1kHz on the connected HM_C095 ECU.
- The semantic profile still fails because the observed debug counter/pattern behavior does not match the HM_C095 semantic expectation; this is not a transport throughput failure.

## HM_C095 1kHz Active Write/Read Evidence

Command:

```powershell
$env:JLINK_DEVICE='Z20K146M'
node D:\AI_Project\Trunk\Jlink_mcp\scripts\hss-hm-c095-mvp-b-active-write.mjs --rate 1000 --duration 3 --min-samples 100 --pre-write-ms 250 --post-write-ms 500
```

Result summary:

```json
{
  "captureId": "875960f6-1f03-4045-9df5-7483c58a730b",
  "overallStatus": "pass",
  "writePathStatus": "pass",
  "captureQualityStatus": "pass",
  "eventWindowStatus": "pass",
  "csvExportStatus": "pass",
  "readbackMismatch": false,
  "requestedRateHz": 1000,
  "actualRateHz": 1000,
  "sampleCount": 1124,
  "validSamples": 1124,
  "readErrors": 0,
  "timeouts": 0,
  "droppedSamples": 0,
  "readbackOk": true,
  "oldValue": 2779077210,
  "newValue": 1,
  "readback": 1,
  "eventSec": 0.498,
  "beforeSampleCount": 100,
  "afterSampleCount": 100,
  "eventWindowWarnings": []
}
```

Artifacts:

- `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\.jlink-mcp\captures\875960f6-1f03-4045-9df5-7483c58a730b\capture.json`
- `D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config\.jlink-mcp\exports\875960f6-1f03-4045-9df5-7483c58a730b.csv`

Interpretation:

- MVP-B active write/readback has passing 1kHz HM_C095 evidence.
- The previous 1000Hz active-write failure was caused by event timestamping against Node host start time, not by the write/readback path itself.
- The previous read-only timeout was consistent with a blocking J-Link GUI dialog and live segment buffering; both paths were addressed.

