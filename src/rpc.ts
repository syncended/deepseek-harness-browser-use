import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { BrowserManager, type BrowserActor } from './browser-manager.js'
import type { BrowserRpcEndpoint } from './protocol.js'

function record(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('browser-use RPC payload must be an object')
  }
  return payload as Record<string, unknown>
}

function stringField(payload: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = payload[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || (required && value.trim().length === 0)) {
    throw new Error(`${key} must be ${required ? 'a non-empty' : 'a'} string`)
  }
  return value
}

function numberField(payload: Record<string, unknown>, key: string, required = true): number | undefined {
  const value = payload[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
  return value
}

function humanActor(payload: Record<string, unknown>): BrowserActor {
  return { kind: 'human', clientId: stringField(payload, 'clientId')! }
}

function failure(error: unknown) {
  return {
    ok: false as const,
    error: {
      code: 'internal' as const,
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

export function registerBrowserRpc(ctx: Context, browser: BrowserManager): void {
  ctx.connection.rpc.handle('/browser-use', async (rawEndpoint, rawPayload, signal) => {
    try {
      const endpoint = rawEndpoint as BrowserRpcEndpoint
      const payload = record(rawPayload)
      switch (endpoint) {
        case 'state':
          return { ok: true, value: await browser.state(false) }
        case 'lease/acquire':
          return { ok: true, value: await browser.acquireHumanControl(stringField(payload, 'clientId')!) }
        case 'lease/release':
          await browser.releaseHumanControl(stringField(payload, 'clientId')!)
          return { ok: true, value: { released: true } }
        case 'screen':
          return { ok: true, value: await browser.screen(stringField(payload, 'clientId')!, signal) }
        case 'navigate':
          return {
            ok: true,
            value: await browser.navigate(stringField(payload, 'url')!, humanActor(payload), signal),
          }
        case 'back':
          return { ok: true, value: await browser.goBack(humanActor(payload), signal) }
        case 'forward':
          return { ok: true, value: await browser.goForward(humanActor(payload), signal) }
        case 'reload':
          return { ok: true, value: await browser.reload(humanActor(payload), signal) }
        case 'tabs/new':
          return {
            ok: true,
            value: await browser.newTab(stringField(payload, 'url', false), humanActor(payload), signal),
          }
        case 'tabs/select':
          return {
            ok: true,
            value: await browser.selectTab(stringField(payload, 'pageId')!, humanActor(payload)),
          }
        case 'tabs/close':
          return {
            ok: true,
            value: await browser.closeTab(stringField(payload, 'pageId', false), humanActor(payload)),
          }
        case 'pointer/click':
          return {
            ok: true,
            value: await browser.humanClick(
              stringField(payload, 'clientId')!,
              numberField(payload, 'x')!,
              numberField(payload, 'y')!,
              signal,
            ),
          }
        case 'wheel':
          return {
            ok: true,
            value: await browser.scroll(
              numberField(payload, 'deltaX', false) ?? 0,
              numberField(payload, 'deltaY')!,
              humanActor(payload),
              signal,
            ),
          }
        case 'key':
          return {
            ok: true,
            value: await browser.humanKey(
              stringField(payload, 'clientId')!,
              stringField(payload, 'key')!,
              stringField(payload, 'text', false),
              signal,
            ),
          }
        default:
          return {
            ok: false,
            error: {
              code: 'bad-request' as const,
              message: `unknown browser-use endpoint: ${rawEndpoint}`,
              details: { issues: [] },
            },
          }
      }
    } catch (error: unknown) {
      return failure(error)
    }
  }, { authority: 'loopback' })
}
