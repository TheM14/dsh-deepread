const GLYPH_RUN = /(?:[-V]\d{2}){4,}/g;
export function assessExtraction(text) {
    const chars = text.replace(/\s/g, '').length;
    const runs = text.match(GLYPH_RUN) ?? [];
    const glyphRuns = runs.length;
    const glyphChars = runs.reduce((n, r) => n + r.length, 0);
    const glyphShare = chars === 0 ? 0 : glyphChars / chars;
    let prose = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a))
            prose += 1;
        else if (code >= 0x4e00 && code <= 0x9fff)
            prose += 1;
    }
    const proseRatio = chars === 0 ? 0 : prose / chars;
    let ok = true;
    let reason = '';
    // 主判据同时要求「命中够多」与「占比够大」。只看命中数会误伤数字表格——
    // 形如 01-02-03-04 的序列本身就能匹配；实测真实乱码是 834 处、占比近 10%，
    // 与偶发数字序列差两个数量级，所以双条件既稳妥又留足余量。
    if (glyphRuns >= 5 && glyphShare >= 0.05) {
        ok = false;
        reason = '抽取结果含 ' + glyphRuns + ' 处字形序号连排（如 -01-02-03），占正文 ' + Math.round(glyphShare * 100) + '%，疑为字体映射失败，正文实际不可读';
    }
    else if (chars >= 1000 && proseRatio < 0.15) {
        // 兜底：长篇却几乎没有自然语言。门槛刻意压到极低——论文正文实测 0.90，
        // 表图密集的文档也在 0.5 以上，只有整篇都是数字/符号时才触发。
        ok = false;
        reason = '抽取结果可读字符占比仅 ' + Math.round(proseRatio * 100) + '%（' + chars + ' 字），疑为乱码或非文本内容';
    }
    if (ok)
        reason = '可读字符占比 ' + Math.round(proseRatio * 100) + '%，字形序号占比 ' + (glyphShare * 100).toFixed(2) + '%，未发现乱码特征';
    return { ok, glyphRuns, glyphShare, chars, prose, proseRatio, reason };
}
