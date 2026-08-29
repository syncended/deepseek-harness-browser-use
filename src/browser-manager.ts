import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { chromium, type BrowserContext, type ElementHandle, type Page } from 'playwright-core'
import lockfile from 'proper-lockfile'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  BrowserActionView,
  BrowserScreenView,
  BrowserSnapshotView,
  BrowserStateView,
  BrowserTabView,
  BrowserUseConfig,
} from './protocol.js'

const MIN_VIEWPORT_WIDTH = 640
const MAX_VIEWPORT_WIDTH = 1920
const MIN_VIEWPORT_HEIGHT = 400
const MAX_VIEWPORT_HEIGHT = 1200

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[role]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const DEFAULT_CONFIG = Object.freeze({
  profile: 'default',
  headless: true,
  noSandbox: false,
  viewportWidth: 1280,
  viewportHeight: 800,
  screenshotQuality: 70,
  operationTimeoutMs: 20_000,
  humanLeaseTtlMs: 15_000,
})

interface ResolvedBrowserUseConfig {
  profile: string
  headless: boolean
  executablePath?: string
  noSandbox: boolean
  viewportWidth: number
  viewportHeight: number
  screenshotQuality: number
  operationTimeoutMs: number
  humanLeaseTtlMs: number
}

interface PersistedTabs {
  version: 1
  activeUrl?: string
  urls: string[]
}

interface SnapshotEntry {
  pageId: string
  handle: ElementHandle<Element>
}

export type BrowserActor =
  | { kind: 'agent' }
  | { kind: 'human'; clientId: string }

