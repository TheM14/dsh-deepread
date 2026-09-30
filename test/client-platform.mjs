import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { createModuleSystem, loadClientModuleSystem } from './helpers/client-module-system.mjs'
import { createRuntimeStub } from './helpers/client-runtime.mjs'
import { clientSmokeHost } from './helpers/client-smoke-host.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
let handoff
vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load(value) { handoff = value } } } })

// Only these platform identities are consumed by DeepRead on Harness 0.2.0-rc.2.
// Do not seed the removed runtime/client facade: that hid issue #10.
const staticModules = { react: {}, '@deepseek-ai/dsh-client-store': createRuntimeStub() }
const requested = []
const plugin = handoff.factory((specifier) => {
  requested.push(specifier)
  assert.ok(Object.hasOwn(staticModules, specifier), `client-modules: require("${specifier}") missed the module table`)
  return staticModules[specifier]
})
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(requested.sort(), Object.keys(staticModules).sort())

const upstreamRoot = clientSmokeHost('CLIENT PLATFORM REAL LOADER', [
  'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
])
if (upstreamRoot !== null) {
  const systemExports = loadClientModuleSystem(upstreamRoot)
  // Cross-check the requested seeds against the shipped web frontend: its
  // boot bundle materializes the platform module table the loader seeds.
  const assetsDir = join(upstreamRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  const frontendAssets = readdirSync(assetsDir).filter((name) => name.endsWith('.js'))
  const frontendText = frontendAssets.map((name) => readFileSync(join(assetsDir, name), 'utf8')).join('\n')
  for (const specifier of requested) {
    assert.ok(frontendText.includes(specifier), `${specifier} is declared by the shipped frontend platform module table`)
  }
  const { system, facade } = createModuleSystem(systemExports, {
    url: pathToFileURL(join(root, 'lib/client.js')).href,
    staticModules,
    rev: 'platform-test',
    loadBundle: (url) => import(url.split('?')[0] + '?platform=' + Date.now()),
  })
  const previousWindow = globalThis.window
  globalThis.window = globalThis
  globalThis.__ModuleLoader__ = facade
  try {
    assert.equal(typeof (await system.import('dsh-deepread')).apply, 'function')
  } finally {
    delete globalThis.__ModuleLoader__
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  console.log('CLIENT PLATFORM: real Harness loader accepts the bundle with current platform seeds')
}
console.log('CLIENT PLATFORM: no removed runtime facade or undeclared module requests')
