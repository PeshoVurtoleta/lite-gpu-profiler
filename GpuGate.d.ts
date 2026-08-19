import type { GpuSummary } from './GpuProfiler.js';

export interface GpuRule { exact?: boolean; max?: number; tolerance?: number; }
export interface GpuRegression {
    metric: string;
    baseline: number | string | null | undefined;
    candidate: number | string | null | undefined;
    rule: 'exact' | 'max' | 'tolerance' | 'schema' | 'unknown';
    reason: string;
}
export type GpuVerdict = 'pass' | 'fail' | 'inconclusive';
export interface GpuGateResult {
    ok: boolean;
    verdict: GpuVerdict;
    regressions: GpuRegression[];
    inconclusive: GpuRegression[];
    warnings: GpuRegression[];
}

export const GPU_DEFAULT_RULES: Record<string, GpuRule>;
export const GPU_FIELDS: string[];
export const COUNTER_FIELDS: string[];
export const TOP_FIELDS: string[];

export class GpuRuleError extends Error { name: 'GpuRuleError'; }
export class GpuRegressionError extends Error { name: 'GpuRegressionError'; report: GpuGateResult; }
export class GpuInconclusiveError extends Error { name: 'GpuInconclusiveError'; report: GpuGateResult; }

export function checkGpuRegression(baseline: GpuSummary, candidate: GpuSummary, rules?: Record<string, GpuRule>): GpuGateResult;
export function assertNoGpuRegression(baseline: GpuSummary, candidate: GpuSummary, rules?: Record<string, GpuRule>): void;
