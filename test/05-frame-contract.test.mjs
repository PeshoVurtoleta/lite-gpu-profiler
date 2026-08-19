import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuProfiler } from '../GpuProfiler.js';

// GG-05 -- frame-contract enforcement (no-op, not throw). An unpaired begin/end
// records nothing: no phantom frame, no discarded measurement. See GPU3-PLAN A1.

const TAGS = ['drawCalls', 'instances', 'floatsUploaded'];

// A1 -- double endFrame does not fabricate a second frame.
test('GG-05 double endFrame records exactly one frame', () => {
    const p = new GpuProfiler(64, { counters: TAGS });
    p.beginFrame();
    p.recordDraw(1);
    p.endFrame();
    p.endFrame();                       // unpaired: must be ignored
    const s = p.summary();
    assert.equal(s.frameCount, 1, 'no phantom frame from the second endFrame');
    assert.equal(s.counters.drawCalls.sum, 1);
    assert.equal(s.counters.drawCalls.max, 1);
    assert.equal(s.framesDrawn, 1);
    assert.equal(s.framesSkipped, 0);
    p.destroy();
});

// A1b -- a bare endFrame on a fresh profiler records nothing.
test('GG-05 bare endFrame records nothing', () => {
    const p = new GpuProfiler(64, { counters: TAGS });
    p.endFrame();                       // no open frame: must be ignored
    const s = p.summary();
    assert.equal(s.frameCount, 0, 'bare endFrame must not push a frame');
    assert.equal(s.counters.drawCalls.sum, 0);
    assert.equal(s.framesDrawn, 0);
    assert.equal(s.framesSkipped, 0);
    p.destroy();
});

// A1c -- a redundant beginFrame preserves the in-flight accumulation.
test('GG-05 double beginFrame preserves accumulated draws', () => {
    const p = new GpuProfiler(64, { counters: TAGS });
    p.beginFrame();
    p.recordDraw(1);
    p.beginFrame();                     // redundant: must NOT restart the frame
    p.recordDraw(1);
    p.endFrame();
    const s = p.summary();
    assert.equal(s.frameCount, 1, 'still one frame');
    assert.equal(s.counters.drawCalls.sum, 2, 'no draw discarded');
    assert.equal(s.counters.drawCalls.max, 2);
    p.destroy();
});

// A1d -- the well-formed path is unchanged (the control).
test('GG-05 well-formed frame sequence is unchanged', () => {
    const p = new GpuProfiler(64, { counters: TAGS });
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
    assert.equal(s.counters.drawCalls.sum, 3);
    assert.equal(s.counters.drawCalls.max, 1);
    assert.equal(s.counters.instances.sum, 4500);
    assert.equal(s.counters.instances.max, 2000);
    assert.equal(s.counters.instances.last, 1500);
    assert.equal(s.counters.floatsUploaded.sum, 36000);
    assert.equal(s.framesDrawn, 3);
    assert.equal(s.framesSkipped, 0);
    p.destroy();
});

// A1e -- reset() mid-frame drops the in-flight frame (no zeroed phantom).
test('GG-05 reset mid-frame drops the in-flight frame', () => {
    const p = new GpuProfiler(64, { counters: TAGS });
    p.beginFrame();
    p.recordDraw(1);
    p.reset();
    p.endFrame();                       // frame was closed by reset(): ignored
    const s = p.summary();
    assert.equal(s.frameCount, 0, 'reset mid-frame must leave no phantom frame');
    p.destroy();
});
