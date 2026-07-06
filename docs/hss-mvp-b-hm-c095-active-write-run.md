# HSS MVP-B HM_C095 Evidence

Run timestamp: 2026-07-07T00:30:57.8691975+08:00

## test:hss-mvp-b actual run log

Workdir: D:\AI_Project\Trunk\Jlink_mcp

~~~text

> jlink-mcp@0.3.2 test:hss-mvp-b
> npm run compile && node --test out/mcp/hss/hss-policy.test.js out/mcp/hss/hss-write-layout.test.js out/mcp/hss/hss-typed-value.test.js out/mcp/hss/hss-write-plan.test.js out/mcp/hss/hss-write-plan-store.test.js out/mcp/hss/hss-write-queue.test.js out/mcp/hss/hss-write-execute.test.js out/mcp/hss/hss-events.test.js out/mcp/hss/hss-flag-overlay.test.js out/mcp/hss/hss-query-event-window.test.js out/mcp/hss/hss-export-event-aware.test.js out/mcp/hss/hss-audit.test.js out/mcp/hss/hss-mvp-b-integration.test.js && node scripts/hss-hm-c095-mvp-b-active-write.mjs --fake


> jlink-mcp@0.3.2 compile
> tsc -p ./

✔ HSS audit records MVP-B write fields at top level (56.0624ms)
✔ capture write events append to jsonl and materialize into capture.json (57.5711ms)
✔ capture write events store host and capture write time separately (10.409ms)
✔ large capture write events use sidecar artifacts (24.7032ms)
✔ hss_capture_export writes event-aware CSV without changing normal export (127.7336ms)
✔ flag overlay appends write intervals and materializes capture.json (110.3238ms)
✔ MVP-B fake/injected memoryIo covers scalar write and draft array write paths (1923.7858ms)
✔ MVP-B helper IPC completes scalar writes and rejects non-scalar writes (1483.026ms)
✔ variable_write_execute supports outside-capture scalar writes and rejects active bypass (1474.3241ms)
✔ variable_write_plan rejects active capture after helper exit (7.0022ms)
✔ hss_capture_stop timeout kills helper and finalizes failed metadata (441.0755ms)
✔ hss_session_recover marks abandoned local capture metadata (11.8008ms)
✔ policy v2 accepts scalar allowlist entries (22.9022ms)
✔ policy v2 accepts fixed array allowlist entries (2.1643ms)
✔ policy v2 rejects invalid element type (3.178ms)
✔ policy v2 rejects missing arrayLength (0.4637ms)
✔ policy v2 rejects allowedIndices outside array bounds (0.336ms)
✔ policy v2 rejects allowedIndexRange outside array bounds (0.2386ms)
✔ policy v2 rejects maxBytesPerWrite smaller than slice byte count (0.2614ms)
✔ policy v2 preserves slice disabled and R3 plan-only entries (0.3472ms)
✔ policy loader reports malformed JSON and unsupported version (63.0302ms)
✔ hss_capture_query supports event_window with effective flags and summary (161.0066ms)
✔ hss_capture_query event_window reports warnings when windows have no samples (228.915ms)
✔ typed values encode integer min/max ranges (1.4859ms)
✔ typed values encode unsigned ranges and reject negatives (1.1622ms)
✔ typed values reject float NaN and Inf and preserve finite float32 bytes (0.835ms)
✔ typed values honor target endian (1.0943ms)
✔ typed arrays encode and decode exact element counts (0.5101ms)
✔ variable_write_execute writes scalar, array element, and array slice with readback (6.3435ms)
✔ variable_write_execute supports dryRun without memory changes (0.5283ms)
✔ variable_write_execute reports old read, write, readback, and mismatch failures without rollback (10.6943ms)
✔ write layout resolves RAM scalar, static scalar, and struct member scalar (80.2069ms)
✔ write layout resolves global, static, and member fixed arrays (50.0275ms)
✔ write layout rejects pointer, dynamic, incomplete, non-RAM, and size mismatch arrays (27.5719ms)
✔ write plan store validates lookup and invalidates stale plans (41.0393ms)
✔ write plan store rejects expired and already executed plans (48.2293ms)
✔ variable_write_plan supports scalar, array element, and array slice (45.6047ms)
✔ variable_write_plan rejects unsafe target and policy cases (14.0472ms)
✔ variable_write_plan enforces counters, bytes, R3 plan-only, and RAM layout (11.1443ms)
✔ HSS write queue allows one job and rejects concurrent jobs (2.1953ms)
✔ HSS write queue records scalar write stages (1.5425ms)
✔ HSS write queue releases lock after failure and rejects when stopping (0.7162ms)
✔ HSS write queue waitForIdle lets current write finish while stopping (2.3305ms)
ℹ tests 43
ℹ suites 0
ℹ pass 43
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5840.3482
{
  "fake": true,
  "device": "Z20K146M",
  "target": "Debug_IqRef",
  "value": 1,
  "captureId": "f691bc95-f039-4be5-9819-e1caa28a52bc",
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
    "eventId": "evt_54d808c5-f848-4d2f-b076-c9538f8d7240"
  },
  "capture": {
    "state": "completed",
    "transportStatus": "pass",
    "dataQualityStatus": "pass",
    "sampleCount": 300,
    "readErrors": 0,
    "timeouts": 0,
    "droppedSamples": 0,
    "actualRateHz": 99.99999999999999
  },
  "eventWindow": {
    "beforeSampleCount": 10,
    "afterSampleCount": 10,
    "deltaAvailable": true,
    "warnings": []
  },
  "elapsedMs": 1485,
  "artifacts": {
    "metadataFile": "D:\\AI_Project\\Trunk\\Jlink_mcp\\.tmp\\hss-active-write-1783355397225-6b482f35b1f808\\.jlink-mcp\\captures\\f691bc95-f039-4be5-9819-e1caa28a52bc\\capture.json",
    "csvFile": "D:\\AI_Project\\Trunk\\Jlink_mcp\\.tmp\\hss-active-write-1783355397225-6b482f35b1f808\\.jlink-mcp\\exports\\f691bc95-f039-4be5-9819-e1caa28a52bc.csv"
  },
  "diagnostics": {
    "readiness": {
      "ready": true,
      "sampleCount": 300,
      "status": {
        "captureId": "f691bc95-f039-4be5-9819-e1caa28a52bc",
        "state": "capturing",
        "sampleCount": 300,
        "validSamples": 300,
        "readErrors": 0,
        "timeouts": 0,
        "overflows": 0,
        "droppedSamples": 0,
        "elapsedSec": 2.99,
        "actualRateHz": 99.99999999999999,
        "requestedRateHz": 100,
        "sampling": {
          "requestedRateHz": 100,
          "hssIndexRateHz": 99.99999999999999,
          "hostObservedRateHz": 99.99999999999999,
          "helperReportedRateHz": 0,
          "helperActualRateHz": 0,
          "readMode": "periodic"
        },
        "currentSegment": "capture_0001.bin",
        "warnings": []
      }
    },
    "write": {
      "writeId": "wr_ebc15187-7867-4535-b3f3-89115c1587b4",
      "eventId": "evt_54d808c5-f848-4d2f-b076-c9538f8d7240",
      "captureId": "f691bc95-f039-4be5-9819-e1caa28a52bc",
      "targetRef": {
        "kind": "scalar",
        "path": "Debug_IqRef"
      },
      "canonicalTarget": "Debug_IqRef",
      "oldValue": 0,
      "newValue": 1,
      "readback": 1,
      "readbackOk": true,
      "mismatches": [],
      "hostWriteStartUs": 1783355397734000,
      "hostWriteEndUs": 1783355397825000,
      "writeStartUs": 1783355397734000,
      "writeEndUs": 1783355397825000,
      "sampleIndexNear": 13,
      "risk": "R2",
      "consumedWriteOps": 1,
      "consumedElements": 1,
      "captureWriteStartUs": 126000,
      "captureWriteEndUs": 217000,
      "queueStages": [
        {
          "stage": "QUEUED",
          "timeUs": 1783355397734000
        },
        {
          "stage": "PRE_READ_OLD",
          "timeUs": 1783355397734000
        },
        {
          "stage": "WRITING",
          "timeUs": 1783355397765000
        },
        {
          "stage": "READBACK",
          "timeUs": 1783355397795000
        },
        {
          "stage": "EVENT_APPEND",
          "timeUs": 1783355397825000
        },
        {
          "stage": "FLAG_APPEND",
          "timeUs": 1783355397826000
        }
      ]
    },
    "captureQuality": {
      "sampleCount": 300,
      "validSamples": 300,
      "readErrors": 0,
      "timeouts": 0,
      "overflows": 0,
      "droppedSamples": 0,
      "targetHaltedSamples": 0,
      "actualRateHz": 99.99999999999999
    },
    "transportStatus": "pass",
    "dataQualityStatus": "pass",
    "failures": [],
    "helperResult": {
      "status": "ok",
      "captureId": "f691bc95-f039-4be5-9819-e1caa28a52bc",
      "requestedRateHz": 100,
      "actualRateHz": 100,
      "durationSec": 3,
      "sampleCount": 300,
      "validSamples": 300,
      "readErrors": 0,
      "timeouts": 0,
      "overflows": 0,
      "droppedSamples": 0,
      "readMode": "periodic",
      "resumeBeforeStart": false,
      "resumeIssued": false,
      "targetWasHaltedBeforeResume": false,
      "targetWasHaltedRaw": 0,
      "targetWasHaltedAfterResume": false,
      "targetReset": false,
      "targetWritten": true,
      "flashIssued": false,
      "resetIssued": false,
      "haltIssued": false,
      "hssSampleHeaderBytes": 4,
      "hssSampleStrideBytes": 8,
      "bytesPerSample": 4,
      "hssBlockCount": 1,
      "readBufferBytes": 4096,
      "firstChangedOffset": 0,
      "firstChangedBytes": "00000000",
      "headerChangedRatio": 1,
      "payloadChangedRatio": 1,
      "payloadFirstChangedOffset": 4,
      "payloadFirstChangedBytes": "01000000"
    },
    "eventWindow": {
      "event": {
        "eventId": "evt_54d808c5-f848-4d2f-b076-c9538f8d7240",
        "type": "variable_write",
        "writeKind": "scalar",
        "writeId": "wr_ebc15187-7867-4535-b3f3-89115c1587b4",
        "captureId": "f691bc95-f039-4be5-9819-e1caa28a52bc",
        "target": "Debug_IqRef",
        "canonicalTarget": "Debug_IqRef",
        "targetRef": {
          "kind": "scalar",
          "path": "Debug_IqRef"
        },
        "basePath": "Debug_IqRef",
        "address": 536870912,
        "dataType": "int32",
        "byteSize": 4,
        "elementCount": 1,
        "writeByteCount": 4,
        "oldValue": 0,
        "newValue": 1,
        "readback": 1,
        "readbackOk": true,
        "mismatches": [],
        "hostWriteStartUs": 1783355397734000,
        "hostWriteEndUs": 1783355397825000,
        "captureWriteStartUs": 126000,
        "captureWriteEndUs": 217000,
        "writeStartUs": 1783355397734000,
        "writeEndUs": 1783355397825000,
        "sampleIndexNear": 13,
        "risk": "R2",
        "policyHash": "1293a79cbcb05f80ed7841ebf337333bd5745940cec9201c8b5398a8e4ee54fa",
        "symbolLayoutHash": "007706f5911f1f6a5f6d9fb18d8033fb8b82204bd54d1a021292c580a76fb01f",
        "ok": true
      },
      "before": {
        "sampleStart": 3,
        "sampleEnd": 12,
        "sampleCount": 10,
        "durationMs": 100,
        "summary": {
          "Debug_IqRef": {
            "count": 10,
            "first": 3,
            "last": 12,
            "delta": 9,
            "min": 3,
            "max": 12,
            "avg": 7.5
          }
        }
      },
      "after": {
        "sampleStart": 13,
        "sampleEnd": 22,
        "sampleCount": 10,
        "durationMs": 100,
        "summary": {
          "Debug_IqRef": {
            "count": 10,
            "first": 13,
            "last": 22,
            "delta": 9,
            "min": 13,
            "max": 22,
            "avg": 17.5
          }
        }
      },
      "delta": {
        "Debug_IqRef": {
          "before": 12,
          "after": 13,
          "delta": 1
        }
      },
      "quality": {
        "excludedSamples": 0,
        "writeNearbySamples": 11,
        "writeInProgressSamples": 9,
        "backendBusySamples": 0,
        "warnings": []
      },
      "eventId": "evt_54d808c5-f848-4d2f-b076-c9538f8d7240",
      "requestedStartSec": 0.026,
      "startSec": 0.026,
      "eventSec": 0.126,
      "requestedEndSec": 0.226,
      "endSec": 0.226,
      "firstSampleSec": 0,
      "lastSampleSec": 2.99,
      "sampleCount": 20,
      "summary": {
        "Debug_IqRef": {
          "count": 20,
          "first": 3,
          "last": 22,
          "delta": 19,
          "min": 3,
          "max": 22,
          "avg": 12.5
        }
      }
    },
    "warnings": []
  }
}

