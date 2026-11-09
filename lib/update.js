/**
 * Version, registry, and installation facts for the dsh update plugin.
 *
 * Everything here is a pure or read-only helper: no plugin context, no network
 * client of its own, and no side effects on the dsh installation. The Host half
 * supplies the fetch implementation and the command runner, which keeps the
 * comparison and registry rules testable without a live dsh.
 * @module dsh-auto-update/update
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Package name of the dsh CLI this plugin upgrades. */
export const DEFAULT_PACKAGE = '@deepseek-ai/dsh'
/** Registry used when npm's own configuration cannot be read. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
/** Dist-tag consulted when the plugin row names no other tag. */
export const DEFAULT_DIST_TAG = 'latest'
/** How many parent directories one install lookup may walk. */
const MAX_INSTALL_WALK = 8
/** Semver core plus optional prerelease/build metadata. */
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse one version string into its numeric core and prerelease identifiers.
 * @param input - candidate version, with or without a leading `v`.
 * @returns the parsed version, or `undefined` when the text is not a version.
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return undefined
  const match = VERSION_PATTERN.exec(input.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * Compare two versions by the semver ordering rules: numeric cores first, then
 * prerelease identifiers (`1.0.0-rc.1 < 1.0.0`; `rc.2 < rc.10`).
 * @param left - left-hand version.
 * @param right - right-hand version.
 * @returns `-1`, `0`, or `1`; `undefined` when either side is not a version.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] === b[key]) continue
    return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/**
 * Encode a package name for one registry path segment: the scope separator
 * becomes `%2F` and the leading `@` stays literal, as npm clients send it.
 * @param packageName - registry package name.
 * @returns the encoded path segment.
 */
export function encodePackageName(packageName) {
  return String(packageName).trim().replaceAll('/', '%2F')
}

/**
 * Build the packument URL for one package on one registry root.
 * @param registry - registry root, with or without a trailing slash.
 * @param packageName - registry package name.
 * @returns the absolute packument URL.
 */
export function packumentUrl(registry, packageName) {
  const base = String(registry ?? '').trim().replace(/\/+$/, '')
  const root = base === '' ? DEFAULT_REGISTRY.replace(/\/+$/, '') : base
  return `${root}/${encodePackageName(packageName)}`
}

/**
 * Read the `dist-tags` entry for one package from its registry.
 * @param options - registry root, package, dist-tag, and the transport to use.
 * @returns the selected version and the URL it came from.
 * @throws when the registry rejects the request, returns a malformed document,
 * or publishes no version under the requested dist-tag.
 */
export async function fetchLatestVersion({
  registry = DEFAULT_REGISTRY,
  packageName = DEFAULT_PACKAGE,
  distTag = DEFAULT_DIST_TAG,
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
  timeoutMs = 20_000,
}) {
  const url = packumentUrl(registry, packageName)
  const timeout = AbortSignal.timeout(timeoutMs)
  const aborted = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9' },
    redirect: 'follow',
    signal: aborted,
  })
  if (response.ok !== true) throw new Error(`registry responded HTTP ${String(response.status)}`)
  const document = await response.json()
  const tags = document !== null && typeof document === 'object' ? document['dist-tags'] : undefined
  const version = tags !== null && typeof tags === 'object' ? tags[distTag] : undefined
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`registry publishes no "${distTag}" version for ${packageName}`)
  }
  return { registry, version: version.trim(), url }
}

/**
 * Read the `version` field of one package directory.
 * @param packageDir - absolute package directory, or `undefined`.
 * @returns the declared version, or `undefined` when it cannot be read.
 */
export function readInstalledVersion(packageDir) {
  if (typeof packageDir !== 'string' || packageDir === '') return undefined
  try {
    const document = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    return typeof document.version === 'string' ? document.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Locate the dsh installation that owns this process: the nearest ancestor of
 * the launcher script whose `package.json` declares the dsh package name.
 * @param argv - process argument list (the launcher script sits at index 1).
 * @param expectedName - package name the installation must declare.
 * @returns the absolute package directory, or `undefined` when not found.
 */
export function locateDshInstall(argv = process.argv, expectedName = DEFAULT_PACKAGE) {
  const anchor = Array.isArray(argv) && typeof argv[1] === 'string' ? argv[1] : undefined
  if (anchor === undefined || anchor === '') return undefined
  let current
  try {
    current = dirname(realpathSync(anchor))
  } catch {
    current = dirname(resolve(anchor))
  }
  for (let depth = 0; depth < MAX_INSTALL_WALK; depth += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const document = JSON.parse(readFileSync(manifest, 'utf8'))
        if (document.name === expectedName) return current
      } catch {
        // An unreadable manifest is not the installation; keep walking.
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}
