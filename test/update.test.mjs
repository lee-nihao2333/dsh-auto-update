import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  compareVersions,
  encodePackageName,
  fetchLatestVersion,
  locateDshInstall,
  packumentUrl,
  parseVersion,
  readInstalledVersion,
} from '../lib/update.js'

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
  }
}
const checkAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`FAIL ${name}: ${error?.message ?? error}`)
  }
}

check('parseVersion accepts stable and prerelease versions', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(parseVersion('v0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, prerelease: ['rc', '2'] })
  assert.equal(parseVersion('not-a-version'), undefined)
  assert.equal(parseVersion(undefined), undefined)
})

check('compareVersions orders numeric cores', () => {
  assert.equal(compareVersions('0.2.1', '0.2.2'), -1)
  assert.equal(compareVersions('0.2.2', '0.2.1'), 1)
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0)
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
})

check('compareVersions follows semver prerelease ordering', () => {
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1'), -1)
  assert.equal(compareVersions('0.2.1', '0.2.1-rc.99'), 1)
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.10'), -1)
  assert.equal(compareVersions('0.2.1-alpha.1', '0.2.1-beta.1'), -1)
  assert.equal(compareVersions('0.2.1-rc.2', '0.2.1-rc.2'), 0)
  assert.equal(compareVersions('0.2.1-1', '0.2.1-alpha'), -1)
  assert.equal(compareVersions('garbage', '1.0.0'), undefined)
})

check('encodePackageName keeps the scope marker and encodes the separator', () => {
  assert.equal(encodePackageName('@deepseek-ai/dsh'), '@deepseek-ai%2Fdsh')
  assert.equal(encodePackageName('plain'), 'plain')
})

check('packumentUrl normalizes the registry root', () => {
  assert.equal(packumentUrl('https://registry.npmjs.org/', '@deepseek-ai/dsh'), 'https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  assert.equal(packumentUrl('https://mirror.example/root', '@deepseek-ai/dsh'), 'https://mirror.example/root/@deepseek-ai%2Fdsh')
  assert.equal(packumentUrl('', '@deepseek-ai/dsh'), 'https://registry.npmjs.org/@deepseek-ai%2Fdsh')
})

check('readInstalledVersion reads the manifest version', () => {
  const dir = new URL('.', import.meta.url).pathname
  assert.equal(readInstalledVersion(join(dir, '..')), '1.0.0')
  assert.equal(readInstalledVersion('/definitely/not/here'), undefined)
  assert.equal(readInstalledVersion(undefined), undefined)
})

check('locateDshInstall resolves the launcher symlink to the package root', () => {
  const launcher = process.env.DSH_BIN ?? join(dirname(process.execPath), 'dsh')
  if (!existsSync(launcher)) {
    console.log('skip locateDshInstall: no dsh launcher beside node')
    return
  }
  const found = locateDshInstall([process.execPath, launcher, 'web'])
  assert.equal(typeof found, 'string')
  assert.equal(readInstalledVersion(found), JSON.parse(readFileSync(join(found, 'package.json'), 'utf8')).version)
})

await checkAsync('fetchLatestVersion reads the selected dist-tag from a registry', async () => {
  const server = createServer((request, response) => {
    if (request.url !== '/@fake%2Fpkg') {
      response.statusCode = 404
      response.end('{}')
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ name: '@fake/pkg', 'dist-tags': { latest: '2.0.0', next: '2.1.0-rc.1' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const latest = await fetchLatestVersion({ registry: `http://127.0.0.1:${port}`, packageName: '@fake/pkg' })
    assert.equal(latest.version, '2.0.0')
    assert.equal(latest.url, `http://127.0.0.1:${port}/@fake%2Fpkg`)
    const next = await fetchLatestVersion({ registry: `http://127.0.0.1:${port}`, packageName: '@fake/pkg', distTag: 'next' })
    assert.equal(next.version, '2.1.0-rc.1')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

await checkAsync('fetchLatestVersion rejects HTTP errors and missing tags', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/@fake%2Fmissing') {
      response.end(JSON.stringify({ name: '@fake/missing', 'dist-tags': {} }))
      return
    }
    response.statusCode = 500
    response.end('boom')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await assert.rejects(() => fetchLatestVersion({ registry: `http://127.0.0.1:${port}`, packageName: '@fake/pkg' }), /HTTP 500/)
    await assert.rejects(
      () => fetchLatestVersion({ registry: `http://127.0.0.1:${port}`, packageName: '@fake/missing' }),
      /no "latest" version/,
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

if (failures.length > 0) {
  console.error(`\n${failures.length} failing check(s)`)
  process.exit(1)
}
console.log('\nall update helpers pass')
