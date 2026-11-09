#!/usr/bin/env node
/**
 * Detached restart hand-off for the dsh update plugin.
 *
 * The Host spawns this process with `detached: true` right before it exits.
 * It waits for the old dsh process to disappear, then starts the same launcher
 * with the same arguments and working directory, logging to the file named in
 * the spec so the relaunch can be inspected afterwards.
 *
 * Usage: node restart-child.mjs '<json spec>'
 * Spec: { parentPid, node, bin, args, cwd, logPath, markerPath, waitMs, settleMs, version }
 */
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const spec = parseSpec(process.argv[2])

function parseSpec(text) {
  try {
    const value = JSON.parse(text ?? '')
    if (value === null || typeof value !== 'object') throw new Error('spec is not an object')
    return value
  } catch (error) {
    process.stderr.write(`dsh-auto-update restart: invalid spec: ${String(error)}\n`)
    process.exit(64)
  }
}

function log(line) {
  if (typeof spec.logPath !== 'string' || spec.logPath === '') return
  try {
    appendFileSync(spec.logPath, `[${new Date().toISOString()}] [restart] ${line}\n`)
  } catch {
    // Logging is diagnostic only; it must never block the relaunch.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function main() {
  if (typeof spec.node !== 'string' || typeof spec.bin !== 'string') {
    throw new Error('spec must name the node executable and dsh launcher')
  }
  log(`waiting for dsh pid ${String(spec.parentPid)} to exit`)
  const waitMs = Number.isFinite(spec.waitMs) ? spec.waitMs : 120_000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && alive(spec.parentPid)) await sleep(200)
  if (alive(spec.parentPid)) {
    log(`dsh pid ${String(spec.parentPid)} is still running after ${String(waitMs)}ms; aborting`)
    process.exit(2)
  }
  const settleMs = Number.isFinite(spec.settleMs) ? spec.settleMs : 600
  await sleep(settleMs)

  const logFd = typeof spec.logPath === 'string' && spec.logPath !== '' ? openSync(spec.logPath, 'a') : 'ignore'
  const child = spawn(spec.node, [spec.bin, ...(Array.isArray(spec.args) ? spec.args : [])], {
    cwd: typeof spec.cwd === 'string' && spec.cwd !== '' ? spec.cwd : process.cwd(),
    env: process.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  if (typeof logFd === 'number') closeSync(logFd)
  log(`started dsh pid ${String(child.pid)} (version ${String(spec.version ?? 'unknown')})`)
  if (typeof spec.markerPath === 'string' && spec.markerPath !== '') {
    try {
      writeFileSync(
        spec.markerPath,
        `${JSON.stringify(
          {
            at: new Date().toISOString(),
            parentPid: spec.parentPid ?? null,
            childPid: child.pid ?? null,
            version: spec.version ?? null,
          },
          null,
          2,
        )}\n`,
      )
    } catch {
      // The marker is diagnostic only.
    }
  }
  process.exit(0)
}

main().catch((error) => {
  log(`relaunch failed: ${error?.stack ?? String(error)}`)
  process.exit(1)
})
