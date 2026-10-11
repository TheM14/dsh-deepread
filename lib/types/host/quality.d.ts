/**
 * 抽取质量闸门。
 *
 * 起因是一个实测案例：同一份 Elsevier PDF，内置纯 JS 解析器抽出 95,707 字，
 * 全部是字形序号（`-01-02-03…` / `V01V02…`），12 页无一例外；同一文件用 PyMuPDF
 * 抽出 44,573 字，干净可读。乱码不会报错，只会一路喂给模型 —— 产出照样结构完整，
 * 但内容全是编的，且报告本身看不出任何异常。所以要有一个显式闸门。
 *
 * 主判据用「字形序号连排」这个特征，它高度特异（正常行文不会出现 `-01-02-03-04`），
 * 因此不容易误伤数字密集的表格或公式页；辅判据是很宽松的「可读字符占比」，只用来
 * 兜住其它形态的乱码，阈值刻意压低避免误报。
 */
export interface ExtractionQuality {
    ok: boolean;
    /** 命中的字形序号连排处数。 */
    glyphRuns: number;
    /** 字形序号连排占全部非空白字符的比例。 */
    glyphShare: number;
    /** 非空白字符数。 */
    chars: number;
    /** 字母 + CJK 字符数。 */
    prose: number;
    /** prose / chars。 */
    proseRatio: number;
    reason: string;
}
export declare function assessExtraction(text: string): ExtractionQuality;
