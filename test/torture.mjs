// test/torture.mjs -- node --expose-gc test/torture.mjs
//
// Zero-GC + retention gate for @zakkster/lite-gpu-profiler. Backs the
// "hot path allocates nothing" claim (GG-07) with the strongest evidence the
// ecosystem instruments can give: no RETENTION (major-GC count 0) and no
// backing-store GROWTH (byteLength identical across reset cycles), plus the
// structural pool invariants. Transient per-op garbage is invisible to both
// maxMajor and measureOps' bytesPerOp (each measures retention -- see V3a), so
// the transient class is covered by those structural proofs and by inspection
// of the pure-typed-array hot bodies, not by a dynamic per-op byte gate. This
// also fences the GpuGate verdict paths (GG-01/02/04/09) so they cannot
// silently regress. Runtime source is UNTOUCHED; this file + one npm script
// are the whole of GPU2.
//
// Tiers, in order:
//   V0  surface conformance -- every documented rule path is evaluated, a typo
//       throws, and rejecting it leaves the valid-path verdict untouched.
//   V1  fail-closed degenerates -- samples===0, non-finite recordGpuTime, empty
//       and single-sample captures, a schema mismatch that routes to inconclusive
//       (GG-10, fixed in 1.1.1), and a metric present in baseline but vanished from
//       the candidate that routes to inconclusive under max/tolerance (GG-13, fixed
//       in 1.2.1; both directions pinned).
//   V3a profiler hot path -- steady instance stepped HOT times under GcProfiler,
//       gated on checkNoGc(maxMajor:0,maxPauseMs:4). A zero-alloc hot path forces
//       no major GC; a retaining variant forces majors. (maxBytesPerOp:0 is NOT
//       gated: measureOps' per-op byte reading has an irreducible sub-byte noise
//       floor that inverts with work -- an instrument artifact, not an allocation.
//       Widening that budget to swallow the floor is forbidden, so the robust
//       zero-alloc proof is the major-GC count instead.)
//   V3b GpuTimerPool begin/end over an allocation-free mock GL, same major-GC gate,
//       plus the structural no-alloc/no-leak proof: exactly poolSize queries ever
//       created, every one deleted on dispose, and both distinguishing branches
//       (disjoint-drop, pool-exhausted) run inside the measured window.
//   V3c retention -- backing stores never grow across reset() (byteLength identical
//       at cycle 1 vs N); tracked profilers are collected (tracker.size() -> 0) via
//       a bounded-retry settle (gc + macrotask, up to MAX_SETTLE_ROUNDS, early-exit
//       the instant the tracker drains -- a real leak burns all rounds and FAILS).
//       lite-leak OUTSIDE every measured window.
//   V5  controls -- five mutants (allocating hot path, legacy binary gate,
//       permissive validator, retaining tracker, vanish-skip gate) each spawned in
//       a child that MUST exit non-zero. The retain mutant is the leak-direction
//       control for the bounded settle: a genuine leak never drains and fails the
//       tier. The vanish mutant restores the old :193 skip and MUST fail V1.
//
// A tier reporting 0 checks is a FAIL. No gate output is a FAIL.
//
// Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. MIT.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';

import { GpuProfiler, GPU_SUMMARY_SCHEMA } from '../GpuProfiler.js';
import { GpuTimerPool } from '../GpuTimerPool.js';
import {
    checkGpuRegression,
    assertNoGpuRegression,
    GpuRuleError,
    GpuRegressionError,
    GpuInconclusiveError,
    GPU_FIELDS,
    COUNTER_FIELDS,
    TOP_FIELDS
} from '../GpuGate.js';

// ---------------------------------------------------------------------------
// Run scale. A mutant child (TORTURE_MUTANT set) runs smaller so the control
// sweep stays fast; only the injected tier needs to fire, not stress.
// ---------------------------------------------------------------------------
const MUTANT = process.env.TORTURE_MUTANT || '';
const CHILD = MUTANT !== '';
// HOT tuned so a retaining hot-path variant RELIABLY forces a major GC while the
// clean path forces none (measured: clean 0 majors 6/6, retain 2 majors 6/6 at
// 2e6). Not reduced for children -- the alloc control must still force a major.
const HOT_A = 2000000;                     // V3a profiler hot-path steps
const HOT_B = 1000000;                     // V3b pool begin/end steps
const CYCLES = CHILD ? 512 : 4096;         // V3c fill/reset stability cycles
// V3c/V3b FR-collection cycles. Child scale is 512, not 256: at 256 a single one
// of the clean pool/profiler objects can straggle uncollected for tens of settle
// rounds (a GC-timing artifact, not a leak), which would fail V3b/V3c for the
// WRONG reason before the retain control ever reaches its V3c injection. At 512 the
// clean set drains in round 1 every time, so a child that fails did so for a real
// reason -- the injected _retainSink leak.
const RETAIN_N = CHILD ? 512 : 1024;

