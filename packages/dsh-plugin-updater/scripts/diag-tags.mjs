/**
 * Reproduce how probeGitTag reads versions for a monorepo package.
 *
 * Feeds the parser the exact refs a monorepo carries (several packages sharing
 * one tag namespace, peeled refs, a root package.json) and prints the chosen
 * release, so a wrong `latest` shows up here instead of in the Plugins page.
 */

import { readFileSync } from 'node:fs'

const source = readFileSync('/home/zeiss/.dsh/profiles/web/node_modules/dsh-plugin-updater/lib/index.js', 'utf8')
const mod = await import('file:///home/zeiss/.dsh/profiles/web/node_modules/dsh-plugin-updater/lib/index.js')

const profileDir = '/home/zeiss/.dsh/profiles/web'
const manifest = JSON.parse(readFileSync(`${profileDir}/package.json`, 'utf8'))

// Exactly what `git ls-remote --tags <url>` returns for this repository.
const TAGS = [
  '5c12ca7b24a8dbf14c8ef5aef3f9c8eb655bf487\trefs/tags/dsh-plugin-updater-v0.1.0',
  '254850f2c41ce7a44c6edda46e291bf1acf2cfa0\trefs/tags/dsh-plugin-updater-v0.1.1',
  '5c12ca7b24a8dbf14c8ef5aef3f9c8eb655bf487\trefs/tags/dsh-vibe-orchestrator-v0.1.0',
  '5c12ca7b24a8dbf14c8ef5aef3f9c8eb655bf487\trefs/tags/dsh-web-search-model-v0.1.0',
].join('\n')

let tool
const services = {
  profileContext: { dir: profileDir },
  pluginManager: {
    listBundles: async () => [
      {
        name: 'dsh-plugin-updater',
        availability: 'profile',
        installed: true,
        enabled: true,
        version: '0.2.0',
        source: manifest.dependencies['dsh-plugin-updater'],
        removable: true,
        rows: [],
      },
    ],
    listVersionExemptions: () => ({ exemptions: {} }),
  },
  pluginRegistryProbe: undefined,
  subprocess: {
    spawn(spec) {
      const wantsTags = spec.argv.includes('--tags')
      const text = wantsTags ? TAGS : 'd5bb4efea13379dd33f75e65668b274e1c52f7fe\tHEAD'
      const reader = { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
      return { collected: { stdout: reader, stderr: reader }, done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true }
    },
  },
}
const ctx = {
  effect: (fn) => fn(),
  get: (k) => services[k],
  inject: (_n, cb) => cb({ effect: ctx.effect, tools: { register: (d) => ((tool = d), () => {}) }, get: ctx.get }),
}
void source
mod.apply(ctx, {})

await new Promise((resolve) => setTimeout(resolve, 9000))
const result = await tool.execute({ action: 'check' }, { signal: new AbortController().signal })
const entry = result.plugins.find((p) => p.name === 'dsh-plugin-updater')
console.log('installed:', entry.version, '| parser says latest:', entry.latest, '| status:', entry.status)
console.log('expected latest:', '0.1.1 (the highest tag this repository carries)')
