# HM_C095 HSS High-Speed Read/Write Report

Run timestamp: 2026-07-07T00:41:23.3344081+08:00

## Existing Rate Baseline

The previously committed HM_C095 MVP-B evidence used --rate 100 --duration 3 --min-samples 10.

- Local npm run test:hss-mvp-b fake active-write: requested 100Hz, sampleCount=300, overallStatus=pass.
- HM_C095 active-write: requested 100Hz; readiness reported requestedRateHz=100, actualRateHz=100; final capture summary reported actualRateHz=10, sampleCount=125, overallStatus=pass.
- npm run test:hss-mvp-a and npm run test:hss-mvp-b are software regression tests; their rates are fixture/script parameters, not an ECU throughput claim.

## High-Speed Test Matrix

| Area | Command | Requested rate | Result | Evidence |
|---|---:|---:|---|---|
| MVP-A read-only | node scripts/hss-hm-c095-smoke.mjs core4 16000 2 | 16000Hz | failed | capture started but ended with sampleCount=0; query/export failed because capture_0001.bin was missing. |
| MVP-A read-only | node scripts/hss-hm-c095-smoke.mjs core4 1000 3 | 1000Hz | timed out | repeated sampleCount=0; command hit the 180s tool timeout and Node emitted EPIPE when the pipe closed. |
| MVP-B active-write | node scripts/hss-hm-c095-mvp-b-active-write.mjs --rate 1000 --duration 3 --min-samples 10 | 1000Hz | degraded/blocked | write/readback passed, capture got samples, but event window was after last captured sample. |
| MVP-B active-write | node scripts/hss-hm-c095-mvp-b-active-write.mjs --rate 500 --duration 3 --min-samples 10 | 500Hz | failed | write issued but readback mismatched. |
| MVP-B active-write | node scripts/hss-hm-c095-mvp-b-active-write.mjs --rate 200 --duration 3 --min-samples 10 | 200Hz | pass | write/readback, capture quality, event window, and CSV export passed. |

## Current Conclusion

- Stable high-speed active read/write evidence on this ECU is 200Hz requested rate.
- 500Hz is not acceptable because it produced READBACK_MISMATCH.
- 1000Hz active-write is useful as a stress result: RAM write/readback passed, but event-window evidence failed because the event landed after the last captured sample.
- MVP-A standalone smoke high-speed path is currently blocked above the committed evidence path: both 16000Hz and 1000Hz read-only smoke runs produced no decoded samples before failure/timeout.

## MVP-B 1000Hz Stress Summary

~~~json
{
    "overallStatus":  "blocked_by_capture_quality",
    "writePathStatus":  "pass",
    "captureQualityStatus":  "fail",
    "eventWindowStatus":  "fail",
    "requestedRateHz":  1000,
    "readinessActualRateHz":  1000,
    "finalActualRateHz":  1000,
    "sampleCount":  446,
    "readbackOk":  true,
    "warnings":  "event window contains no samples; before window contains no samples; after window contains no samples; after window is incomplete; event is after last captured sample"
}
~~~

## MVP-B 500Hz Failure Summary

~~~json
{
    "overallStatus":  "failed",
    "writePathStatus":  "fail",
    "captureQualityStatus":  "fail",
    "requestedRateHz":  500,
    "readinessActualRateHz":  500,
    "finalActualRateHz":  250.00000000000003,
    "sampleCount":  290,
    "writeErrorCode":  "READBACK_MISMATCH",
    "writeErrorMessage":  "readback does not match written bytes; target state is unknown"
}
~~~

## MVP-B 200Hz Passing Output JSON

