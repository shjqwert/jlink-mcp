# HSS MVP-B Controlled Variable Writes

MVP-B allows capture-time writes only through `variable_write_plan` followed by `variable_write_execute` while an HSS capture is active.

Safety boundaries:
- Targets must be in `.jlink-mcp/policy.json`.
- Targets must resolve to RAM scalar, fixed array element, or contiguous fixed array slice.
- Flash, peripheral, debug/core registers, raw probe/GDB commands, reset, halt, step, rollback, and multi-variable transactions are out of scope.
- R2 plans can execute. R3 plans are plan-only and execute returns a structured rejection.
- Every real execute reads old values, writes typed bytes, reads back, compares element-wise, records event JSONL, flag overlay JSONL, materialized capture metadata, and audit JSONL.

Core workflow:
1. `hss_capture_start`
2. `variable_write_plan`
3. `variable_write_execute`
4. `hss_capture_stop`
5. `hss_capture_query` with `mode: "event_window"`
6. `hss_capture_export` with `eventAware: true`

Policy file path:

```text
.jlink-mcp/policy.json
```

Minimum policy example:

```json
{
  "version": 2,
  "requireReadback": true,
  "variableWriteAllowlist": [
    {
      "path": "Debug_IqRef",
      "kind": "scalar",
      "type": "int32",
      "min": -1000,
      "max": 1000,
      "risk": "R2",
      "captureTimeWrite": true
    },
    {
      "path": "Debug_ProfileTable",
      "kind": "fixed_array",
      "elementType": "int16",
      "arrayLength": 16,
      "allowedIndexRange": { "start": 4, "end": 7 },
      "allowArraySliceWrite": true,
      "maxElementsPerWrite": 4,
      "maxElementsTotal": 4,
      "maxBytesPerWrite": 8,
      "risk": "R2",
      "captureTimeWrite": true
    }
  ]
}
```

Validation:

```powershell
npm run test:hss-mvp-b
node scripts/hss-validate-mvp-b-capture.mjs .jlink-mcp/captures/<captureId>/capture.json
```
