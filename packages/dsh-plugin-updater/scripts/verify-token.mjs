/**
 * Verify how the updater resolves and attaches a private-repository token.
 *
 * Checks, without touching the network:
 *   1. the credential store wins over the environment,
 *   2. the environment is the fallback,
 *   3. a token is only attached for hosts the token kind belongs to,
 *   4. an embedded token never leaks into the reported URL.
 */

import { readFileSync } from 'node:fs'

const source = readFileSync('/home/zeiss/.dsh/profiles/web/node_modules/dsh-plugin-updater/lib/index.js', 'utf8')
const mod = await import('file:///home/zeiss/.dsh/profiles/web/node_modules/dsh-plugin-updater/lib/index.js')

const profileDir = '/home/zeiss/.dsh/profiles/web'
const manifest = JSON.parse(readFileSync(`${profileDir}/package.json`, 'utf8'))

/** Record what each git invocation was given. */
const invocations = []
const record = (extra = {}) => ({
  name: 'dsh-lan-gate',
  availability: 'profile',
  installed: true,
  enabled: true,
  version: '0.13.2',
  source: manifest.dependencies['dsh-lan-gate'],
  removable: true,
  rows: [],
  ...extra,
})

function build({ storeValue, envValue, bundle = record() }) {
  invocations.length = 0
  const services = {
    profileContext: { dir: profileDir },
    pluginManager: {
      listBundles: async () => [bundle],
      listVersionExemptions: () => ({ exemptions: {} }),
    },
    pluginRegistryProbe: undefined,
    credentials:
      storeValue === undefined
        ? undefined
        : { resolve: async (ref) => (ref === 'DSH_PLUGIN_UPDATER_TOKEN' ? { value: storeValue, source: 'store' } : undefined) },
    subprocess: {
      spawn(spec) {
        invocations.push(spec.argv.join(' '))
        const text = spec.argv.includes('--tags') ? 'deadbeef\trefs/tags/dsh-lan-gate-v0.13.2' : 'deadbeef\tHEAD'
        const reader = { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
        return { collected: { stdout: reader, stderr: reader }, done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true }
      },
    },
  }
  let tool
  const ctx = {
    effect: (fn) => { fn() },
    get: (key) => services[key],
    inject: (_names, callback) => callback({ effect: ctx.effect, tools: { register: (definition) => ((tool = definition), () => {}) }, get: ctx.get }),
  }
  mod.apply(ctx, {})
  return { getTool: () => tool }
}

const ENV = process.env.DSH_PLUGIN_UPDATER_TOKEN

// 1. The credential store wins.
process.env.DSH_PLUGIN_UPDATER_TOKEN = 'env-token'
{
  const { getTool } = build({ storeValue: 'store-token' })
  await new Promise((resolve) => setTimeout(resolve, 9500))
  const summary = await getTool().execute({ action: 'check' }, { signal: new AbortController().signal })
  const usesStore = invocations.some((line) => line.includes('store-token'))
  const usesEnv = invocations.some((line) => line.includes('env-token'))
  const url = summary.plugins[0]?.id ?? ''
  console.log(`store wins: ${usesStore && !usesEnv} (store=${usesStore}, env=${usesEnv})`)
  console.log(`no token in report: ${!JSON.stringify(summary).includes('store-token')}`)
  void url
}

// 2. The environment is the fallback.
{
  const { getTool } = build({ storeValue: undefined })
  await new Promise((resolve) => setTimeout(resolve, 9500))
  await getTool().execute({ action: 'check' }, { signal: new AbortController().signal })
  console.log(`env fallback: ${invocations.some((line) => line.includes('env-token'))}`)
}

// 3. No credential at all: the URL stays anonymous.
{
  delete process.env.DSH_PLUGIN_UPDATER_TOKEN
  const { getTool } = build({ storeValue: undefined })
  await new Promise((resolve) => setTimeout(resolve, 9500))
  await getTool().execute({ action: 'check' }, { signal: new AbortController().signal })
  console.log(`anonymous without a token: ${!invocations.some((line) => line.includes('@github.com'))}`)
}

// 4. A non-forge host never receives the token.
{
  const { getTool } = build({
    storeValue: 'secret-token',
    bundle: record({ source: 'git+https://git.internal.example/team/plugin.git' }),
  })
  await new Promise((resolve) => setTimeout(resolve, 9500))
  await getTool().execute({ action: 'check' }, { signal: new AbortController().signal })
  const leaked = invocations.some((line) => line.includes('secret-token') && line.includes('internal.example'))
  console.log(`no token for a non-forge host: ${!leaked}`)
}

if (ENV === undefined) delete process.env.DSH_PLUGIN_UPDATER_TOKEN
else process.env.DSH_PLUGIN_UPDATER_TOKEN = ENV
