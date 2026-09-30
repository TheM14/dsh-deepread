import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const fixture = mkdtempSync(join(tmpdir(), 'deepread-smoke-host-'))
const system = 'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'
const gatedScripts = ['client-lifecycle', 'client-platform']

function run(script) {
  return spawnSync(process.execPath, [join(root, 'test', `${script}.mjs`)], {
    env: { ...process.env, DSH_HARNESS_ROOT: fixture }, encoding: 'utf8', timeout: 20000,
  })
}

function expectSkip(reason) {
  for (const script of gatedScripts) {
    const result = run(script)
    assert.equal(result.status, 0, `${script}: ${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /SKIP:/, `${script} reports a skip explicitly`)
    assert.match(result.stdout, reason)
    assert.ok(result.stdout.includes(fixture), `${script} names the inspected checkout`)
    assert.doesNotMatch(result.stderr, /TypeError|HOST_MODULE_IMPORTED/)
    if (script === 'client-platform') {
      assert.match(result.stdout, /no removed runtime facade or undeclared module requests/,
        'local bundle assertions still run when the real-host portion is skipped')
    }
  }
}

try {
  mkdirSync(dirname(join(fixture, system)), { recursive: true })
  // A poisoned runtime bundle would throw on execution. It must never run.
  writeFileSync(join(fixture, system), 'throw new Error("HOST_MODULE_IMPORTED");\n')
  for (const version of ['0.2.1-alpha.1', '0.1.2-rc.1', '0.2.0-rc.1']) {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module', version }))
    expectSkip(new RegExp(`host core ${version.replaceAll('.', '\\.')}.*outside.*0\\.2\\.0-rc\\.2`))
  }

  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }))
  expectSkip(/missing.*version/)
  writeFileSync(join(fixture, 'package.json'), '{')
  expectSkip(/cannot read host version/)
  rmSync(join(fixture, 'package.json'))
  expectSkip(/cannot read host version/)

  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.0-rc.2' }))
  rmSync(join(fixture, system))
  expectSkip(/missing required host files:.*client-modules.*client\.js/)
  mkdirSync(dirname(join(fixture, system)), { recursive: true })
  writeFileSync(join(fixture, system), 'throw new Error("HOST_MODULE_IMPORTED");\n')

  // client-drag no longer gates on a host checkout: with jsdom and react-dom
  // installed it must pass (or skip loudly when they are absent), never crash.
  const drag = spawnSync(process.execPath, [join(root, 'test', 'client-drag.mjs')], {
    encoding: 'utf8', timeout: 60000,
  })
  assert.equal(drag.status, 0, `client-drag: ${drag.stdout}\n${drag.stderr}`)
  assert.match(drag.stdout, /CLIENT DRAG/)

  // A supported host must reach its loader, and actual import errors must not become skips.
  const lifecycle = run('client-lifecycle')
  assert.notEqual(lifecycle.status, 0, 'client-lifecycle reaches the poisoned host bundle')
  assert.match(lifecycle.stderr, /HOST_MODULE_IMPORTED/)
  assert.doesNotMatch(lifecycle.stdout, /SKIP:/)
  console.log('CLIENT SMOKE PREFLIGHT: all real-loader entry points reject unsupported hosts before import, explain missing files, and retain local assertions')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
