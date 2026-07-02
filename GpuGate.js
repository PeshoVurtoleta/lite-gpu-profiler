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
 * Copyright (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 * MIT License.
 */

/** Sensible defaults: dirty-range and draw-call count must be identical; p99 within 15%. */
export const GPU_DEFAULT_RULES = {
    'counter.floatsUploaded.max': { exact: true },
    'counter.drawCalls.max': { exact: true },
    'gpu.p99': { tolerance: 0.15 }
};

function read(summary, path) {
    const p = path.split('.');
    if (p[0] === 'counter') { const c = summary.counters && summary.counters[p[1]]; return c ? c[p[2]] : undefined; }
    if (p[0] === 'gpu') { return summary.gpu ? summary.gpu[p[1]] : undefined; }
    return summary[path];
}

/**
 * @param {object} baseline @param {object} candidate GpuProfiler summaries.
 * @param {Object<string, {exact?:boolean, max?:number, tolerance?:number}>} [rules]
 * @returns {{ ok: boolean, regressions: Array<{metric,baseline,candidate,rule,reason}> }}
 */
export function checkGpuRegression(baseline, candidate, rules = GPU_DEFAULT_RULES) {
    const regressions = [];
    for (const path in rules) {
        const rule = rules[path];
        const base = read(baseline, path);
        const cand = read(candidate, path);
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
        if (cand === undefined) continue;                     // max/tolerance: no metric -> nothing to bound
        if (rule.max !== undefined) {
            if (cand > rule.max) {
                regressions.push({ metric: path, baseline: base, candidate: cand, rule: 'max', reason: `${cand} > ceiling ${rule.max}` });
            }
        } else if (rule.tolerance !== undefined) {
            if (base === undefined || base === 0) continue;
            const pct = (cand - base) / base;                 // higher is worse for time
            if (pct > rule.tolerance) {
                regressions.push({ metric: path, baseline: base, candidate: cand, rule: 'tolerance', reason: `+${(pct * 100).toFixed(1)}% > ${(rule.tolerance * 100).toFixed(0)}%` });
            }
        }
    }
    return { ok: regressions.length === 0, regressions };
}

/** Throwing form for prepublish/CI gates. Error carries `.report`. */
export function assertNoGpuRegression(baseline, candidate, rules) {
    const r = checkGpuRegression(baseline, candidate, rules);
    if (!r.ok) {
        const e = new Error('GPU regression: ' + r.regressions.map((x) => `${x.metric} ${x.reason}`).join('; '));
        e.report = r;
        throw e;
    }
}
