/**
 * dsh-auto-update — Host half.
 *
 * Watches the npm registry for a newer dsh release, exposes the availability
 * facts and the two user actions (install, restart) over authenticated Web
 * routes, and hands the relaunch to a detached helper before the Host exits.
 *
 * The Client half renders the top-right Update button from these routes; all
 * authority stays here, so the page can never choose a different package,
 * version, or command.
 * @module dsh-auto-update
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installGlobal, resolveNpmRegistry } from './lib/npm.js'
import { createHandlers } from './lib/routes.js'
import { createUpdater } from './lib/updater.js'
import { DEFAULT_DIST_TAG, DEFAULT_PACKAGE, locateDshInstall, readInstalledVersion } from './lib/update.js'

/** Stable Cordis plugin name. */
export const name = '@marvinlee2011/dsh-auto-update'
/** Host services required before the routes can mount. */
export const inject = ['webServer', 'connection']

/** Default minutes between two automatic registry checks. */
const DEFAULT_CHECK_MINUTES = 30

/**
 * Apply the row's configuration over the plugin defaults.
 * @param config - raw Loader row configuration.
 * @returns normalized settings.
 */
function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const packageName =
    typeof source.packageName === 'string' && source.packageName.trim() !== '' ? source.packageName.trim() : DEFAULT_PACKAGE
  const distTag = typeof source.distTag === 'string' && source.distTag.trim() !== '' ? source.distTag.trim() : DEFAULT_DIST_TAG
  const registry = typeof source.registry === 'string' ? source.registry.trim().replace(/\/+$/, '') : ''
  const minutes = Number(source.checkIntervalMinutes)
  const checkIntervalMinutes =
    Number.isFinite(minutes) && minutes >= 1 ? Math.min(minutes, 24 * 60) : DEFAULT_CHECK_MINUTES
  return { packageName, distTag, registry, checkIntervalMinutes }
}

/**
 * Mount the update routes and start the registry watchdog.
 * @param ctx - plugin context carrying the web server and connection services.
 * @param config - Loader row configuration.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const home = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const stateDir = join(home, 'cache', 'dsh-auto-update')
  const installDir = locateDshInstall(process.argv)
  const updater = createUpdater({
    packageName: settings.packageName,
    distTag: settings.distTag,
    registry: settings.registry,
    checkIntervalMs: settings.checkIntervalMinutes * 60_000,
    stateDir,
    installDir,
    currentVersion: readInstalledVersion(installDir),
    resolveRegistry: () => resolveNpmRegistry({ execPath: process.execPath }),
    installPackage: (spec) => installGlobal(spec, { execPath: process.execPath }),
    exit: (code) => {
      const appExit = ctx.get('appExit')
      if (typeof appExit === 'function') appExit(code)
      else process.exit(code)
    },
  })

  /**
   * Apply the same Host/Origin fence and browser authentication as the shipped
   * `/api` routes to one request.
   * @param request - incoming request.
   * @param response - response owner.
   * @returns true when the request was rejected and must not be handled.
   */
  const rejected = (request, response) => {
    const connection = ctx.get('connection')
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      // Fail closed: without the authentication carrier no request is trusted.
      response.statusCode = 503
      response.end()
      return true
    }
    const rejection = connection.requestRejection(request)
    if (rejection === undefined) return false
    response.statusCode = rejection
    response.end()
    return true
  }

  for (const [path, handler] of createHandlers({ updater, authorize: rejected })) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `dsh-auto-update: ${path}`)
  }

  ctx.effect(() => {
    void updater.init().catch((error) => {
      // The initial check reports failures through its own state; this guard
      // only keeps an unexpected rejection out of the process-wide handler.
      console.error('dsh-auto-update: initial registry check failed:', error)
    })
    return () => updater.dispose()
  }, 'dsh-auto-update: registry watchdog')
}
