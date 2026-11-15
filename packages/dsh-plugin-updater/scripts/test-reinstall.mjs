/**
 * Regression cases for the host half's reinstall path, run against a fake plugin
 * manager so no package manager touches the profile.
 *
 * The HMR refusal reaches this code two ways: the real manager settles it into
 * `{application:'failed', error:{code:'already-installed'}}` (its `change()`
 * catches the ManagementFailure), and a manager that rejects carries the same
 * code on the error. Both must remove the installed copy and retry; a retry that
 * fails must put the removed copy back.
 *
 * Usage: node scripts/test-reinstall.mjs
 * Reads the profile named by DSH_PROFILE_DIR, defaulting to the author's web
 * profile, only for inventory and manifest facts.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROFILE = process.env.DSH_PROFILE_DIR ?? '/home/zeiss/.dsh/profiles/web'
const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')
const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
const names = Object.keys(manifest.dependencies).filter((name) => manifest.dsh.profile.bundles.includes(name))

function installedOf(name) {
  try {
    return JSON.parse(readFileSync(join(PROFILE, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Build a fake manager whose k-th installBundle answer comes from `answers`. */
async function scenario(label, { hmr = true, answers }) {
  const calls = []
  let installs = 0
  const manager = {
    listBundles: async () =>
      names.map((name) => ({
        name,
        availability: 'profile',
        installed: installedOf(name) !== undefined,
        enabled: true,
        version: installedOf(name)?.version,
        source: manifest.dependencies[name],
        removable: true,
        rows: [],
      })),
    listVersionExemptions: () => ({ exemptions: {} }),
    installBundle: async (spec) => {
      calls.push(`install:${spec}`)
      const answer = answers[installs] ?? { application: 'applied', changed: true }
      installs += 1
      if (answer instanceof Error) throw answer
      return answer
    },
    removeBundle: async (name) => {
      calls.push(`remove:${name}`)
      return { application: 'applied', changed: true }
    },
    setPluginEnabled: async () => ({ application: 'applied' }),
  }
  const services = { profileContext: { dir: PROFILE }, pluginManager: manager, subprocess: {}, pluginRegistryProbe: undefined }
  if (hmr) services.hmr = {}
  let tool
  const ctx = {
    effect: (fn) => fn(),
    get: (key) => services[key],
    inject: (_names, callback) =>
      callback({ effect: ctx.effect, get: ctx.get, tools: { register: (definition) => ((tool = definition), () => {}) } }),
  }
  const mod = await import(`${MODULE}?${label}`)
  mod.apply(ctx, { probe: false, agentToolMirrorsPlan: true })
  const result = await Promise.race([
    tool.execute({ action: 'apply', updates: [{ id: 'profile:dsh-advisor', version: '0.7.2' }] }, { signal: new AbortController().signal }),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 20000)),
  ])
  if (result === 'TIMEOUT') throw new Error(`${label}: apply never settled`)
  return { calls, outcome: result.items?.[0] ?? result }
}

const cases = []
function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log('  ok -', message)
}

const refusal = { application: 'failed', changed: false, error: { code: 'already-installed' } }
const rejection = Object.assign(new Error('already-installed'), { code: 'already-installed' })

cases.push(async () => {
  console.log('case returned refusal')
  const { calls, outcome } = await scenario('returned', { answers: [refusal, { application: 'applied', changed: true }] })
  check(calls[0] === 'install:dsh-advisor@0.7.2', 'installs the target first')
  check(calls[1] === 'remove:dsh-advisor', 'removes the installed copy after the refusal')
  check(calls[2] === 'install:dsh-advisor@0.7.2', 'installs the target again')
  check(outcome.ok === true, 'reports the update as applied')
})

cases.push(async () => {
  console.log('case rejected refusal')
  const { calls, outcome } = await scenario('rejected', { answers: [rejection, { application: 'applied', changed: true }] })
  check(calls[1] === 'remove:dsh-advisor', 'removes the installed copy after the rejection')
  check(calls.filter((call) => call.startsWith('install:')).length === 2, 'installs twice')
  check(outcome.ok === true, 'reports the update as applied')
})

cases.push(async () => {
  console.log('case unrelated rejection propagates')
  const { calls, outcome } = await scenario('other-error', {
    answers: [Object.assign(new Error('broken'), { code: 'operation-error' })],
  })
  check(!calls.some((call) => call.startsWith('remove:')), 'an unrelated rejection removes nothing')
  check(outcome.ok === false && String(outcome.message).includes('broken'), 'an unrelated rejection still fails with its own message')
})

cases.push(async () => {
  console.log('case retry fails')
  const { calls, outcome } = await scenario('retry-fails', {
    answers: [refusal, { application: 'failed', changed: false, error: { code: 'network' } }, { application: 'applied', changed: true }],
  })
  check(calls.at(-1) === 'install:dsh-advisor@0.7.1', 'restores the version the removal took away')
  check(outcome.ok === false && outcome.error?.code === 'network', 'reports the retry failure')
})

cases.push(async () => {
  console.log('case no HMR')
  const { calls, outcome } = await scenario('plain', { hmr: false, answers: [{ application: 'applied', changed: true }] })
  check(calls.length === 1 && !calls.some((call) => call.startsWith('remove:')), 'installs over the running copy without removing it')
  check(outcome.ok === true, 'reports the update as applied')
})

for (const run of cases) await run()
console.log('ALL OK')
process.exit(0)
