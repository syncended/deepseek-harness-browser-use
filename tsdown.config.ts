import type { UserConfig } from 'tsdown'

const PACKAGE_ID = '@syncended/dsh-browser-use'
const clientExternals = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
])

const host: UserConfig = {
  name: PACKAGE_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => specifier === 'playwright-core' || specifier.startsWith('@deepseek-ai/'),
    alwaysBundle: (specifier: string) => specifier !== 'playwright-core' && !specifier.startsWith('@deepseek-ai/'),
  },
}

const client: UserConfig = {
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => clientExternals.has(specifier),
    alwaysBundle: (specifier: string) => !clientExternals.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
