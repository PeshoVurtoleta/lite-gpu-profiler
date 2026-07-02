export interface GpuTimerPoolOptions {
    poolSize?: number;
    onSample?: (ms: number) => void;
}
export class GpuTimerPool {
    constructor(gl: WebGL2RenderingContext, options?: GpuTimerPoolOptions | null);
    readonly supported: boolean;
    begin(): void;
    end(): void;
    onSample(cb: (ms: number) => void): void;
    dispose(): void;
}
