# Changelog

## [1.0.1] - 2026-08-18

Fail-closed gate fixes. The regression gate no longer returns a green pass on
state it never measured.

- `checkGpuRegression` gains a tri-state verdict:
  `{ ok, verdict: 'pass'|'fail'|'inconclusive', regressions, inconclusive }`.
  `ok === (verdict === 'pass')`. A gpu.* rule whose candidate has
  `gpu.samples === 0` (headless CI, no timer extension), a poisoned/non-finite
  stat, or a counter tag tracked by neither summary now routes to `inconclusive`
  instead of passing (GG-01).
- `assertNoGpuRegression` throws `GpuRegressionError` on a 'fail' verdict and
  `GpuInconclusiveError` on 'inconclusive'; both carry `.report`. Both classes
  are exported so CI can tell "did not measure" from "regressed" from "clean".
- `recordGpuTime` now drops non-finite samples (`Number.isFinite(ms) && ms >= 0`),
  so a single `+Infinity` no longer poisons `summary().gpu` to null (GG-04).
- Rule paths are validated against the known metric surface before evaluation; a
  misspelled path throws `GpuRuleError` ("valid paths are ...") instead of being
  silently skipped (GG-02). Exports `GpuRuleError`, `GPU_FIELDS`, `COUNTER_FIELDS`,
  `TOP_FIELDS`.
- A rule declaring no bound (`{}` or `{ exact: false }` with no `max`/`tolerance`)
  is rejected with `GpuRuleError` instead of evaluating nothing and passing a real
  regression (GG-09, found by the qa boundary pass while closing GG-01/GG-02).
- No change to the counter hot path or the Float32 ring.

## [1.0.0] - 2026-07-01

Initial release.

- `GpuProfiler`: GL-agnostic headless core. Deterministic command counters
  (drawCalls, instances, floatsUploaded) with per-frame accumulate + ring flush,
  derived framesDrawn/framesSkipped, and an async GPU-time ring fed via
  `recordGpuTime`. Zero-allocation hot path; reuses lite-ring-buffer + lite-stats-math.
- `GpuTimerPool` (subpath `/timer`): zero-GC EXT_disjoint_timer_query_webgl2 pool.
  Fixed pre-allocated query ring, at most one region per frame, lagged FIFO drain
  of finished queries, GPU_DISJOINT drop, no leaked handles, safe no-op when
  unsupported. Under sustained GPU latency beyond poolSize frames the pool skips
  opening new regions instead of recycling pending ones, so sampling thins
  (~poolSize/latency of frames) rather than starving.
- `checkGpuRegression` / `assertNoGpuRegression`: exact / ceiling / tolerance gate.
  Counters gate exactly and headlessly; GPU time by tolerance.