~~~json
{
  "fake": false,
  "device": "Z20K146M",
  "target": "g_hssDbgWriteProbe",
  "value": 1,
  "captureId": "ed8f0195-77c0-446b-b7fe-33e810436c02",
  "overallStatus": "pass",
  "writePathStatus": "pass",
  "captureQualityStatus": "pass",
  "eventWindowStatus": "pass",
  "csvExportStatus": "pass",
  "readbackMismatch": false,
  "write": {
    "planOk": true,
    "executeOk": true,
    "readbackOk": true,
    "eventId": "evt_e3983f7b-b499-423e-9098-3b5b76e230e4"
  },
  "capture": {
    "state": "stopped",
    "transportStatus": "pass",
    "dataQualityStatus": "pass",
    "sampleCount": 156,
    "readErrors": 0,
    "timeouts": 0,
    "droppedSamples": 0,
    "actualRateHz": 40
  },
  "eventWindow": {
    "beforeSampleCount": 4,
    "afterSampleCount": 4,
    "deltaAvailable": true,
    "warnings": []
  },
  "elapsedMs": 9575,
  "artifacts": {
    "metadataFile": "D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\captures\\ed8f0195-77c0-446b-b7fe-33e810436c02\\capture.json",
    "csvFile": "D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\exports\\ed8f0195-77c0-446b-b7fe-33e810436c02.csv"
  },
  "diagnostics": {
    "readiness": {
      "ready": true,
      "sampleCount": 64,
      "status": {
        "captureId": "ed8f0195-77c0-446b-b7fe-33e810436c02",
        "state": "capturing",
        "sampleCount": 64,
        "validSamples": 64,
        "readErrors": 0,
        "timeouts": 0,
        "overflows": 0,
        "droppedSamples": 0,
        "elapsedSec": 1.575,
        "actualRateHz": 200,
        "requestedRateHz": 200,
        "sampling": {
          "requestedRateHz": 200,
          "hssIndexRateHz": 200,
          "hostObservedRateHz": 200,
          "helperReportedRateHz": 0,
          "helperActualRateHz": 0,
          "readMode": "periodic"
        },
        "currentSegment": "capture_0001.bin",
        "warnings": []
      }
    },
    "write": {
      "writeId": "wr_0225260e-5290-4cfd-a502-65dcfae442dc",
      "eventId": "evt_e3983f7b-b499-423e-9098-3b5b76e230e4",
      "captureId": "ed8f0195-77c0-446b-b7fe-33e810436c02",
      "targetRef": {
        "kind": "scalar",
        "path": "g_hssDbgWriteProbe"
      },
      "canonicalTarget": "g_hssDbgWriteProbe",
      "oldValue": 2779077210,
      "newValue": 1,
      "readback": 1,
      "readbackOk": true,
      "mismatches": [],
      "hostWriteStartUs": 1783355997314000,
      "hostWriteEndUs": 1783355997357000,
      "writeStartUs": 1783355997314000,
      "writeEndUs": 1783355997357000,
      "sampleIndexNear": 655,
      "risk": "R2",
      "consumedWriteOps": 1,
      "consumedElements": 1,
      "captureWriteStartUs": 3276000,
      "captureWriteEndUs": 3319000,
      "queueStages": [
        {
          "stage": "QUEUED",
          "timeUs": 1783355997314000
        },
        {
          "stage": "PRE_READ_OLD",
          "timeUs": 1783355997314000
        },
        {
          "stage": "WRITING",
          "timeUs": 1783355997327000
        },
        {
          "stage": "READBACK",
          "timeUs": 1783355997341000
        },
        {
          "stage": "EVENT_APPEND",
          "timeUs": 1783355997358000
        },
        {
          "stage": "FLAG_APPEND",
          "timeUs": 1783355997359000
        }
      ]
    },
    "captureQuality": {
      "sampleCount": 156,
      "validSamples": 156,
      "readErrors": 0,
      "timeouts": 0,
      "overflows": 0,
      "droppedSamples": 0,
      "targetHaltedSamples": 0,
      "actualRateHz": 40
    },
    "transportStatus": "pass",
    "dataQualityStatus": "pass",
    "failures": [],
    "helperResult": {
      "status": "stopped",
      "captureId": "ed8f0195-77c0-446b-b7fe-33e810436c02",
      "backend": "jlink-hss",
      "requestedRateHz": 200,
      "readMode": "periodic",
      "resumeBeforeStart": false,
      "resumeIssued": false,
      "targetWasHaltedBeforeResume": false,
      "targetHaltedBeforeResumeRaw": 0,
      "targetWasHaltedAfterResume": false,
      "targetHaltedAfterResumeRaw": 0,
      "actualRateHz": 228.434,
      "durationSec": 0.682909,
      "sampleCount": 156,
      "requestedSamples": 600,
      "validSamples": 156,
      "readErrors": 0,
      "hssBlockCount": 3,
      "hssSampleHeaderBytes": 4,
      "hssSampleStrideBytes": 40,
      "readAttempts": 129,
      "decodedSamples": 156,
      "emptyReads": 72,
      "shortReads": 0,
      "missingSamples": 0,
      "bytesPerSample": 36,
      "readBufferBytes": 4096,
      "firstReadReturnCode": 0,
      "lastReadReturnCode": 120,
      "minReadReturnCode": 0,
      "maxReadReturnCode": 240,
      "firstReadBufferChanged": false,
      "lastReadBufferChanged": true,
      "firstReadSamplePrefixChanged": false,
      "lastReadSamplePrefixChanged": true,
      "unchangedReads": 72,
      "changedReads": 57,
      "samplePrefixChangedReads": 57,
      "headerChangedReads": 57,
      "payloadChangedReads": 57,
      "firstChangedOffset": 0,
      "firstChangedBytes": "00000000f81503076127000061270000",
      "headerChangedRatio": 0.44186,
      "payloadChangedRatio": 0.44186,
      "payloadFirstChangedOffset": 4,
      "payloadFirstChangedBytes": "f8150307612700006127000001000000",
      "layout": {
        "hssSampleHeaderBytes": 4,
        "hssSampleStrideBytes": 40,
        "bytesPerSample": 36,
        "hssBlockCount": 3,
        "readBufferBytes": 4096,
        "firstChangedOffset": 0,
        "firstChangedBytes": "00000000f81503076127000061270000",
        "headerChangedRatio": 0.44186,
        "payloadChangedRatio": 0.44186,
        "payloadFirstChangedOffset": 4,
        "payloadFirstChangedBytes": "f8150307612700006127000001000000"
      },
      "timeouts": 0,
      "overflows": 0,
      "droppedSamples": 0,
      "targetReset": false,
      "targetWritten": true,
      "flashIssued": false,
      "resetIssued": false,
      "haltIssued": false,
      "segment": {
        "file": "capture_0001.bin",
        "sampleStart": 0,
        "sampleCount": 156,
        "crc32": "290c831c"
      },
      "stopReturnCode": 0,
      "diagnostic": {
        "captureId": "ed8f0195-77c0-446b-b7fe-33e810436c02",
        "stage": "after_hss_stop",
        "timeNs": 8194295146499,
        "readAttempts": 129,
        "validSamples": 156,
        "lastReadReturnCode": 120
      }
    },
    "eventWindow": {
      "event": {
        "eventId": "evt_e3983f7b-b499-423e-9098-3b5b76e230e4",
        "type": "variable_write",
        "writeKind": "scalar",
        "writeId": "wr_0225260e-5290-4cfd-a502-65dcfae442dc",
        "captureId": "ed8f0195-77c0-446b-b7fe-33e810436c02",
        "target": "g_hssDbgWriteProbe",
        "canonicalTarget": "g_hssDbgWriteProbe",
        "targetRef": {
          "kind": "scalar",
          "path": "g_hssDbgWriteProbe"
        },
        "basePath": "g_hssDbgWriteProbe",
        "address": 536872964,
        "dataType": "uint32",
        "byteSize": 4,
        "elementCount": 1,
        "writeByteCount": 4,
        "oldValue": 2779077210,
        "newValue": 1,
        "readback": 1,
        "readbackOk": true,
        "mismatches": [],
        "hostWriteStartUs": 1783355997314000,
        "hostWriteEndUs": 1783355997357000,
        "captureWriteStartUs": 3276000,
        "captureWriteEndUs": 3319000,
        "writeStartUs": 1783355997314000,
        "writeEndUs": 1783355997357000,
        "sampleIndexNear": 655,
        "risk": "R2",
        "policyHash": "02d72cdfe6f0cca58052e3df81603f3c06e2171fdb32f697caf11bb016dcc83e",
        "symbolLayoutHash": "223c7739a320fc7c8a95455581a787cd926e89b3bda256d3c966e8fca1229de4",
        "ok": true
      },
      "before": {
        "sampleStart": 640,
        "sampleEnd": 655,
        "sampleCount": 4,
        "durationMs": 100,
        "summary": {
          "g_hssDbgCounterFocIsr": {
            "count": 4,
            "first": 2161,
            "last": 2261,
            "delta": 100,
            "min": 2161,
            "max": 2261,
            "avg": 2211.25
          },
          "g_hssDbgSawFocIsr": {
            "count": 4,
            "first": 2161,
            "last": 2261,
            "delta": 100,
            "min": 2161,
            "max": 2261,
            "avg": 2211.25
          },
          "g_hssDbgToggleFocIsr": {
            "count": 4,
            "first": 0,
            "last": 0,
            "delta": 0,
            "min": 0,
            "max": 1,
            "avg": 0.25
          },
          "g_hssDbgPatternFocIsr": {
            "count": 4,
            "first": 3698345447,
            "last": 1191832171,
            "delta": -2506513276,
            "min": 40551354,
            "max": 3698345447,
            "avg": 1596509247.25
          },
          "g_hssDbgRawAdcM1U": {
            "count": 4,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2040,
            "avg": 2039.25
          },
          "g_hssDbgRawAdcM1V": {
            "count": 4,
            "first": 2033,
            "last": 2034,
            "delta": 1,
            "min": 2033,
            "max": 2034,
            "avg": 2033.5
          },
          "g_hssDbgRawAdcM2U": {
            "count": 4,
            "first": 2033,
            "last": 2034,
            "delta": 1,
            "min": 2033,
            "max": 2035,
            "avg": 2034
          },
          "g_hssDbgRawAdcM2V": {
            "count": 4,
            "first": 2038,
            "last": 2039,
            "delta": 1,
            "min": 2038,
            "max": 2039,
            "avg": 2038.5
          },
          "g_hssDbgOffsetM1U": {
            "count": 4,
            "first": 0,
            "last": 0,
            "delta": 0,
            "min": 0,
            "max": 0,
            "avg": 0
          },
          "g_hssDbgOffsetM1V": {
            "count": 4,
            "first": 0,
            "last": 0,
            "delta": 0,
            "min": 0,
            "max": 1,
            "avg": 0.25
          }
        }
      },
      "after": {
        "sampleStart": 660,
        "sampleEnd": 675,
        "sampleCount": 4,
        "durationMs": 100,
        "summary": {
          "g_hssDbgCounterFocIsr": {
            "count": 4,
            "first": 2295,
            "last": 2395,
            "delta": 100,
            "min": 2295,
            "max": 2395,
            "avg": 2344.75
          },
          "g_hssDbgSawFocIsr": {
            "count": 4,
            "first": 2295,
            "last": 2395,
            "delta": 100,
            "min": 2295,
            "max": 2395,
            "avg": 2345
          },
          "g_hssDbgToggleFocIsr": {
            "count": 4,
            "first": 1,
            "last": 1,
            "delta": 0,
            "min": 0,
            "max": 1,
            "avg": 0.5
          },
          "g_hssDbgPatternFocIsr": {
            "count": 4,
            "first": 2589651054,
            "last": 2667450457,
            "delta": 77799403,
            "min": 395934511,
            "max": 3078393456,
            "avg": 2182857369.5
          },
          "g_hssDbgRawAdcM1U": {
            "count": 4,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2039,
            "avg": 2039
          },
          "g_hssDbgRawAdcM1V": {
            "count": 4,
            "first": 2033,
            "last": 2033,
            "delta": 0,
            "min": 2033,
            "max": 2034,
            "avg": 2033.25
          },
          "g_hssDbgRawAdcM2U": {
            "count": 4,
            "first": 2034,
            "last": 2034,
            "delta": 0,
            "min": 2034,
            "max": 2035,
            "avg": 2034.25
          },
          "g_hssDbgRawAdcM2V": {
            "count": 4,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2039,
            "avg": 2039
          },
          "g_hssDbgOffsetM1U": {
            "count": 4,
            "first": 0,
            "last": 0,
            "delta": 0,
            "min": 0,
            "max": 1,
            "avg": 0.25
          },
          "g_hssDbgOffsetM1V": {
            "count": 4,
            "first": 0,
            "last": 0,
            "delta": 0,
            "min": 0,
            "max": 1,
            "avg": 0.25
          }
        }
      },
      "delta": {
        "g_hssDbgCounterFocIsr": {
          "before": 2261,
          "after": 2295,
          "delta": 34
        },
        "g_hssDbgSawFocIsr": {
          "before": 2261,
          "after": 2295,
          "delta": 34
        },
        "g_hssDbgToggleFocIsr": {
          "before": 0,
          "after": 1,
          "delta": 1
        },
        "g_hssDbgPatternFocIsr": {
          "before": 1191832171,
          "after": 2589651054,
          "delta": 1397818883
        },
        "g_hssDbgRawAdcM1U": {
          "before": 2039,
          "after": 2039,
          "delta": 0
        },
        "g_hssDbgRawAdcM1V": {
          "before": 2034,
          "after": 2033,
          "delta": -1
        },
        "g_hssDbgRawAdcM2U": {
          "before": 2034,
          "after": 2034,
          "delta": 0
        },
        "g_hssDbgRawAdcM2V": {
          "before": 2039,
          "after": 2039,
          "delta": 0
        },
        "g_hssDbgOffsetM1U": {
          "before": 0,
          "after": 0,
          "delta": 0
        },
        "g_hssDbgOffsetM1V": {
          "before": 0,
          "after": 0,
          "delta": 0
        }
      },
      "quality": {
        "excludedSamples": 0,
        "writeNearbySamples": 2,
        "writeInProgressSamples": 1,
        "backendBusySamples": 0,
        "warnings": []
      },
      "eventId": "evt_e3983f7b-b499-423e-9098-3b5b76e230e4",
      "requestedStartSec": 3.176,
      "startSec": 3.176,
      "eventSec": 3.276,
      "requestedEndSec": 3.376,
      "endSec": 3.376,
      "firstSampleSec": 0,
      "lastSampleSec": 3.875,
      "sampleCount": 8,
      "summary": {
        "g_hssDbgCounterFocIsr": {
          "count": 8,
          "first": 2161,
          "last": 2395,
          "delta": 234,
          "min": 2161,
          "max": 2395,
          "avg": 2278
        },
        "g_hssDbgSawFocIsr": {
          "count": 8,
          "first": 2161,
          "last": 2395,
          "delta": 234,
          "min": 2161,
          "max": 2395,
          "avg": 2278.125
        },
        "g_hssDbgToggleFocIsr": {
          "count": 8,
          "first": 0,
          "last": 1,
          "delta": 1,
          "min": 0,
          "max": 1,
          "avg": 0.375
        },
        "g_hssDbgPatternFocIsr": {
          "count": 8,
          "first": 3698345447,
          "last": 2667450457,
          "delta": -1030894990,
          "min": 40551354,
          "max": 3698345447,
          "avg": 1889683308.375
        },
        "g_hssDbgRawAdcM1U": {
          "count": 8,
          "first": 2039,
          "last": 2039,
          "delta": 0,
          "min": 2039,
          "max": 2040,
          "avg": 2039.125
        },
        "g_hssDbgRawAdcM1V": {
          "count": 8,
          "first": 2033,
          "last": 2033,
          "delta": 0,
          "min": 2033,
          "max": 2034,
          "avg": 2033.375
        },
        "g_hssDbgRawAdcM2U": {
          "count": 8,
          "first": 2033,
          "last": 2034,
          "delta": 1,
          "min": 2033,
          "max": 2035,
          "avg": 2034.125
        },
        "g_hssDbgRawAdcM2V": {
          "count": 8,
          "first": 2038,
          "last": 2039,
          "delta": 1,
          "min": 2038,
          "max": 2039,
          "avg": 2038.75
        },
        "g_hssDbgOffsetM1U": {
          "count": 8,
          "first": 0,
          "last": 0,
          "delta": 0,
          "min": 0,
          "max": 1,
          "avg": 0.125
        },
        "g_hssDbgOffsetM1V": {
          "count": 8,
          "first": 0,
          "last": 0,
          "delta": 0,
          "min": 0,
          "max": 1,
          "avg": 0.25
        }
      }
    },
    "warnings": []
  }
}
~~~

