import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuProfiler } from '../GpuProfiler.js';
import {
    checkGpuRegression,
    assertNoGpuRegression,
    GpuRegressionError,
    GpuInconclusiveError,
    GpuRuleError
} from '../GpuGate.js';

function capture({ uploadFloats, drawInstances, gpuMs, frames = 8 }) {
    const p = new GpuProfiler(64);
    for (let f = 0; f < frames; f++) {
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

// ---------------------------------------------------------------------------
// recordGpuTime input boundary matrix: 0, -0, NaN, null, undefined, -1,
// Infinity, -Infinity. Only Number.isFinite(ms) && ms >= 0 is admitted.
// ---------------------------------------------------------------------------

test('recordGpuTime boundary: 0 is KEPT (a valid finite non-negative sample)', () => {
    const p = new GpuProfiler(64);
    p.recordGpuTime(0);
    const s = p.summary();
    assert.equal(s.gpu.samples, 1, '0ms is a real measurement, not a missing one');
    assert.equal(s.gpu.max, 0);
    p.destroy();
});

test('recordGpuTime boundary: -0 is KEPT (Number.isFinite(-0) is true, -0 >= 0 is true)', () => {
    const p = new GpuProfiler(64);
    p.recordGpuTime(-0);
    const s = p.summary();
    assert.equal(s.gpu.samples, 1, '-0 must not be treated as negative and dropped');
    p.destroy();
});

test('recordGpuTime boundary: NaN is dropped', () => {
    const p = new GpuProfiler(64);
    p.recordGpuTime(1.0);
    p.recordGpuTime(NaN);
    const s = p.summary();
    assert.equal(s.gpu.samples, 1, 'NaN sample must not be admitted');
    p.destroy();
});

test('recordGpuTime boundary: -1 (negative) is dropped', () => {
    const p = new GpuProfiler(64);
    p.recordGpuTime(1.0);
    p.recordGpuTime(-1);
    const s = p.summary();
    assert.equal(s.gpu.samples, 1, 'negative sample must not be admitted');
    p.destroy();
});

test('recordGpuTime boundary: null is dropped (Number.isFinite(null) is false)', () => {
    const p = new GpuProfiler(64);
    p.recordGpuTime(1.0);
    p.recordGpuTime(null);
    const s = p.summary();
    assert.equal(s.gpu.samples, 1, 'null must not coerce into an admitted 0');
    p.destroy();
});

test('recordGpuTime boundary: undefined is dropped', () => {
    const p = new GpuProfiler(64);
    p.recordGpuTime(1.0);
    p.recordGpuTime(undefined);
    const s = p.summary();
    assert.equal(s.gpu.samples, 1, 'undefined must not be admitted');
    p.destroy();
});

test('recordGpuTime boundary: -Infinity is dropped alongside +Infinity (GG-04, both signs)', () => {
    const p = new GpuProfiler(64);
    for (let f = 0; f < 5; f++) { p.beginFrame(); p.recordDraw(1); p.endFrame(); p.recordGpuTime(1.0); }
    p.recordGpuTime(Infinity);
    p.recordGpuTime(-Infinity);
    const s = p.summary();
    assert.equal(s.gpu.samples, 5, 'neither +Infinity nor -Infinity is admitted');
    assert.ok(Number.isFinite(s.gpu.p99) && Number.isFinite(s.gpu.avg) && Number.isFinite(s.gpu.max) && Number.isFinite(s.gpu.min));
    p.destroy();
});

// ---------------------------------------------------------------------------
// Rule-path validation boundary: top-level paths, empty path, malformed field.
// ---------------------------------------------------------------------------

test('rule path boundary: a well-formed top-level path (frameCount) validates and evaluates', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0, frames: 8 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0, frames: 8 });
    assert.doesNotThrow(() => checkGpuRegression(base, cand, { frameCount: { exact: true } }));
    const r = checkGpuRegression(base, cand, { frameCount: { exact: true } });
    assert.equal(r.verdict, 'pass', 'identical frameCount, exact rule -> pass, not skipped');
});

