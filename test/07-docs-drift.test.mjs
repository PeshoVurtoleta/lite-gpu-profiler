import { test } from 'node:test';
import assert from 'node:assert/strict';

// Docs-drift guard. The README and llms.txt promise a public surface; this test
// pins it so the docs cannot silently drift from the code.
import * as barrel from '../index.js';

test('documented surface exists with the right shape (docs cannot drift)', () => {
    // The six named exports on the barrel (index.js).
    assert.equal(typeof barrel.GpuProfiler, 'function');
    assert.equal(typeof barrel.GpuTimerPool, 'function');
    assert.equal(typeof barrel.checkGpuRegression, 'function');
    assert.equal(typeof barrel.assertNoGpuRegression, 'function');
    assert.equal(typeof barrel.GPU_DEFAULT_RULES, 'object');
    assert.equal(typeof barrel.GPU_SUMMARY_SCHEMA, 'string');

    // The schema token is a hard invariant: enforcing token equality (GG-10) means
    // it must never change, or every baseline produced by 1.0.x/1.1.0 breaks.
    assert.equal(barrel.GPU_SUMMARY_SCHEMA, 'lite-gpu-profiler/summary@1');

    // GG-12: the gate error classes + field arrays are exported from the entry
    // point since 1.2.0, so consumers reach them off the barrel directly.
    assert.equal(typeof barrel.GpuRuleError, 'function');
    assert.equal(typeof barrel.GpuRegressionError, 'function');
    assert.equal(typeof barrel.GpuInconclusiveError, 'function');
    assert.ok(Array.isArray(barrel.GPU_FIELDS));
    assert.ok(Array.isArray(barrel.COUNTER_FIELDS));
    assert.ok(Array.isArray(barrel.TOP_FIELDS));

    // The field arrays keep their documented lengths (6/5/4).
    assert.equal(barrel.GPU_FIELDS.length, 6);
    assert.equal(barrel.COUNTER_FIELDS.length, 5);
    assert.equal(barrel.TOP_FIELDS.length, 4);

    // GG-12: these classes are exported from the entry point since 1.2.0, so
    // `err instanceof GpuInconclusiveError` works off the barrel import.
    assert.notEqual(barrel.GpuRuleError, undefined);
    assert.notEqual(barrel.GpuRegressionError, undefined);
    assert.notEqual(barrel.GpuInconclusiveError, undefined);
});

test('instanceof round-trip (GG-12)', () => {
    // Force an inconclusive verdict: a candidate with gpu.samples === 0 cannot be
    // measured against a gpu.* rule, so the gate fails closed to inconclusive.
    const baseline = {
        schema: 'lite-gpu-profiler/summary@1',
        gpu: { avg: 1, min: 1, max: 1, p01: 1, p99: 1, samples: 10 },
        counters: {}
    };
    const candidate = {
        schema: 'lite-gpu-profiler/summary@1',
        gpu: { avg: 0, min: 0, max: 0, p01: 0, p99: 0, samples: 0 },
        counters: {}
    };
    const rules = { 'gpu.p99': { tolerance: 0.15 } };

    let caught;
    try {
        barrel.assertNoGpuRegression(baseline, candidate, rules);
    } catch (e) {
        caught = e;
    }

    // Option 1: instanceof, now expressible from the barrel import (1.2.0).
    assert.ok(caught instanceof barrel.GpuInconclusiveError);
    // Option 2: name branch, for CI that prefers not to import.
    assert.equal(caught.name, 'GpuInconclusiveError');
    // The report rides on the error either way.
    assert.equal(caught.report.verdict, 'inconclusive');
});
