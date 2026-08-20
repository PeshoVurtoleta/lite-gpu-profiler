# Changelog

## [1.2.1] - 2026-08-20

Fail-closed correctness + doc hygiene. No new caller-visible exception, no new module
export, no new report field, and the hot path
(`recordDraw`/`recordUpload`/`add`/`recordGpuTime`/`endFrame` and `GpuTimerPool`
`begin`/`end`) is byte-identical -- `GpuProfiler.js` and `GpuTimerPool.js` gain zero
changed lines. So this is a patch, on the GG-10 precedent: GG-10 (schema mismatch)
shipped as the patch 1.1.1 under "making a fail-open fail-closed is fixing WRONG
OUTPUT, hence a patch." GG-13 is the identical class -- it flips a currently-green
gate on a vanished metric to `inconclusive`/throw, reusing the existing tri-state and
`GpuInconclusiveError`, adding no public surface. `.d.ts` is unchanged
(`GpuGate.d.ts` already typed the `rule` values and `warnings`). `GPU_SUMMARY_SCHEMA`
stays `lite-gpu-profiler/summary@1`, so every baseline from 1.0.x/1.1.x/1.2.0 keeps
gating.

- **GG-13 (S1, closed) -- vanished-metric fail-open in the max/tolerance leg.** The
  `exact` leg already treated "baseline tracked this metric, candidate no longer
  reports it" as a regression, but the `max`/`tolerance` leg hit
  `if (cand === undefined) continue;` and silently PASSED -- a green verdict on state
  the candidate never measured, the exact thing the fail-closed contract forbids. The
  loop now splits that branch: `base` present and `cand` absent routes to
  `inconclusive` (`rule: <kind>`, "metric present in baseline, absent in candidate --
  nothing to bound"); both-undefined still skips (no basis either side). Reachable
  where a gate is actually used -- a stored baseline compared against a later
  candidate whose field set drifted. `assertNoGpuRegression` now throws
  `GpuInconclusiveError` instead of returning green. The counter/gpu/poisoned guards
  keep priority; the exact leg is untouched.
- **GG-14 (S3, closed) -- README ASCII sweep + a permanent byte guard.** `README.md`
  shipped with 50 ASCII-law violations (em-dashes, arrows, superscripts, a middot,
  a copyright sign); all are transliterated to ASCII (`--`, `->`/`<-`, `^`, `(c)`,
  `...`), keeping only the two law-permitted `U+00D7`. `07-docs-drift` now enumerates
  every codepoint in `README.md` + `llms.txt` at runtime and fails on any cp > 127
  outside `{U+00D7, U+00B5}`, naming file + offset, so the drift cannot recur.
- **GG-15 (S3, closed) -- precision advisory now covers all three rule kinds.** The
  `>= 2^24` Float32-quantization advisory was nested inside the `if (rule.exact)`
  block, so a `max`/`tolerance` operand from the same ring at the same magnitude got
  no warning. The advisory is hoisted above the rule-kind branch with `rule: <kind>`;
  it remains verdict-neutral (extends `warnings[]` only, never `ok`/`verdict`) and the
  exact-leg emission is unchanged.
- **Tests: 57 -> 66.** `02-gate` adds GG-13 coverage both directions -- a vanished
  metric routes to `inconclusive` under `max`/`tolerance` for a counter, a top-level
  field (`framesSkipped`), and `gpu.samples`, while `exact` still fails and a
  both-undefined top field still passes; `06-gate-schema` adds the GG-15 max/tolerance
  precision-advisory controls (operand >= 2^24 -> one warning, verdict-neutral);
  `07-docs-drift` adds the byte-level ASCII guard. The torture harness gains a V1
  GG-13 degenerate and a fifth `vanish` mutant that restores the old skip and must
  exit non-zero.

## [1.2.0] - 2026-08-19

Additive public surface -- the first minor. GG-12 is closed by forwarding six
already-`export`ed `GpuGate.js` names through the package entry point, so this is a
minor (new public surface), not a patch. No runtime behaviour changed: the hot path
(`recordDraw`/`recordUpload`/`add`/`recordGpuTime`/`endFrame`) is byte-identical, and
`GpuProfiler.js` / `GpuGate.js` / `GpuTimerPool.js` gain zero changed lines. No
gate-semantics, verdict, frame-contract, timer-pool or rule-kind change.
`GPU_SUMMARY_SCHEMA` stays `lite-gpu-profiler/summary@1`, so every baseline from
1.0.x/1.1.x keeps gating.

- **GG-12 (closed) -- gate error classes + field arrays now on the entry point.**
  `index.js` re-exports `GpuRuleError`, `GpuRegressionError`, `GpuInconclusiveError`,
  `GPU_FIELDS`, `COUNTER_FIELDS` and `TOP_FIELDS` (barrel: 6 -> 12 names), so
  `err instanceof GpuInconclusiveError` works. `index.d.ts` already declared all six
  via `export *`, so this makes the runtime match the types that shipped since 1.0.1;
  it was a barrel gap, never a type gap. `err.name` / `err.report.verdict` remain for
  CI that prefers not to import. The README and llms.txt reverse the 1.1.1
  "not exported" note.
- **Tests: 56 -> 57.** `07-docs-drift` now pins the surface off the barrel and adds an
  `instanceof` round-trip test that proves both the `instanceof` and `err.name`
  branching styles.

## [1.1.1] - 2026-08-19

Fail-closed correctness + doc hygiene. No new caller-visible exception, no new
module export, and the hot path (`recordDraw`/`recordUpload`/`add`/`recordGpuTime`)
is byte-identical -- so this is a patch. `GPU_SUMMARY_SCHEMA` stays
`lite-gpu-profiler/summary@1` (bumping it while beginning to enforce token equality
would invalidate every baseline from 1.0.x/1.1.0); no field is added to `summary()`.

- **GG-05 -- frame contract, as a no-op (not a throw).** `beginFrame()`/`endFrame()`
  each gain one boolean guard on the existing `_frameOpen` field: an unpaired call
  records nothing. A stray `endFrame()` no longer fabricates a zeroed phantom frame,
  a redundant `beginFrame()` preserves the accumulation in flight instead of
  discarding every draw since the last one, and a `reset()` mid-frame correctly drops
  the in-flight frame. The instrument never throws from the render loop; the gate
  already routes a malformed capture (`frameCount: 0`) to `inconclusive`/`fail`. Two
  predictable branches per frame, zero per draw, zero allocation added.
- **GG-10 -- the gate reads `summary.schema`.** Two summaries whose `schema` tokens
  differ are incomparable and short-circuit to `inconclusive` before any rule runs
  (one `schema` entry, no regressions), reusing the existing tri-state and
  `GpuInconclusiveError`. `undefined` vs `undefined` is deliberately treated as
  comparable. This is the one verdict flip in the release (`pass` -> `inconclusive`
  on a mismatched pair); re-record the baseline to clear it.
- **GG-03 -- a `warnings` array on the report.** `checkGpuRegression` now returns
  `{ ok, verdict, regressions, inconclusive, warnings }` (`warnings` always present,
  never affecting `verdict`/`ok`). An `exact` rule whose operand reaches 2^24 is
  flagged: the `Float32` counter ring quantizes there, so a sub-quantum regression is
  invisible to an exact gate. Below the ceiling is byte-for-byte unchanged.
- **GG-08 -- doc correction.** The phantom external real-GPU smoke-test reference is
  removed from `GpuTimerPool.js`, `llms.txt`, and `README.md`. What actually verifies
  the timer is the mock-GL state-machine suite in
  `test/03-timer-pool.test.mjs`; absolute nanoseconds are driver-reported and not
  asserted here (no WebGL2 under node). No browser-automation dependency is added.
- **GG-12 (docs-only) -- reachability note.** The gate error classes and field arrays
  are documented but not re-exported from the entry point; the README and llms.txt now
  say CI should branch on `err.name` / `err.report.verdict`. A subpath export is a
  1.2.0 candidate (recorded in `GPU_ROADMAP.md`).
- **Tests: 44 -> 56.** Adds `05-frame-contract` (5, GG-05), `06-gate-schema` (6,
  GG-10 + GG-03), and `07-docs-drift` (1, pins the documented surface + the schema
  token). `test/torture.mjs`: the GG-10 pin is flipped to assert both directions
  (mismatch -> `inconclusive`, matched pair still passes); the retention settle is now
  a bounded, early-exiting retry (`MAX_SETTLE_ROUNDS = 8`) that a real leak still
  fails; and V5 now spawns a **fourth** mutant, `retain`, as the leak-direction
  control for that settle. The zero-allocation hot path is re-proven after the frame
  guards: V3a/V3b major-GC count stays exactly 0.

## [1.1.0] - 2026-08-18

Torture harness. No runtime behavior change -- `GpuProfiler`, `GpuTimerPool`, and
`GpuGate` are byte-for-byte identical; this release adds evidence, not surface.

- `test/torture.mjs` (`npm run torture` -> `node --expose-gc test/torture.mjs`)
  proves the package through `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak`,
  as the ecosystem law requires. Tiers, run in order, each printing `ok <tier>`;
  a tier reporting zero checks is a FAIL, and the first failure sets a non-zero
  exit code:
  - V0 -- every documented rule path (25: 15 counter + 6 gpu + 4 top-level) is
    evaluated in both directions; a misspelled path throws `GpuRuleError` and
    rejecting it leaves the valid-path verdict unchanged (fences GG-02).
  - V1 -- fail-closed degenerates: `gpu.samples === 0`, non-finite/negative
    `recordGpuTime`, empty and single-sample captures each route to `inconclusive`
    or `fail`, never a silent `pass` (fences GG-01/GG-04). Pins GG-10 (the gate
    does not read `summary.schema`; deferred, not fixed).
  - V3a/V3b -- the profiler and pool hot paths are stepped 2e6 / 1e6 times under
    `GcProfiler`; the zero-allocation claim is gated on `checkNoGc(maxMajor:0,
    maxPauseMs:4)` (major-GC count), the noise-immune proof. A retaining hot-path
    variant reliably forces a major and fails; the clean path forces none. V3b
    also proves the pool never allocates after construction structurally: exactly
    `poolSize` queries created, all deleted on dispose, with the disjoint-drop and
    pool-exhausted branches exercised in the measured window.
  - V3c -- retention: ring backing stores do not grow across 4096 `reset()` cycles
    (`byteLength` identical at cycle 1 vs N) and tracked profilers are collected
    (`tracker.size() -> 0`).
  - V5 -- controls: three mutants (allocating hot path, legacy binary gate,
    permissive validator), each spawned in a child that must exit non-zero, so
    the gate is proven able to fail.
- `scripts.torture` added. `test/` still excluded from the published tarball --
  the harness does not ship.

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
