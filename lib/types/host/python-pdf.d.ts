export interface PythonPdfPages {
    pageCount: number;
    /** 每页清洗后的原文，顺序与页码一致；不含【第N页】标记。 */
    pages: string[];
}
export interface PythonProbe {
    path: string;
    ok: boolean;
    detail: string;
}
export interface PythonPdfOptions {
    /** 显式指定解释器；空串表示自动探测。 */
    pythonPath?: string;
    timeoutMs?: number | undefined;
}
export declare function createPythonPdf(options?: PythonPdfOptions): {
    probe: () => Promise<PythonProbe>;
    pages: (bytes: Uint8Array, limit?: number, onProgress?: (done: number, total: number) => void) => Promise<PythonPdfPages>;
};
