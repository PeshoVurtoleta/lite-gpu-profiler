import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuProfiler } from '../GpuProfiler.js';
import {
    checkGpuRegression,
    assertNoGpuRegression,
    GPU_DEFAULT_RULES,
    GpuRegressionError,
    GpuInconclusiveError,
    GpuRuleError
} from '../GpuGate.js';

// Build a summary with a fixed dirty-range upload + one instanced draw per frame.
function capture({ uploadFloats, drawInstances, gpuMs }) {
    const p = new GpuProfiler(64);
    for (let f = 0; f < 8; f++) {
        p.beginFrame();
        p.recordUpload(uploadFloats);
        p.recordDraw(drawInstances);
        p.endFrame();
        if (gpuMs) p.recordGpuTime(gpuMs);
    }
    const s = p.summary();
    p.destroy();
    return s;
}

test('exact counter gate: identical dirty-range passes', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 1_000_000, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 1_000_000, gpuMs: 1.0 });
    const r = checkGpuRegression(base, cand);
    assert.equal(r.ok, true, 'no regression when nothing changed');
    assert.equal(r.verdict, 'pass');
    assert.equal(r.regressions.length, 0);
    assert.equal(r.inconclusive.length, 0);
});

test('exact counter gate: a dirty-range regression (full re-upload) FAILS, noise-free', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 1_000_000, gpuMs: 1.0 });          // one instance uploaded
    const cand = capture({ uploadFloats: 8_000_000, drawInstances: 1_000_000, gpuMs: 1.0 });   // whole buffer re-uploaded
    const r = checkGpuRegression(base, cand);
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'fail');
    const hit = r.regressions.find((x) => x.metric === 'counter.floatsUploaded.max');
    assert.ok(hit && hit.rule === 'exact', 'caught by the exact dirty-range gate');
});

test('ceiling gate: draw-call count over an absolute cap FAILS', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100 });
    // pretend a regression split the single instanced draw into many calls
    cand.counters.drawCalls.max = 64;
    const r = checkGpuRegression(base, cand, { 'counter.drawCalls.max': { max: 1 } });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'fail');
    assert.equal(r.regressions[0].rule, 'max');
});

test('tolerance gate: GPU p99 within tolerance passes, beyond it fails', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const okCand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.1 });   // +10%
    const okR = checkGpuRegression(base, okCand, { 'gpu.p99': { tolerance: 0.15 } });
    assert.equal(okR.ok, true);
    assert.equal(okR.verdict, 'pass');
    const badCand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.5 });  // +50%
    const badR = checkGpuRegression(base, badCand, { 'gpu.p99': { tolerance: 0.15 } });
    assert.equal(badR.ok, false);
    assert.equal(badR.verdict, 'fail');
});

test('assertNoGpuRegression throws with a report on regression', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 800, drawInstances: 100, gpuMs: 1.0 });
    assert.throws(() => assertNoGpuRegression(base, cand), (e) => e.report && e.report.ok === false && e.report.verdict === 'fail');
});

test('default rules exist for the two claims that matter', () => {
    assert.ok(GPU_DEFAULT_RULES['counter.floatsUploaded.max'].exact);
    assert.ok(GPU_DEFAULT_RULES['counter.drawCalls.max'].exact);
});

test('exact gate: a metric that VANISHES from the candidate is a regression, not a silent pass', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    delete cand.counters.floatsUploaded;          // a refactor stopped tracking it
    const r = checkGpuRegression(base, cand);
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'fail');
    const hit = r.regressions.find((x) => x.metric === 'counter.floatsUploaded.max');
    assert.match(hit.reason, /missing/);
});

test('inconclusive gate: baseline also lacks the metric -> tracked by neither -> inconclusive, not a green pass', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    delete base.counters.floatsUploaded;
    delete cand.counters.floatsUploaded;
    const r = checkGpuRegression(base, cand);
    // floatsUploaded is tracked by neither -> unmeasured -> inconclusive (was a silent ok:true on v1.0.0)
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.regressions.length, 0);
    assert.ok(r.inconclusive.some((x) => x.metric === 'counter.floatsUploaded.max'));
});

