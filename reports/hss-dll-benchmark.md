# HSS DLL Benchmark

Result: safety blocked, no benchmark PASS.

The machine-readable matrix is in `reports/hss-dll-benchmark.json`. It includes 1/3/7/10 variable rows with `actualRateHz`, `successRate`, and `errors`.

Reason:

- Connect-preflight detected `targetWasHalted=true`.
- Benchmark stopped before HSS Start/Read/Stop.
- `actualRateHz` and `successRate` are intentionally null.

No raw HSS read artifact exists because the helper stopped before target access.