const COUNTER_TAGS = ['drawCalls', 'instances', 'floatsUploaded'];

// Mutant-selectable dependencies. The gates WRAP the real gate rather than
// patch the module: an alternative harness function, never an in-process
// monkey-patch of runtime source.
const gateV0 = MUTANT === 'validator' ? permissiveValidatorGate
    : MUTANT === 'gate' ? legacyBinaryGate
        : checkGpuRegression;
const gateV1 = MUTANT === 'gate' ? legacyBinaryGate : checkGpuRegression;
// GG-13 vanish control: restores the old :193 skip through a wrapper (see below).
const gateVanish = MUTANT === 'vanish' ? vanishSkipGate : checkGpuRegression;
const allocMutant = MUTANT === 'alloc';
// Leak-direction control for the bounded settle (GG-11): retain every tracked
// profiler so the tracker never drains, exhausting all settle rounds and failing V3c.
const retainMutant = MUTANT === 'retain';
const _retainSink = [];

// ---------------------------------------------------------------------------
// Mutant gates (harness alternatives; never touch runtime source).
// ---------------------------------------------------------------------------

// The legacy binary gate: no third verdict. It collapses 'inconclusive' to a
// green 'pass' -- exactly the GG-01 fail-open that shipped before v1.0.1. A
// samples===0 candidate then passes silently, which V1 must reject.
function legacyBinaryGate(baseline, candidate, rules) {
    const r = checkGpuRegression(baseline, candidate, rules);   // preserves path validation
    if (r.verdict === 'inconclusive') {
        return { ok: true, verdict: 'pass', regressions: [], inconclusive: [] };
    }
    return r;
}

// The permissive validator: re-admits a misspelled rule path (the GG-02
// fail-open). It swallows the GpuRuleError the real pre-pass throws and returns
// a green report, so V0's typo control no longer fires.
function permissiveValidatorGate(baseline, candidate, rules) {
    try {
        return checkGpuRegression(baseline, candidate, rules);
    } catch (e) {
        if (e && e.name === 'GpuRuleError') {
            return { ok: true, verdict: 'pass', regressions: [], inconclusive: [] };
        }
        throw e;
    }
}

// The vanish-skip gate: the GG-13 fail-open control. A wrapper cannot re-insert
// `continue` at GpuGate.js:193, so it restores that old silent skip through the
// only door a wrapper has -- it strips every GG-13 vanish inconclusive (a
// max/tolerance entry whose reason names the vanish) from the real report and
// recomputes verdict/ok, collapsing the fail-closed inconclusive back to the
// silent green pass that V1 must reject. Distinct from legacyBinaryGate, which
// collapses ALL inconclusive (schema, zero-sample, poisoned, ...) to pass.
function vanishSkipGate(baseline, candidate, rules) {
    const r = checkGpuRegression(baseline, candidate, rules);
    const kept = r.inconclusive.filter((x) =>
        !((x.rule === 'max' || x.rule === 'tolerance') && / nothing to bound$/.test(x.reason)));
    if (kept.length === r.inconclusive.length) return r;
    const verdict = r.regressions.length ? 'fail' : kept.length ? 'inconclusive' : 'pass';
    return { ok: verdict === 'pass', verdict, regressions: r.regressions, inconclusive: kept, warnings: r.warnings };
}

// ---------------------------------------------------------------------------
// Check accounting. Every tier bumps _checks via ok()/throws(); a tier that
// bumps it zero times is treated as a FAIL by runTier.
// ---------------------------------------------------------------------------
let _checks = 0;

function ok(cond, msg) {
    _checks++;
    if (!cond) throw new Error(msg || 'assertion failed');
}

function throws(fn, ctor, msg) {
    _checks++;
    let caught = null;
    try { fn(); } catch (e) { caught = e; }
    if (!caught) throw new Error((msg || 'expected throw') + ': nothing thrown');
    if (ctor && !(caught instanceof ctor) && caught.name !== ctor.name) {
        throw new Error((msg || 'wrong error class') + ': got ' + (caught && caught.name));
    }
    return caught;
}

