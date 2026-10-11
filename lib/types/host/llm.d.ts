import type { AbortLike, HostContext, ModelSelection, RuntimeConfig } from './types.js';
export declare function str(v: unknown, fallback: string): string;
export declare function num(v: unknown, fallback: number): number;
export declare function arr(v: unknown): unknown[];
export declare function repairJson(text: string): string;
export declare function parseJson(text: string): unknown;
export declare function splitChunks(text: string, size: number): string[];
export declare function sectionPlan(length: number, chunkChars: number, maxSections: number): {
    partSize: number;
    parts: number;
};
export declare function splitForSections(text: string, chunkChars: number, maxSections: number): string[];
interface LlmRuntimeDependencies {
    ctx: HostContext;
    tune: RuntimeConfig;
    estimateTokens(text: string): number;
    llmCallStats: {
        calls: number;
        ms: number;
    };
    recordCalibration(rateTokPerSec: number, latencyMs: number): void;
}
export declare function createLlmRuntime(deps: LlmRuntimeDependencies): {
    callModelJson: (cfg: ModelSelection, system: string, userText: string, maxTokens: number, signal?: AbortLike | null) => Promise<unknown>;
    pickConfig: (parent?: unknown) => Promise<ModelSelection>;
    selectedModel: (parent?: unknown) => ModelSelection | null;
};
export {};
