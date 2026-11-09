import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdater } from '../lib/updater.js'

const failures = []
const checkAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error?.stack ?? error}`)
  }
}

/** One registry answer with the given dist-tag version. */
const registryResponse = (version) => ({
  ok: true,
  status: 200,
  async json() {
    return { name: '@deepseek-ai/dsh', 'dist-tags': { latest: version } }
  },
})

/**
 * Build an installation directory and an updater over injected transports.
 * @param options - package version, registry version, and transport overrides.
 */
async function fixture({ installed = '0.2.1-rc.2', available = '9.9.9', registry = 'https://registry.example/', ...overrides }) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-auto-update-state-'))
  const installDir = await mkdtemp(join(tmpdir(), 'dsh-auto-update-install-'))
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: installed }))
  const events = { restarts: [], exits: [], installs: [] }
  const updater = createUpdater({
    packageName: '@deepseek-ai/dsh',
    distTag: 'latest',
    registry,
    checkIntervalMs: 0,
    stateDir,
    installDir,
    currentVersion: installed,
    fetchImpl: async () => registryResponse(available),
    installPackage: async (spec) => {
      events.installs.push(spec)
      const version = spec.split('@').slice(-1)[0]
      await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
      return { code: 0, stdout: 'installed', stderr: '' }
    },
    respawn: { node: '/usr/bin/node', bin: '/fake/bin/dsh', args: ['web'], cwd: '/fake/work' },
    spawnRestart: async ({ spec }) => {
      events.restarts.push(spec)
      return 4242
    },
    exit: (code) => events.exits.push(code),
    exitGraceMs: 0,
    ...overrides,
  })
  return { updater, events, stateDir, installDir }
}

await checkAsync('init publishes an available update', async () => {
  const { updater, stateDir } = await fixture({})
  const status = await updater.init()
  assert.equal(status.currentVersion, '0.2.1-rc.2')
  assert.equal(status.latestVersion, '9.9.9')
  assert.equal(status.updateAvailable, true)
  assert.equal(status.phase, 'idle')
  assert.equal(status.pid, process.pid)
  assert.equal(typeof status.checkedAt, 'string')
  const persisted = JSON.parse(await (await import('node:fs/promises')).readFile(join(stateDir, 'state.json'), 'utf8'))
  assert.equal(persisted.latestVersion, '9.9.9')
  updater.dispose()
})

await checkAsync('init reports no update when the registry version is older', async () => {
  const { updater } = await fixture({ installed: '1.0.0', available: '0.9.0' })
  const status = await updater.init()
  assert.equal(status.updateAvailable, false)
  updater.dispose()
})

await checkAsync('prerelease ordering suppresses a non-newer registry version', async () => {
  const { updater } = await fixture({ installed: '0.2.2-alpha.2', available: '0.2.1-rc.4' })
  const status = await updater.init()
  assert.equal(status.updateAvailable, false)
  updater.dispose()
})

await checkAsync('apply installs the exact version, schedules the restart, and exits', async () => {
  const { updater, events } = await fixture({})
  await updater.init()
  const outcome = updater.beginUpdate()
  assert.equal(outcome.ok, true)
  assert.equal(outcome.status, 202)
  assert.equal(outcome.version, '9.9.9')
  assert.equal(updater.status().phase, 'updating')
  await outcome.done
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(events.installs, ['@deepseek-ai/dsh@9.9.9'])
  assert.equal(updater.status().phase, 'restarting')
  assert.equal(updater.status().updateAvailable, false)
  assert.equal(updater.status().restartRequired, true)
  assert.equal(updater.status().currentVersion, '9.9.9')
  assert.equal(events.restarts.length, 1)
  const spec = events.restarts[0]
  assert.equal(spec.parentPid, process.pid)
  assert.equal(spec.node, '/usr/bin/node')
  assert.equal(spec.bin, '/fake/bin/dsh')
  assert.deepEqual(spec.args, ['web'])
  assert.equal(spec.cwd, '/fake/work')
  assert.equal(spec.version, '9.9.9')
  assert.equal(typeof spec.logPath, 'string')
  assert.equal(typeof spec.markerPath, 'string')
  assert.deepEqual(events.exits, [0])
  updater.dispose()
})

await checkAsync('a rejected update starts nothing', async () => {
  const { updater, events } = await fixture({ installed: '1.0.0', available: '1.0.0' })
  await updater.init()
  const outcome = updater.beginUpdate()
  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, 409)
  assert.equal(outcome.code, 'no-update')
  assert.deepEqual(events.installs, [])
  updater.dispose()
})

await checkAsync('a failed installation keeps the update available and never restarts', async () => {
  const { updater, events } = await fixture({
    installPackage: async () => ({ code: 3, stdout: '', stderr: 'EACCES: permission denied' }),
  })
  await updater.init()
  const outcome = updater.beginUpdate()
  await outcome.done
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(updater.status().phase, 'failed')
  assert.equal(updater.status().updateAvailable, true)
  assert.match(updater.status().error, /EACCES/)
  assert.equal(events.restarts.length, 0)
  assert.deepEqual(events.exits, [])
  updater.dispose()
})

await checkAsync('a version mismatch after install fails closed', async () => {
  const { updater, events } = await fixture({
    installPackage: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  await updater.init()
  const outcome = updater.beginUpdate()
  await outcome.done
  assert.equal(updater.status().phase, 'failed')
  assert.match(updater.status().error, /still reports/)
  assert.equal(events.restarts.length, 0)
  assert.deepEqual(events.exits, [])
  updater.dispose()
})

await checkAsync('a restart spawn failure asks for a restart retry', async () => {
  const { updater, events } = await fixture({
    spawnRestart: async () => {
      throw new Error('spawn EACCES')
    },
  })
  await updater.init()
  const outcome = updater.beginUpdate()
  await outcome.done
  assert.equal(updater.status().phase, 'restart-required')
  assert.match(updater.status().error, /EACCES/)
  assert.deepEqual(events.exits, [])
  const retry = updater.beginRestart()
  assert.equal(retry.ok, true)
  await retry.done
  updater.dispose()
})

await checkAsync('concurrent apply requests are rejected as busy', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { updater } = await fixture({
    installPackage: async (spec) => {
      await gate
      const version = spec.split('@').slice(-1)[0]
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  await updater.init()
  const first = updater.beginUpdate()
  const second = updater.beginUpdate()
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.code, 'busy')
  release()
  await first.done
  updater.dispose()
})

await checkAsync('a failed check keeps the previously known update', async () => {
  let fail = false
  const { updater } = await fixture({
    fetchImpl: async () => {
      if (fail) throw new Error('registry offline')
      return registryResponse('9.9.9')
    },
  })
  await updater.init()
  assert.equal(updater.status().updateAvailable, true)
  fail = true
  const status = await updater.refresh({ force: true })
  assert.equal(status.updateAvailable, true)
  assert.equal(status.latestVersion, '9.9.9')
  assert.match(status.error, /registry offline/)
  updater.dispose()
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failing check(s)`)
  process.exit(1)
}
console.log('\nall updater transitions pass')