// ---------------------------------------------------------------------------
// Summary fixtures for V0/V1 (cold; not a measured path).
// ---------------------------------------------------------------------------
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

function getPath(sum, path) {
    const p = path.split('.');
    if (p[0] === 'counter') return sum.counters[p[1]][p[2]];
    if (p[0] === 'gpu') return sum.gpu[p[1]];
    return sum[path];
}

function setPath(sum, path, val) {
    const p = path.split('.');
    if (p[0] === 'counter') sum.counters[p[1]][p[2]] = val;
    else if (p[0] === 'gpu') sum.gpu[p[1]] = val;
    else sum[path] = val;
}

// The 25 documented rule paths, derived from the module's own field lists so
// the surface can never drift from GpuGate: 15 counter + 6 gpu + 4 top-level.
function allRulePaths() {
    const paths = [];
    for (const tag of COUNTER_TAGS) for (const f of COUNTER_FIELDS) paths.push('counter.' + tag + '.' + f);
    for (const f of GPU_FIELDS) paths.push('gpu.' + f);
    for (const f of TOP_FIELDS) paths.push(f);
    return paths;
}

// ---------------------------------------------------------------------------
// Tier V0 -- surface conformance (fences GG-02).
// ---------------------------------------------------------------------------
async function tierV0() {
    const paths = allRulePaths();
    ok(paths.length === 25, 'surface must be 25 paths, got ' + paths.length);

    // Both directions per path (A4: 25 x 2 = 50). A passing rule leaves no
    // trace, so the evaluated direction feeds a VIOLATING candidate and asserts
    // regressions[0].metric === path -- proof the path was actually read.
    for (const path of paths) {
        const rules = {};
        rules[path] = { exact: true };

        // violating direction: bump this path's value so exact must regress.
        const base = baseSummary();
        const bad = baseSummary();
        setPath(bad, path, getPath(base, path) + 1);
        const rBad = gateV0(base, bad, rules);
        ok(rBad.verdict === 'fail' && rBad.regressions.length === 1 && rBad.regressions[0].metric === path,
            'V0 evaluated ' + path + ': verdict=' + rBad.verdict + ' n=' + rBad.regressions.length +
            ' metric=' + (rBad.regressions[0] && rBad.regressions[0].metric));

        // passing direction: identical value -> clean pass, path still evaluated.
        const rOk = gateV0(base, baseSummary(), rules);
        ok(rOk.verdict === 'pass' && rOk.regressions.length === 0,
            'V0 clean ' + path + ': verdict=' + rOk.verdict);
    }

    // Typo control: a misspelled field throws GpuRuleError in the pre-pass, and
    // rejecting it must not disturb the 25 valid paths' verdict.
    const rules25 = {};
    for (const path of paths) rules25[path] = { exact: true };
    const base = baseSummary();

    const reportBefore = gateV0(base, base, rules25);
    ok(reportBefore.verdict === 'pass', 'V0 rules25 baseline verdict=' + reportBefore.verdict);

    const rulesTypo = Object.assign({}, rules25, { 'counter.drawCalls.maxx': { exact: true } });
    throws(() => gateV0(base, base, rulesTypo), GpuRuleError, 'V0 typo path must throw GpuRuleError');

    const reportAfter = gateV0(base, base, rules25);
    ok(JSON.stringify(reportBefore) === JSON.stringify(reportAfter),
        'V0 valid-path report unchanged by rejected typo');
}

