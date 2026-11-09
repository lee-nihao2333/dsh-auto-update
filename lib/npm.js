/**
 * npm access for the dsh update plugin: the registry npm itself would use and
 * one global installation invocation.
 *
 * The plugin runs inside the dsh Host, so it prefers the npm executable that
 * sits beside the running node binary — the same installation that owns the
 * global prefix dsh itself was installed into.
 * @module dsh-auto-update/npm
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Characters of captured command output retained per stream. */
const OUTPUT_TAIL_CHARS = 20_000

/**
 * Resolve the npm launcher paired with one node executable.
 * @param execPath - absolute node executable path.
 * @returns the sibling npm path when present, otherwise plain `npm` from PATH.
 */
export function npmExecutable(execPath = process.execPath) {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const sibling = join(dirname(execPath), name)
  return existsSync(sibling) ? sibling : name
}

/**
 * Keep only the trailing slice of one captured stream.
 * @param text - accumulated text.
 * @param limit - maximum retained characters.
 * @returns the retained text.
 */
function tail(text, limit = OUTPUT_TAIL_CHARS) {
  const value = String(text ?? '')
  return value.length <= limit ? value : value.slice(value.length - limit)
}

/**
 * Run one command to completion with bounded output retention and a deadline.
 * A missing executable, a spawn failure, and a timeout all settle with a
 * non-zero code instead of rejecting.
 * @param file - executable path or name.
 * @param args - argument list.
 * @param options - environment, working directory, and deadline.
 * @returns the exit code and retained stdout/stderr text.
 */
export function runCommand(file, args, { env = process.env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((settle) => {
    let child
    try {
      child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      settle({ code: -1, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process may already have exited.
      }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout = tail(stdout + String(chunk))
    })
    child.stderr?.on('data', (chunk) => {
      stderr = tail(stderr + String(chunk))
    })
    child.on('error', (error) => {
      stderr = tail(`${stderr}\n${String(error)}`)
      finish(-1)
    })
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1))
  })
}

/**
 * Ask npm which registry it would use, honoring mirrors and user configuration.
 * @param options - node executable, environment, and deadline.
 * @returns the configured registry root, or `undefined` when it is unavailable.
 */
export async function resolveNpmRegistry({ execPath = process.execPath, env = process.env, timeoutMs = 20_000 } = {}) {
  const result = await runCommand(npmExecutable(execPath), ['config', 'get', 'registry'], { env, timeoutMs })
  const value = result.code === 0 ? result.stdout.trim() : ''
  return /^https?:\/\//.test(value) ? value : undefined
}

/**
 * Install an exact package version into npm's global prefix.
 * @param spec - exact package spec such as `@deepseek-ai/dsh@1.2.3`.
 * @param options - node executable, environment, and deadline.
 * @returns the npm exit code and retained output.
 */
export async function installGlobal(spec, { execPath = process.execPath, env = process.env, timeoutMs = 15 * 60_000 } = {}) {
  return runCommand(
    npmExecutable(execPath),
    ['install', '--global', spec, '--no-fund', '--no-audit', '--progress=false', '--loglevel=error'],
    { env, timeoutMs },
  )
}