## MVP-A 16000Hz Read-Only Tail

~~~text
    "sampling": {
      "requestedRateHz": 16000,
      "actualRateHz": 0,
      "hssIndexRateHz": 0,
      "hostObservedRateHz": 0,
      "helperReportedRateHz": 0,
      "helperActualRateHz": 0,
      "readMode": "periodic",
      "durationSec": 0,
      "timestampSource": "qpc",
      "timestampFrequency": "1000000000"
    },
    "sampleCount": 0,
    "validSamples": 0,
    "readErrors": 0,
    "timeouts": 0,
    "overflows": 0,
    "droppedSamples": 0,
    "currentSegment": "capture_0001.bin",
    "warnings": []
  },
  "risk": {
    "level": "R0",
    "requiresUserApproval": false
  },
  "backend": {
    "selected": "jlink-hss",
    "fallbackFrom": null,
    "reason": null
  },
  "artifacts": [
    "capture_0001.bin"
  ],
  "warnings": [],
  "message": "completed"
}
{
  "ok": false,
  "operation": "hss_capture_query",
  "data": null,
  "risk": {
    "level": "R0",
    "requiresUserApproval": false
  },
  "backend": {
    "selected": null,
    "fallbackFrom": null,
    "reason": "ENOENT: no such file or directory, open 'D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\captures\\911a5141-1d86-41c0-8740-11782a333f7c\\capture_0001.bin'"
  },
  "artifacts": [],
  "warnings": [],
  "message": "failed",
  "error": {
    "code": "HSS_HELPER_BAD_JSON",
    "message": "ENOENT: no such file or directory, open 'D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\captures\\911a5141-1d86-41c0-8740-11782a333f7c\\capture_0001.bin'",
    "details": {}
  }
}
{
  "ok": false,
  "operation": "hss_capture_export",
  "data": null,
  "risk": {
    "level": "R0",
    "requiresUserApproval": false
  },
  "backend": {
    "selected": null,
    "fallbackFrom": null,
    "reason": "ENOENT: no such file or directory, open 'D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\captures\\911a5141-1d86-41c0-8740-11782a333f7c\\capture_0001.bin'"
  },
  "artifacts": [],
  "warnings": [],
  "message": "failed",
  "error": {
    "code": "HSS_HELPER_BAD_JSON",
    "message": "ENOENT: no such file or directory, open 'D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\captures\\911a5141-1d86-41c0-8740-11782a333f7c\\capture_0001.bin'",
    "details": {}
  }
}
~~~

