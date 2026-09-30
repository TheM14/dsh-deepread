import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exact validation boundary, not a claim that all newer prerelease APIs are compatible.
// 0.2.0-rc.2 ships the client module system as published packages inside the
// desktop runtime tree (`node_modules/@deepseek-ai/...`), not as monorepo
// `packages/client/...` sources.
export const validatedHostVersion = '0.2.0-rc.2'

// Default probe: a runtime tree unpacked next to this repository (the desktop
// app.asar `dsh/` payload). Override with DSH_HARNESS_ROOT when it lives elsewhere.
const defaultRoot = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '..', 'dsh-ref', 'dsh')

export function clientSmokeHost(label, requiredFiles) {
  const root = process.env.DSH_HARNESS_ROOT ?? defaultRoot
  const skip = (reason) => {
    console.log(`${label} SKIP: ${reason}; checkout: ${root}. Set DSH_HARNESS_ROOT to an unpacked DeepSeek Harness ${validatedHostVersion} runtime tree (the app.asar dsh/ payload). This does not validate real-host compatibility.`)
    return null
  }

  let version
  try {
    version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  } catch (error) {
    return skip(`cannot read host version from package.json (${error.code ?? error.name})`)
  }
  if (typeof version !== 'string' || version.length === 0) return skip('missing package.json version')
  if (version !== validatedHostVersion) {
    return skip(`host core ${version} is outside the validated version ${validatedHostVersion}`)
  }

  const missing = requiredFiles.filter((file) => !existsSync(join(root, file)))
  if (missing.length > 0) return skip(`missing required host files: ${missing.join(', ')}`)
  return root
}
