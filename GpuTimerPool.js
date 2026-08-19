/**
 * @zakkster/lite-gpu-profiler/timer
 *
 * GpuTimerPool - zero-GC EXT_disjoint_timer_query_webgl2 GPU-time sampler.
 *
 * WebGL2 timer queries are asynchronous: you wrap a region with begin()/end(),
 * but the result is not ready until the GPU drains, typically 1-3 frames later.
 * This pool keeps a fixed ring of pre-allocated query objects, starts at most one
 * region per frame, and resolves every consecutively-finished query on each
 * begin(). A frame whose GPU_DISJOINT flag is set (context switch, throttle) is
 * discarded -- its timing is meaningless. When the GPU falls more than poolSize
 * frames behind, the pool skips opening new regions until a slot frees up, so
 * sustained lag thins the sample rate instead of collapsing it. The pool never
 * allocates after construction and never leaks a query handle (dispose() deletes
 * every one).
 *
 * BROWSER ONLY: this touches a live WebGL2 context. Its state machine (cycling,
 * lag, disjoint-drop, no-leak) is unit-tested headlessly against a mock gl in
 * test/03-timer-pool.test.mjs. The absolute nanosecond values come from the
 * driver's TIME_ELAPSED_EXT and are not asserted by this package -- there is no
 * WebGL2 under node, so no real-GPU test ships here.
 *
 * Constraint honored: only one TIME_ELAPSED query may be active at a time (no
 * nesting). begin() starts the active query; end() ends it; finished queries wait
 * in a FIFO for their result. For lite-gl -- one instanced draw per frame -- wrap
 * the sink's single draw() and this yields per-frame GPU time.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

const EXT_NAME = 'EXT_disjoint_timer_query_webgl2';

export class GpuTimerPool {
    /**
     * @param {WebGL2RenderingContext} gl a WebGL2 context.
     * @param {{ poolSize?: number, onSample?: (ms: number) => void }} [options]
     *        poolSize bounds in-flight queries (default 8): full-rate sampling
     *        holds while GPU result latency stays under poolSize frames; beyond
     *        that, sampling thins to ~poolSize/latency of frames. onSample
     *        receives each resolved GPU time in milliseconds (wire it to
     *        GpuProfiler.recordGpuTime).
     */
    constructor(gl, options = null) {
        this._gl = gl;
        this._ext = gl ? gl.getExtension(EXT_NAME) : null;
        this._onSample = (options && options.onSample) || null;

        const size = Math.max(2, (options && options.poolSize) || 8);
        this._size = size;
        this._supported = !!this._ext;

        if (!this._supported) {
            // No timer-query support: the pool degrades to a no-op. Counters still work.
            this._queries = null;
            return;
        }

        this._target = this._ext.TIME_ELAPSED_EXT;
        this._disjointPname = this._ext.GPU_DISJOINT_EXT;

        // Pre-allocate every query object once. Never grows.
        this._queries = new Array(size);
        for (let i = 0; i < size; i++) this._queries[i] = gl.createQuery();

        // free stack of query indices
        this._free = new Int32Array(size);
        for (let i = 0; i < size; i++) this._free[i] = i;
        this._freeTop = size;                       // count of free indices

        // FIFO of ended-and-awaiting-result query indices (submission order)
        this._fifo = new Int32Array(size);
        this._head = 0;
        this._len = 0;

        this._active = -1;                          // index of the currently-open query, or -1
    }

    /** @returns {boolean} whether GPU timing is available in this context */
    get supported() { return this._supported; }

    _pushFifo(idx) { this._fifo[(this._head + this._len) % this._size] = idx; this._len++; }
    _peekFifo() { return this._fifo[this._head]; }
    _popFifo() { const i = this._fifo[this._head]; this._head = (this._head + 1) % this._size; this._len--; return i; }
    _freePush(idx) { this._free[this._freeTop++] = idx; }
    _freePop() { return this._free[--this._freeTop]; }

    /**
     * Start a frame's GPU-time region. Resolves every consecutively-finished
     * query from the head of the FIFO, then opens a new one if a slot is free.
     * Call before the draw.
     */
    begin() {
        if (!this._supported) return;
        const gl = this._gl;

        // 1) resolve finished queries in FIFO order. One disjoint read per frame;
        //    the drain loop lets the pool catch up after a slow stretch instead of
        //    recovering at one sample per frame.
        if (this._len > 0) {
            const disjoint = gl.getParameter(this._disjointPname);
            if (disjoint) {
                // Timing since the last check is unreliable: discard every in-flight
                // query, not just this one, and free them.
                while (this._len > 0) this._freePush(this._popFifo());
            } else {
                while (this._len > 0) {
                    const idx = this._peekFifo();
                    const q = this._queries[idx];
                    // head not ready: stop; newer queries must not be probed out of order
                    if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
                    const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
                    this._popFifo();
                    this._freePush(idx);
                    if (this._onSample) this._onSample(ns / 1e6);   // ns -> ms
                }
            }
        }

        // 2) open a new query only when a slot is free and none is active. When the
        //    pool is exhausted (GPU more than poolSize frames behind), SKIP this
        //    frame's region rather than dropping the oldest pending: the oldest is
        //    the query closest to completion, and recycling it starves the pool
        //    completely once GPU latency >= poolSize (zero samples, self-sustaining).
        //    Skipping lets pending queries ripen, so sustained latency of L frames
        //    thins sampling to ~poolSize/L of frames instead of collapsing to none.
        //    Samples may then be several frames stale, which is harmless: each one
        //    accurately measures its own frame and consumers aggregate a window --
        //    nothing correlates a sample to a frame index.
        if (this._active === -1 && this._freeTop > 0) {
            const idx = this._freePop();
            this._active = idx;
            gl.beginQuery(this._target, this._queries[idx]);
        }
    }

    /** End the frame's GPU-time region. Call after the draw. */
    end() {
        if (!this._supported || this._active === -1) return;
        this._gl.endQuery(this._target);
        this._pushFifo(this._active);
        this._active = -1;
    }

    /** @param {(ms: number) => void} cb receive resolved GPU times (milliseconds) */
    onSample(cb) { this._onSample = cb; }

    /** Delete every query. Call on dispose or before recreating after context restore. */
    dispose() {
        if (!this._supported || !this._queries) return;
        const gl = this._gl;
        if (this._active !== -1) { try { gl.endQuery(this._target); } catch (_e) { /* context may be gone */ } this._active = -1; }
        for (let i = 0; i < this._queries.length; i++) {
            const q = this._queries[i];
            if (q) gl.deleteQuery(q);
        }
        this._queries = null;
        this._len = 0;
        this._freeTop = 0;
    }
}
