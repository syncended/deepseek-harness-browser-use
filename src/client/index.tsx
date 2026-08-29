import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
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
const VIEWPORT_RESIZE_DEBOUNCE_MS = 120
const MIN_VIEWPORT_WIDTH = 640
const MAX_VIEWPORT_WIDTH = 1920
const MIN_VIEWPORT_HEIGHT = 400
const MAX_VIEWPORT_HEIGHT = 1200

const styles = `
.dbu-panel{display:flex;width:100%;height:100%;flex:1;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
[data-conversation-scroll]:has(.dbu-panel)>[data-composer-seat]{display:none}
.dbu-toolbar{display:flex;align-items:center;gap:6px;min-width:0;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dbu-toolbar button,.dbu-toolbar select{height:30px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:0 9px;font:inherit;font-size:12px;cursor:pointer}
.dbu-toolbar button:hover:not(:disabled),.dbu-toolbar select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.dbu-toolbar button:focus-visible,.dbu-toolbar select:focus-visible,.dbu-url input:focus-visible,.dbu-viewport:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dbu-toolbar button:disabled,.dbu-toolbar select:disabled,.dbu-url input:disabled{opacity:.45;cursor:default}
.dbu-toolbar select{min-width:96px;max-width:160px}
.dbu-url{display:flex;min-width:120px;flex:1}
.dbu-url input{width:100%;height:30px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 10px;font:inherit;font-size:12px}
.dbu-url input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dbu-viewport-wrap{position:relative;display:flex;flex:1;align-items:flex-start;justify-content:center;min-height:0;overflow:auto;background:var(--dsw-alias-bg-layer-3);scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.dbu-viewport{display:block;width:auto;height:auto;max-width:100%;max-height:100%;outline:none;cursor:default;user-select:none;-webkit-user-drag:none}
.dbu-viewport[aria-disabled=true]{cursor:wait;opacity:.72}
.dbu-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;padding:24px}
.dbu-empty strong{color:var(--dsw-alias-label-secondary);font-size:14px;font-weight:500}
.dbu-status{display:flex;gap:8px;align-items:center;min-height:30px;padding:0 12px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dbu-status strong{color:var(--dsw-alias-state-success-primary);font-weight:600}
.dbu-status span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbu-error{color:var(--dsw-alias-state-error-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@media (max-width:760px){.dbu-toolbar{flex-wrap:wrap}.dbu-url{order:10;flex-basis:100%}.dbu-toolbar select{flex:1;max-width:none}}
`

interface RpcClient {
  call<T>(endpoint: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>
}

interface PanelInjected {
  rpc: RpcClient
}

type PanelProps = PropsRuntime<'conversation.view'> & PanelInjected

function activeTab(screen: BrowserScreenView | undefined): BrowserTabView | undefined {
  return screen?.tabs.find(tab => tab.active)
}

function clampViewport(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function BrowserPanel({ rpc }: PanelProps) {
  const [clientId] = useState(() => globalThis.crypto.randomUUID())
  const imageRef = useRef<HTMLImageElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastViewport = useRef('')
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
    const viewport = viewportRef.current
    const pageId = screen?.activePageId
    if (viewport === null || pageId === undefined || !leaseOwned) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending = ''
    const resize = (): void => {
      const rect = viewport.getBoundingClientRect()
      const width = clampViewport(rect.width, MIN_VIEWPORT_WIDTH, MAX_VIEWPORT_WIDTH)
      const height = clampViewport(rect.height, MIN_VIEWPORT_HEIGHT, MAX_VIEWPORT_HEIGHT)
      const key = `${pageId}:${String(width)}x${String(height)}`
      if (key === lastViewport.current || key === pending) return
      pending = key
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void rpc.call('viewport/resize', { clientId, width, height }, abort.signal)
          .then(() => { lastViewport.current = key })
          .catch((reason: unknown) => {
            if (!abort.signal.aborted && mounted.current) {
              setError(reason instanceof Error ? reason.message : String(reason))
            }
          })
          .finally(() => { pending = '' })
      }, VIEWPORT_RESIZE_DEBOUNCE_MS)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    resize()
    return () => {
      abort.abort()
      observer.disconnect()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [clientId, leaseOwned, rpc, screen?.activePageId])

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
    <section
      className="dbu-panel"
      aria-label="Persistent browser"
      data-conversation-composer-overlay=""
    >
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
      </div>
      <div ref={viewportRef} className="dbu-viewport-wrap">
        {screen === undefined
          ? <div className="dbu-empty">Starting persistent Chromium…</div>
          : activeTab(screen)?.url === 'about:blank'
            ? (
              <div className="dbu-empty">
                <strong>Browser ready</strong>
                <span>Enter a URL above to start browsing.</span>
              </div>
            )
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

export const inject = ['connection', 'slots']

export function apply(ctx: Context): void {
  const rpc: RpcClient = {
    async call<T>(endpoint: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
      const result = await ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal)
      if (!result.ok) throw new Error(result.error.message)
      return result.value as T
    },
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = '@syncended/dsh-browser-use'
    style.dataset.pluginCss = STYLE_ID
    style.textContent = styles
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'browser-use: styles')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'browser',
    order: 20,
    label: 'Browser',
    inject: (): PanelInjected => ({ rpc }),
  }, BrowserPanel))
}
