# Changelog

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
