import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuProfiler, GPU_SUMMARY_SCHEMA } from '../GpuProfiler.js';
import {
    checkGpuRegression,
    assertNoGpuRegression,
    GpuInconclusiveError,
    GpuRuleError
} from '../GpuGate.js';

const TAGS = ['drawCalls', 'instances', 'floatsUploaded'];

function baseSummary() {
    return {
        schema: GPU_SUMMARY_SCHEMA,
        frameCount: 100,
        capacity: 128,
        framesDrawn: 90,
        framesSkipped: 10,
        counters: {
            drawCalls: { sum: 900, min: 0, max: 12, avg: 9, last: 10 },
            instances: { sum: 4500, min: 0, max: 60, avg: 45, last: 50 },
            floatsUploaded: { sum: 7200, min: 0, max: 96, avg: 72, last: 80 }
        },
        gpu: { avg: 2.0, min: 1.0, max: 3.0, p01: 1.1, p99: 2.9, samples: 100 }
    };
}

// Capture a summary whose counter.instances.max is the Float32 read-back of n.
function captureInstancesMax(n) {
    const p = new GpuProfiler(64, { counters: TAGS });
    p.beginFrame();
    p.recordDraw(n);
    p.endFrame();
    const s = p.summary();
    p.destroy();
    return s;
}

// ---------------------------------------------------------------------------
// GG-10 -- GpuGate reads summary.schema; a mismatched pair is incomparable.
// ---------------------------------------------------------------------------

// A2 -- schema mismatch short-circuits to inconclusive with a typed schema entry.
test('GG-10 schema mismatch routes to inconclusive', () => {
    const wrong = baseSummary();
    wrong.schema = 'lite-gpu-profiler/summary@999';
    const rules = { 'counter.drawCalls.max': { exact: true } };
    const r = checkGpuRegression(wrong, baseSummary(), rules);
    assert.equal(r.verdict, 'inconclusive');
    assert.equal(r.ok, false);
    assert.equal(r.regressions.length, 0);
    assert.equal(r.inconclusive.length, 1);
    assert.equal(r.inconclusive[0].rule, 'schema');
    assert.equal(r.inconclusive[0].metric, 'schema');
    assert.equal(r.warnings.length, 0);
});

// A2 -- assertNoGpuRegression throws the typed error; validation still precedes
// the short-circuit; 'schema' is not a nameable rule path.
test('GG-10 assert throws GpuInconclusiveError; controls hold', () => {
    const wrong = baseSummary();
    wrong.schema = 'lite-gpu-profiler/summary@999';
    const rules = { 'counter.drawCalls.max': { exact: true } };
    let caught = null;
    try { assertNoGpuRegression(wrong, baseSummary(), rules); } catch (e) { caught = e; }
    assert.ok(caught instanceof GpuInconclusiveError, 'typed inconclusive error');
    assert.ok(caught.report, 'error carries .report');
    assert.equal(caught.report.verdict, 'inconclusive');

    // Ordering control: a misspelled path still throws even when schemas mismatch.
    const typo = { 'counter.drawCalls.maxx': { exact: true } };
    assert.throws(() => checkGpuRegression(wrong, baseSummary(), typo), GpuRuleError);

    // Surface control: 'schema' is not a nameable rule path (not in TOP_FIELDS).
    assert.throws(() => checkGpuRegression(baseSummary(), baseSummary(), { schema: { exact: true } }), GpuRuleError);
});

// A2 -- matched pair still passes (the pre-pass does not break the comparable case).
test('GG-10 matched schema pair still passes', () => {
    const rules = { 'counter.drawCalls.max': { exact: true } };
    const r = checkGpuRegression(baseSummary(), baseSummary(), rules);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 0);
});

// ---------------------------------------------------------------------------
// GG-03 -- the 2^24 signal: additive warnings[], never affects verdict/ok.
// ---------------------------------------------------------------------------

// A4 -- both operands at 2^24: passes, one warning.
test('GG-03 exact operand at 2^24 emits one warning, verdict unchanged', () => {
    const base = captureInstancesMax(16777216);
    const cand = captureInstancesMax(16777216);
    const rules = { 'counter.instances.max': { exact: true } };
    const r = checkGpuRegression(base, cand, rules);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0].metric, 'counter.instances.max');
    assert.equal(r.warnings[0].rule, 'exact');
});

// A4 -- 2^24 vs 2^24+1 both read back as 16777216: the blind spot now signals.
test('GG-03 sub-quantum regression above 2^24 is flagged', () => {
    const base = captureInstancesMax(16777216);
    const cand = captureInstancesMax(16777217);   // rounds to 16777216 in the Float32 ring
    assert.equal(cand.counters.instances.max, 16777216, 'quantized read-back');
    const rules = { 'counter.instances.max': { exact: true } };
    const r = checkGpuRegression(base, cand, rules);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.warnings.length, 1);
});

// A4 -- below the ceiling: byte-for-byte unchanged, no warning.
test('GG-03 exact operand at 2^24 - 1 emits no warning', () => {
    const base = captureInstancesMax(16777215);
    const cand = captureInstancesMax(16777215);
    const rules = { 'counter.instances.max': { exact: true } };
    const r = checkGpuRegression(base, cand, rules);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.warnings.length, 0);
});

// ---------------------------------------------------------------------------
// GG-15 -- the precision advisory covers max/tolerance too, not just exact.
// The max direction is the LIVE control (the exact tests above cannot see the
// hoist: kind === 'exact' whether the advisory sits inside the exact leg or
// above it). Reverting the hoist back inside `if (rule.exact)` turns these red.
// ---------------------------------------------------------------------------

// A5 -- max operand >= 2^24 -> one warning tagged 'max', verdict-neutral vs 2^24-1.
test('GG-15 max operand at 2^24 emits one max warning; verdict identical to 2^24-1', () => {
    const rules = { 'counter.instances.max': { max: 99999999 } };   // ceiling above the value -> pass

    const above = checkGpuRegression(captureInstancesMax(16777216), captureInstancesMax(16777216), rules);
    assert.equal(above.warnings.length, 1, 'a max operand at 2^24 must warn');
    assert.equal(above.warnings[0].rule, 'max');
    assert.equal(above.warnings[0].metric, 'counter.instances.max');

    const below = checkGpuRegression(captureInstancesMax(16777215), captureInstancesMax(16777215), rules);
    assert.equal(below.warnings.length, 0, 'a max operand below 2^24 must not warn');

    // verdict-neutral: the advisory never moves ok/verdict.
    assert.equal(above.verdict, below.verdict);
    assert.equal(above.ok, below.ok);
    assert.equal(above.verdict, 'pass');
});

// A5 -- tolerance operand >= 2^24 -> one warning tagged 'tolerance', verdict-neutral.
test('GG-15 tolerance operand at 2^24 emits one tolerance warning; verdict identical to 2^24-1', () => {
    const rules = { 'counter.instances.max': { tolerance: 0.15 } };

    const above = checkGpuRegression(captureInstancesMax(16777216), captureInstancesMax(16777216), rules);
    assert.equal(above.warnings.length, 1, 'a tolerance operand at 2^24 must warn');
    assert.equal(above.warnings[0].rule, 'tolerance');
    assert.equal(above.warnings[0].metric, 'counter.instances.max');

    const below = checkGpuRegression(captureInstancesMax(16777215), captureInstancesMax(16777215), rules);
    assert.equal(below.warnings.length, 0, 'a tolerance operand below 2^24 must not warn');

    assert.equal(above.verdict, below.verdict);
    assert.equal(above.ok, below.ok);
    assert.equal(above.verdict, 'pass');
});
