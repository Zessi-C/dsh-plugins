/**
 * Generate `index.json`, the plugin-market document that lists this repository's
 * packages, from what the repository actually contains.
 *
 * The document names each package with its git source and the commit that
 * carries its current version, so a machine that has no checkout can install
 * any package straight from the Plugins page.
 *
 * Usage: node scripts/build-market-index.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'https://github.com/Zessi-C/dsh-plugins'

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

/** One directory per package; the directory name is the package name. */
const packages = readdirSync(join(root, 'packages')).sort()
const head = git('rev-parse', 'HEAD')

const entries = []
for (const directory of packages) {
  const dir = join(root, 'packages', directory)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const locale = (name) => {
    try {
      return JSON.parse(readFileSync(join(dir, 'locale', `${name}.json`), 'utf8')).meta
    } catch {
      return undefined
    }
  }
  const en = locale('en') ?? {}
  const zh = locale('zh') ?? {}

  // The commit that last touched this package owns its present version, so an
  // install of that commit cannot pick up another package's newer files.
  const commit = git('log', '-1', '--format=%H', '--', `packages/${directory}`) || head
  // The market format counts publish time in whole Unix seconds.
  const publishedMs = Date.parse(git('log', '-1', '--format=%cI', '--', `packages/${directory}`))
  const publishTimestamp = Number.isFinite(publishedMs) ? Math.floor(publishedMs / 1000) : Math.floor(Date.now() / 1000)

  entries.push({
    name: manifest.name,
    title: { en: en.title ?? manifest.name, zh: zh.title ?? en.title ?? manifest.name },
    description: { en: en.description ?? manifest.description ?? '', zh: zh.description ?? en.description ?? '' },
    author: manifest.author,
    homepage: manifest.homepage,
    repository: { url: `${repository}.git`, directory: `packages/${directory}` },
    metadata: {
      keywords: manifest.keywords ?? [],
      labels: [],
      sortKeys: {},
    },
    versions: [
      {
        version: manifest.version,
        publishTimestamp,
        source: { type: 'git', url: `${repository}.git`, commit, path: `packages/${directory}` },
        engines: { dsh: manifest.engines?.dsh ?? '*' },
      },
    ],
  })
}

const document = {
  format: 1,
  name: 'Zessi-C dsh plugins',
  title: { en: 'Zessi-C dsh plugins', zh: 'Zessi-C 的 dsh 插件' },
  description: 'Self-authored dsh plugins kept in one repository.',
  metadata: { categories: {}, labels: {}, sortKeys: {} },
  plugins: entries,
}

// Refuse to publish a document the market would reject.
const { parseMarketIndex } = await import(
  process.env.DSH_MARKET_INDEX_MODULE ??
    '/opt/dsh/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js',
)
parseMarketIndex(document, `${repository}.git/main/index.json`)

writeFileSync(join(root, 'index.json'), `${JSON.stringify(document, null, 2)}\n`)
console.log(`wrote index.json with ${entries.length} plugin(s) at ${head.slice(0, 7)}`)
for (const entry of entries) {
  console.log(`  ${entry.name.padEnd(24)} ${entry.versions[0].version.padEnd(8)} ${entry.versions[0].source.commit.slice(0, 7)}`)
}
