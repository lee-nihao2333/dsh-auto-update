import assert from 'node:assert/strict'
import { APPLY_PATH, RESTART_PATH, STATUS_PATH, createHandlers } from '../lib/routes.js'

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error?.stack ?? error}`)
  }
}

/** Minimal IncomingMessage stand-in. */
const request = (method) => ({ method, url: '/dsh-auto-update/status', headers: {} })

/** Minimal ServerResponse stand-in that records status, headers, and body. */
function response() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body) {
      this.body = body
    },
  }
}

/** Updater stand-in with scripted transition outcomes. */
function updater({ phase = 'idle', updateAvailable = true, restartRequired = false, update, restart } = {}) {
  return {
    status: () => ({
      phase,
      currentVersion: '0.2.1-rc.2',
      latestVersion: updateAvailable ? '0.2.2' : '0.2.1-rc.2',
      updateAvailable,
      restartRequired,
      checkedAt: '2026-10-28T10:00:00.000Z',
      error: null,
      pid: 4242,
    }),
    beginUpdate: update ?? (() => ({ ok: true, status: 202, version: '0.2.2' })),
    beginRestart: restart ?? (() => ({ ok: true, status: 202 })),
  }
}

/** Authorizer that trusts every request. */
const allow = () => false

/** Authorizer that rejects one request the way the connection service would. */
const deny = (req, res) => {
  res.statusCode = 403
  res.end()
  return true
}

check('GET status returns the live facts as no-store JSON', () => {
  const handlers = createHandlers({ updater: updater(), authorize: allow })
  const res = response()
  handlers.get(STATUS_PATH)(request('GET'), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.currentVersion, '0.2.1-rc.2')
  assert.equal(body.latestVersion, '0.2.2')
  assert.equal(body.updateAvailable, true)
  assert.equal(body.pid, 4242)
})

check('a rejected request never reaches the updater', () => {
  let called = false
  const handlers = createHandlers({
    updater: updater({
      update: () => {
        called = true
        return { ok: true, status: 202, version: '0.2.2' }
      },
    }),
    authorize: deny,
  })
  const res = response()
  handlers.get(APPLY_PATH)(request('POST'), res)
  assert.equal(res.statusCode, 403)
  assert.equal(called, false)
})

check('POST apply accepts the update with 202', () => {
  const handlers = createHandlers({ updater: updater(), authorize: allow })
  const res = response()
  handlers.get(APPLY_PATH)(request('POST'), res)
  assert.equal(res.statusCode, 202)
  assert.deepEqual(JSON.parse(res.body), { ok: true, accepted: true, version: '0.2.2' })
})

check('POST apply reports the updater refusal', () => {
  const handlers = createHandlers({
    updater: updater({ update: () => ({ ok: false, status: 409, code: 'no-update' }) }),
    authorize: allow,
  })
  const res = response()
  handlers.get(APPLY_PATH)(request('POST'), res)
  assert.equal(res.statusCode, 409)
  assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'no-update' })
})

check('wrong methods are refused with Allow', () => {
  const handlers = createHandlers({ updater: updater(), authorize: allow })
  const res = response()
  handlers.get(APPLY_PATH)(request('GET'), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
  const statusRes = response()
  handlers.get(STATUS_PATH)(request('POST'), statusRes)
  assert.equal(statusRes.statusCode, 405)
  assert.equal(statusRes.headers.allow, 'GET')
})

check('POST restart accepts the retry with 202', () => {
  const handlers = createHandlers({ updater: updater({ restartRequired: true }), authorize: allow })
  const res = response()
  handlers.get(RESTART_PATH)(request('POST'), res)
  assert.equal(res.statusCode, 202)
  assert.deepEqual(JSON.parse(res.body), { ok: true, accepted: true })
})

check('POST restart refuses when no restart is pending', () => {
  const handlers = createHandlers({
    updater: updater({ restart: () => ({ ok: false, status: 409, code: 'no-restart' }) }),
    authorize: allow,
  })
  const res = response()
  handlers.get(RESTART_PATH)(request('POST'), res)
  assert.equal(res.statusCode, 409)
  assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'no-restart' })
})

check('all three paths are registered exactly once', () => {
  const handlers = createHandlers({ updater: updater(), authorize: allow })
  assert.deepEqual([...handlers.keys()], [STATUS_PATH, APPLY_PATH, RESTART_PATH])
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failing check(s)`)
  process.exit(1)
}
console.log('\nall route contracts pass')
