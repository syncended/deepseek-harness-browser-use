import { Context } from '@deepseek-ai/cordis'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserManager } from '../src/browser-manager.js'
import { registerBrowserRpc } from '../src/rpc.js'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('credentials', {
    modifyRecord: async (_key: unknown, update: (record: undefined) => Promise<unknown>) => update(undefined),
  } as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // Load the unmodified release: Connection injects credentials, not webServer.
  await ctx.plugin(Connection)
  ctx.webServer.register({
    kind: 'exact', path: '/',
    handler: (request, response) => {
      if (ctx.connection.authorizeIndex(request, response)) response.end('ok')
    },
  })
  const state = { running: false, control: 'agent', tabs: [] }
  const browser = {
    state: vi.fn(async () => state),
    navigate: vi.fn(async () => ({ pageId: 'page-1', url: 'https://example.test/', title: 'Example' })),
    screen: vi.fn(async () => state),
  }
  const plugin = {
    inject: ['connection'],
    apply: (scope: Context) => registerBrowserRpc(scope, browser as unknown as BrowserManager),
  }
  const fiber = await ctx.plugin(plugin)
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!
  const request = (endpoint: string, payload: unknown = {}, options: RequestInit = {}) => fetch(`${origin}/api/browser-use/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: `browser-use/${endpoint}`, payload }),
    ...options,
  })
  return { ctx, browser, state, fiber, plugin, origin, cookie, request }
}

describe('browser RPC on DSH 0.1.5-rc.2', () => {
  it('boots with the published Connection and returns a correlated RPC response', async () => {
    const { request, browser, state } = await fixture()
    const response = await request('state')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: 'server-response', rpcId: 'test-rpc', result: { ok: true, value: state } })
    expect(browser.state).toHaveBeenCalledWith(false)
  })

  it('uses the native authentication and Origin checks before invoking the browser', async () => {
    const { request, cookie, browser } = await fixture()
    expect((await request('state', {}, { headers: { 'content-type': 'application/json' } })).status).toBe(401)
    expect((await request('state', {}, {
      headers: { 'content-type': 'application/json', cookie, origin: 'https://untrusted.test' },
    })).status).toBe(403)
    expect(browser.state).not.toHaveBeenCalled()
  })

  it('validates the envelope and rejects a method that differs from the URL', async () => {
    const { request, cookie, browser } = await fixture()
    expect((await request('state', {}, { headers: { cookie, 'content-type': 'text/plain' } })).status).toBe(415)
    expect((await request('state', {}, { body: '{' })).status).toBe(400)
    expect((await request('state', {}, { body: '{}' })).status).toBe(400)
    const response = await request('state', {}, {
      body: JSON.stringify({ type: 'client-request', rpcId: 'mismatch', method: 'browser-use/navigate', payload: {} }),
    })
    expect(await response.json()).toMatchObject({ rpcId: 'mismatch', result: { ok: false, error: { code: 'gateway/bad-request' } } })
    expect(browser.state).not.toHaveBeenCalled()
    expect(browser.navigate).not.toHaveBeenCalled()
    expect((await request('unknown')).status).toBe(404)
    expect((await request('state', {}, { method: 'GET', body: undefined })).status).toBe(404)
  })

  it('forwards human ownership and returns browser failures in the RPC envelope', async () => {
    const { request, browser } = await fixture()
    expect((await request('navigate', { url: 'https://example.test/', clientId: 'client-1' })).status).toBe(200)
    expect(browser.navigate).toHaveBeenCalledWith('https://example.test/', { kind: 'human', clientId: 'client-1' }, expect.any(AbortSignal))
    browser.navigate.mockRejectedValueOnce(new Error('control belongs to another client'))
    const failed = await request('navigate', { url: 'https://example.test/', clientId: 'client-2' })
    expect(await failed.json()).toMatchObject({ result: { ok: false, error: { message: 'control belongs to another client' } } })
  })

  it('aborts a pending browser operation when its HTTP caller disconnects', async () => {
    const { request, browser } = await fixture()
    let operationSignal: AbortSignal | undefined
    browser.screen.mockImplementation((_clientId, signal) => {
      operationSignal = signal
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const abort = new AbortController()
    const pending = request('screen', { clientId: 'client-1' }, { signal: abort.signal }).catch(error => error)
    await vi.waitFor(() => expect(operationSignal).toBeDefined())
    abort.abort()
    await pending
    await vi.waitFor(() => expect(operationSignal?.aborted).toBe(true))
  })

  it('removes its routes on plugin disposal and can register them again', async () => {
    const { ctx, fiber, plugin, request } = await fixture()
    await fiber.dispose()
    expect((await request('state')).status).toBe(404)
    await ctx.plugin(plugin)
    expect((await request('state')).status).toBe(200)
  })
})
