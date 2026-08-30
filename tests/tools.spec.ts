import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { CallId, contentHasImage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekConnectionOptions, DeepSeekFileStore, WireRequest } from '@deepseek-ai/dsh-llm-deepseek'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { strFromU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserManager, BrowserScreenshot } from '../src/browser-manager.js'
import { registerBrowserScreenshotTool } from '../src/tools.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function attachmentStore(): Promise<LocalAttachmentStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-screenshot-'))
  temporaryRoots.push(root)
  return new LocalAttachmentStore(new Context(), {
    dshHome: root,
    normalizedImageMaxDimension: 16,
  })
}

async function jpegScreenshot(): Promise<BrowserScreenshot> {
  const data = await sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: '#ffffff',
    },
  }).jpeg().withMetadata().toBuffer()
  return {
    data,
    width: 32,
    height: 24,
    page: {
      pageId: 'page-1',
      url: 'https://example.test/',
      title: 'Screenshot test',
    },
  }
}

function screenshotTool(store: LocalAttachmentStore, screenshot: BrowserScreenshot): ToolDefinition {
  let registered: ToolDefinition | undefined
  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        registered = definition
        return () => undefined
      },
    },
    attachments: store,
    get(name: string) {
      if (name !== 'llm') return undefined
      return {
        async resolveModelInfo() {
          return { inputModalities: ['text', 'image'] }
        },
      }
    },
  } as unknown as Context
  const browser = {
    config: { operationTimeoutMs: 1_000 },
    async captureForAgent() {
      return screenshot
    },
  } as unknown as BrowserManager

  registerBrowserScreenshotTool(ctx, browser)
  if (registered === undefined) throw new Error('browser_screenshot was not registered')
  return registered
}

async function executeScreenshot(tool: ToolDefinition): Promise<{
  value: JsonValue
  content: ContentBlock[]
  ref: ImageAttachmentRef
}> {
  const value = await tool.execute({}, {
    signal: new AbortController().signal,
    agent: {
      options: { provider: 'test', model: 'vision' },
      session: {
        requestHeader: () => ({ config: { provider: 'test', model: 'vision' } }),
      },
    },
  } as unknown as ToolRunContext) as JsonValue
  const violations = validateJsonSchemaValue(tool.output.schema, value)
  expect(violations).toEqual([])

  const content = tool.output.render({}, value)
  const image = content.find(block => block.type === 'image')
  if (image?.type !== 'image') throw new Error('browser_screenshot did not render an image')
  return { value, content, ref: image.attachment }
}

function modelConnection(baseURL: string): DeepSeekConnectionOptions {
  return {
    baseURL,
    apiKeyEnv: 'TEST_API_KEY' as never,
    defaults: { thinking: 'disabled' },
    maxTokens: 128,
    defaultContextWindow: 10_000,
    models: [{
      id: 'vision',
      inputModalities: ['text', 'image'],
      imagePixelBudget: 1_000_000,
      imageMaxBytes: 1_000_000,
    }],
    streamIdleTimeoutMs: 10_000,
    maxRequestFilesBytes: 1_000_000,
    maxInlineRequestImageBytes: 1_000_000,
    maxImagesPerRequest: 20,
    imageOffloadByteQuantum: 1_000,
    inlineImageOffloadByteQuantum: 1_000,
    imageOffloadCountQuantum: 1,
    filesApiTimeoutMs: 10_000,
    filePolicy: {
      expiresAfterSeconds: 3_600,
      refreshMarginSeconds: 60,
      quotaCleanupBatch: 1,
    },
    retryPolicy: {} as never,
  }
}

