import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { npmPackFileList } from './helpers/npm-pack.mjs'

const testDir = dirname(fileURLToPath(import.meta.url))
const root = dirname(testDir)
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const buildScript = await readFile(join(root, 'scripts', 'build-host.mjs'), 'utf8')
const entrySource = await readFile(join(root, 'src', 'index.ts'), 'utf8')
const files = await npmPackFileList(root)
const { resolveConfig } = await import('../lib/types/host/config.js')

assert.ok(!entrySource.includes('legacy'), 'published Host source must not delegate to legacy runtime code')
assert.ok(!buildScript.includes('legacy'), 'Host build must compile TypeScript instead of copying legacy runtime code')
assert.ok(!packageJson.files.some((entry) => entry.includes('legacy')), 'package allowlist must not publish legacy Host code')
assert.ok(!files.some((entry) => entry.startsWith('lib/legacy/') || entry.startsWith('legacy/')), 'packed artifact must exclude legacy Host code')

for (const modulePath of [
  'src/host/types.ts',
  'src/host/config.ts',
  'src/host/budget.ts',
  'src/host/calibration.ts',
  'src/host/cache.ts',
  'src/host/source.ts',
  'src/host/pdf.ts',
  'src/host/python-pdf.ts',
  'src/host/quality.ts',
  'src/host/llm.ts',
  'src/host/analysis.ts',
  'src/host/export.ts',
  'src/host/plugin.ts',
]) {
  assert.ok(files.includes(modulePath), `packed artifact includes ${modulePath}`)
}

const zeroConfig = resolveConfig({
  timeoutMs: 0,
  chunkChars: 0,
  maxParts: 0,
  maxInputChars: 0,
  cacheTtlHours: 0,
  backgroundMinChars: 0,
  reasoningEffort: 'bogus',
  sectionMaxTokens: 0,
  pythonPath: 42,
  pdfParser: 'bogus',
})
assert.deepEqual(
  zeroConfig,
  {
    timeoutMs: 900000,
    chunkChars: 6000,
    maxParts: 20,
    maxInputChars: 400000,
    cacheEnabled: true,
    cacheTtlHours: 0,
    estTokensPerSecond: 0,
    estLatencyPerCallMs: 0,
    backgroundMinChars: 9000,
    reasoningEffort: 'inherit',
    sectionMaxTokens: 12000,
    pythonPath: '',
    pdfParser: 'auto',
  },
  'legacy-positive config fields must treat zero as invalid while zero-valued estimate overrides remain supported',
)

const tunedConfig = resolveConfig({
  reasoningEffort: 'low',
  sectionMaxTokens: 8000,
  pythonPath: '  C:\\Python312\\python.exe  ',
  pdfParser: 'python',
})
assert.equal(tunedConfig.reasoningEffort, 'low', 'a declared reasoning-effort mode must pass through')
assert.equal(tunedConfig.sectionMaxTokens, 8000, 'a positive section output budget must pass through')
assert.equal(tunedConfig.pythonPath, 'C:\\Python312\\python.exe', 'the interpreter path must be trimmed')
assert.equal(tunedConfig.pdfParser, 'python', 'a declared PDF parser mode must pass through')

// 长文分段：旧实现是 parts.slice(0, maxParts)，会静默丢掉尾部，而综合提示词仍宣称覆盖全文。
// 长文的结论与参考文献正好在被丢掉的那一段，所以这里把「不丢尾」锁成断言。
const { sectionPlan, splitChunks, splitForSections } = await import('../lib/types/host/llm.js')
const paragraph = ('Viscous oil film heat generation must be suppressed. ' + 'x'.repeat(20) + ' ').repeat(20)
const tail = 'TAIL_SENTINEL_末段哨兵'
const longText = [...Array.from({ length: 300 }, (_, i) => paragraph + ' [P' + i + ']'), tail].join('\n\n')
assert.ok(longText.length > 6000 * 20, 'fixture 必须超过 chunkChars × maxParts 才会触发旧的截断路径')

const longParts = splitForSections(longText, 6000, 20)
assert.ok(longParts.length <= 20, '段数不得超过上限，实际 ' + longParts.length)
assert.ok(longParts[longParts.length - 1].includes(tail), '末尾段落必须保留（不得静默丢尾）')
const rejoined = longParts.join('\n')
for (const marker of ['[P0]', '[P150]', '[P299]']) {
  assert.ok(rejoined.includes(marker), '各段内容不得丢失，缺少 ' + marker)
}

// 未超上限时不得归并：自然粒度（按段落边界）必须原样保留，否则等于把段落改粗。
const shortText = Array.from({ length: 40 }, (_, i) => paragraph + ' [S' + i + ']').join('\n\n')
const natural = splitChunks(shortText, 6000)
assert.ok(natural.length <= 20, 'fixture 应在上限内')
assert.deepEqual(
  splitForSections(shortText, 6000, 20),
  natural,
  '未超上限时必须原样返回自然分段，不得归并',
)

const plan = sectionPlan(200000, 6000, 20)
assert.equal(plan.parts, 20, '超限时仍以 maxParts 为上限')
assert.ok(plan.partSize >= 10000, '超限时必须放大段长而非丢弃内容，实际 ' + plan.partSize)
assert.equal(sectionPlan(44573, 6000, 20).parts, 8, '未超限时段长与段数与旧口径一致')

console.log('HOST TYPESCRIPT RUNTIME 2/2: strict TypeScript packaging and legacy config fallback semantics')
