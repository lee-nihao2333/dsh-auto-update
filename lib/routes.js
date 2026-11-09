/**
 * Web route handlers for the dsh update plugin.
 *
 * The handlers own only HTTP shape: they translate one already-authenticated
 * request into one updater transition and one JSON answer. Authentication, the
 * web server, and the updater itself stay outside so both the wiring and the
 * contracts can be exercised independently.
 * @module dsh-auto-update/routes
 */

/** Status read consumed by the Client half. */
export const STATUS_PATH = '/dsh-auto-update/status'
/** Start installation and restart; accepted with 202 and polled through status. */
export const APPLY_PATH = '/dsh-auto-update/apply'
/** Retry only the restart after an installation that could not relaunch. */
export const RESTART_PATH = '/dsh-auto-update/restart'

/**
 * Send one JSON response. Update facts are live, so they are never cacheable.
 * @param response - response owner.
 * @param status - HTTP status code.
 * @param value - serializable body.
 */
export function sendJson(response, status, value) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(value))
}

/**
 * Reject a method that the route does not serve.
 * @param response - response owner.
 * @param allowed - the one method the route serves.
 */
export function sendMethodNotAllowed(response, allowed) {
  response.setHeader('allow', allowed)
  sendJson(response, 405, { ok: false, code: 'method-not-allowed' })
}

/**
 * Build the three route handlers.
 * @param options - updater transitions and the request authorizer.
 * @returns one handler per absolute pathname, in registration order.
 */
export function createHandlers({ updater, authorize }) {
  /** Status: current version, latest version, availability, phase, error. */
  const status = (request, response) => {
    if (authorize(request, response)) return
    if (request.method !== 'GET') {
      sendMethodNotAllowed(response, 'GET')
      return
    }
    sendJson(response, 200, { ok: true, ...updater.status() })
  }

  /** Install and restart. Validation answers immediately; work continues. */
  const apply = (request, response) => {
    if (authorize(request, response)) return
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'POST')
      return
    }
    const outcome = updater.beginUpdate()
    if (outcome.ok !== true) {
      sendJson(response, outcome.status, { ok: false, code: outcome.code })
      return
    }
    sendJson(response, 202, { ok: true, accepted: true, version: outcome.version })
  }

  /** Restart-only retry after an installation that could not relaunch. */
  const restart = (request, response) => {
    if (authorize(request, response)) return
    if (request.method !== 'POST') {
      sendMethodNotAllowed(response, 'POST')
      return
    }
    const outcome = updater.beginRestart()
    if (outcome.ok !== true) {
      sendJson(response, outcome.status, { ok: false, code: outcome.code })
      return
    }
    sendJson(response, 202, { ok: true, accepted: true })
  }

  return new Map([
    [STATUS_PATH, status],
    [APPLY_PATH, apply],
    [RESTART_PATH, restart],
  ])
}