// ---------------------------------------------------------------------------
// Tier V1 -- fail-closed degenerates (fences GG-01, GG-04).
// ---------------------------------------------------------------------------
async function tierV1() {
    // (1) gpu.samples === 0 -> inconclusive, never a silent pass.
    const base = baseSummary();
    const zero = baseSummary();
    zero.gpu = { avg: 0, min: 0, max: 0, p01: 0, p99: 0, samples: 0 };
    const rZero = gateV1(base, zero, { 'gpu.p99': { tolerance: 0.15 } });
    ok(rZero.verdict !== 'pass', 'V1 samples===0 must not pass, got ' + rZero.verdict);
    // real gate is precise: inconclusive, and assert throws the typed error.
    const rReal = checkGpuRegression(base, zero, { 'gpu.p99': { tolerance: 0.15 } });
    ok(rReal.verdict === 'inconclusive', 'V1 samples===0 real verdict=' + rReal.verdict);
    const eInc = throws(() => assertNoGpuRegression(base, zero, { 'gpu.p99': { tolerance: 0.15 } }),
        GpuInconclusiveError, 'V1 samples===0 asserts GpuInconclusiveError');
    ok(!!eInc.report, 'V1 inconclusive error carries .report');

    // (2) non-finite / negative recordGpuTime are DROPPED (GG-04): the ring
    // never ingests them, so gpu.samples stays 0 instead of poisoning to null.
    const p = new GpuProfiler(64, { counters: COUNTER_TAGS });
    p.recordGpuTime(Infinity);
    p.recordGpuTime(NaN);
    p.recordGpuTime(-1);
    ok(p.gpuMsRing.count === 0, 'V1 non-finite/negative samples dropped, count=' + p.gpuMsRing.count);
    p.recordGpuTime(2.5);
    ok(p.gpuMsRing.count === 1, 'V1 finite sample ingested, count=' + p.gpuMsRing.count);
    ok(p.summary().gpu.samples === 1, 'V1 summary samples=1 after one finite ingest');

    // (3) empty capture (frameCount === 0): a gpu rule cannot be measured.
    const empty = new GpuProfiler(64, { counters: COUNTER_TAGS }).summary();
    ok(empty.frameCount === 0 && empty.gpu.samples === 0, 'V1 empty capture shape');
    const rEmpty = checkGpuRegression(base, empty, { 'gpu.avg': { tolerance: 0.1 } });
    ok(rEmpty.verdict === 'inconclusive', 'V1 empty gpu rule inconclusive, got ' + rEmpty.verdict);

    // (4) single-sample capture is still gated (not skipped): a lone regressing
    // sample fails, it does not slip through as a silent pass.
    const one = new GpuProfiler(64, { counters: COUNTER_TAGS });
    for (let i = 0; i < 5; i++) { one.beginFrame(); one.recordDraw(1); one.endFrame(); }
    one.recordGpuTime(100);
    const oneSum = one.summary();
    ok(oneSum.gpu.samples === 1, 'V1 single-sample samples=1');
    const rOne = checkGpuRegression(base, oneSum, { 'gpu.p99': { tolerance: 0.15 } });
    ok(rOne.verdict === 'fail', 'V1 single-sample regression must fail, got ' + rOne.verdict);
    const eReg = throws(() => assertNoGpuRegression(base, oneSum, { 'gpu.p99': { tolerance: 0.15 } }),
        GpuRegressionError, 'V1 single-sample asserts GpuRegressionError');
    ok(!!eReg.report, 'V1 regression error carries .report');

    // (5) GG-10 (fixed in 1.1.1): GpuGate reads summary.schema. Two summaries whose
    // schema tokens differ are incomparable, so the gate short-circuits to
    // inconclusive before any rule runs -- one 'schema' entry, no regressions. Both
    // directions are pinned: the mismatched pair routes away from pass, and the
    // matched control still passes (the pre-pass did not break the comparable case).
    const wrongSchema = baseSummary();
    wrongSchema.schema = 'lite-gpu-profiler/summary@999';
    const schemaRules = { 'counter.drawCalls.max': { exact: true } };

    // mutant-sensitive: legacyBinaryGate collapses inconclusive to pass, so this
    // trips the 'gate' mutant on the NEW route as well as the old ones.
    ok(gateV1(wrongSchema, baseSummary(), schemaRules).verdict !== 'pass',
        'V1 GG-10: schema mismatch must not pass');

    const rSchema = checkGpuRegression(wrongSchema, baseSummary(), schemaRules);
    ok(rSchema.verdict === 'inconclusive', 'V1 GG-10 schema mismatch verdict=' + rSchema.verdict);
    ok(rSchema.inconclusive.length === 1, 'V1 GG-10 one inconclusive entry, got ' + rSchema.inconclusive.length);
    ok(rSchema.inconclusive[0].rule === 'schema', 'V1 GG-10 entry rule=' + rSchema.inconclusive[0].rule);
    ok(rSchema.regressions.length === 0, 'V1 GG-10 no regressions, got ' + rSchema.regressions.length);
    const eSchema = throws(() => assertNoGpuRegression(wrongSchema, baseSummary(), schemaRules),
        GpuInconclusiveError, 'V1 GG-10 asserts GpuInconclusiveError');
    ok(!!eSchema.report, 'V1 GG-10 inconclusive error carries .report');

    // matched direction (the control): the pre-pass leaves comparable pairs alone.
    ok(checkGpuRegression(baseSummary(), baseSummary(), schemaRules).verdict === 'pass',
        'V1 GG-10 matched schema pair still passes');

    // (6) GG-13 (fixed in 1.2.1): a metric present in baseline but ABSENT from the
    // candidate cannot be bounded by max/tolerance -- fail closed to inconclusive,
    // not the old silent green pass at :193. The real gate is pinned on
    // rule/metric/reason; at least one check runs through gateVanish so the
    // 'vanish' mutant (which restores the old skip) trips HERE. Controls: exact on
    // the same input still fails, and a both-undefined TOP-LEVEL field still skips.
    const vanBase = baseSummary();
    const vanDropped = baseSummary();
    delete vanDropped.counters.instances;   // baseline tracks it, candidate dropped it
    const vanRules = { 'counter.instances.max': { max: 1000 } };

    // mutant-sensitive: real gate -> inconclusive; vanishSkipGate strips it back to
    // a silent pass, so this assertion is exactly what the 'vanish' mutant fails on.
    ok(gateVanish(vanBase, vanDropped, vanRules).verdict !== 'pass',
        'V1 GG-13: vanished metric under max must not pass');

    const rVan = checkGpuRegression(vanBase, vanDropped, vanRules);
    ok(rVan.verdict === 'inconclusive', 'V1 GG-13 vanish verdict=' + rVan.verdict);
    ok(rVan.regressions.length === 0, 'V1 GG-13 no regressions, got ' + rVan.regressions.length);
    ok(rVan.inconclusive.length === 1, 'V1 GG-13 one inconclusive entry, got ' + rVan.inconclusive.length);
    ok(rVan.inconclusive[0].rule === 'max', 'V1 GG-13 entry rule=' + rVan.inconclusive[0].rule);
    ok(rVan.inconclusive[0].metric === 'counter.instances.max', 'V1 GG-13 entry metric=' + rVan.inconclusive[0].metric);
    ok(rVan.inconclusive[0].candidate === undefined, 'V1 GG-13 entry candidate must be undefined');
    const eVan = throws(() => assertNoGpuRegression(vanBase, vanDropped, vanRules),
        GpuInconclusiveError, 'V1 GG-13 asserts GpuInconclusiveError');
    ok(!!eVan.report, 'V1 GG-13 inconclusive error carries .report');

    // tolerance direction routes the same way.
    ok(checkGpuRegression(vanBase, vanDropped, { 'counter.instances.max': { tolerance: 0.15 } }).inconclusive[0].rule === 'tolerance',
        'V1 GG-13 tolerance direction inconclusive rule');

    // control: exact on the identical input still FAILS (the exact leg is unchanged).
    const rVanExact = checkGpuRegression(vanBase, vanDropped, { 'counter.instances.max': { exact: true } });
    ok(rVanExact.verdict === 'fail', 'V1 GG-13 control exact still fails, got ' + rVanExact.verdict);
    ok(rVanExact.regressions.length === 1, 'V1 GG-13 control exact one regression');

    // control: both-undefined on a TOP_FIELDS path still SKIPS to pass (no basis
    // either side). A counter fixture is intercepted by the :145 guard and proves
    // nothing about the skip branch, so use framesSkipped, absent on both sides.
    const noFieldBase = baseSummary();
    const noFieldCand = baseSummary();
    delete noFieldBase.framesSkipped;
    delete noFieldCand.framesSkipped;
    const rSkip = checkGpuRegression(noFieldBase, noFieldCand, { 'framesSkipped': { max: 10 } });
    ok(rSkip.verdict === 'pass', 'V1 GG-13 both-undefined top field still passes, got ' + rSkip.verdict);
    ok(rSkip.inconclusive.length === 0, 'V1 GG-13 both-undefined no inconclusive');
}

