import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuTimerPool } from '../GpuTimerPool.js';

// Mock WebGL2 context. Simulates async timer queries: a query becomes available
// `lag` clock ticks after it was ended. Fake result ns = 1e6 * creationOrder, so a
// resolved sample in ms equals the query's creation order (1, 2, 3, ...) -- lets us
// assert FIFO ordering and correct result reads.
function makeMockGL({ lag = 2 } = {}) {
    const ext = { TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB };
    let created = 0, deleted = 0, clock = 0, submit = 0, disjoint = false, active = null;
    const endedAt = new Map();
    const gl = {
        QUERY_RESULT_AVAILABLE: 0x8867,
        QUERY_RESULT: 0x8866,
        getExtension: (n) => (n === 'EXT_disjoint_timer_query_webgl2' ? ext : null),
        createQuery: () => { created++; return { ns: 0 }; },        // queries are reused; result stamped per endQuery
        deleteQuery: () => { deleted++; },
        beginQuery: (_t, q) => { active = q; },
        endQuery: () => { submit++; active.ns = submit * 1e6; endedAt.set(active, clock); active = null; },
        getParameter: (p) => (p === ext.GPU_DISJOINT_EXT ? disjoint : 0),
        getQueryParameter: (q, p) => {
            if (p === gl.QUERY_RESULT_AVAILABLE) return (clock - (endedAt.has(q) ? endedAt.get(q) : Infinity)) >= lag;
            if (p === gl.QUERY_RESULT) return q.ns;
            return 0;
        },
        _tick: () => { clock++; },
        _setDisjoint: (v) => { disjoint = v; },
        _created: () => created,
        _deleted: () => deleted
    };
    return gl;
}

test('resolves lagged samples in FIFO order; result ns -> ms conversion', () => {
    const gl = makeMockGL({ lag: 2 });
    const samples = [];
    const pool = new GpuTimerPool(gl, { poolSize: 4, onSample: (ms) => samples.push(ms) });
    assert.equal(pool.supported, true);

    const N = 12;
    for (let f = 0; f < N; f++) { gl._tick(); pool.begin(); pool.end(); }

    // First query (creation order 1) resolves to 1ms, second to 2ms, ... in order.
    assert.ok(samples.length >= N - 4 && samples.length <= N, `sane sample count (${samples.length})`);
    for (let i = 0; i < samples.length; i++) assert.equal(samples[i], i + 1, 'FIFO order + correct result');
    pool.dispose();
});

test('pool is reused: never allocates a query after warmup, never leaks a handle', () => {
    const gl = makeMockGL({ lag: 2 });
    const POOL = 4;
    const pool = new GpuTimerPool(gl, { poolSize: POOL, onSample: () => {} });
    for (let f = 0; f < 500; f++) { gl._tick(); pool.begin(); pool.end(); }
    assert.equal(gl._created(), POOL, 'exactly poolSize queries ever created (zero per-frame alloc)');
    pool.dispose();
    assert.equal(gl._deleted(), POOL, 'every query deleted on dispose (no leak)');
});

test('disjoint frames are dropped, not sampled; sampling resumes after', () => {
    const gl = makeMockGL({ lag: 2 });
    const samples = [];
    const pool = new GpuTimerPool(gl, { poolSize: 4, onSample: (ms) => samples.push(ms) });

    for (let f = 0; f < 6; f++) { gl._tick(); pool.begin(); pool.end(); }
    const before = samples.length;
    assert.ok(before > 0, 'sampling before disjoint');

    // GPU goes disjoint for a stretch: no samples should be taken, pending flushed.
    gl._setDisjoint(true);
    for (let f = 0; f < 4; f++) { gl._tick(); pool.begin(); pool.end(); }
    assert.equal(samples.length, before, 'no samples recorded while disjoint');

    // recover
    gl._setDisjoint(false);
    for (let f = 0; f < 8; f++) { gl._tick(); pool.begin(); pool.end(); }
    assert.ok(samples.length > before, 'sampling resumes after disjoint clears');
    pool.dispose();
});

test('unsupported context (no timer extension) degrades to a safe no-op', () => {
    const gl = { getExtension: () => null };
    const samples = [];
    const pool = new GpuTimerPool(gl, { poolSize: 4, onSample: (ms) => samples.push(ms) });
    assert.equal(pool.supported, false);
    for (let f = 0; f < 10; f++) { pool.begin(); pool.end(); }   // must not throw
    assert.equal(samples.length, 0);
    pool.dispose();   // must not throw
});

test('REGRESSION: sustained GPU latency > poolSize must thin sampling, not starve it', () => {
    // The old exhaustion policy dropped the oldest pending query to open a new
    // one -- but the oldest is the query closest to completion, so once latency
    // reached poolSize every query was recycled one frame before it ripened and
    // sample flow collapsed to exactly ZERO (the frozen demo scope at 250k/500k).
    // The fix skips opening instead: the oldest ripens, frees its slot, and the
    // pool settles into one latency-delayed sample per frame.
    const POOL = 4, LAG = POOL + 2;                    // GPU strictly slower than the pool
    const gl = makeMockGL({ lag: LAG });
    const samples = [];
    const pool = new GpuTimerPool(gl, { poolSize: POOL, onSample: (ms) => samples.push(ms) });

    const N = 300;
    for (let f = 0; f < N; f++) { gl._tick(); pool.begin(); pool.end(); }

    // steady state under lag L: the P in-flight queries ripen in a burst, then a
    // (L-P)-frame hole while the next batch cooks -> throughput ~ N * P / L.
    const expected = Math.floor(N * POOL / LAG);
    assert.ok(samples.length >= expected - LAG - POOL, `samples keep flowing under lag (got ${samples.length}, expect ~${expected}; old policy: 0)`);
    for (let i = 1; i < samples.length; i++) {
        assert.equal(samples[i], samples[i - 1] + 1, 'FIFO order preserved under lag (no dropped/reordered results)');
    }
    assert.equal(gl._created(), POOL, 'still exactly poolSize queries ever created');
    pool.dispose();
    assert.equal(gl._deleted(), POOL, 'no leaked handles after sustained pressure');
});

test('a latency spike drains as a backlog burst, then sampling resumes per-frame', () => {
    // lag=2 keeps a small steady backlog; freezing the clock simulates a stall
    // (nothing ripens), then ticking again must resolve the whole backlog via the
    // drain loop rather than one sample per begin().
    const gl = makeMockGL({ lag: 2 });
    const samples = [];
    const pool = new GpuTimerPool(gl, { poolSize: 4, onSample: (ms) => samples.push(ms) });

    for (let f = 0; f < 6; f++) { gl._tick(); pool.begin(); pool.end(); }
    const before = samples.length;

    // stall: clock frozen, three more begin/end fill the FIFO with unripe queries
    for (let f = 0; f < 3; f++) { pool.begin(); pool.end(); }
    assert.equal(samples.length, before, 'nothing resolves while stalled');

    // recovery: everything in the FIFO ripens; one begin() must drain the backlog
    for (let t = 0; t < 4; t++) gl._tick();
    pool.begin();
    assert.ok(samples.length >= before + 2, `drain loop caught up the backlog (got +${samples.length - before})`);
    pool.end();
    pool.dispose();
});