describe('browser_screenshot attachments', () => {
  it('uses normalized AttachmentStore metadata and a matching filename', async () => {
    const store = await attachmentStore()
    const tool = screenshotTool(store, await jpegScreenshot())
    const { value, ref } = await executeScreenshot(tool)

    expect(value).toMatchObject({
      attachmentId: String(ref.attachmentId),
      mediaType: 'image/png',
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      name: 'browser-screenshot.png',
    })
    expect(ref.mediaType).toBe('image/png')
    expect(tool.output.schema).toMatchObject({
      properties: {
        mediaType: {
          type: 'string',
          enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        },
      },
    })
    expect(tool.output.render({}, value)[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(`${String(ref.width)}x${String(ref.height)} screenshot`),
    })
  })

  it('survives the complete tool-result to model-request path', async () => {
    let acceptRequest!: (body: WireRequest) => void
    const receivedRequest = new Promise<WireRequest>(resolve => { acceptRequest = resolve })
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      acceptRequest(JSON.parse(body) as WireRequest)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
        '',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('model test server did not bind')
      const store = await attachmentStore()
      const tool = screenshotTool(store, await jpegScreenshot())
      const { content, ref } = await executeScreenshot(tool)
      const toolResult = createToolResultMessage({
        callId: CallId('call-1'),
        content,
        isError: false,
      })
      expect(contentHasImage(toolResult.content)).toBe(true)

      const adapter = new DeepSeekAdapter({
        options: () => modelConnection(`http://127.0.0.1:${String(address.port)}`),
        resolveApiKey: async () => 'test-key',
        resolveUserId: () => 'test-user' as never,
        resolveAttachments: () => store,
        resolveFiles: () => ({
          async ensureUploaded() {
            throw new Error('Files API intentionally unavailable in regression test')
          },
        }) as unknown as DeepSeekFileStore,
      })
      const chunks = []
      for await (const chunk of adapter.stream({
        provider: 'test',
        model: 'vision',
        messages: [toolResult],
      })) chunks.push(chunk)
      expect(chunks.some(chunk => chunk.type === 'finish')).toBe(true)

      const request = await receivedRequest
      expect(request.messages[0]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call-1',
      })
      expect(request.messages[1]).toMatchObject({
        role: 'user',
        content: expect.arrayContaining([{
          type: 'image_url',
          image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
        }]),
      })

      const requestImage = await store.readImageRequest(ref, {
        maxPixels: 1_000_000,
        maxBytes: 1_000_000,
      })
      expect(requestImage.attachment).toEqual(ref)
      await expect(store.readImage({ ...ref, mediaType: 'image/jpeg' })).rejects.toThrow(
        'Stored attachment metadata does not match its reference.',
      )
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('streams a session log export containing the normalized screenshot', async () => {
    const store = await attachmentStore()
    const tool = screenshotTool(store, await jpegScreenshot())
    const { content, ref } = await executeScreenshot(tool)
    const root = {
      filename: 'session.jsonl',
      content: `${JSON.stringify({
        kind: 'tool/result',
        data: {
          content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'browser_screenshot', content }],
        },
      })}\n`,
    }
    const sessionPersistence = {
      supportsRawArtifacts: true,
      async readRaw() {
        return root
      },
    }
    const ctx = new Context()
    ctx.provide('attachments', store)
    ctx.provide('sessionPersistence', sessionPersistence as never)
    ctx.provide('sessionQuery', {} as never)
    ctx.provide('userQuestions', { registerProvider: () => () => undefined } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'test', model: 'vision' }),
      cwd: process.cwd(),
      sessionExportCompressionLevel: 0,
    })
    const response = await api.downloads.sessionLog({
      sessionId: 'session-1' as never,
      includeDescendants: false,
    }, new AbortController().signal)

    expect(response.status).toBe(200)
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
    const mediaPath = `media/${String(ref.attachmentId)}.png`
    expect(Object.keys(archive).sort()).toEqual(['session.jsonl', mediaPath].sort())
    expect(strFromU8(archive['session.jsonl']!)).toBe(root.content)
    expect(archive[mediaPath]).toEqual((await store.readImage(ref)).data)
  })
})
