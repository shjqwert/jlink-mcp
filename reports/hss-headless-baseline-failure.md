# HSS Headless Baseline Failure

Initial baseline failed before HSS development.

## Failures

| Command | Exit | Root cause |
| --- | ---: | --- |
| `npm run lint` | 1 | PowerShell blocked `npm.ps1`; rerun with `npm.cmd run lint` passed. |
| `npm.cmd run test` | 1 | Tests used Windows system Temp and TraceAgent referenced missing `hm-c095-real-hardware-direct-rtt-stream-30s-csharp.bin`. |
| `npm.cmd run test:capture-ipc` | 1 | MSBuild used Windows system Temp; sandbox also blocks executing the native helper without elevation. |
| `npm.cmd run test:elf` | 1 | Arm GCC used Windows system Temp. |
| `npm.cmd run test:coverage` | 1 | Node built-in coverage used Windows system Temp. |
| `openspec.cmd validate --strict` | 1 | Current OpenSpec CLI requires an explicit target; `openspec.cmd validate --all --strict` passed. |

## Fixes

- Test temp directories now use repo `.tmp/jlink-mcp`.
- Native build, ELF integration, and coverage harnesses set `TEMP`, `TMP`, and `TMPDIR` to repo `.tmp/jlink-mcp/*`.
- TraceAgent clean-stream coverage now uses explicit synthetic data.
- Current HM_C095 real RTT stream is asserted as NOT_PASS while CRC/gap/discard evidence remains.

## Status

After fixes, baseline commands pass with `npm.cmd`; native helper execution requires elevated sandbox permission.
