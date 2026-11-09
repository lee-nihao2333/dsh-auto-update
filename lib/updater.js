/**
 * Update state machine for the dsh update plugin: one registry check, one npm
 * installation, and the detached restart hand-off.
 *
 * The updater owns no Cordis context; the Host half injects the transports
 * (fetch, npm runner, restart spawner, exit request) so every transition can be
 * exercised without a live dsh installation.
 * @module dsh-auto-update/updater
 */
import { spawn } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DIST_TAG,
  DEFAULT_PACKAGE,
  compareVersions,
  fetchLatestVersion,
  readInstalledVersion,
} from './update.js'

/** Detached restart helper shipped beside this module. */
const RESTART_CHILD = fileURLToPath(new URL('./restart-child.mjs', import.meta.url))
/** Minimum spacing between two automatic registry checks. */
const CHECK_DEBOUNCE_MS = 60_000
/** Grace period between spawning the restart helper and requesting process exit. */
const EXIT_GRACE_MS = 600
/** How long the restart helper waits for the old process to disappear. */
const RESTART_WAIT_MS = 120_000
/** Settle time after the old process exits before the launcher is started again. */
const RESTART_SETTLE_MS = 600

/** Shorten one error into a single bounded line. */
function messageOf(error) {
  const text = error instanceof Error ? error.message : String(error)
  const line = text.split('\n').find((part) => part.trim() !== '') ?? text
  return line.trim().slice(0, 500)
}

/** Name of the node executable that hosts the running dsh process. */
function defaultRespawn() {
  return {
    node: process.execPath,
    bin: process.argv[1],
    args: process.argv.slice(2),
    cwd: process.cwd(),
  }
}

/**
 * Spawn the detached restart helper. The helper owns the relaunch, so the Host
 * can exit immediately without leaving a supervising child behind.
 * @param options - node executable, helper script, and the relaunch spec.
 * @returns the helper process id.
 */
