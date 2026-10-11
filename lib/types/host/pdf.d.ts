import type { PdfParserMode, PdfStats } from './types.js';
export interface PdfProgress {
    done: number;
    total: number;
}
interface ParsedPdfObject {
    dict: string;
    stream: string | null;
    filters: string[];
}
export interface PdfPagesResult {
    pageCount: number;
    pages: string[];
    parser: string;
}
export interface PdfBridge {
    probe(): Promise<{
        path: string;
        ok: boolean;
        detail: string;
    }>;
    pages(bytes: Uint8Array, limit?: number, onProgress?: (done: number, total: number) => void): Promise<{
        pageCount: number;
        pages: string[];
    }>;
}
export interface PdfToolsOptions {
    /** 显式 Python 解释器路径；空串/缺省表示自动探测。 */
    pythonPath?: string;
    pythonTimeoutMs?: number;
    /** 'auto'（缺省）Python 优先并回退；'python' 只用 Python；'builtin' 只用内置纯 JS。 */
    parser?: PdfParserMode;
    /** 测试注入点；缺省在进程内创建一个真实桥。 */
    bridge?: PdfBridge;
}
export declare function createPdfTools(estimateTokens: (text: string) => number, options?: PdfToolsOptions): {
    bytesToLatin1: (bytes: Uint8Array) => string;
    collectPageNums: (latin1: string) => {
        pageNums: string[];
        getObject: (num: string | number | undefined) => ParsedPdfObject | null;
        resolveRef: (dict: string, key: string) => string | null;
        resolveMultiRef: (dict: string, key: string) => string[];
    };
    extractPdfStats: (bytes: Uint8Array) => Promise<{
        stats: PdfStats;
        parser: string;
    }>;
    extractPdfText: (bytes: Uint8Array, onPage?: (progress: PdfProgress) => void) => Promise<{
        text: string;
        parser: string;
    }>;
};
export {};
