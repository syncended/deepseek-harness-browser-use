import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
import { BrowserManager } from './browser-manager.js'
import type { BrowserUseConfig } from './protocol.js'
import { registerBrowserRpc } from './rpc.js'
import { registerBrowserScreenshotTool, registerBrowserTools } from './tools.js'

export { BrowserManager } from './browser-manager.js'
export type { BrowserActor, BrowserScreenshot } from './browser-manager.js'
export type * from './protocol.js'

export const name = 'browser-use'
export const inject = ['tools', 'connection']

export function apply(ctx: Context, config: BrowserUseConfig = {}): void {
  const browser = new BrowserManager(config)

  ctx.effect(() => async () => browser.close(), 'browser-use: persistent browser lifecycle')
  registerBrowserTools(ctx, browser)
  registerBrowserRpc(ctx, browser)

  ctx.inject(['attachments'], attachmentCtx => {
    registerBrowserScreenshotTool(attachmentCtx, browser)
  })
}

export default { name, inject, apply }
