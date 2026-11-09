import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { APPLY_PATH, RESTART_PATH, STATUS_PATH } from '../lib/routes.js'
import { compareVersions, readInstalledVersion, locateDshInstall } from '../lib/update.js'

/**
 * Wiring check for the real plugin module: `apply` mounts all three routes,
 * the registry watchdog runs against the real registry, and the status route
 * answers with the running installation's version. `DSH_HOME` is redirected so
 * the live dsh state is never touched.
 */
const home = await mkdtemp(join(tmpdir(), 'dsh-auto-update-plugin-'))
process.env.DSH_HOME = home
const launcher = process.env.DSH_BIN ?? join(dirname(process.execPath), 'dsh')
const previousArgv = [...process.argv]
if (existsSync(launcher)) process.argv[1] = launcher

const { apply, name, inject } = await import('../index.js')

assert.equal(name, '@marvinlee2011/dsh-auto-update')
assert.deepEqual(inject, ['webServer', 'connection'])

const routes = new Map()
const disposers = []
const ctx = {
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  webServer: {
    register(route) {
      assert.equal(route.kind, 'exact')
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  connection: { requestRejection: () => undefined },
  get(name) {
    return name === 'connection' ? this.connection : undefined
  },
}

try {
  apply(ctx, {})
  await waitFor(async () => {
    if (!existsSync(join(home, 'cache', 'dsh-auto-update', 'state.json'))) return false
    const state = JSON.parse(await readFile(join(home, 'cache', 'dsh-auto-update', 'state.json'), 'utf8'))
    return typeof state.checkedAt === 'string' && state.checkedAt !== null
  }, 60_000)
  console.log('ok   apply mounted all three exact routes')
  assert.deepEqual([...routes.keys()], [STATUS_PATH, APPLY_PATH, RESTART_PATH])

  const status = await call(routes.get(STATUS_PATH), 'GET')
  assert.equal(status.statusCode, 200)
  const body = JSON.parse(status.body)
  const install = locateDshInstall(process.argv)
  if (install !== undefined) {
    assert.equal(body.currentVersion, readInstalledVersion(install))
    assert.equal(typeof body.latestVersion, 'string')
    assert.equal(body.updateAvailable, (compareVersions(body.latestVersion, body.currentVersion) ?? 0) > 0)
  }
  assert.equal(body.pid, process.pid)
  console.log(`ok   live status: ${body.currentVersion} -> ${body.latestVersion} (update=${body.updateAvailable})`)

  const refused = await call(routes.get(APPLY_PATH), 'POST')
  assert.equal(refused.statusCode, 409)
  assert.equal(JSON.parse(refused.body).code, 'no-update')
  console.log('ok   apply refuses when the registry version is not newer')

  const persisted = JSON.parse(await readFile(join(home, 'cache', 'dsh-auto-update', 'state.json'), 'utf8'))
  assert.equal(persisted.currentVersion, body.currentVersion)
  console.log('ok   state file mirrors the live status')
} finally {
  for (const dispose of disposers.reverse()) {
    try {
      await dispose()
    } catch {
      // Disposal is best effort in this wiring check.
    }
  }
  process.argv.splice(0, process.argv.length, ...previousArgv)
}

/** One fake request/response cycle over a mounted route. */
async function call(route, method) {
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(body) {
      this.body = body
    },
  }
  await route.handler({ method, url: route.path, headers: {} }, response)
  return response
}

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('timed out waiting for the first registry check')
}
