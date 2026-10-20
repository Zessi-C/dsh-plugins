/** Run the updater's engine against the live profile and print what it reports. */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const mod = await import('/home/zeiss/.dsh/profiles/web/node_modules/dsh-plugin-updater/lib/index.js')
const { Context } = await import('/opt/dsh/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')

const profileDir = '/home/zeiss/.dsh/profiles/web'
const manifest = JSON.parse(readFileSync(`${profileDir}/package.json`, 'utf8'))
const names = Object.keys(manifest.dependencies).filter((n) => manifest.dsh.profile.bundles.includes(n))

const manager = {
  listBundles: async () =>
    names.map((name) => {
      const installed = readInstalled(name)
      return {
        name,
        availability: 'profile',
        installed: installed !== undefined,
        enabled: true,
        version: installed?.version,
        source: manifest.dependencies[name],
        removable: true,
        rows: [],
      }
    }),
  listVersionExemptions: () => ({ exemptions: {} }),
}
function readInstalled(name) {
  try {
    return JSON.parse(readFileSync(`${profileDir}/node_modules/${name}/package.json`, 'utf8'))
  } catch {
    return undefined
  }
}
const subprocess = {
  spawn(spec) {
    let out = ''
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd })
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (out += c))
    const reader = { readFrom: () => ({ text: out, nextOffset: out.length, lossy: false }) }
    return { collected: { stdout: reader, stderr: reader }, done: new Promise((r) => child.on('close', (code) => r({ exitCode: code, signal: null }))), terminate() {}, waitForExit: async () => true }
  },
}
const services = { profileContext: { dir: profileDir }, pluginManager: manager, subprocess, pluginRegistryProbe: undefined }
let tool
const ctx = {
  effect: (fn) => fn(),
  get: (k) => services[k],
  inject: (_n, cb) => cb({ effect: ctx.effect, tools: { register: (d) => ((tool = d), () => {}) }, get: ctx.get }),
}
mod.apply(ctx, {})
await new Promise((r) => setTimeout(r, 9000))
const result = await tool.execute({ action: 'check' }, { signal: new AbortController().signal })
console.log('dsh', result.runtimeVersion, '| counts:', JSON.stringify(result.counts))
for (const p of result.plugins) console.log('  ', p.kind.padEnd(9), p.name.padEnd(24), String(p.version).padEnd(9), p.status.padEnd(10), 'latest=' + (p.latest ?? '-'))
