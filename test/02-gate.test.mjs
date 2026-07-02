import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuProfiler } from '../GpuProfiler.js';
import { checkGpuRegression, assertNoGpuRegression, GPU_DEFAULT_RULES } from '../GpuGate.js';

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
});

test('exact counter gate: a dirty-range regression (full re-upload) FAILS, noise-free', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 1_000_000 });          // one instance uploaded
    const cand = capture({ uploadFloats: 8_000_000, drawInstances: 1_000_000 });   // whole buffer re-uploaded
    const r = checkGpuRegression(base, cand);
    assert.equal(r.ok, false);
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
    assert.equal(r.regressions[0].rule, 'max');
});

test('tolerance gate: GPU p99 within tolerance passes, beyond it fails', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.0 });
    const okCand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.1 });   // +10%
    assert.equal(checkGpuRegression(base, okCand, { 'gpu.p99': { tolerance: 0.15 } }).ok, true);
    const badCand = capture({ uploadFloats: 8, drawInstances: 100, gpuMs: 1.5 });  // +50%
    assert.equal(checkGpuRegression(base, badCand, { 'gpu.p99': { tolerance: 0.15 } }).ok, false);
});

test('assertNoGpuRegression throws with a report on regression', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100 });
    const cand = capture({ uploadFloats: 800, drawInstances: 100 });
    assert.throws(() => assertNoGpuRegression(base, cand), (e) => e.report && e.report.ok === false);
});

test('default rules exist for the two claims that matter', () => {
    assert.ok(GPU_DEFAULT_RULES['counter.floatsUploaded.max'].exact);
    assert.ok(GPU_DEFAULT_RULES['counter.drawCalls.max'].exact);
});

test('exact gate: a metric that VANISHES from the candidate is a regression, not a silent pass', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100 });
    delete cand.counters.floatsUploaded;          // a refactor stopped tracking it
    const r = checkGpuRegression(base, cand);
    assert.equal(r.ok, false);
    assert.match(r.regressions[0].reason, /missing/);
});

test('exact gate: baseline also lacks the metric -> no basis -> skip (not a false regression)', () => {
    const base = capture({ uploadFloats: 8, drawInstances: 100 });
    const cand = capture({ uploadFloats: 8, drawInstances: 100 });
    delete base.counters.floatsUploaded;
    delete cand.counters.floatsUploaded;
    const r = checkGpuRegression(base, cand);
    // only floatsUploaded is gone; drawCalls + gpu still gate and match -> ok
    assert.equal(r.ok, true);
});
