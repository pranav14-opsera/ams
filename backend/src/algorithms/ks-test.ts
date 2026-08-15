export interface KsTestResult {
  /** The KS statistic D: the max absolute difference between the two samples' empirical CDFs. */
  statistic: number;
  /** Two-tailed p-value from the asymptotic Kolmogorov distribution (Stephens' approximation) — the probability of seeing a D this large (or larger) if both samples were drawn from the same distribution. */
  pValue: number;
  sampleSizeA: number;
  sampleSizeB: number;
}

function empiricalCdfAt(sorted: number[], x: number): number {
  // sorted is ascending; count of values <= x, divided by n. Sample sizes here are small (dozens to low thousands of quality-score ticks), so a linear scan is simple and fast enough — no need for a binary search.
  let count = 0;
  for (const value of sorted) {
    if (value <= x) count++;
    else break;
  }
  return count / sorted.length;
}

/**
 * Stephens' (1970) asymptotic approximation to P(D_effectiveN > lambda) for
 * the Kolmogorov distribution — the same formula used by SciPy's
 * `kstwobign` survival function. Returns 1 for very small lambda (no
 * evidence at all against the null) and decays toward 0 as lambda grows.
 */
function kolmogorovSurvival(lambda: number): number {
  if (lambda < 0.2) return 1;
  if (lambda > 6) return 0; // terms are astronomically small past this point
  let sum = 0;
  for (let k = 1; k <= 100; k++) {
    const term = Math.exp(-2 * k * k * lambda * lambda);
    sum += (k % 2 === 1 ? 1 : -1) * term;
    if (term < 1e-12) break;
  }
  return Math.max(0, Math.min(1, 2 * sum));
}

/**
 * Two-sample Kolmogorov-Smirnov test: are samples A and B drawn from the
 * same underlying distribution? Returns the KS statistic D (max |ECDF_A -
 * ECDF_B|) and an asymptotic two-tailed p-value. A small p-value is
 * evidence the two samples come from different distributions.
 */
export function twoSampleKsTest(sampleA: number[], sampleB: number[]): KsTestResult {
  if (sampleA.length === 0 || sampleB.length === 0) throw new RangeError("both samples must be non-empty for a two-sample KS test");
  for (const value of [...sampleA, ...sampleB]) {
    if (!Number.isFinite(value)) throw new RangeError(`sample values must be finite numbers, got ${value}`);
  }

  const sortedA = [...sampleA].sort((a, b) => a - b);
  const sortedB = [...sampleB].sort((a, b) => a - b);
  const combinedPoints = [...new Set([...sortedA, ...sortedB])].sort((a, b) => a - b);

  let maxDiff = 0;
  for (const x of combinedPoints) {
    const diff = Math.abs(empiricalCdfAt(sortedA, x) - empiricalCdfAt(sortedB, x));
    if (diff > maxDiff) maxDiff = diff;
  }

  const n = sortedA.length;
  const m = sortedB.length;
  const effectiveN = (n * m) / (n + m);
  const lambda = (Math.sqrt(effectiveN) + 0.12 + 0.11 / Math.sqrt(effectiveN)) * maxDiff;
  const pValue = kolmogorovSurvival(lambda);

  return { statistic: maxDiff, pValue, sampleSizeA: n, sampleSizeB: m };
}
