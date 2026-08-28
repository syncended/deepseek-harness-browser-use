import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import type { BrowserScreenView, BrowserTabView } from '../protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: ConnectionHandle
  }
}

const CHANNEL = '/browser-use'
const STYLE_ID = '@syncended/dsh-browser-use/client.css'
const POLL_MS = 400

const styles = `
.dbu-header-button{height:28px;border:1px solid var(--dsw-alias-border-primary,#d7d7d7);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#555);padding:0 10px;font:inherit;font-size:12px;cursor:pointer}
.dbu-header-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dbu-overlay-launcher{position:fixed;right:18px;bottom:18px;z-index:40;pointer-events:auto;box-shadow:0 4px 18px rgba(0,0,0,.18);background:var(--dsw-alias-bg-primary,#fff)}
.dbu-panel{position:fixed;z-index:50;top:0;right:0;bottom:0;width:min(520px,calc(100vw - 48px));min-width:320px;display:flex;flex-direction:column;box-shadow:-8px 0 28px rgba(0,0,0,.18);background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);pointer-events:auto}
.dbu-toolbar{display:flex;align-items:center;gap:6px;padding:8px;border-bottom:1px solid var(--dsw-alias-border-primary,#ddd)}
.dbu-toolbar button,.dbu-toolbar select{height:30px;border:1px solid var(--dsw-alias-border-primary,#d0d0d0);border-radius:6px;background:var(--dsw-alias-bg-secondary,#f7f7f7);color:inherit;padding:0 8px;cursor:pointer}
.dbu-toolbar button:disabled{opacity:.45;cursor:default}
.dbu-toolbar select{min-width:0;max-width:128px}
.dbu-url{display:flex;min-width:0;flex:1}
.dbu-url input{width:100%;height:30px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-primary,#d0d0d0);border-radius:6px;background:var(--dsw-alias-bg-primary,#fff);color:inherit;padding:0 9px;font:inherit;font-size:12px}
.dbu-viewport-wrap{position:relative;min-height:0;flex:1;display:flex;align-items:flex-start;justify-content:center;overflow:auto;background:#202124}
.dbu-viewport{display:block;width:100%;height:auto;outline:none;cursor:default;user-select:none;-webkit-user-drag:none}
.dbu-empty{margin:auto;color:#ddd;font-size:13px;text-align:center;padding:24px}
.dbu-status{display:flex;gap:8px;align-items:center;min-height:28px;padding:0 9px;border-top:1px solid var(--dsw-alias-border-primary,#ddd);font-size:11px;color:var(--dsw-alias-label-tertiary,#777)}
.dbu-status strong{color:#2f9e44;font-weight:600}
.dbu-error{color:#d9480f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`

