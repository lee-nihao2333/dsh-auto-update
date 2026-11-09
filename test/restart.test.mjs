import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, '..', 'lib', 'restart-child.mjs')
const failures = []

/** Start one dummy long-lived process that can stand in for the old dsh. */
function startDummyParent() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  return child
}

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Run the helper to completion with one spec. */
function runHelper(spec) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

const checkAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error?.stack ?? error}`)
  }
}

await checkAsync('relaunches the launcher after the old process exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-update-restart-'))
  const launched = join(dir, 'launched.txt')
  const childScript = join(dir, 'child.mjs')
  await writeFile(childScript, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(launched)}, 'child ran\\n')\n`)
  const logPath = join(dir, 'restart.log')
  const markerPath = join(dir, 'restart.json')
  const parent = startDummyParent()
  try {
    const spec = {
      parentPid: parent.pid,
      node: process.execPath,
      bin: childScript,
      args: [],
      cwd: dir,
      logPath,
      markerPath,
      waitMs: 15_000,
      settleMs: 100,
      version: '9.9.9',
    }
    const running = runHelper(spec)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(existsSync(markerPath), false, 'helper must wait for the parent')
    parent.kill('SIGKILL')
    const result = await running
    assert.equal(result.code, 0)
    await waitFor(() => existsSync(markerPath), 10_000, 'restart marker')
    const marker = JSON.parse(await readFile(markerPath, 'utf8'))
    assert.equal(marker.parentPid, parent.pid)
    assert.equal(typeof marker.childPid, 'number')
    assert.equal(marker.version, '9.9.9')
    await waitFor(() => existsSync(launched), 10_000, 'relaunched child output')
    const log = await readFile(logPath, 'utf8')
    assert.match(log, /waiting for dsh pid/)
    assert.match(log, /started dsh pid/)
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
  }
})

await checkAsync('aborts without launching while the old process is alive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-auto-update-restart-timeout-'))
  const launched = join(dir, 'launched.txt')
  const childScript = join(dir, 'child.mjs')
  await writeFile(childScript, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(launched)}, 'child ran\\n')\n`)
  const parent = startDummyParent()
  try {
    const spec = {
      parentPid: parent.pid,
      node: process.execPath,
      bin: childScript,
      args: [],
      cwd: dir,
      logPath: join(dir, 'restart.log'),
      markerPath: join(dir, 'restart.json'),
      waitMs: 500,
      settleMs: 50,
      version: '9.9.9',
    }
    const result = await runHelper(spec)
    assert.equal(result.code, 2)
    assert.equal(existsSync(launched), false)
    assert.equal(existsSync(join(dir, 'restart.json')), false)
    const log = await readFile(join(dir, 'restart.log'), 'utf8')
    assert.match(log, /aborting/)
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL')
  }
})

await checkAsync('rejects a malformed spec', async () => {
  const child = spawn(process.execPath, [helper, 'not-json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.equal(code, 64)
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failing check(s)`)
  process.exit(1)
}
console.log('\nall restart hand-off checks pass')