~~~

## HM_C095 active-write output JSON

Workdir: D:\FOC_Project\Trunk\ProJect\HM_C095_SCM_App-e8f80a2-mcal-config

~~~powershell
$env:JLINK_DEVICE = "Z20K146M"
node "D:\AI_Project\Trunk\Jlink_mcp\scripts\hss-hm-c095-mvp-b-active-write.mjs" --rate 100 --duration 3 --min-samples 10
~~~

~~~json
{
  "fake": false,
  "device": "Z20K146M",
  "target": "g_hssDbgWriteProbe",
  "value": 1,
  "captureId": "4598e409-421e-4c38-ad7f-9bc2d7cec944",
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
    "eventId": "evt_c886ced0-832d-445d-bd1e-fcd2ddc8d07f"
  },
  "capture": {
    "state": "stopped",
    "transportStatus": "pass",
    "dataQualityStatus": "pass",
    "sampleCount": 125,
    "readErrors": 0,
    "timeouts": 0,
    "droppedSamples": 0,
    "actualRateHz": 10
  },
  "eventWindow": {
    "beforeSampleCount": 1,
    "afterSampleCount": 1,
    "deltaAvailable": true,
    "warnings": []
  },
  "elapsedMs": 10514,
  "artifacts": {
    "metadataFile": "D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\captures\\4598e409-421e-4c38-ad7f-9bc2d7cec944\\capture.json",
    "csvFile": "D:\\FOC_Project\\Trunk\\ProJect\\HM_C095_SCM_App-e8f80a2-mcal-config\\.jlink-mcp\\exports\\4598e409-421e-4c38-ad7f-9bc2d7cec944.csv"
  },
  "diagnostics": {
    "readiness": {
      "ready": true,
      "sampleCount": 64,
      "status": {
        "captureId": "4598e409-421e-4c38-ad7f-9bc2d7cec944",
        "state": "capturing",
        "sampleCount": 64,
        "validSamples": 64,
        "readErrors": 0,
        "timeouts": 0,
        "overflows": 0,
        "droppedSamples": 0,
        "elapsedSec": 6.3,
        "actualRateHz": 100,
        "requestedRateHz": 100,
        "sampling": {
          "requestedRateHz": 100,
          "hssIndexRateHz": 100,
          "hostObservedRateHz": 100,
          "helperReportedRateHz": 0,
          "helperActualRateHz": 0,
          "readMode": "periodic"
        },
        "currentSegment": "capture_0001.bin",
        "warnings": []
      }
    },
    "write": {
      "writeId": "wr_61b91dc9-60a1-4b21-a7b1-0f858fd45aad",
      "eventId": "evt_c886ced0-832d-445d-bd1e-fcd2ddc8d07f",
      "captureId": "4598e409-421e-4c38-ad7f-9bc2d7cec944",
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
      "hostWriteStartUs": 1783355423124000,
      "hostWriteEndUs": 1783355423198000,
      "writeStartUs": 1783355423124000,
      "writeEndUs": 1783355423198000,
      "sampleIndexNear": 368,
      "risk": "R2",
      "consumedWriteOps": 1,
      "consumedElements": 1,
      "captureWriteStartUs": 3677000,
      "captureWriteEndUs": 3751000,
      "queueStages": [
        {
          "stage": "QUEUED",
          "timeUs": 1783355423123000
        },
        {
          "stage": "PRE_READ_OLD",
          "timeUs": 1783355423124000
        },
        {
          "stage": "WRITING",
          "timeUs": 1783355423152000
        },
        {
          "stage": "READBACK",
          "timeUs": 1783355423183000
        },
        {
          "stage": "EVENT_APPEND",
          "timeUs": 1783355423199000
        },
        {
          "stage": "FLAG_APPEND",
          "timeUs": 1783355423230000
        }
      ]
    },
    "captureQuality": {
      "sampleCount": 125,
      "validSamples": 125,
      "readErrors": 0,
      "timeouts": 0,
      "overflows": 0,
      "droppedSamples": 0,
      "targetHaltedSamples": 0,
      "actualRateHz": 10
    },
    "transportStatus": "pass",
    "dataQualityStatus": "pass",
    "failures": [],
    "helperResult": {
      "status": "stopped",
      "captureId": "4598e409-421e-4c38-ad7f-9bc2d7cec944",
      "backend": "jlink-hss",
      "requestedRateHz": 100,
      "readMode": "periodic",
      "resumeBeforeStart": false,
      "resumeIssued": false,
      "targetWasHaltedBeforeResume": false,
      "targetHaltedBeforeResumeRaw": 0,
      "targetWasHaltedAfterResume": false,
      "targetHaltedAfterResumeRaw": 0,
      "actualRateHz": 115.293,
      "durationSec": 1.0842,
      "sampleCount": 125,
      "requestedSamples": 300,
      "validSamples": 125,
      "readErrors": 0,
      "hssBlockCount": 3,
      "hssSampleHeaderBytes": 4,
      "hssSampleStrideBytes": 40,
      "readAttempts": 104,
      "decodedSamples": 125,
      "emptyReads": 19,
      "shortReads": 0,
      "missingSamples": 0,
      "bytesPerSample": 36,
      "readBufferBytes": 4096,
      "firstReadReturnCode": 0,
      "lastReadReturnCode": 0,
      "minReadReturnCode": 0,
      "maxReadReturnCode": 160,
      "firstReadBufferChanged": false,
      "lastReadBufferChanged": false,
      "firstReadSamplePrefixChanged": false,
      "lastReadSamplePrefixChanged": false,
      "unchangedReads": 19,
      "changedReads": 85,
      "samplePrefixChangedReads": 85,
      "headerChangedReads": 85,
      "payloadChangedReads": 85,
      "firstChangedOffset": 0,
      "firstChangedBytes": "00000000479099a22b2b00002b2b0000",
      "headerChangedRatio": 0.817308,
      "payloadChangedRatio": 0.817308,
      "payloadFirstChangedOffset": 4,
      "payloadFirstChangedBytes": "479099a22b2b00002b2b000001000000",
      "layout": {
        "hssSampleHeaderBytes": 4,
        "hssSampleStrideBytes": 40,
        "bytesPerSample": 36,
        "hssBlockCount": 3,
        "readBufferBytes": 4096,
        "firstChangedOffset": 0,
        "firstChangedBytes": "00000000479099a22b2b00002b2b0000",
        "headerChangedRatio": 0.817308,
        "payloadChangedRatio": 0.817308,
        "payloadFirstChangedOffset": 4,
        "payloadFirstChangedBytes": "479099a22b2b00002b2b000001000000"
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
        "sampleCount": 125,
        "crc32": "1e4140c0"
      },
      "stopReturnCode": 0,
      "diagnostic": {
        "captureId": "4598e409-421e-4c38-ad7f-9bc2d7cec944",
        "stage": "after_hss_stop",
        "timeNs": 7620235787099,
        "readAttempts": 104,
        "validSamples": 125,
        "lastReadReturnCode": 0
      }
    },
    "eventWindow": {
      "event": {
        "eventId": "evt_c886ced0-832d-445d-bd1e-fcd2ddc8d07f",
        "type": "variable_write",
        "writeKind": "scalar",
        "writeId": "wr_61b91dc9-60a1-4b21-a7b1-0f858fd45aad",
        "captureId": "4598e409-421e-4c38-ad7f-9bc2d7cec944",
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
        "hostWriteStartUs": 1783355423124000,
        "hostWriteEndUs": 1783355423198000,
        "captureWriteStartUs": 3677000,
        "captureWriteEndUs": 3751000,
        "writeStartUs": 1783355423124000,
        "writeEndUs": 1783355423198000,
        "sampleIndexNear": 368,
        "risk": "R2",
        "policyHash": "02d72cdfe6f0cca58052e3df81603f3c06e2171fdb32f697caf11bb016dcc83e",
        "symbolLayoutHash": "223c7739a320fc7c8a95455581a787cd926e89b3bda256d3c966e8fca1229de4",
        "ok": true
      },
      "before": {
        "sampleStart": 360,
        "sampleEnd": 360,
        "sampleCount": 1,
        "durationMs": 100,
        "summary": {
          "g_hssDbgCounterFocIsr": {
            "count": 1,
            "first": 734,
            "last": 734,
            "delta": 0,
            "min": 734,
            "max": 734,
            "avg": 734
          },
          "g_hssDbgSawFocIsr": {
            "count": 1,
            "first": 734,
            "last": 734,
            "delta": 0,
            "min": 734,
            "max": 734,
            "avg": 734
          },
          "g_hssDbgToggleFocIsr": {
            "count": 1,
            "first": 0,
            "last": 0,
            "delta": 0,
            "min": 0,
            "max": 0,
            "avg": 0
          },
          "g_hssDbgPatternFocIsr": {
            "count": 1,
            "first": 2123460979,
            "last": 2123460979,
            "delta": 0,
            "min": 2123460979,
            "max": 2123460979,
            "avg": 2123460979
          },
          "g_hssDbgRawAdcM1U": {
            "count": 1,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2039,
            "avg": 2039
          },
          "g_hssDbgRawAdcM1V": {
            "count": 1,
            "first": 2034,
            "last": 2034,
            "delta": 0,
            "min": 2034,
            "max": 2034,
            "avg": 2034
          },
          "g_hssDbgRawAdcM2U": {
            "count": 1,
            "first": 2033,
            "last": 2033,
            "delta": 0,
            "min": 2033,
            "max": 2033,
            "avg": 2033
          },
          "g_hssDbgRawAdcM2V": {
            "count": 1,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2039,
            "avg": 2039
          },
          "g_hssDbgOffsetM1U": {
            "count": 1,
            "first": 2038,
            "last": 2038,
            "delta": 0,
            "min": 2038,
            "max": 2038,
            "avg": 2038
          },
          "g_hssDbgOffsetM1V": {
            "count": 1,
            "first": 2034,
            "last": 2034,
            "delta": 0,
            "min": 2034,
            "max": 2034,
            "avg": 2034
          }
        }
      },
      "after": {
        "sampleStart": 370,
        "sampleEnd": 370,
        "sampleCount": 1,
        "durationMs": 100,
        "summary": {
          "g_hssDbgCounterFocIsr": {
            "count": 1,
            "first": 801,
            "last": 801,
            "delta": 0,
            "min": 801,
            "max": 801,
            "avg": 801
          },
          "g_hssDbgSawFocIsr": {
            "count": 1,
            "first": 801,
            "last": 801,
            "delta": 0,
            "min": 801,
            "max": 801,
            "avg": 801
          },
          "g_hssDbgToggleFocIsr": {
            "count": 1,
            "first": 1,
            "last": 1,
            "delta": 0,
            "min": 1,
            "max": 1,
            "avg": 1
          },
          "g_hssDbgPatternFocIsr": {
            "count": 1,
            "first": 2815270424,
            "last": 2815270424,
            "delta": 0,
            "min": 2815270424,
            "max": 2815270424,
            "avg": 2815270424
          },
          "g_hssDbgRawAdcM1U": {
            "count": 1,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2039,
            "avg": 2039
          },
          "g_hssDbgRawAdcM1V": {
            "count": 1,
            "first": 2034,
            "last": 2034,
            "delta": 0,
            "min": 2034,
            "max": 2034,
            "avg": 2034
          },
          "g_hssDbgRawAdcM2U": {
            "count": 1,
            "first": 2034,
            "last": 2034,
            "delta": 0,
            "min": 2034,
            "max": 2034,
            "avg": 2034
          },
          "g_hssDbgRawAdcM2V": {
            "count": 1,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2039,
            "avg": 2039
          },
          "g_hssDbgOffsetM1U": {
            "count": 1,
            "first": 2039,
            "last": 2039,
            "delta": 0,
            "min": 2039,
            "max": 2039,
            "avg": 2039
          },
          "g_hssDbgOffsetM1V": {
            "count": 1,
            "first": 2033,
            "last": 2033,
            "delta": 0,
            "min": 2033,
            "max": 2033,
            "avg": 2033
          }
        }
      },
      "delta": {
        "g_hssDbgCounterFocIsr": {
          "before": 734,
          "after": 801,
          "delta": 67
        },
        "g_hssDbgSawFocIsr": {
          "before": 734,
          "after": 801,
          "delta": 67
        },
        "g_hssDbgToggleFocIsr": {
          "before": 0,
          "after": 1,
          "delta": 1
        },
        "g_hssDbgPatternFocIsr": {
          "before": 2123460979,
          "after": 2815270424,
          "delta": 691809445
        },
        "g_hssDbgRawAdcM1U": {
          "before": 2039,
          "after": 2039,
          "delta": 0
        },
        "g_hssDbgRawAdcM1V": {
          "before": 2034,
          "after": 2034,
          "delta": 0
        },
        "g_hssDbgRawAdcM2U": {
          "before": 2033,
          "after": 2034,
          "delta": 1
        },
        "g_hssDbgRawAdcM2V": {
          "before": 2039,
          "after": 2039,
          "delta": 0
        },
        "g_hssDbgOffsetM1U": {
          "before": 2038,
          "after": 2039,
          "delta": 1
        },
        "g_hssDbgOffsetM1V": {
          "before": 2034,
          "after": 2033,
          "delta": -1
        }
      },
      "quality": {
        "excludedSamples": 0,
        "writeNearbySamples": 1,
        "writeInProgressSamples": 1,
        "backendBusySamples": 0,
        "warnings": []
      },
      "eventId": "evt_c886ced0-832d-445d-bd1e-fcd2ddc8d07f",
      "requestedStartSec": 3.577,
      "startSec": 3.577,
      "eventSec": 3.677,
      "requestedEndSec": 3.777,
      "endSec": 3.777,
      "firstSampleSec": 0,
      "lastSampleSec": 12.4,
      "sampleCount": 2,
      "summary": {
        "g_hssDbgCounterFocIsr": {
          "count": 2,
          "first": 734,
          "last": 801,
          "delta": 67,
          "min": 734,
          "max": 801,
          "avg": 767.5
        },
        "g_hssDbgSawFocIsr": {
          "count": 2,
          "first": 734,
          "last": 801,
          "delta": 67,
          "min": 734,
          "max": 801,
          "avg": 767.5
        },
        "g_hssDbgToggleFocIsr": {
          "count": 2,
          "first": 0,
          "last": 1,
          "delta": 1,
          "min": 0,
          "max": 1,
          "avg": 0.5
        },
        "g_hssDbgPatternFocIsr": {
          "count": 2,
          "first": 2123460979,
          "last": 2815270424,
          "delta": 691809445,
          "min": 2123460979,
          "max": 2815270424,
          "avg": 2469365701.5
        },
        "g_hssDbgRawAdcM1U": {
          "count": 2,
          "first": 2039,
          "last": 2039,
          "delta": 0,
          "min": 2039,
          "max": 2039,
          "avg": 2039
        },
        "g_hssDbgRawAdcM1V": {
          "count": 2,
          "first": 2034,
          "last": 2034,
          "delta": 0,
          "min": 2034,
          "max": 2034,
          "avg": 2034
        },
        "g_hssDbgRawAdcM2U": {
          "count": 2,
          "first": 2033,
          "last": 2034,
          "delta": 1,
          "min": 2033,
          "max": 2034,
          "avg": 2033.5
        },
        "g_hssDbgRawAdcM2V": {
          "count": 2,
          "first": 2039,
          "last": 2039,
          "delta": 0,
          "min": 2039,
          "max": 2039,
          "avg": 2039
        },
        "g_hssDbgOffsetM1U": {
          "count": 2,
          "first": 2038,
          "last": 2039,
          "delta": 1,
          "min": 2038,
          "max": 2039,
          "avg": 2038.5
        },
        "g_hssDbgOffsetM1V": {
          "count": 2,
          "first": 2034,
          "last": 2033,
          "delta": -1,
          "min": 2033,
          "max": 2034,
          "avg": 2033.5
        }
      }
    },
    "warnings": []
  }
}

~~~
