import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuProfiler } from '../GpuProfiler.js';

// A mock sink mirroring lite-gl GLBackend createPointSink's interface exactly:
//   upload(data, floatOffset, floatCount, instanceOffset, stride)
//   draw(count)
// It forwards to the profiler the way the real (browser) sink would. No GL.
function instrumentedMockSink(profiler) {
    return {
        upload(_data, _floatOffset, floatCount, _instanceOffset, _stride) { profiler.recordUpload(floatCount); },
        draw(count) { profiler.recordDraw(count); }
    };
}

test('counter sums, max, last across drawn frames', () => {
    const p = new GpuProfiler(64, { counters: ['drawCalls', 'instances', 'floatsUploaded'] });
    // 3 frames, each draws once with a different instance count + upload size.
    const draws = [1000, 2000, 1500];
    const uploads = [8000, 16000, 12000];
    for (let f = 0; f < 3; f++) {
        p.beginFrame();
        p.recordUpload(uploads[f]);
        p.recordDraw(draws[f]);
        p.endFrame();
    }
    const s = p.summary();
    assert.equal(s.frameCount, 3);
    assert.equal(s.counters.drawCalls.sum, 3);          // one draw per frame
    assert.equal(s.counters.drawCalls.max, 1);
    assert.equal(s.counters.instances.sum, 4500);
    assert.equal(s.counters.instances.max, 2000);
    assert.equal(s.counters.instances.last, 1500);
    assert.equal(s.counters.floatsUploaded.sum, 36000);
    assert.equal(s.framesDrawn, 3);
    assert.equal(s.framesSkipped, 0);
    p.destroy();
});

test('frames drawn vs skipped is recovered from the drawCalls ring', () => {
    const p = new GpuProfiler(64);
    // 5 frames: draw, skip, draw, skip, skip
    const pattern = [true, false, true, false, false];
    for (const drew of pattern) {
        p.beginFrame();
        if (drew) { p.recordUpload(80); p.recordDraw(10); }
        p.endFrame();
    }
    const s = p.summary();
    assert.equal(s.frameCount, 5);
    assert.equal(s.framesDrawn, 2);
    assert.equal(s.framesSkipped, 3);
    assert.equal(s.counters.drawCalls.sum, 2);
    p.destroy();
});

test('dirty-range batching: a one-instance change uploads one stride, not the whole buffer', () => {
    // This is the verification lite-gl exists for. STRIDE floats per instance
    // (LAYOUT.POINT = 8). A field of CAP instances, but only instance #7 changed,
    // so the flush must upload exactly STRIDE floats. If a regression re-uploaded
    // the whole buffer, floatsUploaded would be CAP*STRIDE and this fails.
    const STRIDE = 8, CAP = 1_000_000;
    const p = new GpuProfiler(64);
    const sink = instrumentedMockSink(p);

    p.beginFrame();
    // dirty range = one instance worth of floats (what reactiveField.flush would pass)
    sink.upload(null, 7 * STRIDE, STRIDE, 7, STRIDE);
    sink.draw(CAP);                                     // still draws all CAP in one instanced call
    p.endFrame();

    const s = p.summary();
    assert.equal(s.counters.floatsUploaded.max, STRIDE, 'uploaded one instance, not the whole buffer');
    assert.equal(s.counters.drawCalls.max, 1, 'one instanced draw call');
    assert.equal(s.counters.instances.max, CAP, 'draw covers all instances');
    // guard against the regression explicitly:
    assert.notEqual(s.counters.floatsUploaded.max, CAP * STRIDE, 'a full re-upload would be a dirty-range regression');
    p.destroy();
});

test('GPU-time samples reduce via StatsMath; sample count trails frames (lag/disjoint)', () => {
    const p = new GpuProfiler(64);
    for (let f = 0; f < 10; f++) { p.beginFrame(); p.recordDraw(100); p.endFrame(); }
    // only 7 of 10 frames produced a resolved GPU-time sample (3 lost to lag/disjoint)
    for (const ms of [1.0, 1.2, 0.9, 1.1, 1.3, 1.0, 5.0]) p.recordGpuTime(ms);
    const s = p.summary();
    assert.equal(s.frameCount, 10);
    assert.equal(s.gpu.samples, 7);
    assert.ok(s.gpu.max >= 5.0 - 1e-6 && s.gpu.avg > 0, 'gpu stats computed');
    assert.ok(s.gpu.p99 >= s.gpu.avg, 'p99 >= avg');
    p.destroy();
});

test('reset clears everything; determinism across two identical runs', () => {
    const p = new GpuProfiler(64);
    const run = () => {
        p.reset();
        for (let f = 0; f < 4; f++) { p.beginFrame(); p.recordUpload(80); p.recordDraw(10); p.endFrame(); }
        return p.summary();
    };
    const a = run(), b = run();
    assert.deepEqual(a.counters, b.counters, 'identical inputs -> identical counters (deterministic)');
    p.destroy();
});

test('custom counter order does not corrupt counters (regression: hardcoded _accum[0])', () => {
    // drawCalls is NOT first -> the old hardcoded _accum[0] would hit "instances".
    const p = new GpuProfiler(64, { counters: ['instances', 'drawCalls', 'floatsUploaded'] });
    for (let f = 0; f < 3; f++) { p.beginFrame(); p.recordUpload(80); p.recordDraw(500); p.endFrame(); }
    const s = p.summary();
    assert.equal(s.counters.drawCalls.sum, 3, 'drawCalls counted correctly at a non-zero index');
    assert.equal(s.counters.drawCalls.max, 1);
    assert.equal(s.counters.instances.sum, 1500, 'instances not corrupted by the drawCalls increment');
    assert.equal(s.counters.instances.max, 500);
    assert.equal(s.counters.floatsUploaded.sum, 240);
    assert.equal(s.framesDrawn, 3, 'framesDrawn (derived from drawCalls) works with a custom order');
    p.destroy();
});

test('drawCalls is auto-prepended when omitted, and lands at index 0', () => {
    const p = new GpuProfiler(64, { counters: ['floatsUploaded'] });   // no drawCalls
    assert.equal(p.counterTags[0], 'drawCalls');
    p.beginFrame(); p.recordUpload(16); p.recordDraw(9); p.endFrame();
    const s = p.summary();
    assert.equal(s.counters.drawCalls.sum, 1);
    assert.equal(s.counters.floatsUploaded.sum, 16);
    assert.equal(s.counters.instances, undefined, 'instances not tracked when not requested');
    p.destroy();
});
