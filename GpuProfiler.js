/**
 * @zakkster/lite-gpu-profiler
 *
 * GpuProfiler - GL-agnostic render-path telemetry core.
 *
 * Two kinds of telemetry with two homes:
 *  - Command COUNTERS (draw calls, instances, floats uploaded) are integers the
 *    caller already has at flush time. They need NO GL, so this core is headless
 *    and its numbers are deterministic -- gate them exactly, cross-version, in the
 *    same matrix as lite-profiler, with no GPU.
 *  - GPU TIME arrives asynchronously from GpuTimerPool (the WebGL2 sink layer,
 *    browser only) via recordGpuTime(ms). This core just stores the resolved
 *    samples; it never touches a GL context.
 *
 * Contract:
 *  - Counter tags are fixed at construction (dynamic tags would allocate).
 *  - The hot path (recordDraw / recordUpload / recordGpuTime) performs no
 *    allocation: it writes to a pre-allocated accumulator or pushes one float to
 *    a ring. endFrame() flushes the frame's counter totals to the rings.
 *  - Call beginFrame()/endFrame() every frame (including frames that draw
 *    nothing); call recordDraw/recordUpload only when work actually happens, so
 *    "frames drawn vs skipped" is recoverable from the drawCalls ring.
 *  - An unpaired begin/end call records nothing: a redundant beginFrame()
 *    preserves the frame in flight, and an endFrame() with no open frame is
 *    ignored -- a broken bracket never fabricates a phantom frame.
 *  - Not safe to use after destroy().
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

import { RingBuffer } from '@zakkster/lite-ring-buffer';
import { StatsMath } from '@zakkster/lite-stats-math';

export const GPU_SUMMARY_SCHEMA = 'lite-gpu-profiler/summary@1';

const DEFAULT_COUNTERS = ['drawCalls', 'instances', 'floatsUploaded'];

export class GpuProfiler {
    /**
     * @param {number} capacity sample window per ring; the underlying ring rounds
     *        up to a power of two.
     * @param {{ counters?: string[] }} [options] counter tags to track. `drawCalls`
     *        is always tracked (frames-drawn is derived from it); any extra tags,
     *        e.g. `instances` and `floatsUploaded`, are recorded per frame.
     */
    constructor(capacity = 1024, options = null) {
        if (!Number.isFinite(capacity) || capacity < 1) {
            throw new RangeError(`GpuProfiler: capacity must be a finite positive number (got ${capacity})`);
        }
        const requested = (options && options.counters) ? options.counters : DEFAULT_COUNTERS;
        // drawCalls must exist: frames-drawn/skipped is derived from its ring.
        const tags = requested.indexOf('drawCalls') === -1 ? ['drawCalls'].concat(requested) : requested.slice();

        const n = tags.length;
        this.counterTags = tags;
        this._counterIndex = Object.create(null);
        this._counterRings = new Array(n);
        this._accum = new Float64Array(n);           // per-frame accumulators
        for (let i = 0; i < n; i++) {
            this._counterIndex[tags[i]] = i;
            this._counterRings[i] = new RingBuffer(capacity);
        }

        // Cached hot-path indices: correct regardless of the caller's tag order, and a
        // monomorphic integer access instead of a string-key lookup per draw. drawCalls
        // is guaranteed present; instances/floatsUploaded may be undefined.
        this._idxDrawCalls = this._counterIndex['drawCalls'];
        this._idxInstances = this._counterIndex['instances'];
        this._idxUploads = this._counterIndex['floatsUploaded'];

        this.gpuMsRing = new RingBuffer(capacity);   // resolved GPU-time samples (sparse: lag + disjoint drops)
        this.capacity = this._counterRings[0].capacity;

        this._frameOpen = false;
        this._stats = new StatsMath(this.capacity);
        this._statsOut = { avg: 0, min: 0, max: 0, p01: 0, p99: 0 };
        this._copy = new Float32Array(this.capacity); // scratch for counter reductions (sum/last)
    }

    /** @returns {number} number of tracked counters */
    get counterCount() { return this._counterRings.length; }

    /**
     * Begin a frame: clear per-frame counter accumulators. A redundant call on an
     * already-open frame is ignored -- it preserves the accumulation in flight
     * rather than discarding it. Unpaired begin/end records nothing.
     */
    beginFrame() {
        if (this._frameOpen) return;
        this._accum.fill(0);
        this._frameOpen = true;
    }

    /**
     * Record a draw. Increments `drawCalls` by one and `instances` (if tracked)
     * by instanceCount. Call once per real draw within the frame.
     * @param {number} instanceCount instances/vertices submitted by this draw.
     */
    recordDraw(instanceCount = 1) {
        this._accum[this._idxDrawCalls] += 1;
        if (this._idxInstances !== undefined) this._accum[this._idxInstances] += instanceCount;
    }

    /**
     * Record a GPU upload. Adds to the `floatsUploaded` counter (if tracked).
     * This is the counter that verifies dirty-range batching: a one-instance
     * change should upload one instance's worth of floats, not the whole buffer.
     * @param {number} floatCount floats written this upload.
     */
    recordUpload(floatCount) {
        if (this._idxUploads !== undefined) this._accum[this._idxUploads] += floatCount;
    }

    /**
     * Add to an arbitrary tracked counter by tag. No-op for unknown tags.
     * @param {string} tag @param {number} n
     */
    add(tag, n = 1) {
        const i = this._counterIndex[tag];
        if (i !== undefined) this._accum[i] += n;
    }

    /**
     * Ingest a resolved GPU-time sample (milliseconds) from GpuTimerPool. Pushed
     * straight to the GPU-time ring; sample count trails frame count because
     * timer queries resolve late and disjoint frames are dropped.
     * @param {number} ms
     */
    recordGpuTime(ms) {
        if (Number.isFinite(ms) && ms >= 0) this.gpuMsRing.push(ms);
    }

    /**
     * End a frame: flush per-frame counter totals to their rings. An unpaired call
     * (no open frame, or after reset()/destroy()) is ignored -- it records nothing,
     * so a broken bracket never fabricates a zeroed phantom frame.
     */
    endFrame() {
        if (!this._frameOpen) return;
        const rings = this._counterRings;
        const accum = this._accum;
        for (let i = 0; i < rings.length; i++) rings[i].push(accum[i]);
        this._frameOpen = false;
    }

    /** Reduce a counter ring to { sum, min, max, avg, last, drawnFrames }. */
    _reduceCounter(ring) {
        const count = ring.count;
        if (count === 0) return { sum: 0, min: 0, max: 0, avg: 0, last: 0, nonzeroFrames: 0 };
        ring.copyTo(this._copy, 0);
        let sum = 0, min = Infinity, max = -Infinity, nonzero = 0;
        for (let i = 0; i < count; i++) {
            const v = this._copy[i];
            sum += v;
            if (v < min) min = v;
            if (v > max) max = v;
            if (v !== 0) nonzero++;
        }
        return { sum, min, max, avg: sum / count, last: ring.peekNewest(), nonzeroFrames: nonzero };
    }

    /**
     * Snapshot a plain summary object (allocates; call off the hot path).
     * @param {object} [meta] merged into the summary (label, engine, etc.).
     * @returns {object} CaptureSummary-shaped: { schema, frameCount, capacity,
     *          counters: { tag: { sum, min, max, avg, last } }, framesDrawn,
     *          framesSkipped, gpu: { avg, min, max, p01, p99, samples } }.
     */
    summary(meta = null) {
        const frameCount = this._counterRings[0].count;
        const counters = Object.create(null);
        let drawnFrames = 0;
        for (let i = 0; i < this._counterRings.length; i++) {
            const tag = this.counterTags[i];
            const r = this._reduceCounter(this._counterRings[i]);
            counters[tag] = { sum: r.sum, min: r.min, max: r.max, avg: r.avg, last: r.last };
            if (tag === 'drawCalls') drawnFrames = r.nonzeroFrames;
        }

        let gpu;
        if (this.gpuMsRing.count > 0) {
            this._stats.compute(this.gpuMsRing, this._statsOut);
            const o = this._statsOut;
            gpu = { avg: o.avg, min: o.min, max: o.max, p01: o.p01, p99: o.p99, samples: this.gpuMsRing.count };
        } else {
            gpu = { avg: 0, min: 0, max: 0, p01: 0, p99: 0, samples: 0 };
        }

        const out = {
            schema: GPU_SUMMARY_SCHEMA,
            frameCount,
            capacity: this.capacity,
            counters,
            framesDrawn: drawnFrames,
            framesSkipped: frameCount - drawnFrames,
            gpu
        };
        if (meta) for (const k in meta) out[k] = meta[k];
        return out;
    }

    /** Clear all rings and accumulators without releasing memory. */
    reset() {
        for (let i = 0; i < this._counterRings.length; i++) this._counterRings[i].reset();
        this.gpuMsRing.reset();
        this._accum.fill(0);
        this._frameOpen = false;
    }

    /** Release all rings. Not safe to use afterwards. */
    destroy() {
        for (let i = 0; i < this._counterRings.length; i++) this._counterRings[i].destroy();
        this.gpuMsRing.destroy();
        this._counterRings = null;
        this._accum = null;
        this._counterIndex = null;
        this._copy = null;
    }
}