// ---------------------------------------------------------------------------
// Tier V3a -- profiler hot path (the zero-alloc gate, GG-07). Steady instance
// OUTSIDE the loop, stepped HOT_A times inside; gate on major-GC count.
// ---------------------------------------------------------------------------

// Clean hot op: beginFrame + recordDraw(1) + recordUpload(8) + add + one
// GPU-time sample + endFrame. No branch, no allocation.
let _hotProf = null;
function hotOpClean(i) {
    _hotProf.beginFrame();
    _hotProf.recordDraw(1);
    _hotProf.recordUpload(8);
    _hotProf.add('instances', 1);
    _hotProf.recordGpuTime((i & 15) + 1);
    _hotProf.endFrame();
}
// Alloc mutant: a RETAINED object per op. Transient garbage is cleared by V8's
// scavenger without a major (measured: even Array(32)/op forces 0 majors at
// 2e6), so a control that must trip the major-GC gate has to retain -- unbounded
// retention forces old-space collection.
const _hotSink = [];
function hotOpAlloc(i) {
    hotOpClean(i);
    _hotSink.push({ a: i });
}

async function tierV3a() {
    _hotProf = new GpuProfiler(1024, { counters: COUNTER_TAGS });
    const op = allocMutant ? hotOpAlloc : hotOpClean;

    if (globalThis.gc) globalThis.gc();
    const gc = new GcProfiler(256, { source: 'gc' }).start();
    for (let i = 0; i < HOT_A; i++) {
        op(i);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    await flush();                       // let async GC entries land before summary()
    const s = gc.summary();
    gc.stop();

    const rep = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    ok(rep.verdict === 'pass',
        'V3a hot path forced GC: major=' + s.gc.major + ' minor=' + s.gc.minor +
        ' maxMs=' + s.gc.maxMs.toFixed(2) + ' verdict=' + rep.verdict);

    _hotProf.destroy();
    _hotProf = null;
    _hotSink.length = 0;
}

// ---------------------------------------------------------------------------
// Allocation-free mock GL for V3b. Integer handles 1..poolSize, Int32Array
// clock/lag/disjoint bookkeeping, result ns = handle * 1e6 so ms stays a Smi.
// Nothing in begin()/end()'s call graph allocates.
// ---------------------------------------------------------------------------
function makeSteadyGL(poolSize, lag) {
    const ext = { TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB };
    const S = new Int32Array(8);
    const IC = 0, ID = 1, ICREATED = 2, IDELETED = 3, IBEGINS = 4, IDJREADS = 5;
    const endedAt = new Int32Array(poolSize + 1);
    endedAt.fill(-1);
    let handleSeq = 0;
    let active = 0;
    const gl = {
        QUERY_RESULT_AVAILABLE: 0x8867,
        QUERY_RESULT: 0x8866,
        getExtension(n) { return n === 'EXT_disjoint_timer_query_webgl2' ? ext : null; },
        createQuery() { S[ICREATED]++; return ++handleSeq; },
        deleteQuery(_q) { S[IDELETED]++; },
        beginQuery(_t, q) { S[IBEGINS]++; active = q; },
        endQuery(_t) { endedAt[active] = S[IC]; active = 0; },
        getParameter(pname) {
            if (pname === ext.GPU_DISJOINT_EXT) { const d = S[ID]; if (d) S[IDJREADS]++; return d; }
            return 0;
        },
        getQueryParameter(q, pname) {
            if (pname === gl.QUERY_RESULT_AVAILABLE) {
                const e = endedAt[q];
                return (e >= 0 && (S[IC] - e) >= lag) ? 1 : 0;
            }
            if (pname === gl.QUERY_RESULT) return q * 1000000;
            return 0;
        },
        _tick() { S[IC]++; },
        _setDisjoint(v) { S[ID] = v ? 1 : 0; },
        _created() { return S[ICREATED]; },
        _deleted() { return S[IDELETED]; },
        _begins() { return S[IBEGINS]; },
        _djReads() { return S[IDJREADS]; }
    };
    return gl;
}

// ---------------------------------------------------------------------------
// Tier V3b -- GpuTimerPool self-integrity (A3).
// ---------------------------------------------------------------------------
const POOL_SIZE = 8;
const POOL_LAG = POOL_SIZE + 2;   // GPU strictly slower than the pool -> exhaustion

let _poolGL = null;
let _pool = null;
const _noop = () => { };
function poolOp(i) {
    _poolGL._tick();
    // A disjoint frame well after warmup, when queries are in flight, drives the
    // disjoint-drop branch. Fire when the FIFO is guaranteed non-empty.
    _poolGL._setDisjoint((i & 8191) === 8191);
    _pool.begin();
    _pool.end();
}

// Fill the tracker with RETAIN_N dropped pools. A standalone function so its loop
// locals (gl/pool) are dead the instant it returns -- the awaiting tierV3b frame
// must hold no reference to any tracked pool, or the last one straggles.
function fillPoolTracker(tracker) {
    for (let k = 0; k < RETAIN_N; k++) {
        const gl = makeSteadyGL(POOL_SIZE, 2);
        const pool = new GpuTimerPool(gl, { poolSize: POOL_SIZE, onSample: _noop });
        for (let f = 0; f < 16; f++) { gl._tick(); pool.begin(); pool.end(); }
        pool.dispose();
        tracker.track(pool, _noop, 'gpu-timer-pool');
    }
}

async function tierV3b() {
    _poolGL = makeSteadyGL(POOL_SIZE, POOL_LAG);
    _pool = new GpuTimerPool(_poolGL, { poolSize: POOL_SIZE, onSample: _noop });
    ok(_pool.supported === true, 'V3b pool must be supported on mock GL');

    if (globalThis.gc) globalThis.gc();
    const gc = new GcProfiler(256, { source: 'gc' }).start();
    for (let i = 0; i < HOT_B; i++) {
        poolOp(i);
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    await flush();
    const s = gc.summary();
    gc.stop();

    const rep = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    ok(rep.verdict === 'pass',
        'V3b pool hot path forced GC: major=' + s.gc.major + ' minor=' + s.gc.minor +
        ' maxMs=' + s.gc.maxMs.toFixed(2) + ' verdict=' + rep.verdict);

    // Structural no-alloc proof: exactly poolSize queries ever created (never
    // grows after construction); both distinguishing branches ran INSIDE the
    // measured window.
    ok(_poolGL._created() === POOL_SIZE, 'V3b created===poolSize, got ' + _poolGL._created());
    ok(_poolGL._begins() < HOT_B, 'V3b pool-exhausted branch never ran (begins=' + _poolGL._begins() + ')');
    ok(_poolGL._djReads() > 0, 'V3b disjoint-drop branch never ran (djReads=' + _poolGL._djReads() + ')');

    // dispose() deletes every query handle -- the no-leak proof by count.
    _pool.dispose();
    ok(_poolGL._deleted() === POOL_SIZE, 'V3b deleted===poolSize after dispose, got ' + _poolGL._deleted());
    _pool = null;
    _poolGL = null;

    // Retention proof by INSTRUMENT: create/dispose/drop short-lived pools with
    // no owner; a collected pool reaches the FR path and size() returns to 0.
    // (OUTSIDE the measure window.) The fill runs in a helper that RETURNS before
    // the settle so no pool/gl binding lingers in the awaiting frame -- otherwise
    // the last-created object stays reachable and straggles for tens of rounds.
    const tracker = createLeakTracker({ name: 'pool-torture', onLeak: _noop });
    fillPoolTracker(tracker);
    const rounds = await settleTracker(tracker);
    ok(tracker.size() === 0, 'V3b tracked pools not collected, size=' + tracker.size() +
        ' after ' + MAX_SETTLE_ROUNDS + ' settle rounds (drained in ' + rounds + ')');
}

// ---------------------------------------------------------------------------
// Tier V3c -- profiler retention (A2). lite-leak OUTSIDE every measure window.
// ---------------------------------------------------------------------------
// Fill the tracker with RETAIN_N dropped profilers. Standalone so its loop local
// (p) is dead the instant it returns. The retain mutant additionally pushes every
// profiler into _retainSink (a module-level hard ref), so that child's tracker
// never drains -- the leak-direction control for the bounded settle.
function fillProfilerTracker(tracker) {
    for (let k = 0; k < RETAIN_N; k++) {
        const p = new GpuProfiler(64, { counters: COUNTER_TAGS });
        for (let f = 0; f < 96; f++) {
            p.beginFrame();
            p.recordDraw(1);
            p.recordUpload(8);
            p.recordGpuTime((f & 7) + 1);
            p.endFrame();
        }
        p.reset();
        if (retainMutant) _retainSink.push(p);
        tracker.track(p, _noop, 'gpu-profiler');
    }
}

async function tierV3c() {
    // Backing-store stability: one profiler, filled to capacity then reset()
    // for CYCLES rounds. reset() must never reallocate a ring.
    const sp = new GpuProfiler(256, { counters: COUNTER_TAGS });
    const cap0 = sp.capacity;
    const gpuBytes0 = sp.gpuMsRing.data.byteLength;
    const copyBytes0 = sp._copy.byteLength;
    const ringBytes0 = sp._counterRings.map((r) => r.data.byteLength);

    for (let c = 0; c < CYCLES; c++) {
        for (let f = 0; f < sp.capacity + 8; f++) {
            sp.beginFrame();
            sp.recordDraw(1);
            sp.recordUpload(8);
            sp.recordGpuTime((f & 7) + 1);
            sp.endFrame();
        }
        sp.reset();
    }

    ok(sp.capacity === cap0, 'V3c capacity changed ' + cap0 + ' -> ' + sp.capacity);
    ok(sp.gpuMsRing.data.byteLength === gpuBytes0, 'V3c gpuMsRing backing grew');
    ok(sp._copy.byteLength === copyBytes0, 'V3c _copy scratch grew');
    for (let i = 0; i < sp._counterRings.length; i++) {
        ok(sp._counterRings[i].data.byteLength === ringBytes0[i], 'V3c counter ring ' + i + ' backing grew');
    }
    sp.destroy();

    // Retention by instrument: fill/reset/drop fresh profilers with no owner;
    // every one must be collected (tracker.size() -> 0). The fill runs in a helper
    // that RETURNS before the settle so no profiler binding lingers in the awaiting
    // frame. The retain mutant hard-holds every profiler in _retainSink, so the
    // tracker never drains and V3c fails for a REAL leak (the settle's control).
    const tracker = createLeakTracker({ name: 'gpu-torture', onLeak: _noop });
    fillProfilerTracker(tracker);
    const rounds = await settleTracker(tracker);
    ok(tracker.size() === 0, 'V3c tracked profilers not collected, size=' + tracker.size() +
        ' after ' + MAX_SETTLE_ROUNDS + ' settle rounds (drained in ' + rounds + ')');
}

// ---------------------------------------------------------------------------
// Tier V5 -- controls. Each mutant is spawned in a child that MUST exit
// non-zero. Injection is env + spawnSync, never an in-process patch.
// ---------------------------------------------------------------------------
async function tierV5() {
    for (const name of ['alloc', 'gate', 'validator', 'retain', 'vanish']) {
        const res = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
            env: Object.assign({}, process.env, { TORTURE_MUTANT: name }),
            encoding: 'utf8'
        });
        const failed = res.error === undefined && typeof res.status === 'number' && res.status !== 0;
        ok(failed, 'V5 mutant "' + name + '" must exit non-zero (status=' + res.status +
            (res.error ? ' error=' + res.error.message : '') + ')' +
            (failed ? '' : '\n--- child stdout ---\n' + (res.stdout || '') + '\n--- child stderr ---\n' + (res.stderr || '')));
    }
}