test('rule path boundary: a malformed top-level path (frameCountz) throws GpuRuleError', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    assert.throws(() => checkGpuRegression(base, cand, { frameCountz: { exact: true } }), GpuRuleError);
});

test('rule path boundary: empty string path throws GpuRuleError', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    assert.throws(() => checkGpuRegression(base, cand, { '': { exact: true } }), GpuRuleError);
});

test('rule path boundary: dotted-empty-segment path ("gpu.") throws GpuRuleError', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    assert.throws(() => checkGpuRegression(base, cand, { 'gpu.': { tolerance: 0.15 } }), GpuRuleError);
});

test('adversarial: a prototype-shaped counter tag ("counter.__proto__.max") does not crash and resolves to inconclusive, not a leaked prototype value', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const r = checkGpuRegression(base, cand, { 'counter.__proto__.max': { exact: true } });
    assert.equal(r.verdict, 'inconclusive', '__proto__ is not a tracked counter tag; must not silently pass or throw a prototype-pollution crash');
    assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// gpu.samples-zero-on-both-sides, and gpu.samples-as-the-gated-field itself.
// ---------------------------------------------------------------------------

test('both baseline and candidate have gpu.samples===0 on a gpu.* rule -> inconclusive, not pass', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100 });   // no gpuMs -> samples 0
    const cand = capture({ uploadFloats: 8, drawInstances: 100 });   // no gpuMs -> samples 0
    assert.equal(base.gpu.samples, 0);
    assert.equal(cand.gpu.samples, 0);
    const r = checkGpuRegression(base, cand, { 'gpu.p99': { tolerance: 0.15 } });
    assert.equal(r.verdict, 'inconclusive', 'zero samples on BOTH sides is still unmeasured, not a trivial pass');
    assert.equal(r.ok, false);
    assert.equal(r.regressions.length, 0);
});

test('gpu.samples itself, gated with {max:...}, is evaluated normally on a real (zero) value -- not force-routed to inconclusive', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100 });   // gpu.samples === 0, a real gateable value
    const cand = capture({ uploadFloats: 8, drawInstances: 100 });   // gpu.samples === 0
    const r = checkGpuRegression(base, cand, { 'gpu.samples': { max: 0 } });
    assert.equal(r.verdict, 'pass', '0 <= ceiling 0 is a real, measured pass for gpu.samples specifically');
    assert.equal(r.ok, true);
    assert.equal(r.inconclusive.length, 0, 'gpu.samples is exempt from the zero-samples inconclusive guard (it IS the samples count)');
});

test('gpu.samples gated with {max:0} FAILS when samples exceed the ceiling (proves it is a real live rule, not silently skipped)', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });   // gpu.samples === 8 > 0
    const r = checkGpuRegression(base, cand, { 'gpu.samples': { max: 0 } });
    assert.equal(r.verdict, 'fail');
    assert.equal(r.ok, false);
    assert.equal(r.regressions[0].metric, 'gpu.samples');
});

// ---------------------------------------------------------------------------
// verdict/ok coupling across all three states, and the fail-wins tie-break.
// ---------------------------------------------------------------------------

test('verdict/ok coupling: ok === (verdict === "pass") holds in all three observed states', () => {
    const cleanBase = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cleanCand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const passR = checkGpuRegression(cleanBase, cleanCand);
    assert.equal(passR.verdict, 'pass');
    assert.equal(passR.ok, passR.verdict === 'pass');
    assert.equal(passR.ok, true);

    const regCand = capture({ uploadFloats: 8_000_000, drawInstances: 100, gpuMs: 1.0 });
    const failR = checkGpuRegression(cleanBase, regCand);
    assert.equal(failR.verdict, 'fail');
    assert.equal(failR.ok, failR.verdict === 'pass');
    assert.equal(failR.ok, false);

    const zeroCand = capture({ uploadFloats: 8, drawInstances: 100 });
    const incR = checkGpuRegression(cleanBase, zeroCand);
    assert.equal(incR.verdict, 'inconclusive');
    assert.equal(incR.ok, incR.verdict === 'pass');
    assert.equal(incR.ok, false);
});

