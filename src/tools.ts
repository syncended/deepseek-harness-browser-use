import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { BrowserManager } from './browser-manager.js'

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pageId: { type: 'string', required: true },
    url: { type: 'string', required: true },
    title: { type: 'string', required: true },
  },
} as const

const TAB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    url: { type: 'string', required: true },
    active: { type: 'boolean', required: true },
  },
} as const

const STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    running: { type: 'boolean', required: true },
    control: { type: 'string', enum: ['agent', 'human'], required: true },
    activePageId: { type: 'string' },
    tabs: { type: 'array', items: TAB_SCHEMA, required: true },
  },
} as const

const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const satisfies readonly ImageMediaType[]

function screenshotName(mediaType: ImageMediaType): string {
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)
  return `browser-screenshot.${extension}`
}

function actionText(value: { title: string; url: string }): string {
  return `${value.title}\n${value.url}`
}

export function registerBrowserTools(ctx: Context, browser: BrowserManager): void {
  ctx.tools.register(defineTool({
    name: 'browser_status',
    description: 'Inspect the persistent browser process, control owner, open tabs, and active tab.',
    parameters: {},
    output: {
      schema: STATE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return browser.state(false)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List, create, select, or close tabs in the persistent browser. Login state is shared across tabs.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'new', 'select', 'close'],
        required: true,
        description: 'Tab operation to perform.',
      },
      pageId: { type: 'string', description: 'Tab id for select or close. Close defaults to the active tab.' },
      url: { type: 'string', description: 'Optional URL for a new tab.' },
    },
    output: {
      schema: STATE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(args, exec) {
      if (args.action === 'list') return browser.state(true)
      if (args.action === 'new') {
        await browser.newTab(args.url, { kind: 'agent' }, exec.signal)
        return browser.state(true)
      }
      if (args.action === 'select') {
        if (args.pageId === undefined) throw new Error('pageId is required when action is select')
        await browser.selectTab(args.pageId, { kind: 'agent' })
        return browser.state(true)
      }
      await browser.closeTab(args.pageId, { kind: 'agent' })
      return browser.state(true)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate the active persistent browser tab to an HTTP or HTTPS URL and wait for DOM content.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL or hostname to open.' },
    },
    output: {
      schema: ACTION_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: actionText(value) }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(args, exec) {
      return browser.navigate(args.url, { kind: 'agent' }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Return visible interactive elements from the active page with one-shot refs. Take a fresh snapshot after every click, type, press, or scroll action.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          snapshotId: { type: 'string', required: true },
          pageId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.title}\n${value.url}\nsnapshot=${value.snapshotId}\n\n${value.content}`,
      }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(_args, exec) {
      return browser.snapshot(exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click one element ref from the latest browser_snapshot.',
    parameters: {
      snapshotId: { type: 'string', required: true, description: 'Snapshot id returned by browser_snapshot.' },
      ref: { type: 'string', required: true, description: 'Element ref such as e1.' },
    },
    output: {
      schema: ACTION_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: actionText(value) }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(args, exec) {
      return browser.click(args.snapshotId, args.ref, { kind: 'agent' }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Replace the value of a text field from the latest browser_snapshot. Password, payment, and one-time-code fields require human control.',
    parameters: {
      snapshotId: { type: 'string', required: true, description: 'Snapshot id returned by browser_snapshot.' },
      ref: { type: 'string', required: true, description: 'Editable element ref such as e3.' },
      text: { type: 'string', required: true, description: 'Complete replacement value.' },
    },
    output: {
      schema: ACTION_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: actionText(value) }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(args, exec) {
      return browser.type(args.snapshotId, args.ref, args.text, { kind: 'agent' }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: 'Press a Playwright key or shortcut in the active page, for example Enter, Escape, Tab, or Control+L.',
    parameters: {
      key: { type: 'string', required: true, description: 'Playwright key name or shortcut.' },
    },
    output: {
      schema: ACTION_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: actionText(value) }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(args, exec) {
      return browser.press(args.key, { kind: 'agent' }, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the active browser page by pixel deltas.',
    parameters: {
      deltaX: { type: 'number', description: 'Horizontal pixel delta. Defaults to 0.' },
      deltaY: { type: 'number', required: true, description: 'Vertical pixel delta; positive scrolls down.' },
    },
    output: {
      schema: ACTION_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: actionText(value) }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(args, exec) {
      return browser.scroll(args.deltaX ?? 0, args.deltaY, { kind: 'agent' }, exec.signal)
    },
  }))
}

export function registerBrowserScreenshotTool(ctx: Context, browser: BrowserManager): void {
  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture the active browser viewport and return it as an image. Requires an image-capable model.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pageId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', enum: IMAGE_MEDIA_TYPES, required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.title}\n${value.url}\n${value.width}x${value.height} screenshot`,
      }, {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(value.attachmentId),
          mediaType: value.mediaType,
          bytes: value.bytes,
          width: value.width,
          height: value.height,
          name: value.name,
        },
      }],
    },
    timeoutMs: browser.config.operationTimeoutMs + 5_000,
    async execute(_args, exec) {
      const routed = exec.agent?.session.requestHeader()?.config
      const provider = routed?.provider ?? exec.agent?.options.provider
      const model = routed?.model ?? exec.agent?.options.model
      const llm = ctx.get('llm')
      if (provider === undefined || model === undefined || llm === undefined) {
        throw new Error('cannot capture a browser screenshot: the current model route could not be resolved')
      }
      const active = await llm.resolveModelInfo(provider, model, exec.signal)
      if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
        throw new Error(`cannot capture a browser screenshot: model "${model}" does not declare image input`)
      }
      const screenshot = await browser.captureForAgent(exec.signal)
      const ref = await ctx.attachments.saveImage({
        data: screenshot.data,
        mediaType: 'image/jpeg',
      })
      return {
        ...screenshot.page,
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        name: screenshotName(ref.mediaType),
      }
    },
  }))
}