export async function spawnRestartHelper({ node, script = RESTART_CHILD, spec }) {
  const child = spawn(node, [script, JSON.stringify(spec)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  return child.pid
}

/**
 * Create one updater instance.
 * @param options - plugin settings and injected transports.
 * @returns the updater's lifecycle, state, and transition methods.
 */
export function createUpdater(options = {}) {
  const {
    packageName = DEFAULT_PACKAGE,
    distTag = DEFAULT_DIST_TAG,
    registry = '',
    checkIntervalMs = 30 * 60_000,
    stateDir,
    installDir,
    currentVersion,
    fetchImpl = (...args) => globalThis.fetch(...args),
    resolveRegistry = async () => undefined,
    installPackage = async () => ({ code: 1, stdout: '', stderr: 'no npm runner configured' }),
    respawn = defaultRespawn(),
    spawnRestart = spawnRestartHelper,
    exit = (code) => process.exit(code),
    exitGraceMs = EXIT_GRACE_MS,
    now = () => Date.now(),
  } = options

  const statePath = typeof stateDir === 'string' && stateDir !== '' ? join(stateDir, 'state.json') : undefined
  const logPath = statePath === undefined ? undefined : join(dirname(statePath), 'restart.log')
  const markerPath = statePath === undefined ? undefined : join(dirname(statePath), 'restart.json')

  /** @type {{ phase: string, currentVersion: string | null, latestVersion: string | null, updateAvailable: boolean, restartRequired: boolean, checkedAt: number | null, error: string | null }} */
  const state = {
    phase: 'idle',
    currentVersion: typeof currentVersion === 'string' && currentVersion !== '' ? currentVersion : null,
    latestVersion: null,
    updateAvailable: false,
    restartRequired: false,
    checkedAt: null,
    error: null,
  }
  let timer
  let disposed = false
  let checking
  let checkController
  let installTask
  let exitTimer

  /** Public, serializable view of the current state. */
  function status() {
    return {
      phase: state.phase,
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      updateAvailable: state.updateAvailable,
      restartRequired: state.restartRequired,
      checkedAt: state.checkedAt === null ? null : new Date(state.checkedAt).toISOString(),
      error: state.error,
      pid: process.pid,
    }
  }

  /** Best-effort durable copy of the current state for diagnostics and display. */
  async function persist() {
    if (statePath === undefined) return
    try {
      await mkdir(dirname(statePath), { recursive: true })
      const temporary = `${statePath}.tmp`
      await writeFile(temporary, `${JSON.stringify(status(), null, 2)}\n`)
      await rename(temporary, statePath)
    } catch {
      // Persistence is diagnostic; a failed write must not fail an update.
    }
  }

  /** Resolve the registry root once, preferring the explicit plugin setting. */
  async function registryRoot() {
    if (registry !== '') return registry
    const detected = await resolveRegistry()
    return typeof detected === 'string' && detected !== '' ? detected : undefined
  }

  /**
   * Query the registry and update the availability facts. A failed check keeps
   * the previously known latest version so a transient outage does not hide a
   * known update.
   * @param options - force bypasses the debounce between checks.
   * @returns the public status after the attempt.
   */
  async function refresh({ force = false } = {}) {
    if (disposed) return status()
    if (state.phase === 'updating' || state.phase === 'restarting') return status()
    if (!force && state.checkedAt !== null && now() - state.checkedAt < CHECK_DEBOUNCE_MS) return status()
    if (checking !== undefined) return checking

    checking = (async () => {
      const controller = new AbortController()
      checkController = controller
      try {
        if (state.currentVersion === null) {
          const installed = readInstalledVersion(installDir)
          if (installed !== undefined) state.currentVersion = installed
        }
        if (state.currentVersion === null) throw new Error('cannot determine the installed dsh version')
        const root = await registryRoot()
        const result = await fetchLatestVersion({
          registry: root,
          packageName,
          distTag,
          fetchImpl,
          signal: controller.signal,
        })
        state.latestVersion = result.version
        state.updateAvailable = (compareVersions(result.version, state.currentVersion) ?? 0) > 0
        state.error = null
      } catch (error) {
        if (controller.signal.aborted) return
        state.error = messageOf(error)
      } finally {
        state.checkedAt = now()
        checkController = undefined
        await persist()
      }
      return status()
    })().finally(() => {
      checking = undefined
    })
    return checking
  }

  /** Build the relaunch spec handed to the detached helper. */
  function restartSpec(version) {
    if (typeof respawn.bin !== 'string' || respawn.bin === '') {
      throw new Error('cannot determine the dsh launcher path for the restart')
    }
    return {
      parentPid: process.pid,
      node: respawn.node,
      bin: respawn.bin,
      args: Array.isArray(respawn.args) ? respawn.args : [],
      cwd: respawn.cwd,
      logPath,
      markerPath,
      waitMs: RESTART_WAIT_MS,
      settleMs: RESTART_SETTLE_MS,
      version: version ?? null,
    }
  }

  /**
   * Spawn the restart helper and request process exit shortly afterwards, so
   * the HTTP response that accepted the update has time to flush.
   * @param version - version the relaunched process should report.
   */
  async function scheduleRestart(version) {
    const spec = restartSpec(version)
    // Publish the intent synchronously so a concurrent request cannot schedule
    // a second relaunch while the helper is starting.
    state.phase = 'restarting'
    state.error = null
    await persist()
    try {
      await spawnRestart({ node: respawn.node, spec })
    } catch (error) {
      state.phase = state.restartRequired ? 'restart-required' : 'failed'
      state.error = messageOf(error)
      await persist()
      throw error
    }
    if (exitTimer !== undefined) clearTimeout(exitTimer)
    exitTimer = setTimeout(() => {
      try {
        exit(0)
      } catch {
        // Exit is the final action; nothing useful can follow a failure here.
      }
    }, exitGraceMs)
    if (typeof exitTimer.unref === 'function') exitTimer.unref()
  }

  /** Run the installation and move to the restart hand-off on success. */
  async function install(version) {
    try {
      const spec = `${packageName}@${version}`
      const result = await installPackage(spec)
      if (result === undefined || result.code !== 0) {
        const detail = String(result?.stderr ?? '').trim() || String(result?.stdout ?? '').trim()
        throw new Error(`npm install ${spec} failed${result?.code === undefined ? '' : ` (exit ${String(result.code)})`}${detail === '' ? '' : `: ${detail}`}`)
      }
      if (disposed) return
      const installed = readInstalledVersion(installDir)
      if (installed !== undefined && installed !== version) {
        throw new Error(`npm reported success but ${installDir ?? 'the install'} still reports ${installed}`)
      }
      state.currentVersion = installed ?? version
      state.latestVersion = version
      state.updateAvailable = false
      state.restartRequired = true
      state.error = null
      state.checkedAt = now()
      state.phase = 'restart-required'
      await persist()
      await scheduleRestart(state.currentVersion)
    } catch (error) {
      if (disposed) return
      state.phase = state.restartRequired ? 'restart-required' : 'failed'
      state.error = messageOf(error)
      await persist()
    }
  }

  /**
   * Accept one update request. Validation is synchronous so the HTTP route can
   * answer immediately; the installation continues in the background.
   * @returns the acceptance outcome, including the installation promise.
   */
  function beginUpdate() {
    if (disposed) return { ok: false, status: 409, code: 'disposed' }
    if (state.phase === 'updating' || state.phase === 'restarting') return { ok: false, status: 409, code: 'busy' }
    if (state.updateAvailable !== true || state.latestVersion === null) {
      return { ok: false, status: 409, code: state.restartRequired ? 'restart-required' : 'no-update' }
    }
    state.phase = 'updating'
    state.error = null
    state.checkedAt = now()
    void persist()
    const version = state.latestVersion
    installTask = install(version)
    return { ok: true, status: 202, version, done: installTask }
  }

  /**
   * Retry the restart hand-off after an installation that could not relaunch.
   * @returns the acceptance outcome, including the restart promise.
   */
  function beginRestart() {
    if (disposed) return { ok: false, status: 409, code: 'disposed' }
    if (state.phase === 'updating' || state.phase === 'restarting') return { ok: false, status: 409, code: 'busy' }
    if (state.restartRequired !== true) return { ok: false, status: 409, code: 'no-restart' }
    const done = scheduleRestart(state.currentVersion).catch(async (error) => {
      if (disposed) return
      state.phase = 'restart-required'
      state.error = messageOf(error)
      await persist()
    })
    return { ok: true, status: 202, done }
  }

  /** Clear timers and abort an in-flight check. */
  function dispose() {
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    if (exitTimer !== undefined) clearTimeout(exitTimer)
    checkController?.abort()
  }

  /**
   * Resolve installation facts, publish the first check, and start the periodic
   * one.
   * @returns the public status after the first check attempt.
   */
  async function init() {
    if (state.currentVersion === null) {
      const installed = readInstalledVersion(installDir)
      if (installed !== undefined) state.currentVersion = installed
    }
    await persist()
    const result = await refresh({ force: true })
    if (!disposed && checkIntervalMs > 0) {
      timer = setInterval(() => {
        void refresh()
      }, checkIntervalMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    return result
  }

  return {
    status,
    refresh,
    beginUpdate,
    beginRestart,
    whenIdle: () => installTask,
    dispose,
    init,
  }
}