// ---- GG-01: zero-sample GPU candidate must fail closed, both directions ----

test('(A) GG-01: zero-sample candidate vs sampled baseline with default rules -> inconclusive', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });   // gpu.samples > 0
    const cand = capture({ uploadFloats: 8, drawInstances: 100 });               // gpu.samples === 0
    assert.ok(base.gpu.samples > 0);
    assert.equal(cand.gpu.samples, 0);
    const r = checkGpuRegression(base, cand);
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.inconclusive.length, 1);
    assert.equal(r.regressions.length, 0);
    assert.equal(r.inconclusive[0].metric, 'gpu.p99');
});

test('(B) typed throws differ: inconclusive vs regression', () => {
    // inconclusive: zero-sample candidate
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const zeroSample = capture({ uploadFloats: 8, drawInstances: 100 });
    let incName;
    assert.throws(
        () => assertNoGpuRegression(base, zeroSample),
        (e) => { incName = e.name; return e instanceof GpuInconclusiveError && e.name === 'GpuInconclusiveError' && e.report.verdict === 'inconclusive'; }
    );
    // regression: the 800-float dirty-range blow-up
    const regBase = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const regCand = capture({ uploadFloats: 800, drawInstances: 100, gpuMs: 1.0 });
    let regName;
    assert.throws(
        () => assertNoGpuRegression(regBase, regCand),
        (e) => { regName = e.name; return e instanceof GpuRegressionError && e.name === 'GpuRegressionError' && e.report.verdict === 'fail'; }
    );
    assert.notEqual(incName, regName, 'CI can tell "did not measure" from "regressed"');
});

test('(C) GG-04: an Infinity sample is dropped at the door; gpu stats stay finite', () => {
    const p = new GpuProfiler(64);
    for (let f = 0; f < 5; f++) {
        p.beginFrame();
        p.recordDraw(1);
        p.endFrame();
        p.recordGpuTime(1.0);
    }
    p.recordGpuTime(Infinity);   // must be dropped, not stored
    const s = p.summary();
    p.destroy();
    assert.equal(s.gpu.samples, 5, 'Infinity was not admitted');
    assert.ok(Number.isFinite(s.gpu.p99), 'p99 stays finite');
    assert.ok(Number.isFinite(s.gpu.avg) && Number.isFinite(s.gpu.max));
});

test('(D) GG-02: malformed rule paths throw; a well-formed untracked tag is inconclusive', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });

    // malformed FIELD names -> throw GpuRuleError (fail fast, before any evaluation)
    assert.throws(() => checkGpuRegression(base, cand, { 'counter.floatsUploaded.maxx': { exact: true } }), GpuRuleError);
    assert.throws(() => checkGpuRegression(base, cand, { 'gpu.p99tolerance': { tolerance: 0.15 } }), GpuRuleError);

    // a typo ANYWHERE in the rule set fails fast, even alongside valid rules
    assert.throws(() => checkGpuRegression(base, cand, {
        'counter.floatsUploaded.maxx': { exact: true },
        'gpu.p99': { tolerance: 0.15 }
    }), GpuRuleError);

    // well-formed field, UNTRACKED tag -> inconclusive, never a green pass
    const r = checkGpuRegression(base, cand, { 'counter.drawcalls.max': { exact: true } });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.regressions.length, 0);
    assert.ok(r.inconclusive.some((x) => x.metric === 'counter.drawcalls.max'));
});

// ---- GG-13: a metric present in baseline, absent in candidate, gated by
// max/tolerance must fail closed to inconclusive -- not a silent green pass. ----

