/**
 * @zakkster/lite-gpu-profiler
 *
 * GpuGate - regression gate over GpuProfiler summaries.
 *
 * Counters and timing gate differently. Counters are deterministic (a scene draws
 * in exactly N draw calls and uploads exactly M floats on every host, every run),
 * so they gate EXACTLY (regress if != baseline) or by absolute CEILING (regress if
 * > cap) -- no noise floor, no median-of-N. GPU time is noisy, so it gates by
 * fractional TOLERANCE like frame time in the version matrix. This exact/ceiling
 * comparator is the piece the lite-profiler counter-channel will reuse.
 *
 * The gate is fail-closed. A rule it cannot evaluate against real measurements
 * (a zero-sample GPU stat, a poisoned/non-finite value, a counter tag neither
 * summary tracks) routes to a third INCONCLUSIVE verdict, never a green pass.
 * A misspelled rule path throws rather than silently evaluating nothing.
 *
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

/** Sensible defaults: dirty-range and draw-call count must be identical; p99 within 15%. */
export const GPU_DEFAULT_RULES = {
    'counter.floatsUploaded.max': { exact: true },
    'counter.drawCalls.max': { exact: true },
    'gpu.p99': { tolerance: 0.15 }
};

/** Fields a gpu.<field> rule may name. */
export const GPU_FIELDS = ['avg', 'min', 'max', 'p01', 'p99', 'samples'];
/** Fields a counter.<tag>.<field> rule may name. */
export const COUNTER_FIELDS = ['sum', 'min', 'max', 'avg', 'last'];
/** Single-segment top-level fields a rule may name. */
export const TOP_FIELDS = ['frameCount', 'capacity', 'framesDrawn', 'framesSkipped'];

// Float32 counter rings are exact up to 2^24; above it the quantum exceeds 1, so
// an exact comparison cannot see a sub-quantum regression. Signal, do not fail.
const EXACT_PRECISION_CEILING = 16777216;   // 2^24

/** Thrown when a rule path does not name a known metric surface. */
export class GpuRuleError extends Error {
    constructor(message) { super(message); this.name = 'GpuRuleError'; }
}
/** Thrown by assertNoGpuRegression when the verdict is 'fail'. Carries `.report`. */
export class GpuRegressionError extends Error {
    constructor(message) { super(message); this.name = 'GpuRegressionError'; }
}
/** Thrown by assertNoGpuRegression when the verdict is 'inconclusive'. Carries `.report`. */
export class GpuInconclusiveError extends Error {
    constructor(message) { super(message); this.name = 'GpuInconclusiveError'; }
}

function read(summary, path) {
    const p = path.split('.');
    if (p[0] === 'counter') { const c = summary.counters && summary.counters[p[1]]; return c ? c[p[2]] : undefined; }
    if (p[0] === 'gpu') { return summary.gpu ? summary.gpu[p[1]] : undefined; }
    return summary[path];
}

function ruleKind(rule) {
    return rule.exact ? 'exact' : rule.max !== undefined ? 'max' : rule.tolerance !== undefined ? 'tolerance' : 'unknown';
}

/** A value that is present but unusable as a measurement: explicit null, or a non-finite number. */
function isPoisoned(v) {
    return v === null || (typeof v === 'number' && !Number.isFinite(v));
}

/**
 * Validate a rule path against the known metric surface by segment count + field
 * allow-list. A malformed FIELD name (or wrong segment count) throws GpuRuleError.
 * Tag existence is NOT checked here: a well-formed path naming an untracked counter
 * tag is unmeasured, not malformed, and routes to inconclusive at evaluation time.
 * @param {string} path
 */
