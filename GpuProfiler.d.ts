export const GPU_SUMMARY_SCHEMA: string;

export interface CounterStat { sum: number; min: number; max: number; avg: number; last: number; }
export interface GpuStat { avg: number; min: number; max: number; p01: number; p99: number; samples: number; }
export interface GpuSummary {
    schema: string;
    frameCount: number;
    capacity: number;
    counters: Record<string, CounterStat>;
    framesDrawn: number;
    framesSkipped: number;
    gpu: GpuStat;
    [key: string]: unknown;
}
export interface GpuProfilerOptions { counters?: string[]; }

export class GpuProfiler {
    constructor(capacity?: number, options?: GpuProfilerOptions | null);
    readonly counterCount: number;
    readonly capacity: number;
    readonly counterTags: string[];
    beginFrame(): void;
    recordDraw(instanceCount?: number): void;
    recordUpload(floatCount: number): void;
    add(tag: string, n?: number): void;
    recordGpuTime(ms: number): void;
    endFrame(): void;
    summary(meta?: Record<string, unknown> | null): GpuSummary;
    reset(): void;
    destroy(): void;
}