test('when a rule set produces BOTH a regression and an inconclusive, verdict is "fail" (fail wins the tie-break)', () => {
    // base has gpuMs -> gpu.p99 evaluable; candidate has NO gpuMs -> gpu.p99 inconclusive.
    // base and candidate ALSO diverge on floatsUploaded.max -> a genuine exact regression.
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8_000_000, drawInstances: 100 });   // no gpuMs -> gpu.samples 0
    const r = checkGpuRegression(base, cand, {
        'counter.floatsUploaded.max': { exact: true },
        'gpu.p99': { tolerance: 0.15 }
    });
    assert.ok(r.regressions.length > 0, 'precondition: a genuine regression is present');
    assert.ok(r.inconclusive.length > 0, 'precondition: a genuine inconclusive is present');
    assert.equal(r.verdict, 'fail', 'fail must win over inconclusive when both are non-empty');
    assert.equal(r.ok, false);
});

test('assertNoGpuRegression on the mixed regression+inconclusive case throws GpuRegressionError, not GpuInconclusiveError', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8_000_000, drawInstances: 100 });
    assert.throws(
        () => assertNoGpuRegression(base, cand, {
            'counter.floatsUploaded.max': { exact: true },
            'gpu.p99': { tolerance: 0.15 }
        }),
        (e) => e instanceof GpuRegressionError && e.name === 'GpuRegressionError'
    );
});

// ---------------------------------------------------------------------------
// Adversarial case the planner did not think of: a rule whose SHAPE (not path)
// is unrecognized -- e.g. {} with none of exact/max/tolerance set -- is valid
// per validateRulePath (which only checks the path segments) but evaluates to
// NEITHER a regression NOR an inconclusive in checkGpuRegression's dispatch,
// silently no-op'ing the rule. On a rule set consisting ONLY of such a rule,
// this reproduces the exact GG-02 fail-open (ok:true on an unverified metric)
// through a different door: rule shape instead of rule path.
// ---------------------------------------------------------------------------

test('GG-09: a well-formed path with a boundless rule shape ({} - no exact/max/tolerance) THROWS, never silently passes a regression', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const cand = capture({ uploadFloats: 8_000_000, drawInstances: 100, gpuMs: 1.0 }); // 1e6x regression on floatsUploaded
    // Fixed in v1.0.1: the pre-pass rejects a rule declaring no bound, so the
    // 1e6x regression can never hide behind an empty rule object. Both directions:
    // this THROWS now (was verdict:'pass' before the GG-09 fix).
    assert.throws(() => checkGpuRegression(base, cand, { 'counter.floatsUploaded.max': {} }), GpuRuleError,
        'an empty rule object must be rejected, not evaluated to a silent pass');
    // { exact: false } is equally boundless -- it evaluates nothing -- and must also throw.
    assert.throws(() => checkGpuRegression(base, cand, { 'counter.floatsUploaded.max': { exact: false } }), GpuRuleError,
        'exact:false with no other bound declares nothing to check');
    // A real bound on the same valid path still evaluates and catches the regression.
    const ok = checkGpuRegression(base, cand, { 'counter.floatsUploaded.max': { exact: true } });
    assert.equal(ok.verdict, 'fail', 'a bounded rule on the same path still catches the 1e6x regression');
    // max:0 and tolerance:0 are real bounds (a ceiling/tolerance of zero), not boundless -> must NOT throw.
    assert.doesNotThrow(() => checkGpuRegression(base, base, { 'counter.floatsUploaded.max': { max: 0 } }));
    assert.doesNotThrow(() => checkGpuRegression(base, base, { 'gpu.p99': { tolerance: 0 } }));
});