function validateRulePath(path) {
    const p = path.split('.');
    if (p[0] === 'counter') {
        if (p.length !== 3 || COUNTER_FIELDS.indexOf(p[2]) === -1) {
            throw new GpuRuleError(`GpuGate: invalid rule path "${path}"; valid paths are counter.<tag>.{${COUNTER_FIELDS.join(',')}}`);
        }
        return;
    }
    if (p[0] === 'gpu') {
        if (p.length !== 2 || GPU_FIELDS.indexOf(p[1]) === -1) {
            throw new GpuRuleError(`GpuGate: invalid rule path "${path}"; valid paths are gpu.{${GPU_FIELDS.join(',')}}`);
        }
        return;
    }
    if (p.length !== 1 || TOP_FIELDS.indexOf(p[0]) === -1) {
        throw new GpuRuleError(`GpuGate: invalid rule path "${path}"; valid paths are ${TOP_FIELDS.join(', ')}, gpu.<field>, counter.<tag>.<field>`);
    }
}

/**
 * @param {object} baseline @param {object} candidate GpuProfiler summaries.
 * @param {Object<string, {exact?:boolean, max?:number, tolerance?:number}>} [rules]
 * @returns {{ ok: boolean, verdict: 'pass'|'fail'|'inconclusive',
 *            regressions: Array<{metric,baseline,candidate,rule,reason}>,
 *            inconclusive: Array<{metric,baseline,candidate,rule,reason}>,
 *            warnings: Array<{metric,baseline,candidate,rule,reason}> }}
 */
