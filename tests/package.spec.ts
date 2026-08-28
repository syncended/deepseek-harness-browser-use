import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('published package surface', () => {
  it('declares a DSH bundle and client face', async () => {
    const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
      exports?: Record<string, unknown>
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports).toHaveProperty('./client')
  })

  it('builds the lazy DSH client registration wrapper', async () => {
    const bundle = await readFile(resolve('lib/client.js'), 'utf8')
    expect(bundle).toContain('window.__ModuleLoader__.load({ id: "@syncended/dsh-browser-use"')
    expect(bundle).toContain('factory: (require) => {')
    expect(bundle).toContain('return module.exports; } });')
  })
})
