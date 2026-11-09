window.__ModuleLoader__.load({
  id: '@marvinlee2011/dsh-auto-update',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'dsh-auto-update'
    /** Browser-relative status route; the page is served from the Host root. */
    const STATUS_ROUTE = 'dsh-auto-update/status'
    /** Browser-relative install-and-restart route. */
    const APPLY_ROUTE = 'dsh-auto-update/apply'
    /** Browser-relative restart-only route. */
    const RESTART_ROUTE = 'dsh-auto-update/restart'
    /** Idle re-read of the Host status. */
    const POLL_MS = 60_000
    /** Poll spacing while waiting for the relaunched process. */
    const WATCH_MS = 1_500
    /** Upper bound on the wait for the relaunched process. */
    const WATCH_LIMIT_MS = 180_000

    /** Simplified-Chinese copy, also the key-set source of truth. */
    const zh = {
      'action.update': '更新',
      'action.updating': '正在更新…',
      'action.restarting': '正在重启…',
      'action.restart': '重启',
      'action.retry': '重试更新',
      'title.available': 'dsh 有新版本：{current} → {latest}。点击后升级并重启 dsh。',
      'title.restart': '新版本已安装，需要重启 dsh 才能生效。',
      'title.applying': '正在安装新版本，请保持页面打开。',
      'title.watching': '安装完成，正在等待 dsh 重启。',
      'title.failed': '更新未完成：{error}',
      'error.noUpdate': '当前已是最新版本。',
      'error.busy': '已有更新或重启正在进行。',
      'error.restartRequired': '新版本已安装，请点击「重启」。',
      'error.start': '无法启动更新，请稍后重试。',
      'error.network': '无法连接 dsh，请检查后台进程状态。',
      'error.installFailed': '安装失败，请查看 dsh 日志后重试。',
      'error.restartTimeout': '等待重启超时，请手动刷新页面。',
    }

    /** English copy, key-identical to the Chinese source of truth. */
    const en = {
      'action.update': 'Update',
      'action.updating': 'Updating…',
      'action.restarting': 'Restarting…',
      'action.restart': 'Restart',
      'action.retry': 'Retry update',
      'title.available': 'A newer dsh is available: {current} → {latest}. Click to upgrade and restart dsh.',
      'title.restart': 'The new version is installed. Restart dsh to activate it.',
      'title.applying': 'Installing the new version. Keep this page open.',
      'title.watching': 'Installation finished. Waiting for dsh to come back.',
      'title.failed': 'The update did not finish: {error}',
      'error.noUpdate': 'dsh is already up to date.',
      'error.busy': 'An update or restart is already in progress.',
      'error.restartRequired': 'The new version is installed; press Restart.',
      'error.start': 'Could not start the update. Try again later.',
      'error.network': 'Could not reach dsh. Check the background process.',
      'error.installFailed': 'Installation failed. Check the dsh log and retry.',
      'error.restartTimeout': 'Timed out waiting for the restart. Reload the page manually.',
    }

    /** Compact header pill built only from host theme tokens. */
    const CSS = [
      '.dsh-auto-update-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;line-height:1;',
      'white-space:nowrap;flex:none;cursor:pointer;transition:background .15s ease,border-color .15s ease}',
      '.dsh-auto-update-pill:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}',
      '.dsh-auto-update-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsh-auto-update-pill:disabled{cursor:default;opacity:.72}',
      '.dsh-auto-update-pill__dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}',
      '.dsh-auto-update-pill--busy .dsh-auto-update-pill__dot{animation:dsh-auto-update-pulse 1s ease-in-out infinite}',
      '.dsh-auto-update-pill--failed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsh-auto-update-pill--failed .dsh-auto-update-pill__dot{background:var(--dsw-alias-state-error-primary)}',
      '@keyframes dsh-auto-update-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}',
    ].join('')

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /**
     * Read the Host status. A failed read (including the moment the Host is
     * down during a restart) is not an error state by itself.
     * @returns the status object, or undefined when it is unavailable.
     */
    async function readStatus() {
      try {
        const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) return undefined
        const value = await response.json()
        return value !== null && typeof value === 'object' ? value : undefined
      } catch {
        return undefined
      }
    }

    /**
     * POST one user action.
     * @param route - browser-relative route.
     * @returns the HTTP outcome and the parsed body when one was sent.
     */
    async function postAction(route) {
      const response = await fetch(route, { method: 'POST', headers: { accept: 'application/json' } })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      return { ok: response.ok === true && body?.ok === true, body }
    }

    /**
     * Translate one rejected action into user-facing copy.
     * @param body - response body, possibly undefined.
     * @param t - namespace translate.
     * @returns the failure message.
     */
    function failureMessage(body, t) {
      if (body !== null && typeof body === 'object' && typeof body.message === 'string' && body.message !== '') {
        return body.message
      }
      const code = body !== null && typeof body === 'object' ? body.code : undefined
      if (code === 'no-update') return t('error.noUpdate')
      if (code === 'busy') return t('error.busy')
      if (code === 'restart-required') return t('error.restartRequired')
      return t('error.start')
    }

    /**
     * Top-right header pill: hidden while dsh is current, shown once a newer
     * version is known, and busy until the relaunched Host answers again.
     * @param props - slot props including the namespace translate.
     * @returns the pill, or null when there is nothing to announce.
     */
    function UpdateButton(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [status, setStatus] = React.useState(null)
      const [phase, setPhase] = React.useState('idle')
      const [error, setError] = React.useState(null)
      const mounted = React.useRef(true)

      React.useEffect(() => {
        mounted.current = true
        let cancelled = false
        const load = async () => {
          const next = await readStatus()
          if (!cancelled && next !== undefined) setStatus(next)
        }
        void load()
        const timer = setInterval(() => {
          void load()
        }, POLL_MS)
        return () => {
          cancelled = true
          mounted.current = false
          clearInterval(timer)
        }
      }, [])

      /**
       * Poll until the Host reports a different process id, then reload so the
       * page runs the freshly installed Client code.
       * @param baseline - process id and version observed before the action.
       */
      const watchRestart = async (baseline) => {
        const deadline = Date.now() + WATCH_LIMIT_MS
        while (Date.now() < deadline) {
          await sleep(WATCH_MS)
          if (!mounted.current) return
          const next = await readStatus()
          if (next === undefined) continue
          if (next.pid !== baseline.pid && baseline.pid !== null) {
            window.location.reload()
            return
          }
          if (next.phase === 'failed') {
            setStatus(next)
            setPhase('failed')
            setError(next.error || t('error.installFailed'))
            return
          }
          if (next.phase === 'restart-required' && typeof next.error === 'string' && next.error !== '') {
            setStatus(next)
            setPhase('failed')
            setError(next.error)
            return
          }
        }
        if (!mounted.current) return
        setPhase('failed')
        setError(t('error.restartTimeout'))
      }

      /**
       * Run one accepted action and follow it to the reload or the failure.
       * @param route - browser-relative action route.
       */
      const run = async (route) => {
        if (phase === 'applying' || phase === 'watching') return
        setError(null)
        setPhase('applying')
        const baseline = {
          pid: typeof status?.pid === 'number' ? status.pid : null,
          version: typeof status?.currentVersion === 'string' ? status.currentVersion : null,
        }
        try {
          const result = await postAction(route)
          if (!result.ok) {
            setPhase('failed')
            setError(failureMessage(result.body, t))
            return
          }
          setPhase('watching')
          await watchRestart(baseline)
        } catch (cause) {
          if (!mounted.current) return
          setPhase('failed')
          setError(t('error.network'))
          console.warn('dsh-auto-update: action failed', cause)
        }
      }

      const updateAvailable = status?.updateAvailable === true
      const restartRequired = status?.restartRequired === true
      const busy = phase === 'applying' || phase === 'watching'
      if (!busy && !updateAvailable && !restartRequired) return null

      const tone = phase === 'failed' ? 'failed' : busy ? 'busy' : 'idle'
      let label
      if (phase === 'applying') label = t('action.updating')
      else if (phase === 'watching') label = t('action.restarting')
      else if (phase === 'failed') label = t('action.retry')
      else if (restartRequired) label = t('action.restart')
      else label = t('action.update')

      let title
      if (phase === 'applying') title = t('title.applying')
      else if (phase === 'watching') title = t('title.watching')
      else if (phase === 'failed') title = t('title.failed', { error: error ?? '' })
      else if (restartRequired) title = t('title.restart')
      else {
        title = t('title.available', {
          current: status?.currentVersion ?? '?',
          latest: status?.latestVersion ?? '?',
        })
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'dsh-auto-update-css' }, CSS),
        h(
          'button',
          {
            key: 'dsh-auto-update-pill',
            type: 'button',
            className: `dsh-auto-update-pill dsh-auto-update-pill--${tone}`,
            title,
            'aria-label': title,
            'aria-busy': busy ? 'true' : 'false',
            disabled: busy,
            onClick: () => {
              void run(restartRequired ? RESTART_ROUTE : APPLY_ROUTE)
            },
          },
          h('span', { className: 'dsh-auto-update-pill__dot', 'aria-hidden': 'true' }),
          h('span', null, label),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * Register the dictionaries and the Session-header utility.
       * @param ctx - client plugin context.
       */
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          'dsh-auto-update: dictionaries',
        )
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'dsh-auto-update',
              order: 20,
              locale: NS,
            },
            UpdateButton,
          ),
        )
      },
    }
  },
})