export function checkGpuRegression(baseline, candidate, rules = GPU_DEFAULT_RULES) {
    // Pre-pass: validate EVERY rule path AND rule shape before any evaluation, so a
    // typo or a boundless rule anywhere fails fast. A rule declaring none of
    // {exact, max, tolerance} would evaluate nothing and pass -- the GG-09 fail-open.
    for (const path in rules) {
        validateRulePath(path);
        const rule = rules[path];
        if (!rule || (!rule.exact && rule.max === undefined && rule.tolerance === undefined)) {
            throw new GpuRuleError(`GpuGate: rule "${path}" declares no bound; set one of {exact:true, max, tolerance}`);
        }
    }

    // Schema pre-pass (GG-10): two summaries whose schema tokens differ are not
    // mutually comparable -- comparing their fields is comparing values that are
    // not defined to mean the same thing. Short-circuit to inconclusive before any
    // rule runs; one fact, one entry. undefined-vs-undefined is NOT a mismatch (two
    // hand-rolled summaries from the same producer), so they evaluate normally.
    const bSchema = baseline && baseline.schema;
    const cSchema = candidate && candidate.schema;
    if (bSchema !== cSchema) {
        const entry = {
            metric: 'schema',
            baseline: bSchema,
            candidate: cSchema,
            rule: 'schema',
            reason: 'summary schema mismatch (incomparable summaries): baseline "'
                  + bSchema + '" vs candidate "' + cSchema + '"'
        };
        return { ok: false, verdict: 'inconclusive', regressions: [], inconclusive: [entry], warnings: [] };
    }

    const regressions = [];
    const inconclusive = [];
    const warnings = [];
    for (const path in rules) {
        const rule = rules[path];
        const p = path.split('.');
        const base = read(baseline, path);
        const cand = read(candidate, path);
        const kind = ruleKind(rule);

        // (c) counter.<tag>.* whose tag is tracked by NEITHER summary -> unmeasured -> inconclusive.
        if (p[0] === 'counter') {
            const tag = p[1];
            const inBase = !!(baseline.counters && baseline.counters[tag] !== undefined);
            const inCand = !!(candidate.counters && candidate.counters[tag] !== undefined);
            if (!inBase && !inCand) {
                inconclusive.push({ metric: path, baseline: base, candidate: cand, rule: kind, reason: `counter tag "${tag}" tracked by neither baseline nor candidate` });
                continue;
            }
        }

        // (e) gpu.* other than gpu.samples where either summary has gpu.samples === 0 or missing gpu.
        if (p[0] === 'gpu' && p[1] !== 'samples') {
            const bOk = !!(baseline.gpu && baseline.gpu.samples > 0);
            const cOk = !!(candidate.gpu && candidate.gpu.samples > 0);
            if (!bOk || !cOk) {
                inconclusive.push({ metric: path, baseline: base, candidate: cand, rule: kind, reason: 'gpu stat has zero samples (nothing measured)' });
                continue;
            }
        }

        // (d) a present-but-poisoned stat (explicit null or non-finite number) -> inconclusive.
        if (isPoisoned(base) || isPoisoned(cand)) {
            inconclusive.push({ metric: path, baseline: base, candidate: cand, rule: kind, reason: 'stat is null or non-finite (poisoned measurement)' });
            continue;
        }

        // GG-03/GG-15: above 2^24 the Float32 counter ring's quantum exceeds 1, so a
        // gate is blind to a sub-quantum regression. The comparison is still
        // correctly measured (equal-vs-equal stays valid); emit a precision advisory
        // that never affects verdict/ok, for every rule kind, pass or fail.
        if ((typeof base === 'number' && base >= EXACT_PRECISION_CEILING) ||
            (typeof cand === 'number' && cand >= EXACT_PRECISION_CEILING)) {
            warnings.push({
                metric: path, baseline: base, candidate: cand, rule: kind,
                reason: 'operand >= 2^24: Float32 counter ring quantizes here, so a regression smaller than the quantum is undetectable at this magnitude'
            });
        }
        if (rule.exact) {
            // An exact rule guards a specific metric. If the baseline tracked it and the
            // candidate no longer reports it, the metric VANISHED -- that is a regression,
            // not a silent pass. (Baseline also lacks it -> no basis -> skip.)
            if (base !== undefined && cand === undefined) {
                regressions.push({ metric: path, baseline: base, candidate: undefined, rule: 'exact', reason: 'metric missing in candidate' });
            } else if (base !== undefined && cand !== base) {
                regressions.push({ metric: path, baseline: base, candidate: cand, rule: 'exact', reason: `changed ${base} -> ${cand}` });
            }
            continue;
        }
        if (cand === undefined) {
            // GG-13: baseline tracked this metric but the candidate no longer reports
            // it -- an unmeasured value cannot be bounded. Fail closed to inconclusive
            // (mirrors the exact leg), not a silent pass. Both-undefined -> no basis -> skip.
            if (base !== undefined) {
                inconclusive.push({ metric: path, baseline: base, candidate: undefined, rule: kind, reason: 'metric present in baseline, absent in candidate -- nothing to bound' });
            }
            continue;
        }
        if (rule.max !== undefined) {
            if (cand > rule.max) {
                regressions.push({ metric: path, baseline: base, candidate: cand, rule: 'max', reason: `${cand} > ceiling ${rule.max}` });
            }
        } else if (rule.tolerance !== undefined) {
            // No basis to compute a percentage against: fail closed to inconclusive, not a silent pass.
            if (base === undefined || base === 0) {
                inconclusive.push({ metric: path, baseline: base, candidate: cand, rule: 'tolerance', reason: 'no baseline basis (baseline is 0 or missing)' });
                continue;
            }
            const pct = (cand - base) / base;                 // higher is worse for time
            if (pct > rule.tolerance) {
                regressions.push({ metric: path, baseline: base, candidate: cand, rule: 'tolerance', reason: `+${(pct * 100).toFixed(1)}% > ${(rule.tolerance * 100).toFixed(0)}%` });
            }
        }
    }
    const verdict = regressions.length ? 'fail' : inconclusive.length ? 'inconclusive' : 'pass';
    return { ok: verdict === 'pass', verdict, regressions, inconclusive, warnings };
}

/**
 * Throwing form for prepublish/CI gates. Fail-closed: a 'fail' verdict throws
 * GpuRegressionError, an 'inconclusive' verdict throws GpuInconclusiveError; both
 * carry `.report`. Only a 'pass' returns quietly.
 */
export function assertNoGpuRegression(baseline, candidate, rules) {
    const r = checkGpuRegression(baseline, candidate, rules);
    if (r.verdict === 'fail') {
        const e = new GpuRegressionError('GPU regression: ' + r.regressions.map((x) => `${x.metric} ${x.reason}`).join('; '));
        e.report = r;
        throw e;
    }
    if (r.verdict === 'inconclusive') {
        const e = new GpuInconclusiveError('GPU gate inconclusive: ' + r.inconclusive.map((x) => `${x.metric} ${x.reason}`).join('; '));
        e.report = r;
        throw e;
    }
}