## MVP-A 1000Hz Read-Only Tail

~~~text
  "operation": "hss_capture_status",
  "data": {
    "captureId": "24d81c98-9e8d-44a0-9525-f9579b0ffb6f",
    "state": "capturing",
    "sampleCount": 0,
    "validSamples": 0,
    "readErrors": 0,
    "timeouts": 0,
    "overflows": 0,
    "droppedSamples": 0,
    "elapsedSec": 0,
    "actualRateHz": 0,
    "requestedRateHz": 1000,
    "sampling": {
      "requestedRateHz": 1000,
      "hssIndexRateHz": 0,
      "hostObservedRateHz": 0,
      "helperReportedRateHz": 0,
      "helperActualRateHz": 0,
      "readMode": "periodic"
    },
    "currentSegment": "capture_0001.bin",
    "warnings": []
  },
  "risk": {
    "level": "R0",
    "requiresUserApproval": false
  },
  "backend": {
    "selected": "jlink-hss",
    "fallbackFrom": null,
    "reason": null
  },
  "artifacts": [
    "capture_0001.bin"
  ],
  "warnings": [],
  "message": "completed"
}
{
  "ok": true,
  "operation": "hss_capture_status",
  "data": {
    "captureId": "24d81c98-9e8d-44a0-9525-f9579b0ffb6f",
    "state": "capturing",
    "sampleCount": 0,
    "validSamples": 0,
    "readErrors": 0,
    "timeouts": 0,
    "overflows": 0,
    "droppedSamples": 0,
    "elapsedSec": 0,
    "actualRateHz": 0,
    "requestedRateHz": 1000,
    "sampling": {
      "requestedRateHz": 1000,
      "hssIndexRateHz": 0,
      "hostObservedRateHz": 0,
      "helperReportedRateHz": 0,
      "helperActualRateHz": 0,
      "readMode": "periodic"
    },
    "currentSegment": "capture_0001.bin",
    "warnings": []
  },
  "risk": {
    "level": "R0",
    "requiresUserApproval": false
  },
  "backend": {
    "selected": "jlink-hss",
    "fallbackFrom": null,
    "reason": null
  },
  "artifacts": [
    "capture_0001.bin"
  ],
  "warnings": [],
  "message": "completed"
}
~~~