// ---------------------------------------------------------------------------
// flush: a macrotask yield only (NO gc). Async GC entries land in the observer
// callback after a macrotask, so a majors window must yield before summary().
// Forcing gc() here would inject a major and corrupt the very count being read.
// ---------------------------------------------------------------------------
async function flush() {
    await new Promise((r) => setTimeout(r, 50));
}

// ---------------------------------------------------------------------------
// gc + macrotask settle, bounded and early-exiting (GG-11). FinalizationRegistry
// callbacks fire only after a collection AND a macrotask, so drive both, retried
// up to MAX_SETTLE_ROUNDS, exiting the instant the tracker drains. Bounded by
// construction: a genuine leak never drains, so it costs all rounds and then fails
// the tier -- the widened window can never mask a leak. Never inside a measured
// GC window. Returns the round count on drain, or -1 if it never drained. The cap
// sits well above the worst observed clean-drain latency (round 1, once the fill
// loops run in helpers so no tracked object outlives its frame), so headroom
// absorbs a rare straggler while a real hard-referenced leak still exhausts it.
// ---------------------------------------------------------------------------
const MAX_SETTLE_ROUNDS = 8;

async function settleTracker(tracker) {
    for (let i = 0; i < MAX_SETTLE_ROUNDS; i++) {
        globalThis.gc && globalThis.gc();
        await new Promise((r) => setTimeout(r, 60));
        if (tracker.size() === 0) return i + 1;
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
async function runTier(name, fn) {
    if (process.exitCode === 1) return;
    const before = _checks;
    try {
        await fn();
    } catch (e) {
        process.exitCode = 1;
        console.error('FAIL ' + name + ': ' + (e && e.message ? e.message : e));
        return;
    }
    const n = _checks - before;
    if (n <= 0) {
        process.exitCode = 1;
        console.error('FAIL ' + name + ': tier reported 0 checks (no gate output is a FAIL)');
        return;
    }
    console.log('ok ' + name);
}

async function main() {
    await runTier('V0', tierV0);
    await runTier('V1', tierV1);
    await runTier('V3a', tierV3a);
    await runTier('V3b', tierV3b);
    await runTier('V3c', tierV3c);
    if (!CHILD) await runTier('V5', tierV5);
    if (process.exitCode !== 1) console.log('ok');
}

await main();
