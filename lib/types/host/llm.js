import { errorMessage, isLlmCatalogService, isLlmStreamService, isRecord } from './types.js';
export function str(v, fallback) {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}
export function num(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
export function arr(v) {
    if (Array.isArray(v))
        return v;
    if (typeof v === 'string' && v.trim() !== '')
        return [v.trim()];
    return [];
}
// 修复模型 JSON 的经典毛病：字符串内未转义的换行/回车/Tab
export function repairJson(text) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (const ch of String(text)) {
        if (esc) {
            out += ch;
            esc = false;
            continue;
        }
        if (ch === '\\') {
            out += ch;
            esc = true;
            continue;
        }
        if (ch === '"') {
            inStr = !inStr;
            out += ch;
            continue;
        }
        if (inStr) {
            if (ch === '\n') {
                out += '\\n';
                continue;
            }
            if (ch === '\r') {
                out += '\\r';
                continue;
            }
            if (ch === '\t') {
                out += '\\t';
                continue;
            }
        }
        out += ch;
    }
    return out;
}
export function parseJson(text) {
    let cleaned = String(text).trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const attempts = [cleaned];
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start)
        attempts.push(cleaned.slice(start, end + 1));
    for (const raw of attempts) {
        const repaired = repairJson(raw);
        for (const candidate of [raw, repaired, raw.replace(/,\s*([}\]])/g, '$1'), repaired.replace(/,\s*([}\]])/g, '$1')]) {
            try {
                return JSON.parse(candidate);
            }
            catch (error) { /* keep going */ }
        }
    }
    return null;
}
export function splitChunks(text, size) {
    const paras = text.split(/\n{2,}|\r\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    const chunks = [];
    let current = '';
    for (const para of paras) {
        if (para.length > size) {
            if (current.trim() !== '') {
                chunks.push(current.trim());
                current = '';
            }
            let rest = para;
            while (rest.length > size) {
                let cut = rest.slice(0, size);
                let found = -1;
                for (let k = cut.length - 1; k > Math.floor(size * 0.5); k--) {
                    const ch = cut[k];
                    if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '.' || ch === '!' || ch === '?' || ch === ';') {
                        found = k + 1;
                        break;
                    }
                }
                if (found > 0)
                    cut = cut.slice(0, found);
                chunks.push(cut.trim());
                rest = rest.slice(cut.length);
            }
            if (rest.trim() !== '')
                current = rest.trim();
        }
        else if ((current === '' ? 0 : current.length + 2) + para.length > size) {
            chunks.push(current.trim());
            current = para;
        }
        else {
            current = current === '' ? para : current + '\n\n' + para;
        }
    }
    if (current.trim() !== '')
        chunks.push(current.trim());
    return chunks;
}
// 分段计划：先按 chunkChars 切；段数超过上限时**放大窗口重切**，而不是丢弃尾部。
//
// 旧写法是运行时 parts.slice(0, MAX_PARTS)：第 MAX_PARTS 段之后的内容被直接扔掉，
// 而综合提示词仍写着「全文共 N 字，分为 MAX_PARTS 个部分」——等于告诉模型它读完了。
// 长文（> chunkChars × maxSections）的结论与参考文献正好落在被丢弃的尾部。
// 预检（budget.ts）本来就按「未截断」算段数，所以这个修复同时让运行时与预检对齐。
export function sectionPlan(length, chunkChars, maxSections) {
    const size = chunkChars > 0 ? chunkChars : 6000;
    const cap = maxSections > 0 ? maxSections : 20;
    const partSize = Math.max(size, Math.ceil(length / cap));
    const parts = Math.max(1, Math.min(Math.ceil(length / partSize), cap));
    return { partSize, parts };
}
export function splitForSections(text, chunkChars, maxSections) {
    const size = chunkChars > 0 ? chunkChars : 6000;
    const cap = maxSections > 0 ? maxSections : 20;
    const first = splitChunks(text, size);
    // 未超上限：保持 splitChunks 的自然粒度（按段落边界切，可能比 chars/chunkChars 略多几段）。
    // 这里必须与上限比较，不能与 sectionPlan 的估算段数比较——后者不含段落边界信息，
    // 拿来比较会把本不需要归并的段落强行合并，反而把粒度改粗。
    if (first.length <= cap)
        return first;
    const { partSize, parts } = sectionPlan(text.length, size, cap);
    const second = splitChunks(text, partSize);
    if (second.length <= parts)
        return second;
    // 放大窗口后仍多于计划段数：按组归并。归并仍是文本拼接，不丢内容；
    // 宁可段落略大，也不静默丢尾。
    const groupSize = Math.ceil(second.length / parts);
    const merged = [];
    for (let i = 0; i < second.length; i += groupSize)
        merged.push(second.slice(i, i + groupSize).join('\n\n'));
    return merged;
}
export function createLlmRuntime(deps) {
    const { ctx, tune, estimateTokens, llmCallStats, recordCalibration } = deps;
    // 路由来源优先级：
    //   1. 当前会话的 Agent 路由（exec.agent.options）—— 即「继承已有状态」；官方
    //      tool-subagent 用的也是这个来源（parentAgentOptionsForDelegation 读 parent.options）。
    //   2. agentDefaultModel 服务的当前选择（旧路径，保留兼容）。
    //   3. 目录里第一个 provider/model —— 仅作最后兜底。
    // 第 3 步是旧实现唯一的来源，风险在于可能选到一个没配 key 的 provider，
    // 表现为「模型返回了空结果」这类无信息故障；现在它退到最后。
    function routeFromAgent(parent) {
        if (!isRecord(parent))
            return null;
        const options = isRecord(parent.options) ? parent.options : null;
        if (options === null)
            return null;
        const provider = typeof options.provider === 'string' && options.provider !== '' ? options.provider : null;
        const model = typeof options.model === 'string' && options.model !== '' ? options.model : null;
        if (provider === null || model === null)
            return null;
        return { provider, model, reasoningEffort: options.reasoningEffort };
    }
    function routeFromCatalog() {
        const sel = ctx.get('agentDefaultModel');
        if (sel !== undefined && typeof sel.currentSelection === 'function') {
            const s = sel.currentSelection();
            if (isRecord(s) && typeof s.provider === 'string' && typeof s.model === 'string') {
                return { provider: s.provider, model: s.model, reasoningEffort: s.reasoningEffort };
            }
        }
        return null;
    }
    function selectedModel(parent) {
        return routeFromAgent(parent) ?? routeFromCatalog();
    }
    async function pickConfig(parent) {
        const cfg = selectedModel(parent);
        if (cfg !== null)
            return cfg;
        if (!isLlmCatalogService(ctx.llm)) {
            throw new Error('没有可用的模型 Provider，无法执行精读分析');
        }
        const providers = ctx.llm.listProviders();
        if (!Array.isArray(providers)) {
            throw new Error('没有可用的模型 Provider，无法执行精读分析');
        }
        const first = providers.find((provider) => typeof provider === 'string' || (isRecord(provider) && typeof provider.id === 'string'));
        const providerId = typeof first === 'string' ? first : (isRecord(first) && typeof first.id === 'string' ? first.id : null);
        if (providerId === null) {
            throw new Error('没有可用的模型 Provider，无法执行精读分析');
        }
        const models = await ctx.llm.listModels(providerId);
        if (!Array.isArray(models)) {
            throw new Error('Provider "' + providerId + '" 下没有可用模型');
        }
        const firstModel = models.find((model) => typeof model === 'string' || (isRecord(model) && typeof model.id === 'string'));
        const modelId = typeof firstModel === 'string' ? firstModel : (isRecord(firstModel) && typeof firstModel.id === 'string' ? firstModel.id : null);
        if (modelId === null) {
            throw new Error('Provider "' + providerId + '" 下没有可用模型');
        }
        return { provider: providerId, model: modelId };
    }
    // 思考预算：'inherit' 沿用会话路由上的等级，其余模式显式覆盖。
    function effortFor(mode, routeEffort) {
        if (mode === 'inherit')
            return routeEffort;
        return mode;
    }
    // 排空一次流式调用。诊断信息（收到的 chunk 类型与 finish 原因）随空结果一起抛出，
    // 否则只报「模型返回了空结果」时无法判断是上游根本没吐 text-delta，还是判定类型不匹配。
    async function drain(options, signal) {
        if (!isLlmStreamService(ctx.llm))
            throw new Error('模型服务不支持流式调用');
        let text = '';
        let failure = null;
        const kinds = new Set();
        let finish = '';
        for await (const chunk of ctx.llm.stream(options)) {
            if (signal !== undefined && signal !== null && signal.aborted)
                throw new Error('任务已取消');
            if (!isRecord(chunk)) {
                kinds.add('non-record');
                continue;
            }
            const type = typeof chunk.type === 'string' ? chunk.type : 'unknown';
            kinds.add(type);
            if (type === 'text-delta' && typeof chunk.text === 'string') {
                text += chunk.text;
            }
            else if (type === 'finish') {
                const reason = chunk.reason;
                if (isRecord(reason)) {
                    const failDetail = isRecord(reason.failure) ? '（' + str(reason.failure.message, str(reason.failure.code, '模型调用失败')) + '）' : '';
                    finish = str(reason.kind, 'unknown') + failDetail;
                    if (reason.kind === 'error' || reason.kind === 'aborted') {
                        const f = reason.failure;
                        failure = isRecord(f) ? str(f.message, str(f.code, '模型调用失败')) : '模型调用失败';
                    }
                }
            }
        }
        if (failure !== null)
            throw new Error('模型调用失败：' + failure);
        if (text.trim() === '') {
            const seen = kinds.size === 0 ? '未收到任何 chunk' : [...kinds].join(',');
            throw new Error('模型返回了空结果（chunk：' + seen + '；finish：' + (finish === '' ? '无' : finish) + '）');
        }
        return text;
    }
    async function callModel(cfg, system, userText, maxTokens, signal) {
        const base = {
            provider: cfg.provider,
            model: cfg.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
            temperature: 0.2,
            maxTokens,
        };
        const effort = effortFor(tune.reasoningEffort, cfg.reasoningEffort);
        if (effort === undefined || effort === null)
            return await drain(base, signal);
        try {
            return await drain({ ...base, reasoningEffort: effort }, signal);
        }
        catch (err) {
            const message = errorMessage(err);
            // 目标模型没声明该档思考等级 → 退化为「不传该字段」重试一次，
            // 不让一次配置档位把整次精读打成失败。
            if (!/UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort/i.test(message))
                throw err;
            return await drain(base, signal);
        }
    }
    // 判定输出是否被 token 预算截断：JSON 解析失败且文本未正常闭合（对象/数组中途断开）。
    function looksTruncated(text) {
        const t = String(text).trim();
        if (t === '')
            return false;
        const last = t[t.length - 1];
        return last !== '}' && last !== ']';
    }
    // 带重试的 JSON 调用：按失败类型分类重试。底层错误（上游失败、空结果）与
    // 截断输出会逐步加大输出预算（×1.5，硬顶 16000），纯格式问题用校正提示
    // 同预算重试；最终失败时保留每个 attempt 的真实原因，不做无信息的吞没。
    async function callModelJson(cfg, system, userText, maxTokens, signal) {
        // 输出预算下限：推理 token 与正文共享 maxTokens，而各调用点的字面量（2500/4000/5000）
        // 是按「不思考」的调用设定的。一旦转发思考预算，就必须同时抬高下限，否则会人为
        // 造出空结果与截断。字面量保留在调用点，抬升集中在这里，避免散落 12 处改动。
        const MAX_BUDGET = Math.max(16000, tune.sectionMaxTokens * 2);
        let prompt = userText;
        let budget = Math.max(maxTokens, tune.sectionMaxTokens);
        const history = [];
        const callStarted = Date.now();
        for (let attempt = 0; attempt < 3; attempt++) {
            let text = '';
            let error = null;
            const t0 = Date.now();
            try {
                text = await callModel(cfg, system, prompt, budget, signal);
                // 运行时自校准：实测吞吐与首字延迟（估计），仅对成功调用采样。
                const elapsedMs = Math.max(1, Date.now() - t0);
                const tokens = estimateTokens(text);
                const seconds = elapsedMs / 1000;
                if (text.trim() !== '' && tokens > 0) {
                    const rateTokPerSec = tokens / seconds;
                    // latency ≈ 耗时 - 生成耗时（产出 token ÷ 速率），夹在 50..5000ms
                    const generationMs = rateTokPerSec > 0 ? (tokens / rateTokPerSec) * 1000 : elapsedMs;
                    recordCalibration(rateTokPerSec, elapsedMs - generationMs);
                }
            }
            catch (err) {
                error = errorMessage(err);
            }
            const parsed = error === null ? parseJson(text) : null;
            history.push({ text, error });
            if (parsed !== null) {
                llmCallStats.calls++;
                llmCallStats.ms += Date.now() - callStarted;
                return parsed;
            }
            const truncated = error === null && looksTruncated(text);
            if (error !== null || truncated) {
                budget = Math.min(Math.ceil(budget * 1.5), MAX_BUDGET);
            }
            if (error !== null) {
                prompt = userText + '\n\n[系统校正] 上一次调用失败（' + error + '），已加大输出预算。请重新只输出一个合法的 JSON 对象：不要任何解释或额外文字。';
            }
            else if (truncated) {
                prompt = userText + '\n\n[系统校正] 你上一次的输出在 JSON 中途被截断（输出预算不足）。请大幅压缩篇幅——arguments 最多 6 条、quotes 最多 4 条、concepts 最多 5 条、questions 最多 4 条，每条只写一句话——并输出完整闭合的 JSON 对象，末尾以 } 结束。';
            }
            else {
                prompt = userText + '\n\n[系统校正] 你上一次的输出无法解析为 JSON（可能混入了解释文字、Markdown 围栏、尾随逗号，或字符串内直接换行）。请重新只输出一个合法的 JSON 对象：不要任何解释或额外文字，字符串内不要直接换行（多行文本用 \\n 转义），引号正确转义，末尾不要有逗号。';
            }
        }
        llmCallStats.calls++;
        llmCallStats.ms += Date.now() - callStarted;
        const kinds = history.map((h) => {
            if (h.error !== null)
                return '底层错误（' + h.error + '）';
            if (looksTruncated(h.text))
                return '输出被截断';
            if (String(h.text).trim() === '')
                return '空输出';
            return 'JSON 解析失败';
        });
        const tail = String(history[history.length - 1]?.text ?? '').trim();
        const shown = tail.length > 160 ? tail.slice(-160) : tail;
        throw new Error('模型输出 3 次均未得到合法 JSON：' + kinds.join('；') + (shown === '' ? '' : '。末次输出尾部：' + shown));
    }
    return { callModelJson, pickConfig, selectedModel };
}