test('(A) GG-13: vanished metric under max -> inconclusive, not a silent pass', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    delete cand.counters.instances;   // baseline tracked it, candidate dropped it
    assert.ok(base.counters.instances !== undefined);
    const r = checkGpuRegression(base, cand, { 'counter.instances.max': { max: 1000 } });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.regressions.length, 0);
    assert.equal(r.inconclusive.length, 1);
    assert.equal(r.inconclusive[0].rule, 'max');
    assert.equal(r.inconclusive[0].metric, 'counter.instances.max');
    assert.equal(r.inconclusive[0].candidate, undefined);
    assert.throws(
        () => assertNoGpuRegression(base, cand, { 'counter.instances.max': { max: 1000 } }),
        (e) => e instanceof GpuInconclusiveError && e.report && e.report.verdict === 'inconclusive'
    );
});

test('(B) GG-13: same vanished metric under tolerance -> inconclusive', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    delete cand.counters.instances;
    const r = checkGpuRegression(base, cand, { 'counter.instances.max': { tolerance: 0.15 } });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.inconclusive.length, 1);
    assert.equal(r.inconclusive[0].rule, 'tolerance');
    assert.equal(r.inconclusive[0].metric, 'counter.instances.max');
});

test('(C) GG-13 control: exact on the identical input still fails (unchanged)', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    delete cand.counters.instances;
    const r = checkGpuRegression(base, cand, { 'counter.instances.max': { exact: true } });
    assert.equal(r.verdict, 'fail');
    assert.equal(r.regressions.length, 1);
    assert.match(r.regressions[0].reason, /missing/);
});

test('(D) GG-13 control: both-undefined top-level field under max still skips (pass)', () => {
    // Hand-rolled summaries with EQUAL schema tokens (or GG-10 short-circuits at :122)
    // and NO framesSkipped on either side -- a TOP_FIELDS path, not a counter, so the
    // counter guard at :145 cannot intercept. No basis either side -> plain skip.
    const base = { schema: 'lite-gpu-profiler/summary@1', counters: {}, gpu: { samples: 0 } };
    const cand = { schema: 'lite-gpu-profiler/summary@1', counters: {}, gpu: { samples: 0 } };
    const r = checkGpuRegression(base, cand, { 'framesSkipped': { max: 10 } });
    assert.equal(r.verdict, 'pass');
    assert.equal(r.ok, true);
    assert.equal(r.inconclusive.length, 0);
    assert.equal(r.regressions.length, 0);
});

// ---- QA boundary coverage: A1 names TOP_FIELDS and gpu.samples explicitly as the
// other two holes the counter guard cannot see; pin the forward-vanish for both, on
// real captures, not just the counter case above. ----

test('(E) GG-13: vanished TOP_FIELDS metric (framesSkipped) under max -> inconclusive', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    assert.equal(typeof base.framesSkipped, 'number');
    delete cand.framesSkipped;   // baseline tracked it, candidate dropped the field
    const r = checkGpuRegression(base, cand, { framesSkipped: { max: 10 } });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.regressions.length, 0);
    assert.equal(r.inconclusive.length, 1);
    assert.equal(r.inconclusive[0].rule, 'max');
    assert.equal(r.inconclusive[0].metric, 'framesSkipped');
    assert.equal(r.inconclusive[0].candidate, undefined);
    assert.throws(
        () => assertNoGpuRegression(base, cand, { framesSkipped: { max: 10 } }),
        (e) => e instanceof GpuInconclusiveError && e.report && e.report.verdict === 'inconclusive'
    );
});

test('(F) GG-13: vanished gpu.samples under tolerance -> inconclusive (the gpu.* guard exempts samples)', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    assert.ok(base.gpu.samples > 0);
    delete cand.gpu;   // baseline measured GPU time, candidate's gpu object vanished entirely
    const r = checkGpuRegression(base, cand, { 'gpu.samples': { tolerance: 0.15 } });
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.regressions.length, 0);
    assert.equal(r.inconclusive.length, 1);
    assert.equal(r.inconclusive[0].rule, 'tolerance');
    assert.equal(r.inconclusive[0].metric, 'gpu.samples');
    assert.equal(r.inconclusive[0].candidate, undefined);
    assert.throws(
        () => assertNoGpuRegression(base, cand, { 'gpu.samples': { tolerance: 0.15 } }),
        (e) => e instanceof GpuInconclusiveError && e.report && e.report.verdict === 'inconclusive'
    );
});
