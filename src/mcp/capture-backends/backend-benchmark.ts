import type { BackendBenchmarkResult } from "./capture-backend";

export function benchmarkPassed(result: BackendBenchmarkResult): boolean {
  return result.readErrors === 0 && result.successRate >= 0.9 && result.actualRateHz > 0;
}

export function summarizeBenchmarks(results: BackendBenchmarkResult[]): {
  results: BackendBenchmarkResult[];
  bestBackend: string | null;
} {
  const passing = results.filter(benchmarkPassed).sort((a, b) => b.actualRateHz - a.actualRateHz);
  return { results, bestBackend: passing[0]?.backendName ?? null };
}
