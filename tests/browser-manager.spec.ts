import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BrowserManager } from '../src/browser-manager.js'

let root: string
let server: Server
let origin: string

const page = `<!doctype html>
<html>
  <head><title>Browser Use Test</title></head>
  <body>
    <label>Name <input aria-label="Name" value="initial"></label>
    <label>Password <input aria-label="Password" type="password"></label>
    <button type="button" onclick="location.hash='clicked'">Continue</button>
  </body>
</html>`

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-use-'))
  process.env.DSH_HOME = root
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  origin = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(root, { recursive: true, force: true })
})

describe('BrowserManager', () => {
  it('navigates, snapshots, acts, screenshots, and enforces human control', async () => {
    const browser = new BrowserManager({
      profile: 'integration',
      headless: true,
      operationTimeoutMs: 10_000,
      humanLeaseTtlMs: 5_000,
    })
    try {
      const navigated = await browser.navigate(origin, { kind: 'agent' })
      expect(navigated.title).toBe('Browser Use Test')

      const snapshot = await browser.snapshot()
      const nameRef = snapshot.content.match(/\[(e\d+)] textbox "Name"/)?.[1]
      const passwordRef = snapshot.content.match(/\[(e\d+)] textbox "Password"[^\n]*sensitive/)?.[1]
      const buttonRef = snapshot.content.match(/\[(e\d+)] button "Continue"/)?.[1]
      expect(nameRef).toBeDefined()
      expect(passwordRef).toBeDefined()
      expect(buttonRef).toBeDefined()

      await browser.type(snapshot.snapshotId, nameRef!, 'updated', { kind: 'agent' })

      const passwordSnapshot = await browser.snapshot()
      const nextPasswordRef = passwordSnapshot.content.match(/\[(e\d+)] textbox "Password"[^\n]*sensitive/)?.[1]
      expect(nextPasswordRef).toBeDefined()
      await expect(browser.type(passwordSnapshot.snapshotId, nextPasswordRef!, 'secret', { kind: 'agent' }))
        .rejects.toThrow(/sensitive fields/)

      const focusSnapshot = await browser.snapshot()
      const focusPasswordRef = focusSnapshot.content.match(/\[(e\d+)] textbox "Password"[^\n]*sensitive/)?.[1]
      await browser.click(focusSnapshot.snapshotId, focusPasswordRef!, { kind: 'agent' })
      await expect(browser.press('s', { kind: 'agent' })).rejects.toThrow(/sensitive fields/)

      const clickSnapshot = await browser.snapshot()
      const nextButtonRef = clickSnapshot.content.match(/\[(e\d+)] button "Continue"/)?.[1]
      const clicked = await browser.click(clickSnapshot.snapshotId, nextButtonRef!, { kind: 'agent' })
      expect(clicked.url).toContain('#clicked')

      const screenshot = await browser.captureForAgent()
      expect(screenshot.data.byteLength).toBeGreaterThan(1_000)
      expect(screenshot.width).toBe(1280)
      expect(screenshot.height).toBe(800)

      await expect(browser.acquireHumanControl('client-a')).resolves.toEqual({ acquired: true, owner: true })
      await expect(browser.navigate(origin, { kind: 'agent' })).rejects.toThrow(/human control/)
      await browser.humanClick('client-a', 20, 20)
      await expect(browser.acquireHumanControl('client-b')).resolves.toEqual({ acquired: false, owner: false })
      await browser.releaseHumanControl('client-a')
      await expect(browser.navigate(origin, { kind: 'agent' })).resolves.toMatchObject({ url: `${origin}/` })
    } finally {
      await browser.close()
    }
  })

  it('restores tabs from the durable browser profile', async () => {
    const first = new BrowserManager({ profile: 'persistence', headless: true, operationTimeoutMs: 10_000 })
    await first.navigate(`${origin}/persisted?token=secret#fragment`, { kind: 'agent' })
    await first.close()

    const second = new BrowserManager({ profile: 'persistence', headless: true, operationTimeoutMs: 10_000 })
    try {
      const state = await second.state(true)
      expect(state.running).toBe(true)
      expect(state.tabs.some(tab => tab.url === `${origin}/persisted`)).toBe(true)
    } finally {
      await second.close()
    }
  })

  it('keeps a live profile lock after failed contenders', async () => {
    const owner = new BrowserManager({ profile: 'locking', headless: true, operationTimeoutMs: 10_000 })
    const contender = new BrowserManager({ profile: 'locking', headless: true, operationTimeoutMs: 10_000 })
    const third = new BrowserManager({ profile: 'locking', headless: true, operationTimeoutMs: 10_000 })
    try {
      await owner.state(true)
      await expect(contender.state(true)).rejects.toThrow(/already in use/)
      await expect(third.state(true)).rejects.toThrow(/already in use/)
      await owner.close()
      await expect(third.state(true)).resolves.toMatchObject({ running: true })
    } finally {
      await owner.close().catch(() => undefined)
      await contender.close().catch(() => undefined)
      await third.close().catch(() => undefined)
    }
  })

  it('rejects invalid profile names before touching disk', () => {
    expect(() => new BrowserManager({ profile: '../escape' })).toThrow(/browser profile/)
  })
})