export interface BrowserScreenshot {
  data: Buffer
  width: number
  height: number
  page: BrowserActionView
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${name} must be a positive integer`)
  return resolved
}

function resolveConfig(config: BrowserUseConfig): ResolvedBrowserUseConfig {
  const profile = config.profile?.trim() || DEFAULT_CONFIG.profile
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(profile)) {
    throw new Error('browser profile must contain only letters, digits, dots, underscores, and hyphens')
  }
  const screenshotQuality = positiveInteger(
    config.screenshotQuality,
    DEFAULT_CONFIG.screenshotQuality,
    'screenshotQuality',
  )
  if (screenshotQuality > 100) throw new Error('screenshotQuality must not exceed 100')
  return {
    profile,
    headless: config.headless ?? DEFAULT_CONFIG.headless,
    ...(config.executablePath?.trim() ? { executablePath: config.executablePath.trim() } : {}),
    noSandbox: config.noSandbox ?? DEFAULT_CONFIG.noSandbox,
    viewportWidth: positiveInteger(config.viewportWidth, DEFAULT_CONFIG.viewportWidth, 'viewportWidth'),
    viewportHeight: positiveInteger(config.viewportHeight, DEFAULT_CONFIG.viewportHeight, 'viewportHeight'),
    screenshotQuality,
    operationTimeoutMs: positiveInteger(
      config.operationTimeoutMs,
      DEFAULT_CONFIG.operationTimeoutMs,
      'operationTimeoutMs',
    ),
    humanLeaseTtlMs: positiveInteger(
      config.humanLeaseTtlMs,
      DEFAULT_CONFIG.humanLeaseTtlMs,
      'humanLeaseTtlMs',
    ),
  }
}

function signalError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('browser operation aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signalError(signal)
}

function normalizeUrl(raw: string): string {
  const value = raw.trim()
  if (value.length === 0) throw new Error('url must be a non-empty string')
  if (value === 'about:blank') return value
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('browser navigation only accepts http:// and https:// URLs')
  }
  return url.toString()
}

function compact(value: string | null | undefined, limit = 160): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

export class BrowserManager {
  readonly config: ResolvedBrowserUseConfig
  readonly profileDir: string
  readonly userDataDir: string
  readonly downloadsDir: string

  #context: BrowserContext | undefined
  #startPromise: Promise<BrowserContext> | undefined
  #closePromise: Promise<void> | undefined
  #closing = false
  #closed = false
  #releaseProfileLock: (() => Promise<void>) | undefined
  #statePath: string
  #stateTimer: NodeJS.Timeout | undefined
  #stateWriteTail: Promise<void> = Promise.resolve()
  #pages = new Map<string, Page>()
  #pageIds = new WeakMap<Page, string>()
  #activePageId: string | undefined
  #snapshotId: string | undefined
  #snapshotEntries = new Map<string, SnapshotEntry>()
  #pageGeneration = 0
  #operationTail: Promise<void> = Promise.resolve()
  #humanLease: { clientId: string; expiresAt: number } | undefined

  constructor(config: BrowserUseConfig = {}) {
    this.config = resolveConfig(config)
    this.profileDir = dshHomePath('browser-use', 'profiles', this.config.profile)
    this.userDataDir = join(this.profileDir, 'user-data')
    this.downloadsDir = join(this.profileDir, 'downloads')
    this.#statePath = join(this.profileDir, 'tabs.json')
  }

  get running(): boolean {
    return this.#context !== undefined
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise
    this.#closing = true
    const pendingOperations = this.#operationTail
    this.#closePromise = (async () => {
      let firstError: unknown
      await pendingOperations.catch(error => { firstError ??= error })
      if (this.#stateTimer !== undefined) {
        clearTimeout(this.#stateTimer)
        this.#stateTimer = undefined
      }
      if (this.#context !== undefined) {
        await this.#queueStateWrite().catch(error => { firstError ??= error })
      }
      await this.#stateWriteTail.catch(error => { firstError ??= error })
      await this.#disposeSnapshot().catch(error => { firstError ??= error })
      const context = this.#context
      try {
        await context?.close()
      } catch (error: unknown) {
        firstError ??= error
      } finally {
        this.#context = undefined
        this.#startPromise = undefined
        this.#pages.clear()
        this.#activePageId = undefined
        await this.#releaseLock().catch(error => { firstError ??= error })
        this.#closed = true
      }
      if (firstError !== undefined) throw firstError
    })()
    return this.#closePromise
  }

  async state(start = false): Promise<BrowserStateView> {
    if (start) await this.#ensureContext()
    this.#expireLease()
    if (this.#context === undefined) {
      return { running: false, control: this.#humanLease === undefined ? 'agent' : 'human', tabs: [] }
    }
    const tabs: BrowserTabView[] = []
    for (const [id, page] of this.#pages) {
      if (page.isClosed()) continue
      tabs.push({
        id,
        title: await this.#safeTitle(page),
        url: page.url(),
        active: id === this.#activePageId,
      })
    }
    return {
      running: true,
      control: this.#humanLease === undefined ? 'agent' : 'human',
      ...(this.#activePageId === undefined ? {} : { activePageId: this.#activePageId }),
      tabs,
    }
  }

  acquireHumanControl(clientId: string): Promise<{ acquired: boolean; owner: boolean }> {
    return this.#exclusive(async () => {
      this.#expireLease()
      if (clientId.trim().length === 0) throw new Error('clientId must be a non-empty string')
      if (this.#humanLease !== undefined && this.#humanLease.clientId !== clientId) {
        return { acquired: false, owner: false }
      }
      this.#humanLease = { clientId, expiresAt: Date.now() + this.config.humanLeaseTtlMs }
      await this.#invalidateSnapshot()
      return { acquired: true, owner: true }
    })
  }

  releaseHumanControl(clientId: string): Promise<void> {
    return this.#exclusive(async () => {
      if (this.#humanLease?.clientId === clientId) this.#humanLease = undefined
    })
  }

  async screen(clientId: string, signal?: AbortSignal): Promise<BrowserScreenView> {
    return this.#exclusive(async () => {
      this.#touchLease(clientId)
      throwIfAborted(signal)
      const screenshot = await this.#captureScreenshot(signal)
      const state = await this.state(true)
      return {
        ...state,
        image: screenshot.data.toString('base64'),
        mediaType: 'image/jpeg',
        width: screenshot.width,
        height: screenshot.height,
      }
    })
  }

  async captureForAgent(signal?: AbortSignal): Promise<BrowserScreenshot> {
    return this.#exclusive(async () => this.#captureScreenshot(signal))
  }

  async navigate(rawUrl: string, actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = await this.#activePage()
      throwIfAborted(signal)
      await page.goto(normalizeUrl(rawUrl), { waitUntil: 'domcontentloaded', timeout: this.config.operationTimeoutMs })
      throwIfAborted(signal)
      await this.#invalidateSnapshot()
      this.#scheduleStateWrite()
      return this.#actionView(page)
    })
  }

  async goBack(actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#historyAction('back', actor, signal)
  }

  async goForward(actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#historyAction('forward', actor, signal)
  }

  async reload(actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = await this.#activePage()
      throwIfAborted(signal)
      await page.reload({ waitUntil: 'domcontentloaded', timeout: this.config.operationTimeoutMs })
      throwIfAborted(signal)
      await this.#invalidateSnapshot()
      return this.#actionView(page)
    })
  }

  async newTab(url: string | undefined, actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const context = await this.#ensureContext()
      throwIfAborted(signal)
      const page = await context.newPage()
      const pageId = this.#registerPage(page)
      this.#activePageId = pageId
      try {
        if (url?.trim()) {
          await page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: this.config.operationTimeoutMs })
        }
        throwIfAborted(signal)
        this.#scheduleStateWrite()
        return await this.#actionView(page)
      } catch (error: unknown) {
        await page.close().catch(() => undefined)
        throw error
      }
    })
  }

  async selectTab(pageId: string, actor: BrowserActor): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = this.#requirePage(pageId)
      this.#activePageId = pageId
      await page.bringToFront()
      await this.#invalidateSnapshot()
      this.#scheduleStateWrite()
      return this.#actionView(page)
    })
  }

  async closeTab(pageId: string | undefined, actor: BrowserActor): Promise<BrowserStateView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      await this.#ensureContext()
      const targetId = pageId ?? this.#activePageId
      if (targetId === undefined) throw new Error('no active browser tab')
      const page = this.#requirePage(targetId)
      await page.close()
      this.#pages.delete(targetId)
      if (this.#activePageId === targetId) this.#activePageId = this.#firstOpenPageId()
      if (this.#activePageId === undefined) {
        const context = await this.#ensureContext()
        const replacement = await context.newPage()
        this.#activePageId = this.#registerPage(replacement)
      }
      await this.#invalidateSnapshot()
      this.#scheduleStateWrite()
      return this.state(true)
    })
  }

  async snapshot(signal?: AbortSignal): Promise<BrowserSnapshotView> {
    return this.#exclusive(async () => {
      const page = await this.#activePage()
      throwIfAborted(signal)
      await this.#disposeSnapshot()
      const generation = this.#pageGeneration
      const snapshotId = randomUUID()
      const pageId = this.#pageId(page)
      const rows: string[] = []
      const nextEntries = new Map<string, SnapshotEntry>()
      try {
        const locator = page.locator(INTERACTIVE_SELECTOR)
        const count = Math.min(await locator.count(), 200)
        let refNumber = 0
        for (let index = 0; index < count; index += 1) {
          throwIfAborted(signal)
          const handle = await locator.nth(index).elementHandle()
          if (handle === null) continue
          const box = await handle.boundingBox().catch(() => null)
          if (box === null || box.width < 1 || box.height < 1) {
            await handle.dispose()
            continue
          }
          const details = await handle.evaluate((node) => {
            const element = node as HTMLElement
            const input = element instanceof HTMLInputElement ? element : undefined
            const textArea = element instanceof HTMLTextAreaElement ? element : undefined
            const tag = element.tagName.toLowerCase()
            const type = input?.type?.toLowerCase()
            const autocomplete = input?.autocomplete?.toLowerCase() ?? ''
            const role = element.getAttribute('role') || (
              tag === 'a' ? 'link'
                : tag === 'button' ? 'button'
                  : tag === 'select' ? 'combobox'
                    : tag === 'textarea' ? 'textbox'
                      : tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'textbox')
                        : tag
            )
            const name = element.getAttribute('aria-label')
              || element.getAttribute('title')
              || input?.placeholder
              || textArea?.placeholder
              || element.innerText
              || element.textContent
              || ''
            const sensitive = type === 'password'
              || ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].includes(autocomplete)
            return {
              role,
              name,
              href: element instanceof HTMLAnchorElement ? element.href : undefined,
              disabled: 'disabled' in element && Boolean((element as HTMLButtonElement).disabled),
              sensitive,
            }
          }).catch(() => null)
          if (details === null) {
            await handle.dispose()
            continue
          }
          refNumber += 1
          const ref = `e${String(refNumber)}`
          nextEntries.set(ref, { pageId, handle })
          const parts = [`[${ref}]`, details.role]
          const name = compact(details.name)
          if (name) parts.push(JSON.stringify(name))
          if (details.href) parts.push(`href=${JSON.stringify(compact(details.href, 200))}`)
          if (details.disabled) parts.push('disabled')
          if (details.sensitive) parts.push('sensitive')
          rows.push(parts.join(' '))
        }
        throwIfAborted(signal)
        if (generation !== this.#pageGeneration || page.isClosed()) {
          throw new Error('page changed while creating the browser snapshot; retry browser_snapshot')
        }
        this.#snapshotEntries = nextEntries
        this.#snapshotId = snapshotId
        const title = await this.#safeTitle(page)
        return {
          snapshotId,
          pageId,
          url: page.url(),
          title,
          content: rows.length === 0 ? '(no visible interactive elements)' : rows.join('\n'),
        }
      } catch (error: unknown) {
        await Promise.all([...nextEntries.values()].map(entry => entry.handle.dispose().catch(() => undefined)))
        throw error
      }
    })
  }

  async click(snapshotId: string, ref: string, actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const { handle, page } = this.#resolveSnapshotEntry(snapshotId, ref)
      try {
        throwIfAborted(signal)
        await handle.click({ timeout: this.config.operationTimeoutMs })
        throwIfAborted(signal)
        this.#activePageId = this.#pageId(page)
        return await this.#actionView(page)
      } finally {
        await this.#invalidateSnapshot()
      }
    })
  }

  async type(
    snapshotId: string,
    ref: string,
    text: string,
    actor: BrowserActor,
    signal?: AbortSignal,
  ): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const { handle, page } = this.#resolveSnapshotEntry(snapshotId, ref)
      try {
        if (actor.kind === 'agent' && await this.#isSensitiveElement(handle)) {
          throw new Error('agents cannot type into sensitive fields; ask the user to take control in the Browser panel')
        }
        throwIfAborted(signal)
        await handle.fill(text, { timeout: this.config.operationTimeoutMs })
        throwIfAborted(signal)
        return await this.#actionView(page)
      } finally {
        await this.#invalidateSnapshot()
      }
    })
  }

  async press(key: string, actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = await this.#activePage()
      try {
        if (key.trim().length === 0) throw new Error('key must be a non-empty Playwright key name')
        if (actor.kind === 'agent') await this.#assertAgentKeyboardSafe(page, key)
        throwIfAborted(signal)
        await page.keyboard.press(key)
        throwIfAborted(signal)
        return await this.#actionView(page)
      } finally {
        await this.#invalidateSnapshot()
      }
    })
  }

  async scroll(deltaX: number, deltaY: number, actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = await this.#activePage()
      try {
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('scroll deltas must be finite numbers')
        throwIfAborted(signal)
        await page.mouse.wheel(deltaX, deltaY)
        throwIfAborted(signal)
        return await this.#actionView(page)
      } finally {
        await this.#invalidateSnapshot()
      }
    })
  }

  async humanResize(
    clientId: string,
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<BrowserActionView> {
    const actor = { kind: 'human', clientId } as const
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      if (!Number.isSafeInteger(width) || width < MIN_VIEWPORT_WIDTH || width > MAX_VIEWPORT_WIDTH) {
        throw new Error(`viewport width must be an integer from ${String(MIN_VIEWPORT_WIDTH)} to ${String(MAX_VIEWPORT_WIDTH)}`)
      }
      if (!Number.isSafeInteger(height) || height < MIN_VIEWPORT_HEIGHT || height > MAX_VIEWPORT_HEIGHT) {
        throw new Error(`viewport height must be an integer from ${String(MIN_VIEWPORT_HEIGHT)} to ${String(MAX_VIEWPORT_HEIGHT)}`)
      }
      const page = await this.#activePage()
      throwIfAborted(signal)
      await page.setViewportSize({ width, height })
      throwIfAborted(signal)
      await this.#invalidateSnapshot()
      return this.#actionView(page)
    })
  }

  async humanClick(clientId: string, x: number, y: number, signal?: AbortSignal): Promise<BrowserActionView> {
    const actor = { kind: 'human', clientId } as const
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = await this.#activePage()
      try {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('pointer coordinates must be finite numbers')
        throwIfAborted(signal)
        await page.mouse.click(x, y)
        throwIfAborted(signal)
        return await this.#actionView(page)
      } finally {
        await this.#invalidateSnapshot()
      }
    })
  }

  async humanKey(clientId: string, key: string, text: string | undefined, signal?: AbortSignal): Promise<BrowserActionView> {
    const actor = { kind: 'human', clientId } as const
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = await this.#activePage()
      try {
        throwIfAborted(signal)
        if (text !== undefined) await page.keyboard.insertText(text)
        else await page.keyboard.press(key)
        throwIfAborted(signal)
        return await this.#actionView(page)
      } finally {
        await this.#invalidateSnapshot()
      }
    })
  }

  async #isSensitiveElement(handle: ElementHandle<Element>): Promise<boolean> {
    return handle.evaluate((node) => {
      if (!(node instanceof HTMLInputElement)) return false
      const autocomplete = node.autocomplete.toLowerCase()
      return node.type.toLowerCase() === 'password'
        || ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].includes(autocomplete)
    })
  }

  async #assertAgentKeyboardSafe(page: Page, key: string): Promise<void> {
    if (key === 'Tab' || key === 'Escape' || key.startsWith('Shift+Tab')) return
    const sensitive = await page.evaluate(() => {
      const node = document.activeElement
      if (!(node instanceof HTMLInputElement)) return false
      const autocomplete = node.autocomplete.toLowerCase()
      return node.type.toLowerCase() === 'password'
        || ['current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc'].includes(autocomplete)
    })
    if (sensitive) {
      throw new Error('agents cannot type into sensitive fields; ask the user to take control in the Browser panel')
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#closed) return Promise.reject(new Error('browser is shutting down'))
    const result = this.#operationTail.then(operation, operation)
    this.#operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  async #ensureContext(): Promise<BrowserContext> {
    if (this.#context !== undefined) return this.#context
    if (this.#startPromise !== undefined) return this.#startPromise
    if (this.#closing) throw new Error('browser is shutting down')
    this.#startPromise = this.#start()
    try {
      return await this.#startPromise
    } catch (error) {
      this.#startPromise = undefined
      await this.#releaseLock()
      throw error
    }
  }

  async #start(): Promise<BrowserContext> {
    await mkdir(this.userDataDir, { recursive: true, mode: 0o700 })
    await mkdir(this.downloadsDir, { recursive: true, mode: 0o700 })
    await this.#acquireLock()
    let context: BrowserContext | undefined
    try {
      const executablePath = await this.#resolveExecutable()
      context = await chromium.launchPersistentContext(this.userDataDir, {
        headless: this.config.headless,
        executablePath,
        acceptDownloads: true,
        downloadsPath: this.downloadsDir,
        viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
        args: [
          '--disable-dev-shm-usage',
          ...(this.config.noSandbox ? ['--no-sandbox'] : []),
        ],
      })
      context.setDefaultTimeout(this.config.operationTimeoutMs)
      context.on('page', (page) => {
        this.#activePageId = this.#registerPage(page)
        this.#pageGeneration += 1
        this.#clearSnapshotDetached()
      })
      context.on('close', () => {
        if (this.#context !== context) return
        this.#context = undefined
        this.#startPromise = undefined
        this.#pages.clear()
        this.#activePageId = undefined
        this.#clearSnapshotDetached()
        void this.#releaseLock()
      })
      for (const page of context.pages()) this.#registerPage(page)
      await this.#restoreTabs(context)
      if (this.#activePageId === undefined) {
        const page = context.pages()[0] ?? await context.newPage()
        this.#activePageId = this.#registerPage(page)
      }
      this.#context = context
      return context
    } catch (error: unknown) {
      await context?.close().catch(() => undefined)
      this.#pages.clear()
      this.#activePageId = undefined
      this.#clearSnapshotDetached()
      throw error
    }
  }

  #registerPage(page: Page): string {
    const existing = this.#pageIds.get(page)
    if (existing !== undefined) return existing
    const id = randomUUID()
    this.#pageIds.set(page, id)
    this.#pages.set(id, page)
    page.setDefaultTimeout(this.config.operationTimeoutMs)
    page.on('close', () => {
      this.#pages.delete(id)
      if (this.#activePageId === id) this.#activePageId = this.#firstOpenPageId()
      this.#pageGeneration += 1
      this.#clearSnapshotDetached()
      this.#scheduleStateWrite()
    })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.#pageGeneration += 1
        this.#clearSnapshotDetached()
        this.#scheduleStateWrite()
      }
    })
    if (this.#activePageId === undefined) this.#activePageId = id
    this.#scheduleStateWrite()
    return id
  }

  async #restoreTabs(context: BrowserContext): Promise<void> {
    let state: PersistedTabs | undefined
    try {
      const value = JSON.parse(await readFile(this.#statePath, 'utf8')) as Partial<PersistedTabs>
      if (value.version === 1 && Array.isArray(value.urls) && value.urls.every(url => typeof url === 'string')) {
        state = { version: 1, urls: value.urls, ...(typeof value.activeUrl === 'string' ? { activeUrl: value.activeUrl } : {}) }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (state === undefined || state.urls.length === 0) return
    const restorable = state.urls.filter(url => url === 'about:blank' || /^https?:\/\//i.test(url))
    if (restorable.length === 0) return
    const existing = context.pages()[0] ?? await context.newPage()
    const pages = [existing]
    for (let index = 1; index < restorable.length; index += 1) pages.push(await context.newPage())
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      const url = restorable[index]
      if (page === undefined || url === undefined || url === 'about:blank') continue
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.operationTimeoutMs }).catch(() => undefined)
    }
    const activeIndex = state.activeUrl === undefined ? 0 : Math.max(0, restorable.indexOf(state.activeUrl))
    const active = pages[activeIndex] ?? pages[0]
    if (active !== undefined) {
      this.#activePageId = this.#registerPage(active)
      await active.bringToFront()
    }
  }

  async #activePage(): Promise<Page> {
    const context = await this.#ensureContext()
    if (this.#activePageId !== undefined) {
      const active = this.#pages.get(this.#activePageId)
      if (active !== undefined && !active.isClosed()) return active
    }
    const existing = context.pages().find(page => !page.isClosed()) ?? await context.newPage()
    this.#activePageId = this.#registerPage(existing)
    return existing
  }

  #requirePage(pageId: string): Page {
    const page = this.#pages.get(pageId)
    if (page === undefined || page.isClosed()) throw new Error(`browser tab not found: ${pageId}`)
    return page
  }

  #pageId(page: Page): string {
    return this.#pageIds.get(page) ?? this.#registerPage(page)
  }

  #firstOpenPageId(): string | undefined {
    for (const [id, page] of this.#pages) if (!page.isClosed()) return id
    return undefined
  }

  async #safeTitle(page: Page): Promise<string> {
    return compact(await page.title().catch(() => ''), 120) || 'Untitled'
  }

  async #actionView(page: Page): Promise<BrowserActionView> {
    return { pageId: this.#pageId(page), url: page.url(), title: await this.#safeTitle(page) }
  }

  async #historyAction(direction: 'back' | 'forward', actor: BrowserActor, signal?: AbortSignal): Promise<BrowserActionView> {
    return this.#exclusive(async () => {
      this.#assertControl(actor)
      const page = await this.#activePage()
      throwIfAborted(signal)
      if (direction === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: this.config.operationTimeoutMs })
      else await page.goForward({ waitUntil: 'domcontentloaded', timeout: this.config.operationTimeoutMs })
      throwIfAborted(signal)
      await this.#invalidateSnapshot()
      this.#scheduleStateWrite()
      return this.#actionView(page)
    })
  }

  async #captureScreenshot(signal?: AbortSignal): Promise<BrowserScreenshot> {
    const page = await this.#activePage()
    throwIfAborted(signal)
    const data = await page.screenshot({ type: 'jpeg', quality: this.config.screenshotQuality, fullPage: false })
    throwIfAborted(signal)
    const viewport = page.viewportSize() ?? {
      width: this.config.viewportWidth,
      height: this.config.viewportHeight,
    }
    return {
      data,
      width: viewport.width,
      height: viewport.height,
      page: await this.#actionView(page),
    }
  }

  #resolveSnapshotEntry(snapshotId: string, ref: string): SnapshotEntry & { page: Page } {
    if (snapshotId !== this.#snapshotId) throw new Error('stale browser snapshot; call browser_snapshot again')
    const entry = this.#snapshotEntries.get(ref)
    if (entry === undefined) throw new Error(`element ref not found in current browser snapshot: ${ref}`)
    return { ...entry, page: this.#requirePage(entry.pageId) }
  }

  async #invalidateSnapshot(): Promise<void> {
    if (this.#snapshotId === undefined && this.#snapshotEntries.size === 0) return
    await this.#disposeSnapshot()
  }

  #clearSnapshotDetached(): void {
    const handles = [...this.#snapshotEntries.values()].map(entry => entry.handle)
    this.#snapshotEntries.clear()
    this.#snapshotId = undefined
    void Promise.all(handles.map(handle => handle.dispose().catch(() => undefined)))
  }

  async #disposeSnapshot(): Promise<void> {
    const handles = [...this.#snapshotEntries.values()].map(entry => entry.handle)
    this.#snapshotEntries.clear()
    this.#snapshotId = undefined
    await Promise.all(handles.map(handle => handle.dispose().catch(() => undefined)))
  }

  #assertControl(actor: BrowserActor): void {
    this.#expireLease()
    if (actor.kind === 'human') {
      this.#touchLease(actor.clientId)
      return
    }
    if (this.#humanLease !== undefined) {
      throw new Error('human control is active in the Browser panel; wait until the user closes or releases it')
    }
  }

  #touchLease(clientId: string): void {
    this.#expireLease()
    if (this.#humanLease?.clientId !== clientId) throw new Error('this browser panel does not own human control')
    this.#humanLease.expiresAt = Date.now() + this.config.humanLeaseTtlMs
  }

  #expireLease(): void {
    if (this.#humanLease !== undefined && this.#humanLease.expiresAt <= Date.now()) this.#humanLease = undefined
  }

  #scheduleStateWrite(): void {
    if (this.#closing || this.#context === undefined) return
    if (this.#stateTimer !== undefined) clearTimeout(this.#stateTimer)
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined
      void this.#queueStateWrite().catch(() => undefined)
    }, 250)
  }

  #queueStateWrite(): Promise<void> {
    const write = this.#stateWriteTail.then(() => this.#writeState(), () => this.#writeState())
    this.#stateWriteTail = write
    return write
  }

  async #writeState(): Promise<void> {
    if (this.#context === undefined) return
    const urls = [...this.#pages.values()]
      .filter(page => !page.isClosed())
      .map(page => this.#restorableUrl(page.url()))
      .filter((url): url is string => url !== undefined)
    const activePageUrl = this.#activePageId === undefined ? undefined : this.#pages.get(this.#activePageId)?.url()
    const activeUrl = activePageUrl === undefined ? undefined : this.#restorableUrl(activePageUrl)
    const value: PersistedTabs = {
      version: 1,
      urls,
      ...(activeUrl === undefined ? {} : { activeUrl }),
    }
    const temporary = `${this.#statePath}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.#statePath)
  }

  #restorableUrl(raw: string): string | undefined {
    if (raw === 'about:blank') return raw
    try {
      const url = new URL(raw)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return undefined
    }
  }

  async #acquireLock(): Promise<void> {
    await mkdir(this.profileDir, { recursive: true, mode: 0o700 })
    if (this.#releaseProfileLock !== undefined) return
    try {
      this.#releaseProfileLock = await lockfile.lock(this.profileDir, {
        realpath: false,
        retries: 0,
        stale: 30_000,
        update: 10_000,
      })
    } catch (error: unknown) {
      throw new Error(`browser profile "${this.config.profile}" is already in use`, { cause: error })
    }
  }

  async #releaseLock(): Promise<void> {
    const release = this.#releaseProfileLock
    this.#releaseProfileLock = undefined
    await release?.()
  }

  async #resolveExecutable(): Promise<string> {
    const candidates = [
      this.config.executablePath,
      process.env.CHROME_PATH,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      chromium.executablePath(),
    ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // Try the next configured or conventional executable.
      }
    }
    throw new Error(
      'no Chromium executable found; set browser-use config executablePath or install Chromium/Google Chrome',
    )
  }
}
