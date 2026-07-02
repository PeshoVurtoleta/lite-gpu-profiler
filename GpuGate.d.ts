import type { GpuSummary } from './GpuProfiler.js';

export interface GpuRule { exact?: boolean; max?: number; tolerance?: number; }
export interface GpuRegression {
    metric: string;
    baseline: number | undefined;
    candidate: number | undefined;
    rule: 'exact' | 'max' | 'tolerance';
    reason: string;
}
export interface GpuGateResult { ok: boolean; regressions: GpuRegression[]; }

export const GPU_DEFAULT_RULES: Record<string, GpuRule>;
export function checkGpuRegression(baseline: GpuSummary, candidate: GpuSummary, rules?: Record<string, GpuRule>): GpuGateResult;
export function assertNoGpuRegression(baseline: GpuSummary, candidate: GpuSummary, rules?: Record<string, GpuRule>): void;
