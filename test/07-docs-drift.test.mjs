import { test } from 'node:test';
import assert from 'node:assert/strict';

// Docs-drift guard. The README and llms.txt promise a public surface; this test
// pins it so the docs cannot silently drift from the code.
import * as barrel from '../index.js';

// GG-12 (recorded, not fixed in 1.1.1): the three error classes and three field
// arrays are documented but are NOT re-exported from the package entry point --
// they are reachable only from their own module. Import them from GpuGate.js
// directly so the existence check reflects where a consumer can actually get them.
import {
    GpuRuleError,
    GpuRegressionError,
    GpuInconclusiveError,
    GPU_FIELDS,
    COUNTER_FIELDS,
    TOP_FIELDS
} from '../GpuGate.js';

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

    // GG-12: the documented gate error classes + field arrays exist on GpuGate.js
    // (not the barrel). Consumers reach them via the module or branch on err.name.
    assert.equal(typeof GpuRuleError, 'function');
    assert.equal(typeof GpuRegressionError, 'function');
    assert.equal(typeof GpuInconclusiveError, 'function');
    assert.ok(Array.isArray(GPU_FIELDS));
    assert.ok(Array.isArray(COUNTER_FIELDS));
    assert.ok(Array.isArray(TOP_FIELDS));

    // These classes are deliberately NOT on the entry point (GG-12 is docs-only in
    // 1.1.1; adding exports would be a minor).
    assert.equal(barrel.GpuRuleError, undefined);
    assert.equal(barrel.GpuRegressionError, undefined);
    assert.equal(barrel.GpuInconclusiveError, undefined);
});
