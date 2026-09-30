import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// On Windows npm is npm.cmd, which cannot be spawned without a shell. Invoke
// the npm CLI script through the current Node executable instead; on POSIX
// keep plain `npm`.
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmBinary = process.platform === 'win32' && existsSync(npmCli) ? process.execPath : 'npm'
const npmArgs = npmBinary === 'npm' ? [] : [npmCli]

export function npmExecFileAsync(args, options) {
  return execFileAsync(npmBinary, [...npmArgs, ...args], options)
}

export function npmExecFileSync(args, options) {
  return execFileSync(npmBinary, [...npmArgs, ...args], options)
}