interface RpcClient {
  call<T>(endpoint: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>
}

interface HeaderInjected {
  openBrowser(): void
}

type HeaderProps = PropsRuntime<'conversation.session.header.actions'> & HeaderInjected
type OverlayProps = PropsRuntime<'shell.overlay'> & HeaderInjected

interface PanelInjected {
  closeBrowser(): void
  rpc: RpcClient
}

type PanelProps = PropsRuntime<'shell.overlay'> & PanelInjected

function activeTab(screen: BrowserScreenView | undefined): BrowserTabView | undefined {
  return screen?.tabs.find(tab => tab.active)
}

function BrowserHeaderAction({ openBrowser }: HeaderProps) {
  return (
    <button type="button" className="dbu-header-button" onClick={openBrowser} title="Open persistent browser">
      Browser
    </button>
  )
}

function BrowserOverlayLauncher({ openBrowser }: OverlayProps) {
  return (
    <button
      type="button"
      className="dbu-header-button dbu-overlay-launcher"
      onClick={openBrowser}
      title="Open persistent browser"
    >
      Browser
    </button>
  )
}

function BrowserPanel({ closeBrowser, rpc }: PanelProps) {
  const [clientId] = useState(() => globalThis.crypto.randomUUID())
  const imageRef = useRef<HTMLImageElement>(null)
  const editingUrl = useRef(false)
  const mounted = useRef(true)
  const commandTail = useRef<Promise<void>>(Promise.resolve())
  const [screen, setScreen] = useState<BrowserScreenView>()
  const [url, setUrl] = useState('about:blank')
  const [error, setError] = useState<string>()
  const [leaseOwned, setLeaseOwned] = useState(false)
  const [busyCount, setBusyCount] = useState(0)

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const next = await rpc.call<BrowserScreenView>('screen', { clientId }, signal)
    if (signal?.aborted || !mounted.current) return
    setScreen(next)
    if (!editingUrl.current) setUrl(activeTab(next)?.url ?? 'about:blank')
  }, [clientId, rpc])

  useEffect(() => {
    mounted.current = true
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async (): Promise<void> => {
      try {
        const lease = await rpc.call<{ acquired: boolean }>('lease/acquire', { clientId }, abort.signal)
        if (abort.signal.aborted) return
        setLeaseOwned(lease.acquired)
        if (!lease.acquired) throw new Error('Another Browser panel currently owns human control')
        await refresh(abort.signal)
        if (!abort.signal.aborted) setError(undefined)
      } catch (reason: unknown) {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => { void loop() }, POLL_MS)
      }
    }
    void loop()
    return () => {
      mounted.current = false
      abort.abort()
      if (timer !== undefined) clearTimeout(timer)
      void rpc.call('lease/release', { clientId }).catch(() => undefined)
    }
  }, [clientId, refresh, rpc])

  const command = useCallback((endpoint: string, payload: Record<string, unknown> = {}): Promise<void> => {
    const run = commandTail.current.then(async () => {
      if (!leaseOwned) throw new Error('Waiting for human browser control')
      if (mounted.current) setBusyCount(count => count + 1)
      try {
        await rpc.call(endpoint, { clientId, ...payload })
        if (mounted.current) setError(undefined)
      } catch (reason: unknown) {
        if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
        throw reason
      } finally {
        if (mounted.current) setBusyCount(count => Math.max(0, count - 1))
      }
    })
    commandTail.current = run.catch(() => undefined)
    return run
  }, [clientId, leaseOwned, rpc])

  useEffect(() => {
    const image = imageRef.current
    if (image === null || screen === undefined || !leaseOwned) return
    let deltaX = 0
    let deltaY = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      timer = undefined
      const rect = image.getBoundingClientRect()
      const scaledX = deltaX * screen.width / rect.width
      const scaledY = deltaY * screen.height / rect.height
      deltaX = 0
      deltaY = 0
      void command('wheel', { deltaX: scaledX, deltaY: scaledY }).catch(() => undefined)
    }
    const onWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault()
      deltaX += event.deltaX
      deltaY += event.deltaY
      if (timer === undefined) timer = setTimeout(flush, 40)
    }
    image.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      image.removeEventListener('wheel', onWheel)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [command, leaseOwned, screen])

  const submitUrl = (event: FormEvent): void => {
    event.preventDefault()
    editingUrl.current = false
    void command('navigate', { url }).catch(() => undefined)
  }

  const clickViewport = (event: MouseEvent<HTMLImageElement>): void => {
    const image = imageRef.current
    if (image === null || screen === undefined || !leaseOwned) return
    image.focus()
    const rect = image.getBoundingClientRect()
    const x = (event.clientX - rect.left) * screen.width / rect.width
    const y = (event.clientY - rect.top) * screen.height / rect.height
    void command('pointer/click', { x, y }).catch(() => undefined)
  }

  const keyViewport = (event: KeyboardEvent<HTMLImageElement>): void => {
    if (!leaseOwned) return
    event.preventDefault()
    if (event.key === 'F5') {
      void command('reload').catch(() => undefined)
      return
    }
    const text = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
      ? event.key
      : undefined
    const modifiers = [
      event.metaKey ? 'Meta' : '',
      event.ctrlKey ? 'Control' : '',
      event.altKey ? 'Alt' : '',
      event.shiftKey && text === undefined ? 'Shift' : '',
    ].filter(Boolean)
    const key = [...modifiers, event.key === ' ' ? 'Space' : event.key].join('+')
    void command('key', { key, ...(text === undefined ? {} : { text }) }).catch(() => undefined)
  }

  const selected = screen?.activePageId ?? ''
  const busy = busyCount > 0
  const disabled = busy || !leaseOwned

  return (
    <section className="dbu-panel" aria-label="Persistent browser">
      <div className="dbu-toolbar">
        <button type="button" disabled={disabled} onClick={() => { void command('back').catch(() => undefined) }} title="Back">←</button>
        <button type="button" disabled={disabled} onClick={() => { void command('forward').catch(() => undefined) }} title="Forward">→</button>
        <button type="button" disabled={disabled} onClick={() => { void command('reload').catch(() => undefined) }} title="Reload">↻</button>
        <form className="dbu-url" onSubmit={submitUrl}>
          <input
            aria-label="Browser URL"
            value={url}
            disabled={!leaseOwned}
            onChange={event => { setUrl(event.target.value) }}
            onFocus={() => { editingUrl.current = true }}
            onBlur={() => { editingUrl.current = false }}
          />
        </form>
        <select
          aria-label="Browser tab"
          value={selected}
          disabled={disabled || (screen?.tabs.length ?? 0) === 0}
          onChange={event => { void command('tabs/select', { pageId: event.target.value }).catch(() => undefined) }}
        >
          {(screen?.tabs ?? []).map(tab => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
        </select>
        <button type="button" disabled={disabled} onClick={() => { void command('tabs/new').catch(() => undefined) }} title="New tab">＋</button>
        <button type="button" disabled={disabled || !selected} onClick={() => { void command('tabs/close', { pageId: selected }).catch(() => undefined) }} title="Close tab">×</button>
        <button type="button" onClick={closeBrowser} title="Close Browser panel">Close</button>
      </div>
      <div className="dbu-viewport-wrap">
        {screen === undefined
          ? <div className="dbu-empty">Starting persistent Chromium…</div>
          : (
            <img
              ref={imageRef}
              className="dbu-viewport"
              src={`data:${screen.mediaType};base64,${screen.image}`}
              width={screen.width}
              height={screen.height}
              alt="Controlled browser viewport"
              aria-disabled={!leaseOwned}
              draggable={false}
              tabIndex={leaseOwned ? 0 : -1}
              onClick={clickViewport}
              onKeyDown={keyViewport}
            />
          )}
      </div>
      <div className="dbu-status">
        <strong>{leaseOwned ? 'You control the browser' : 'Waiting for control'}</strong>
        <span>{activeTab(screen)?.title ?? 'Starting…'}</span>
        {error === undefined ? null : <span className="dbu-error" title={error}>{error}</span>}
      </div>
    </section>
  )
}

class BrowserPanelController {
  #disposePanel: (() => void) | undefined

  constructor(private readonly ctx: Context, readonly rpc: RpcClient) {}

  open = (): void => {
    if (this.#disposePanel !== undefined) return
    this.#disposePanel = this.ctx.slots.inject('shell.overlay', () => this.ctx.slots.register({
      name: 'shell.overlay',
      id: 'browser-use-panel',
      order: 110,
      inject: (): PanelInjected => ({ closeBrowser: this.close, rpc: this.rpc }),
    }, BrowserPanel))
  }

  close = (): void => {
    this.#disposePanel?.()
    this.#disposePanel = undefined
  }

  dispose(): void {
    this.#disposePanel?.()
    this.#disposePanel = undefined
  }
}

export const inject = ['connection', 'slots']

export function apply(ctx: Context): void {
  if (!ctx.connection.isLoopback) return
  const rpc: RpcClient = {
    async call<T>(endpoint: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
      const result = await ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value as T
    },
  }
  const controller = new BrowserPanelController(ctx, rpc)

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@syncended/dsh-browser-use'
    style.dataset.pluginCss = STYLE_ID
    style.textContent = styles
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'browser-use: styles')

  ctx.effect(() => () => { controller.dispose() }, 'browser-use: panel lifecycle')

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'browser-use',
    order: 30,
    inject: (): HeaderInjected => ({ openBrowser: controller.open }),
  }, BrowserHeaderAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'browser-use-launcher',
    order: 100,
    inject: (): HeaderInjected => ({ openBrowser: controller.open }),
  }, BrowserOverlayLauncher))
}
