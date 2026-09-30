import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

// Extract the ClientModuleSystem contract face from the published
// `@deepseek-ai/dsh-client-modules` C6 bundle. The runtime bundle is a
// self-contained factory that only registers itself through
// window.__ModuleLoader__.load, so executing it in a VM sandbox and calling
// the factory with a throwing `require` reproduces the browser handoff
// without any monorepo source checkout.
export function loadClientModuleSystem(hostRoot) {
  const bundlePath = join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'client.js')
  const bundle = readFileSync(bundlePath, 'utf8')
  let handoff = null
  vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load(value) { handoff = value } } } })
  if (handoff === null || handoff.id !== '@deepseek-ai/dsh-client-modules') {
    throw new Error('HOST_MODULE_IMPORTED: client-modules bundle did not register its C6 handoff')
  }
  return handoff.factory(() => { throw new Error('client-modules bootstrap must be self-contained') })
}

// Build a live ClientModuleSystem over one plugin graph row, mirroring the
// 0.2.0-rc.2 web frontend boot: a queue-mode registration facade plus a
// parsed boot manifest whose single application batch owns the row. The
// returned facade becomes window.__ModuleLoader__ in the caller: the
// constructor flips it to live mode, so bundles loaded afterwards register
// through the real system.
export function createModuleSystem(systemExports, options) {
  const rev = options.rev ?? 'test'
  const url = `${options.url}?rev=${encodeURIComponent(rev)}`
  const boot = {
    rev,
    entries: [{ id: 'dsh-deepread', url, rev }],
    batches: [{ phase: 'application', url, rev, entries: ['dsh-deepread'] }],
  }
  const facade = { mode: 'queue', pendingQueue: [], load() {} }
  const system = new systemExports.ClientModuleSystem({
    manifest: systemExports.parseBootManifest(boot),
    staticModules: options.staticModules,
    registrationTarget: facade,
    bootstrapModule: { id: '@deepseek-ai/dsh-client-modules/client', exports: systemExports },
    loadBundle: options.loadBundle,
  })
  return { system, facade }
}
