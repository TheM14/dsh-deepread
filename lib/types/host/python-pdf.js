import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
// 桥接系统 Python 的 PyMuPDF。设计上只做一件事：把 PDF 每页的原文取出来。
// 【第N页】标记、字符统计与分词预算都留在 JS 侧，保证换解析器不改变下游看到的格式
// （引用溯源与 budget.ts 都依赖这个口径）。
//
// 为什么要临时文件而不是把字节喂给 stdin：宿主只给了 latin1 字符串与不透明的
// fs target，拿不到可靠的 OS 路径；落一个临时文件是与 fs 后端无关的做法。
const SCRIPT = `import json, re, sys

def main():
    import fitz  # PyMuPDF
    pdf, limit = sys.argv[1], int(sys.argv[2])
    doc = fitz.open(pdf)
    total = doc.page_count
    count = min(limit, total) if limit > 0 else total
    # 先报总页数，让上层在解析开始前就能显示「共 N 页」。
    sys.stderr.write("__DEEPREAD_PROGRESS__0/%d\\n" % total)
    sys.stderr.flush()
    pages = []
    for i in range(count):
        t = doc[i].get_text("text")
        t = t.replace("\\r\\n", "\\n").replace("\\r", "\\n")
        t = re.sub(r"[ \\t]{2,}", " ", t)
        t = re.sub(r"\\n{3,}", "\\n\\n", t)
        t = "\\n".join(line.rstrip() for line in t.split("\\n")).strip()
        pages.append(t)
        # 进度走 stderr，stdout 只留给最终 JSON。
        sys.stderr.write("__DEEPREAD_PROGRESS__%d/%d\\n" % (i + 1, count))
        sys.stderr.flush()
    sys.stdout.write("__DEEPREAD_JSON__" + json.dumps(
        {"ok": True, "pageCount": total, "pages": pages}, ensure_ascii=False))

main()
`;
const SENTINEL = '__DEEPREAD_JSON__';
const PROGRESS = /__DEEPREAD_PROGRESS__(\d+)\/(\d+)/;
// Windows 命令行有长度上限，脚本与 PDF 路径都走文件参数，不经 shell。
const PROBE_CODE = 'import fitz,sys;sys.stdout.write("__DEEPREAD_OK__"+getattr(fitz,"__version__","?"))';
// 用 spawn 而非 execFile：Python 逐页把进度写进 stderr，需要实时转出去，
// 否则全量抽取期间（大 PDF 数秒）没有任何反馈。
function runScript(python, args, onProgress, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(python, args, {
            windowsHide: true,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer;
        const finish = (settle) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            settle();
        };
        timer = setTimeout(() => {
            child.kill();
            finish(() => reject(new Error('Python 解析超时（' + String(timeoutMs) + 'ms）')));
        }, timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk;
            if (onProgress === undefined)
                return;
            for (const line of String(chunk).split('\n')) {
                const matched = PROGRESS.exec(line);
                if (matched !== null)
                    onProgress(Number(matched[1] ?? 0), Number(matched[2] ?? 0));
            }
        });
        child.on('error', (err) => { finish(() => reject(err)); });
        child.on('close', (code) => {
            finish(() => {
                if (code !== 0) {
                    const first = stderr.trim().split('\n')[0] ?? '';
                    reject(new Error('Python 退出码 ' + String(code) + (first === '' ? '' : '：' + first)));
                    return;
                }
                resolve(stdout);
            });
        });
    });
}
function candidateInterpreters(configured) {
    const list = [];
    if (configured !== '')
        list.push(configured);
    list.push('python', 'python3', 'py');
    // 常见 Windows 安装位置，避免用户没把 python 加进 PATH。
    if (process.platform === 'win32') {
        list.push('C:\\Python312\\python.exe', 'C:\\Python311\\python.exe', 'C:\\Python313\\python.exe');
    }
    else {
        list.push('/usr/bin/python3', '/usr/local/bin/python3');
    }
    return list;
}
export function createPythonPdf(options = {}) {
    const configured = typeof options.pythonPath === 'string' ? options.pythonPath.trim() : '';
    const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 180000;
    let probed = null;
    // 探测一次并缓存：解释器存在且能 import fitz 才算可用。
    async function probe() {
        if (probed !== null)
            return probed;
        const failures = [];
        for (const candidate of candidateInterpreters(configured)) {
            try {
                const { stdout } = await execFileAsync(candidate, ['-c', PROBE_CODE], {
                    timeout: 20000,
                    maxBuffer: 1024 * 1024,
                    windowsHide: true,
                });
                if (typeof stdout === 'string' && stdout.includes('__DEEPREAD_OK__')) {
                    const version = (stdout.split('__DEEPREAD_OK__')[1] ?? '').trim();
                    probed = { path: candidate, ok: true, detail: 'PyMuPDF ' + (version === '' ? '?' : version) };
                    return probed;
                }
                failures.push(candidate + ': 响应异常');
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                failures.push(candidate + ': ' + message.split('\n')[0]);
            }
        }
        probed = {
            path: '',
            ok: false,
            detail: '未找到可用的 Python/PyMuPDF（' + failures.slice(0, 3).join('；') + '）',
        };
        return probed;
    }
    /**
     * 用 PyMuPDF 抽取每页原文。
     * @param bytes PDF 原始字节。
     * @param limit 只解析前 N 页（采样预检用）；<= 0 表示全量。
     * @param onProgress 逐页进度回调（来自 Python 的 stderr）。
     */
    async function pages(bytes, limit = 0, onProgress) {
        const state = await probe();
        if (!state.ok)
            throw new Error(state.detail);
        const dir = await mkdtemp(join(tmpdir(), 'deepread-pdf-'));
        const pdfPath = join(dir, 'input.pdf');
        const scriptPath = join(dir, 'extract.py');
        try {
            await writeFile(pdfPath, bytes);
            await writeFile(scriptPath, SCRIPT, 'utf8');
            const stdout = await runScript(state.path, [scriptPath, pdfPath, String(limit)], onProgress, timeoutMs);
            const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
            if (line === undefined)
                throw new Error('Python 未返回结果（stdout 无标记）');
            const parsed = JSON.parse(line.slice(SENTINEL.length));
            if (typeof parsed !== 'object' || parsed === null)
                throw new Error('Python 返回结构无效');
            const record = parsed;
            if (record.ok !== true)
                throw new Error('Python 解析失败');
            const pageCount = typeof record.pageCount === 'number' ? record.pageCount : 0;
            const pageList = Array.isArray(record.pages) ? record.pages.map((p) => String(p)) : [];
            if (pageCount <= 0 || pageList.length === 0)
                throw new Error('PDF 中没有可提取的文本');
            return { pageCount, pages: pageList };
        }
        finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
    return { probe, pages };
}
