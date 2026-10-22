/**
 * dsh-plugin-updater — host half.
 *
 * The engine behind two callers: the Plugins-page tab (browser half) and the
 * `plugin_update` agent tool. Both work on the plugins of the *current* profile
 * and answer three questions, then act on them:
 *
 *   1. version   — is there a newer release than the one installed?
 *   2. remote    — for a plugin installed from a repository, has HEAD moved?
 *   3. dsh range — does the installed version still satisfy the running dsh,
 *                  and if not, which release would?
 *
 * ── Reaching this plugin from the browser ────────────────────────────────────
 *
 * The Client cannot call this plugin's own service: `ctx.remote.*` only carries
 * the static Typert namespaces an installation ships, and the `harness.handle`
 * bridge belongs to dynamic (agent-authored) packages. So this service composes
 * no RPC of its own. The browser half reads and changes the profile through the
 * SAME `remote.pluginManager` API the Plugins page uses — inventory, install,
 * removal, exemptions, registries — while this page supplies the probe results
 * and the target versions. The agent tool runs the whole engine here, where every
 * service is reachable.
 *
 * ── Where a package came from ────────────────────────────────────────────────
 *
 * The spec recorded in the profile manifest decides the probe:
 *
 *   file:/abs/path            local checkout — never probed over the network;
 *   link:/portal:                               build staleness is reported
 *   github:owner/repo…        remote         — `git ls-remote` for HEAD, plus the
 *   git+https://…, git@…                       manifest at that commit for the
 *   owner/name                                 version (private repos work through
 *                                              gh's credential helper)
 *   https://…/x.tgz           remote         — reachability only
 *   @scope/name, name         npm registry   — registry packument
 *
 * A package that resolves from the dsh installation (`availability:
 * 'installation'`) ships with dsh and is reported, never updated: overwriting it
 * in the profile would shadow the shipped copy.
 *
 * ── Applying an update ───────────────────────────────────────────────────────
 *
 *   1. `pluginManager.installBundle` installs the exact target, so pnpm, the
 *      build-script policy and the lockfile stay the Harness's business.
 *   2. The recorded dependency spec, the bundle selection, and rows the user had
 *      switched off are restored afterwards, because a reinstall re-derives all
 *      three from the newly installed package.
 *   3. When only the declared dsh range is behind, the installed manifest's
 *      `engines.dsh` / dsh peer range is widened so the release that already
 *      works keeps working; when no release fits at all, `pluginManager` records
 *      the Harness's own exact-version exemption.
 *
 * Every profile mutation is serialised, so the page and the agent tool can never
 * interleave two package-manager runs.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export const name = 'dsh-plugin-updater'

/**
 * No hard dependency: every service this row uses is reached through
 * `ctx.get(...)`, which answers `undefined` instead of throwing, so a profile
 * missing the plugin manager or the tool registry still loads the row. The
 * agent tool installs itself only once `tools` exists, through `ctx.inject`.
 */
export const inject = []

/** Row id this bundle inserts, so the Client can find the row that holds options. */
export const ROW_ID = 'plugin-updater'



//#region semver

/**
 * Load the `semver` package the running dsh already ships.
 *
 * This plugin is installed by link, so it has no node_modules of its own and a
 * bare `import 'semver'` fails (ERR_MODULE_NOT_FOUND). Resolving from the dsh
 * entry point (`process.argv[1]`) finds the exact copy the Harness itself uses
 * for `dsh-app-boot`'s plugin-compatibility check, so the compatibility column
 * agrees with the boot-time decision by construction.
 *
 * @returns {object | undefined} The semver module, or undefined when unavailable.
 */
/**
 * The directory the running dsh is installed in, located from the `dsh` command.
 *
 * `import.meta.resolve` in this module resolves against the plugin's own
 * location, so it can never see the Harness's packages; the command on PATH is
 * the one fact that describes where the running installation lives.
 * @returns {string | undefined} Absolute dsh package directory, or undefined when unknown.
 */
function dshInstallRoot() {
  const candidates = []
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    candidates.push(join(dir, 'dsh'))
  }
  candidates.push('/opt/dsh/node/bin/dsh', '/usr/local/bin/dsh', '/usr/bin/dsh')
  const seen = new Set()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      if (!existsSync(candidate)) continue
      const real = realpathSync(candidate)
      // <root>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js → .../@deepseek-ai/dsh
      const packageDir = join(real, '..', '..')
      if (!existsSync(join(packageDir, 'package.json'))) continue
      return packageDir
    } catch {
      /* not this candidate */
    }
  }
  return undefined
}

/**
 * Load the `semver` package the running dsh already ships.
 *
 * This plugin is installed by link, so it has no node_modules of its own and a
 * bare `import 'semver'` fails. The copy is taken from the installation that runs
 * this plugin, which is the one `dsh-app-boot` uses for its compatibility check,
 * so the two decisions cannot drift.
 *
 * @returns {object | undefined} The semver module, or undefined when unavailable.
 */
/**
 * Load one package the running dsh already installed.
 *
 * This plugin is installed by link, so it has no node_modules of its own: a bare
 * `import` of a Harness package fails. The copy used here is the one the running
 * installation loads, found from the `dsh` command rather than from this file's
 * location, so the schema and the version logic match the Host's own.
 *
 * @param {string} name - Package name.
 * @param {string} entry - Entry file relative to the package directory.
 * @returns {object | undefined} The loaded module, or undefined when absent.
 */
function loadHostPackage(name, entry) {
  const packageDir = dshInstallRoot()
  if (packageDir === undefined) return undefined
  const roots = [join(packageDir, 'node_modules'), join(packageDir, '..'), join(packageDir, '..')]
  for (const root of roots) {
    const target = join(root, ...name.split('/'))
    if (!existsSync(join(target, entry))) continue
    try {
      return createRequire(join(root, 'noop.js'))(name)
    } catch {
      /* try the next root */
    }
  }
  return undefined
}

const semver = loadHostPackage('semver', 'index.js')
const schemastery = loadHostPackage('@deepseek-ai/schemastery', 'lib/index.cjs')

/**
 * The schema language every dsh plugin Config uses.
 *
 * The exported `Config` must be a real Schemastery schema: the Loader decides
 * whether a Config is one by reading `schema?.['~standard'].vendor`, and a plain
 * object has no `~standard`, which throws during activation. When the package
 * cannot be loaded at all this module still imports, and `Config` is omitted
 * rather than replaced with something that would crash the row.
 */
const schema = schemastery === undefined ? undefined : schemastery.default ?? schemastery

export const Config =
  schema === undefined
    ? undefined
    : schema.object({
        timeoutMs: schema.number().default(30000).description('Timeout in milliseconds for one registry or git probe.'),
        probe: schema.boolean().default(true).description('Probe registries and git remotes at all; false lists plugins without network access.'),
        fallbackRegistry: schema
          .string()
          .default('https://registry.npmjs.org/')
          .description('Registry asked when the profile pnpm registry does not answer.'),
        agentToolMirrorsPlan: schema
          .boolean()
          .default(false)
          .description('Let the plugin_update agent tool apply a plan, not only report one.'),
        gitTokenEnv: schema
          .string()
          .default('DSH_PLUGIN_UPDATER_TOKEN')
          .description(
            'Environment variable holding a token for private repositories. Read from the dsh credential store first, then the environment.',
          ),
      })


/**
 * Whether a string is a valid semantic version.
 * @param {string} value - Candidate version.
 * @returns {boolean} Whether it parses as one.
 */
export function isVersion(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (semver !== undefined) {
    try {
      return semver.valid(value) !== null
    } catch {
      return false
    }
  }
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

/** Compare two versions with SemVer precedence, tolerating the unknown. */
function compareVersions(a, b) {
  if (semver !== undefined) {
    try {
      return semver.compare(a, b)
    } catch {
      return 0
    }
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

/**
 * Whether a version satisfies a range, with prereleases participating.
 *
 * The Harness evaluates plugin requirements as
 * `semver.satisfies(version, range, { includePrerelease: true })`
 * (`dsh-app-boot`), so this must answer the same way for the compatibility
 * column to mean anything.
 *
 * @param {string} version - Candidate version.
 * @param {string} range - Range such as `^0.2.1-rc.2`.
 * @returns {boolean} Whether the version is admitted.
 */
export function satisfies(version, range) {
  if (range === undefined || range === null) return true
  if (semver === undefined) return String(version) === String(range).replace(/^[\^~]/, '')
  try {
    return semver.satisfies(String(version), String(range), { includePrerelease: true })
  } catch {
    // An unparsable range cannot be proven to admit anything.
    return false
  }
}

//#endregion

//#region requirements

/** The constraint blocks a manifest declares. */
function requirementFacts(manifest) {
  const engines = typeof manifest?.engines === 'object' && manifest.engines !== null ? manifest.engines : {}
  const peers = typeof manifest?.peerDependencies === 'object' && manifest.peerDependencies !== null ? manifest.peerDependencies : {}
  return { engines, peers }
}

/**
 * Reproduce `dsh-app-boot`'s `unmetRequirements`: an own `engines.dsh` decides
 * alone and dsh peers are then ignored; otherwise every `@deepseek-ai/dsh` or
 * `@deepseek-ai/dsh-*` peer must match, with `workspace:^`/`~`/`*` meaning the
 * running runtime.
 *
 * @param {object} manifest - A package manifest.
 * @param {string} runtimeVersion - Running dsh version.
 * @returns {{ all: Record<string,string>, unmet: Record<string,string> }} Constraints and the unmet ones.
 */
export function dshRequirements(manifest, runtimeVersion) {
  const { engines, peers } = requirementFacts(manifest)
  const all = {}
  const unmet = {}
  if (typeof engines.dsh === 'string') {
    all['engines.dsh'] = engines.dsh
    if (!satisfies(runtimeVersion, engines.dsh)) unmet['engines.dsh'] = engines.dsh
    return { all, unmet }
  }
  for (const [peerName, peerRange] of Object.entries(peers)) {
    if (peerName !== '@deepseek-ai/dsh' && !peerName.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof peerRange !== 'string') continue
    all[peerName] = peerRange
    const effective = ['workspace:^', 'workspace:~', 'workspace:*'].includes(peerRange) ? runtimeVersion : peerRange
    if (!satisfies(runtimeVersion, effective)) unmet[peerName] = peerRange
  }
  return { all, unmet }
}

/** The single constraint to widen when a plugin must accept a runtime. */
export function dshConstraintOf(manifest) {
  const { engines, peers } = requirementFacts(manifest)
  if (typeof engines.dsh === 'string') return { field: 'engines.dsh', range: engines.dsh }
  const entries = Object.entries(peers).filter(([key, value]) => (key === '@deepseek-ai/dsh' || key.startsWith('@deepseek-ai/dsh-')) && typeof value === 'string')
  if (entries.length === 0) return null
  const primary = entries.find(([key]) => key === '@deepseek-ai/dsh') ?? entries[0]
  return { field: 'peerDependencies', key: primary[0], range: primary[1] }
}

//#endregion

//#region specs

/** Classify one recorded dependency spec. */
/**
 * Split a git spec fragment into the ref and the package subdirectory.
 *
 * pnpm puts both in one fragment, joined by `&`:
 *
 *   #main&path:/packages/name
 *   #<commit>&path:/packages/name
 *   #path:/packages/name&main
 *   #semver:^1.0.0&path:/packages/name
 *
 * Reading the fragment as a bare ref makes a package in a monorepo look like the
 * repository root, so the two parts are separated here once and reused.
 *
 * @param {string | undefined} fragment - Text after `#`, without the `#`.
 * @returns {{ ref?: string, subdirectory?: string }} Parsed parts.
 */
export function parseFragment(fragment) {
  if (typeof fragment !== 'string' || fragment === '') return {}
  let ref
  let subdirectory
  for (const part of fragment.split('&')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const pathMatch = /^path[:=](.*)$/i.exec(trimmed)
    if (pathMatch !== null) {
      const value = pathMatch[1].replace(/^\/+|\/+$/g, '')
      if (value !== '') subdirectory = value
      continue
    }
    if (ref === undefined) ref = trimmed
  }
  return { ...(ref === undefined || ref === '' ? {} : { ref }), ...(subdirectory === undefined ? {} : { subdirectory }) }
}

export function classifySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return { kind: 'npm' }
  if (/^(file:|link:|portal:|workspace:)/i.test(text)) return { kind: 'local' }
  if (/^(github|gitlab|bitbucket):/i.test(text)) {
    const colon = text.indexOf(':')
    const scheme = text.slice(0, colon)
    const rest = text.slice(colon + 1)
    const hash = rest.indexOf('#')
    const path = hash === -1 ? rest : rest.slice(0, hash)
    const fragment = hash === -1 ? undefined : rest.slice(hash + 1)
    return { kind: 'git', host: scheme, url: `https://${scheme}.com/${path}`, remotePath: path, ...parseFragment(fragment) }
  }
  if (/^(git\+|git@|git:\/\/)/i.test(text) || /\.git(?:#|$)/.test(text)) {
    return { kind: 'git', url: text, ...parseFragment(text.includes('#') ? text.slice(text.indexOf('#') + 1) : undefined) }
  }
  if (/^https?:\/\//i.test(text)) {
    return { kind: /\.tgz(?:#.*)?$/i.test(text) ? 'tarball' : 'git', url: text, ...parseFragment(text.includes('#') ? text.slice(text.indexOf('#') + 1) : undefined) }
  }
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#.*)?$/.test(text)) {
    const hash = text.indexOf('#')
    const path = hash === -1 ? text : text.slice(0, hash)
    const fragment = hash === -1 ? undefined : text.slice(hash + 1)
    return { kind: 'git', host: 'github', url: `https://github.com/${path}`, remotePath: path, ...parseFragment(fragment) }
  }
  return { kind: 'npm' }
}

/** Turn a GitHub or ssh spec into the https URL git and pnpm both accept. */
export function normaliseGitUrl(url) {
  let text = String(url ?? '')
  if (text.startsWith('github:')) text = `https://github.com/${text.slice(7)}`
  if (/^git@([^:]+):/.test(text)) text = text.replace(/^git@([^:]+):/, 'https://$1/')
  if (text.startsWith('git+')) text = text.slice(4)
  if (text.startsWith('git://')) text = `https://${text.slice(6)}`
  return text.replace(/#.*$/, '').replace(/\.git$/, '')
}

//#endregion

//#region helpers

/** Read JSON without throwing. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The localised title a bundle reports, with the package name as fallback. */
function titleOf(meta, fallback) {
  const title = meta?.title
  if (typeof title === 'string') return title
  if (title !== null && typeof title === 'object') return title.zh ?? title['zh-CN'] ?? title.en ?? fallback
  return fallback
}

/** The repository a manifest declares, normalised. */
function repositoryOf(manifest) {
  const repository = manifest?.repository
  const raw = typeof repository === 'string' ? repository : repository?.url
  return typeof raw === 'string' ? normaliseGitUrl(raw) : undefined
}

/** This application's own dsh version. */
function readRuntimeVersion() {
  const packageDir = dshInstallRoot()
  if (packageDir !== undefined) {
    for (const candidate of [join(packageDir, '..', 'dsh-app-boot'), packageDir]) {
      const manifest = readJson(join(candidate, 'package.json'))
      if (typeof manifest?.version === 'string') return manifest.version
    }
  }
  return '0.0.0'
}

/** One sentence for a plugin-manager change result. */
function describeChange(result) {
  if (result === undefined || result === null) return 'no result'
  if (result.error !== undefined) return `${result.error.code}${result.error.diagnostic === undefined ? '' : `: ${result.error.diagnostic}`}`
  if (result.application === 'restart-required') return 'installed; restart dsh to load the new code'
  if (result.application === 'applied') return 'installed and applied'
  if (result.application === 'overridden') return 'installed, but a higher patch layer overrides it'
  if (result.application === 'cancelled') return 'cancelled'
  return String(result.application)
}

/** The key an exemption uses for a package version. */
function exemptionKey(packageName, version) {
  return `${packageName}@${version}`
}

//#endregion

/**
 * The updater engine: one instance per loaded plugin, shared by the agent tool
 * and by nothing else (see the module header for why the Client does not call
 * it directly).
 */
class Updater {
  lastReport = null
  lastPlan = null
  busy = false

  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.profileDir = ctx.get('profileContext')?.dir
    this.runtimeVersion = readRuntimeVersion()
  }

  // ---------------------------------------------------------------------------
  // Filesystem and process helpers
  // ---------------------------------------------------------------------------

  /** Resolve an installed package's directory the way the application does. */
  packageDir(packageName) {
    if (this.profileDir !== undefined) {
      const candidate = join(this.profileDir, 'node_modules', ...packageName.split('/'))
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
    try {
      return decodeURIComponent(new URL('.', import.meta.resolve(`${packageName}/package.json`)).pathname)
    } catch {
      return undefined
    }
  }

  /** Read one installed package's manifest. */
  installedManifest(packageName) {
    const dir = this.packageDir(packageName)
    return dir === undefined ? undefined : readJson(join(dir, 'package.json'))
  }

  /** The profile manifest, which records each dependency's install spec. */
  profileManifest() {
    return this.profileDir === undefined ? undefined : readJson(join(this.profileDir, 'package.json'))
  }

  /** Run one process through the Harness subprocess service. */
  async run(argv, runOptions = {}) {
    const service = this.ctx.get('subprocess')
    if (service === undefined) return { code: -1, output: 'the subprocess service is unavailable in this profile' }
    const handle = service.spawn({
      argv,
      cwd: runOptions.cwd ?? this.profileDir ?? process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
      graceMs: 5000,
      signal: runOptions.signal,
      env: runOptions.env,
    })
    const timer = setTimeout(() => handle.terminate(), runOptions.timeoutMs ?? this.options.timeoutMs)
    try {
      const outcome = await handle.done
      const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
      return { code: outcome.exitCode, output: `${stdout}${stderr}`.trim() }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Fetch text with a timeout and the caller's cancellation. */
  async http(url, fetchOptions = {}, signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), fetchOptions.timeoutMs ?? this.options.timeoutMs)
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener?.('abort', forward, { once: true })
    try {
      const response = await fetch(url, { headers: fetchOptions.headers, redirect: 'follow', signal: controller.signal })
      const text = await response.text()
      return { ok: response.ok, status: response.status, text }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', forward)
    }
  }

  // ---------------------------------------------------------------------------
  // Inventory
  // ---------------------------------------------------------------------------

  /** Every exemption the profile records. */
  exemptions() {
    try {
      return this.ctx.get('pluginManager')?.listVersionExemptions?.().exemptions ?? {}
    } catch {
      return {}
    }
  }

  /**
   * Read every plugin this profile owns, with the facts the probes need.
   * @returns {Promise<object[]>} One record per bundle.
   */
  async readInventory() {
    const manager = this.ctx.get('pluginManager')
    if (manager === undefined) return []
    const recorded = this.profileManifest()?.dependencies ?? {}
    const granted = this.exemptions()
    const records = []
    for (const bundle of await manager.listBundles()) {
      const shipped = bundle.availability === 'installation'
      const base = {
        id: `${shipped ? 'builtin' : bundle.availability}:${bundle.name}`,
        name: bundle.name,
        version: bundle.version,
        enabled: bundle.enabled,
        title: titleOf(bundle.meta, bundle.name),
      }
      if (shipped) {
        // Shipped with dsh: the version follows dsh itself.
        records.push({ ...base, kind: 'builtin', managed: false, rows: [], probe: { kind: 'builtin', status: 'ok', note: '' }, dsh: { ok: true, requirements: {}, all: {} }, exemptions: [] })
        continue
      }
      if (bundle.availability !== 'profile' || bundle.installed !== true) {
        records.push({ ...base, kind: 'missing', managed: false, rows: [], probe: { kind: 'none', status: 'error', note: 'declared but not found in node_modules' }, dsh: { ok: true, requirements: {}, all: {} }, exemptions: [] })
        continue
      }
      const manifest = this.installedManifest(bundle.name)
      const spec = bundle.source ?? recorded[bundle.name]
      const parsed = classifySpec(spec)
      const requirements = dshRequirements(manifest ?? {}, this.runtimeVersion)
      const version = manifest?.version ?? bundle.version
      const key = exemptionKey(bundle.name, version)
      records.push({
        ...base,
        version,
        spec,
        kind: parsed.kind,
        host: parsed.host,
        url: parsed.url,
        repoUrl: repositoryOf(manifest),
        dir: this.packageDir(bundle.name),
        managed: true,
        rows: (bundle.rows ?? []).map((row) => ({ rowId: row.rowId, entryId: row.entryId })),
        dsh: { ok: Object.keys(requirements.unmet).length === 0, runtimeVersion: this.runtimeVersion, requirements: requirements.unmet, all: requirements.all },
        exemptions: Array.isArray(granted[key]) ? granted[key] : [],
        constraint: manifest === undefined ? null : dshConstraintOf(manifest),
        probe: { kind: parsed.kind, status: this.options.probe ? 'pending' : 'skipped', note: this.options.probe ? undefined : 'probing disabled by configuration' },
      })
    }
    return records
  }

  // ---------------------------------------------------------------------------
  // Probes
  // ---------------------------------------------------------------------------

  /** Registries to ask, most specific first. */
  registries() {
    const found = []
    for (const file of [this.profileDir === undefined ? undefined : join(this.profileDir, '.npmrc'), join(process.env.HOME ?? '', '.npmrc')]) {
      if (file === undefined) continue
      try {
        const match = /^\s*registry\s*=\s*(\S+)/m.exec(readFileSync(file, 'utf8'))
        if (match !== null) found.push(match[1])
      } catch {
        /* no such file */
      }
    }
    found.push(this.options.fallbackRegistry)
    return [...new Set(found.map((entry) => `${entry.replace(/\/+$/, '')}/`))]
  }

  /** The registry document for a package. */
  async packument(packageName, signal) {
    const encoded = packageName.startsWith('@') ? `@${encodeURIComponent(packageName.slice(1))}` : encodeURIComponent(packageName)
    for (const registry of this.registries()) {
      try {
        const answer = await this.http(`${registry}${encoded}`, { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } }, signal)
        if (!answer.ok) continue
        const document = JSON.parse(answer.text)
        if (typeof document.versions === 'object' && document.versions !== null) return { ...document, registry }
      } catch (error) {
        if (signal?.aborted === true) throw error
      }
    }
    return undefined
  }

  /**
   * Probe a registry package: newer releases, split by whether each still
   * satisfies the running dsh.
   * @param {object} record - Inventory record.
   * @param {AbortSignal} [signal] - Cancellation.
   */
  async probeRegistry(record, signal) {
    const document = await this.packument(record.name, signal)
    if (document === undefined) return { kind: 'npm', status: 'error', note: 'no registry answered' }
    const releases = Object.keys(document.versions ?? {})
      .map((version) => {
        const facts = dshRequirements(document.versions[version] ?? {}, this.runtimeVersion)
        return { version, deprecated: typeof document.versions[version]?.deprecated === 'string', dshOk: Object.keys(facts.unmet).length === 0, requirements: facts.unmet }
      })
      .sort((a, b) => compareVersions(a.version, b.version))
    const newer = releases.filter((release) => compareVersions(release.version, record.version) > 0 && !release.deprecated)
    const compatible = newer.filter((release) => release.dshOk)
    const blocked = newer.filter((release) => !release.dshOk)
    const latest = document['dist-tags']?.latest
    const latestRelease = releases.find((release) => release.version === latest)
    return {
      kind: 'npm',
      status: 'ok',
      registry: document.registry,
      latest,
      latestDshOk: latestRelease?.dshOk,
      blockedLatest: blocked.length === 0 ? undefined : blocked[blocked.length - 1].version,
      blockedRequirements: blocked.length === 0 ? undefined : blocked[blocked.length - 1].requirements,
      compatibleLatest: compatible.length === 0 ? undefined : compatible[compatible.length - 1].version,
      hasUpdate: compatible.length !== 0,
      newerCompatible: compatible.map((release) => release.version),
    }
  }

  /**
   * The token used for private repositories.
   *
   * Read from the dsh credential store first, so it survives restarts and never
   * needs to be exported by hand, then from the configured environment variable.
   * Resolution is per call: a rotated token is picked up by the next probe
   * without reloading the plugin.
   *
   * @returns {Promise<string | undefined>} The token, or undefined when none is configured.
   */
  async gitToken() {
    const credentials = this.ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(this.options.gitTokenEnv)
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
      } catch {
        /* fall through to the environment */
      }
    }
    const ambient = process.env[this.options.gitTokenEnv]
    return typeof ambient === 'string' && ambient !== '' ? ambient : undefined
  }

  /**
   * Whether a token may be sent to this remote, and as which user.
   *
   * A token is only attached for the shared public forges, where the username is
   * fixed by the token kind; any other host would receive someone else's secret.
   * @param {string} url - Normalised repository URL.
   * @returns {string | undefined} The userinfo to embed, or undefined.
   */
  tokenUserinfo(url) {
    try {
      const host = new URL(url).host
      if (host === 'github.com') return 'x-access-token'
      if (host === 'gitlab.com' || host === 'bitbucket.org') return 'oauth2'
    } catch {
      /* an unparsable URL gets no credential */
    }
    return undefined
  }

  /** A URL with the token embedded, for one git invocation. */
  withToken(url, token) {
    const user = this.tokenUserinfo(url)
    if (token === undefined || user === undefined) return url
    const parsed = new URL(url)
    parsed.username = user
    parsed.password = token
    return parsed.toString()
  }

  /**
   * Headers that authenticate a raw-file read against a private repository.
   * @param {string | undefined} token - Token resolved for this probe.
   * @returns {Record<string, string>} Headers, empty when no token applies.
   */
  tokenHeaders(token) {
    return token === undefined ? {} : { authorization: `Bearer ${token}` }
  }

  /** Where a repository's raw files can be read at a commit, when the host offers it. */
  rawBase(url) {
    // The caller passes the plain repository URL, never the credential-bearing
    // form: withToken() writes `user:token@` into the authority, which used to
    // stop this match and silently skip the tag fallback beside it.
    const match = /^https:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(url)
    if (match === null) return undefined
    const [, host, owner, repo] = match
    if (host === 'github.com') return `https://raw.githubusercontent.com/${owner}/${repo}`
    if (host === 'gitlab.com') return `https://gitlab.com/${owner}/${repo}/-/raw`
    if (host === 'bitbucket.org') return `https://bitbucket.org/${owner}/${repo}/raw`
    return undefined
  }

  /**
   * Probe a repository: the remote head and the manifest recorded at it.
   *
   * `git ls-remote` uses the user's git configuration, so a private GitHub
   * repository works whenever `gh auth login` configured the credential helper.
   * The manifest is then read over https at that exact commit; when the host has
   * no public raw endpoint (typically a private repository), the head commit is
   * still reported and the version comparison stays open.
   */
  async probeGit(record, signal) {
    const url = normaliseGitUrl(record.url ?? record.spec)
    const token = await this.gitToken()
    const listed = await this.run(['git', 'ls-remote', this.withToken(url, token), 'HEAD'], { signal })
    if (listed.code !== 0) {
      const authProblem = /permission denied|authentication failed|could not read|terminal prompts disabled/i.test(listed.output)
      return {
        kind: 'git',
        status: 'error',
        url,
        note: authProblem
          ? `the remote rejected the request and no usable credential was found; store a repository token in the dsh credential store under ${this.options.gitTokenEnv}, or run \`gh auth login\``
          : listed.output.split('\n')[0],
      }
    }
    const head = listed.output.split('\n').find((line) => line.trim() !== '')?.split(/\s+/)[0]
    if (head === undefined) return { kind: 'git', status: 'error', url, note: 'the remote reported no HEAD' }
    const parsed = classifySpec(record.spec)
    const subdirectory = parsed.subdirectory
    const base = this.rawBase(url)
    if (base !== undefined) {
      for (const ref of [head, 'HEAD']) {
        try {
          const path = subdirectory === undefined || subdirectory === '' ? 'package.json' : `${subdirectory.replace(/^\/+|\/+$/g, '')}/package.json`
          const answer = await this.http(`${base}/${ref}/${path}`, this.tokenHeaders(token), signal)
          if (!answer.ok) continue
          const manifest = JSON.parse(answer.text)
          const facts = dshRequirements(manifest, this.runtimeVersion)
          return {
            kind: 'git',
            status: 'ok',
            url,
            head,
            latest: manifest.version,
            dshOk: Object.keys(facts.unmet).length === 0,
            requirements: facts.unmet,
            hasUpdate: typeof manifest.version === 'string' ? compareVersions(manifest.version, record.version) > 0 : undefined,
          }
        } catch (error) {
          if (signal?.aborted === true) throw error
        }
      }
    }
    // A private repository exposes no public raw file, so the version is read
    // from the package's release tag: `<package>-v<version>`. Publishing one with
    // every release keeps version comparison working without cloning anything.
    const tag = await this.probeGitTag(record, url, signal)
    const moved = this.commitMoved(record.spec, head)
    if (tag !== undefined) {
      // A tag records the last published release; the head records the source as
      // it stands. This repository commits without tagging, so the head can be
      // ahead of its own package version: an update that only followed the tag
      // would report "current" and reinstall nothing while the source moved on.
      if (moved && tag.hasUpdate !== true) {
        return {
          ...tag,
          hasUpdate: true,
          headMoved: true,
          note: `the tracked commit moved to ${String(head).slice(0, 7)} but the newest release tag is ${tag.latest}; reinstalling takes the tracked commit, not that tag`,
        }
      }
      return tag
    }
    return {
      kind: 'git',
      status: 'unknown',
      url,
      head,
      pinned: head,
      note: 'the head commit was read; the manifest is private and no release tag exists, so the version is compared by commit rather than by number',
      hasUpdate: moved,
    }
  }

  /**
   * Read a package's newest release tag from the remote.
   * @param {object} record - Inventory record.
   * @param {string} url - Repository URL.
   * @param {AbortSignal} [signal] - Cancellation.
   * @returns {Promise<object | undefined>} A probe result, or undefined when the remote carries no tags.
   */
  async probeGitTag(record, url, signal) {
    const listed = await this.run(['git', 'ls-remote', '--tags', this.withToken(url, await this.gitToken())], { signal })
    if (listed.code !== 0) return undefined
    const prefix = `${record.name}-v`
    const releases = listed.output
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2 && parts[1].startsWith(`refs/tags/${prefix}`) && !parts[1].endsWith('^{}'))
      .map((parts) => ({ version: parts[1].slice(`refs/tags/${prefix}`.length), commit: parts[0] }))
      .filter((release) => isVersion(release.version))
      .sort((a, b) => compareVersions(a.version, b.version))
    if (releases.length === 0) return undefined
    const newest = releases[releases.length - 1]
    const parsed = classifySpec(record.spec)
    const pinned = typeof parsed.ref === 'string' && /^[0-9a-f]{7,40}$/.test(parsed.ref) ? parsed.ref : undefined
    return {
      kind: 'git',
      status: 'ok',
      url,
      latest: newest.version,
      tag: `${prefix}${newest.version}`,
      head: newest.commit,
      hasUpdate: compareVersions(newest.version, record.version) > 0,
      pinned,
      note: '',
    }
  }

  /**
   * Whether the recorded spec survives the remote head and, when it names a
   * commit, whether that commit is still the head.
   * @param {string} spec - Recorded dependency spec.
   * @param {string} head - Remote head commit.
   * @returns {boolean} Whether the installation is behind the remote.
   */
  commitMoved(spec, head) {
    // The pin lives in the spec fragment, which also carries `path:/…` for a
    // monorepo package (pnpm writes `#<commit>&path:/packages/<name>`), so it is
    // read through the same parser as the rest of the spec. Anchoring the
    // pattern at the end of the spec never matched that form.
    const text = String(spec ?? '')
    const pinned = parseFragment(text.includes('#') ? text.slice(text.indexOf('#') + 1) : undefined).ref
    if (typeof pinned !== 'string' || !/^[0-9a-f]{7,40}$/.test(pinned)) return false
    return !head.startsWith(pinned) && !pinned.startsWith(head)
  }

  /** Reachability of a tarball source. */
  async probeTarball(record, signal) {
    const url = normaliseGitUrl(record.spec)
    try {
      const answer = await this.http(url, { headers: { range: 'bytes=0-0' } }, signal)
      return { kind: 'tarball', status: answer.ok ? 'unknown' : 'error', url, note: answer.ok ? 'tarball reachable; comparing versions needs unpacking' : `HTTP ${answer.status}` }
    } catch (error) {
      return { kind: 'tarball', status: 'error', url, note: String(error?.message ?? error) }
    }
  }

  /**
   * Report whether a locally linked package was rebuilt after its sources
   * changed. A link is a symlink into the profile, so a stale build silently
   * keeps old code running without any version changing.
   */
  probeLocal(record) {
    const dir = record.dir
    if (dir === undefined) return { kind: 'local', status: 'error', note: 'the linked directory is missing' }
    const newest = (target) => {
      let latest = 0
      const walk = (path, depth) => {
        if (depth > 6) return
        let entries
        try {
          entries = readdirSync(path, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (['node_modules', '.git', 'out', '.next'].includes(entry.name)) continue
          const child = join(path, entry.name)
          if (entry.isDirectory()) walk(child, depth + 1)
          else {
            try {
              const at = statSync(child).mtimeMs
              if (at > latest) latest = at
            } catch {
              /* unreadable entry */
            }
          }
        }
      }
      walk(target, 0)
      return latest
    }
    const sourceNewest = Math.max(...['src', 'client', 'app', 'index.ts', 'client.ts'].map((entry) => (existsSync(join(dir, entry)) ? newest(join(dir, entry)) : 0)))
    const built = ['lib', 'dist', 'build'].filter((entry) => existsSync(join(dir, entry)))
    const builtNewest = Math.max(...built.map((entry) => newest(join(dir, entry))), 0)
    const stale = sourceNewest > 0 && builtNewest > 0 && sourceNewest > builtNewest
    return {
      kind: 'local',
      status: 'ok',
      dir,
      stale,
      note: stale ? 'sources are newer than the build output; rebuild the package to load them' : 'local checkout',
      hasUpdate: false,
    }
  }

  // ---------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------

  /** Turn one record plus its probe into a report line with the actions it allows. */
  summarise(record) {
    const probe = record.probe ?? { kind: 'none', status: 'skipped' }
    const entry = {
      id: record.id,
      name: record.name,
      title: record.title,
      version: record.version,
      spec: record.spec,
      kind: record.kind,
      host: record.host,
      url: probe.url ?? record.url ?? record.repoUrl,
      enabled: record.enabled,
      managed: record.managed,
      builtin: record.kind === 'builtin',
      dir: record.dir,
      dsh: record.dsh,
      exemptions: record.exemptions ?? [],
      probe,
      actions: [],
      status: 'current',
    }
    if (record.kind === 'builtin') {
      entry.status = record.dsh.ok ? 'builtin' : 'incompatible'
      return entry
    }
    if (record.kind === 'missing') {
      entry.status = 'error'
      return entry
    }
    if (probe.status === 'error') {
      entry.status = 'error'
      return entry
    }
    if (!record.dsh.ok) {
      entry.status = probe.status === 'ok' && probe.blockedLatest !== undefined ? 'incompatible-update' : 'incompatible'
      entry.actions.push('incompatible')
      return entry
    }
    if (probe.hasUpdate === true) {
      entry.status = 'update'
      entry.actions.push('update')
      return entry
    }
    // A private repository without release tags still moves only when the
    // recorded spec pins a commit behind the head; the tag probe above already
    // proved that no tag supersedes the installed version, so an unpinned spec
    // is current rather than unknown.
    if (probe.kind === 'git' && probe.status === 'unknown' && probe.head !== undefined && isVersion(record.version)) {
      entry.status = probe.hasUpdate === true ? 'update' : 'current'
      if (entry.status === 'update') entry.actions.push('update')
      return entry
    }
    // The newest tag can be older than the installed version: this repository
    // installs from a branch, which runs ahead of its last release tag. The page
    // reads "current → 0.1.1" from that pair, so the probe says which number is
    // the tag rather than letting it read as a target.
    if (probe.kind === 'git' && probe.status === 'ok' && probe.latest !== undefined && probe.hasUpdate !== true && compareVersions(probe.latest, record.version) < 0) {
      entry.note = `the newest release tag on the remote is ${probe.latest}, older than the installed version; the plugin is installed from a commit, so the tag is not an older version to install`
    }
    if (probe.kind === 'local' && probe.stale === true) {
      entry.status = 'stale'
      return entry
    }
    if (probe.status === 'unknown') entry.status = 'unknown'
    return entry
  }

  /**
   * Build the update report: every plugin, its compatibility, and its probe result.
   * @param {object} [scanOptions] - `probe: false` skips the network, `signal` cancels.
   * @returns {Promise<object>} The report.
   */
  async scan(scanOptions = {}) {
    const signal = scanOptions.signal
    const records = await this.readInventory()
    const shouldProbe = this.options.probe && scanOptions.probe !== false
    await Promise.all(
      records.map(async (record) => {
        if (!shouldProbe || !record.managed || record.kind === 'builtin') {
          if (record.probe.status === 'pending') record.probe = { kind: record.kind, status: 'skipped', note: 'not probed' }
          return
        }
        try {
          if (record.kind === 'local') record.probe = this.probeLocal(record)
          else if (record.kind === 'git') record.probe = await this.probeGit(record, signal)
          else if (record.kind === 'tarball') record.probe = await this.probeTarball(record, signal)
          else record.probe = await this.probeRegistry(record, signal)
        } catch (error) {
          if (signal?.aborted === true) throw error
          record.probe = { kind: record.kind, status: 'error', note: String(error?.message ?? error) }
        }
      }),
    )
    const entries = records.map((record) => this.summarise(record))
    const counts = { total: entries.length, updates: 0, blocked: 0, incompatible: 0, errors: 0, stale: 0 }
    for (const entry of entries) {
      if (entry.status === 'update') counts.updates += 1
      else if (entry.status === 'incompatible-update') counts.blocked += 1
      else if (entry.status === 'incompatible') counts.incompatible += 1
      else if (entry.status === 'error') counts.errors += 1
      else if (entry.status === 'stale') counts.stale += 1
    }
    return { runtimeVersion: this.runtimeVersion, scannedAt: new Date().toISOString(), probed: shouldProbe, entries, counts }
  }

  /** Read the report, scanning when it is absent or older than the caller allows. */
  async ensureReport(scanOptions = {}) {
    const maxAgeMs = Math.max(1, Number(scanOptions.maxAgeMinutes ?? 10)) * 60_000
    if (this.lastReport !== null && scanOptions.force !== true && Date.now() - Date.parse(this.lastReport.scannedAt) < maxAgeMs) return this.lastReport
    this.lastReport = await this.scan(scanOptions)
    return this.lastReport
  }

  // ---------------------------------------------------------------------------
  // Applying changes
  // ---------------------------------------------------------------------------

  /** Rows a bundle owns that the user switched off in the profile patch. */
  disabledRowIds(rows) {
    if (this.profileDir === undefined) return []
    let patch
    try {
      patch = readFileSync(join(this.profileDir, 'cordis.patch.yml'), 'utf8')
    } catch {
      return []
    }
    const own = new Set((rows ?? []).map((row) => row.rowId))
    const disabled = new Set()
    for (const block of patch.split(/^\s*-\s+(?=id:)/m)) {
      const id = /^\s*id:\s*['"]?([^'"\s]+)['"]?/.exec(block)
      if (id === null || !own.has(id[1])) continue
      if (/^\s*disabled:\s*true\b/m.test(block)) disabled.add(id[1])
    }
    return [...disabled]
  }

  /**
   * Install one exact target and put back what a reinstall rewrites.
   *
   * A reinstall re-derives the dependency spec and the bundle selection from the
   * new package, so both are snapshotted first: the user's recorded spec is
   * restored, bundle-list membership is preserved, and rows that were switched
   * off are switched off again.
   */
  async reinstall(record, spec) {
    const manager = this.ctx.get('pluginManager')
    if (manager === undefined) throw new Error('the plugin manager is unavailable in this profile')
    const before = this.profileManifest()
    const dependency = before?.dependencies?.[record.name]
    const bundles = before?.dsh?.profile?.bundles ?? []
    const disabledRows = this.disabledRowIds(record.rows)
    let registry
    try {
      registry = await this.ctx.get('pluginRegistryProbe')?.fastest?.()
    } catch {
      registry = undefined
    }
    const result = await manager.installBundle(spec, { enabled: record.enabled !== false, saveExact: true, registry: registry ?? undefined })
    this.restoreManifest(record.name, dependency, bundles)
    const restoredRows = []
    for (const rowId of disabledRows) {
      const row = (record.rows ?? []).find((candidate) => candidate.rowId === rowId)
      if (row?.entryId === undefined) continue
      try {
        const answer = await manager.setPluginEnabled(row.entryId, false)
        if (answer?.application !== 'failed') restoredRows.push(rowId)
      } catch {
        /* the page shows the resulting switch state */
      }
    }
    return {
      ok: result?.application !== 'failed' && result?.application !== 'cancelled',
      application: result?.application,
      error: result?.error,
      warnings: result?.warnings,
      pendingBuilds: result?.pendingBuilds,
      restoredRows,
      message: describeChange(result),
    }
  }

  /** Put the recorded dependency spec and bundle-list membership back. */
  restoreManifest(packageName, dependency, bundles) {
    if (this.profileDir === undefined) return
    const file = join(this.profileDir, 'package.json')
    const manifest = readJson(file)
    if (manifest === undefined) return
    let changed = false
    if (dependency !== undefined && manifest.dependencies?.[packageName] !== dependency) {
      manifest.dependencies = { ...(manifest.dependencies ?? {}), [packageName]: dependency }
      changed = true
    }
    const current = manifest?.dsh?.profile?.bundles
    if (Array.isArray(current) && bundles.length !== 0 && bundles.some((bundle) => !current.includes(bundle))) {
      manifest.dsh.profile.bundles = bundles
      changed = true
    }
    if (changed) {
      try {
        writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`)
      } catch {
        /* a read-only profile shows up as the wrong recorded spec on the next read */
      }
    }
  }

  /** Widen the installed manifest's dsh constraint so it admits the runtime. */
  widenConstraint(record) {
    if (record.dir === undefined) return { ok: false, message: 'the installed package directory could not be located' }
    const file = join(record.dir, 'package.json')
    const manifest = readJson(file)
    if (manifest === undefined) return { ok: false, message: `cannot read ${file}` }
    const constraint = dshConstraintOf(manifest)
    if (constraint === null) return { ok: false, message: 'the package declares no dsh requirement to widen' }
    if (['workspace:^', 'workspace:~', 'workspace:*'].includes(constraint.range)) return { ok: false, message: 'the declared range refers to the workspace, not to a dsh version' }
    if (satisfies(this.runtimeVersion, constraint.range)) return { ok: true, already: true, range: constraint.range }
    const range = `${constraint.range} || ${this.runtimeVersion}`
    if (constraint.field === 'engines.dsh') manifest.engines = { ...(manifest.engines ?? {}), dsh: range }
    else manifest.peerDependencies = { ...(manifest.peerDependencies ?? {}), [constraint.key]: range }
    try {
      writeFileSync(file, `${JSON.stringify(manifest, undefined, 2)}\n`)
    } catch (error) {
      return { ok: false, message: `cannot write ${file}: ${String(error?.message ?? error)}` }
    }
    return { ok: true, range, where: constraint.field === 'engines.dsh' ? 'engines.dsh' : `peerDependencies["${constraint.key}"]` }
  }

  /**
   * Make one plugin fit the running dsh.
   *
   * Preferred order: install the newest registry release that declares support
   * for this dsh; when that is the version already installed, only the declared
   * range is behind, so widen it. With no compatible release, the user's
   * acceptance is recorded as the Harness's own exact-version exemption.
   */
  async makeCompatible(record, accept) {
    const manager = this.ctx.get('pluginManager')
    if (manager === undefined) throw new Error('the plugin manager is unavailable in this profile')
    const target = record.probe?.compatibleLatest
    if (record.kind === 'npm' && target !== undefined && target !== record.version) {
      const outcome = await this.reinstall(record, `${record.name}@${target}`)
      return { ...outcome, to: target, mode: outcome.ok ? 'upgraded' : 'upgrade-failed' }
    }
    if (record.kind === 'npm' || record.kind === 'local') {
      const widened = this.widenConstraint(record)
      if (widened.ok) {
        return {
          ok: true,
          mode: 'widened',
          to: record.version,
          message: widened.already === true ? 'the installed version already declares this dsh' : `widened ${widened.where} to ${widened.range}`,
        }
      }
      if (accept !== true) return { ok: false, mode: 'needs-consent', message: `${widened.message}; accepting the risk records an exact-version exemption instead` }
    }
    if (record.kind === 'git' && record.probe?.hasUpdate === true && record.probe?.head !== undefined) {
      const outcome = await this.reinstall(record, `${normaliseGitUrl(record.url ?? record.spec)}#${record.probe.head}`)
      return { ...outcome, to: record.probe.head, mode: 'git-head' }
    }
    if (accept !== true) {
      return { ok: false, mode: 'needs-consent', message: 'no release of this plugin declares support for the running dsh; accepting the risk records an exact-version exemption' }
    }
    const result = await manager.setVersionExemption(exemptionKey(record.name, record.version), this.runtimeVersion, true, true)
    return {
      ok: result?.application !== 'failed',
      mode: 'exemption',
      message:
        result?.application === 'failed'
          ? describeChange(result)
          : `recorded the exact-version exemption for ${exemptionKey(record.name, record.version)} on dsh ${this.runtimeVersion}`,
    }
  }

  /** Serialise every profile mutation. */
  async exclusive(operation) {
    if (this.busy) return { ok: false, message: 'another update is already running' }
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }

  /**
   * Apply the plan a caller confirmed.
   * @param {object} [plan] - `{ updates: [{ id, version? }], incompatible: [{ id, accept? }] }`.
   * @param {object} [scanOptions] - Forwarded to {@link ensureReport} and the closing rescan: `force` reads the live state, `signal` cancels.
   * @returns {Promise<object>} One outcome per item.
   */
  async apply(plan = {}, scanOptions = {}) {
    const items = [...(plan.updates ?? []).map((item) => ({ ...item, intent: 'update' })), ...(plan.incompatible ?? []).map((item) => ({ ...item, intent: 'incompatible' }))]
    if (items.length === 0) return { ok: false, message: 'the plan is empty', items: [] }
    if (this.ctx.get('pluginManager') === undefined) return { ok: false, message: 'the plugin manager is unavailable in this profile', items: [] }
    const current = await this.ensureReport({ maxAgeMinutes: 10, force: scanOptions.force === true, signal: scanOptions.signal })
    const byId = new Map(current.entries.map((entry) => [entry.id, entry]))
    return this.exclusive(async () => {
      const outcomes = []
      for (const item of items) {
        const entry = byId.get(item.id)
        if (entry === undefined) {
          outcomes.push({ id: item.id, ok: false, message: `no plugin named "${item.id}" is in the current report; ids look like \`profile:<package>\`, or pass a package name` })
          continue
        }
        if (entry.builtin) {
          outcomes.push({ id: item.id, ok: false, message: 'this plugin ships with dsh itself and is updated together with dsh' })
          continue
        }
        try {
          const record = (await this.readInventory()).find((candidate) => candidate.id === item.id)
          if (record === undefined) {
            outcomes.push({ id: item.id, ok: false, message: 'the plugin is no longer installed' })
            continue
          }
          if (item.intent === 'incompatible') {
            outcomes.push({ id: item.id, action: 'incompatible', ...(await this.makeCompatible(record, item.accept === true)) })
            continue
          }
          if (record.kind === 'git') {
            const head = item.version === undefined ? record.probe?.head : item.version
            const outcome = await this.reinstall(record, `${normaliseGitUrl(record.url ?? record.spec)}#${head ?? 'HEAD'}`)
            outcomes.push({ id: item.id, action: 'update', to: record.probe?.latest ?? head, ...outcome })
            continue
          }
          const target = item.version ?? entry.probe?.compatibleLatest
          const outcome =
            target === undefined
              ? { ok: false, message: 'no target version is known for this plugin; run a check first' }
              : await this.reinstall(record, `${record.name}@${target}`)
          outcomes.push({ id: item.id, action: 'update', to: target, ...outcome })
        } catch (error) {
          outcomes.push({ id: item.id, ok: false, message: String(error?.message ?? error) })
        }
      }
      this.lastPlan = { at: new Date().toISOString(), outcomes }
      // A failed rescan must not be cached as the report: the next `show` would
      // then serve a scan that never completed.
      const rescanned = await this.scan({ signal: scanOptions.signal }).catch(() => undefined)
      if (rescanned !== undefined) this.lastReport = rescanned
      return { ok: outcomes.every((outcome) => outcome.ok !== false), items: outcomes }
    })
  }

  /** Drop every exemption this profile records for the running dsh. */
  async clearExemptions() {
    const manager = this.ctx.get('pluginManager')
    if (manager === undefined) return { ok: false, message: 'the plugin manager is unavailable in this profile', removed: [] }
    return this.exclusive(async () => {
      const removed = []
      for (const [key, versions] of Object.entries(this.exemptions())) {
        for (const version of versions ?? []) {
          if (version !== this.runtimeVersion) continue
          try {
            const answer = await manager.setVersionExemption(key, version, false, false)
            if (answer?.application !== 'failed') removed.push(`${key} on ${version}`)
          } catch {
            /* a malformed compatibility.json is reported by its own reader */
          }
        }
      }
      this.lastReport = await this.scan().catch(() => this.lastReport)
      return { ok: true, removed, message: removed.length === 0 ? 'nothing to clear' : `cleared ${removed.length} exemption${removed.length === 1 ? '' : 's'}` }
    })
  }

  /** Bounded facts for the agent tool: no long notes, no secrets. */
  async summary() {
    const current = await this.ensureReport({ maxAgeMinutes: 10 })
    return {
      runtimeVersion: current.runtimeVersion,
      scannedAt: current.scannedAt,
      counts: current.counts,
      plugins: current.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        kind: entry.kind,
        status: entry.status,
        latest: entry.probe?.compatibleLatest ?? entry.probe?.latest,
        blockedLatest: entry.probe?.blockedLatest,
        // The commit the remote actually tracks, so an update that installs it
        // is not mistaken for an install of `latest`.
        head: entry.probe?.headMoved === true ? entry.probe?.head : undefined,
        requirements: entry.dsh?.ok === false ? entry.dsh.requirements : undefined,
        note: entry.probe?.note,
      })),
      lastPlan: this.lastPlan ?? undefined,
    }
  }
}

/**
 * Build the Host plugin.
 * @param {object} ctx - Cordis host context.
 * @param {object} config - The row's Config.
 */
export function apply(ctx, config) {
  const options = {
    timeoutMs: Number(config?.timeoutMs ?? 30000),
    probe: config?.probe !== false,
    fallbackRegistry: String(config?.fallbackRegistry ?? 'https://registry.npmjs.org/'),
    agentToolMirrorsPlan: config?.agentToolMirrorsPlan === true,
    gitTokenEnv: String(config?.gitTokenEnv ?? 'DSH_PLUGIN_UPDATER_TOKEN'),
  }
  const updater = new Updater(ctx, options)

  // Read the plugin table on boot so a page opened later starts from real rows.
  ctx.effect(() => {
    let disposed = false
    const timer = setTimeout(() => {
      if (!disposed) updater.scan({ probe: false }).catch(() => undefined)
    }, 4000)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, 'dsh-plugin-updater: initial table')

  // Register the agent tool when a tool registry exists in this profile. The
  // callback runs on arrival and its registrations are disposed with this row.
  ctx.inject(['tools'], (scoped) => {
    scoped.effect(
      () => scoped.tools.register({
        name: 'plugin_update',
        description:
          'Check or apply dsh plugin updates for this profile. `check` probes every installed plugin (npm registry, git remote, dsh requirement) and returns the report; `show` returns the cached report without network access; `apply` updates the named plugins and, for plugins whose newest release exceeds the running dsh, makes them compatible by installing the newest compatible release, widening a stale declared dsh range, or recording the exact-version exemption when the caller passes accept: true.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['check', 'show', 'apply'], description: 'check probes; show uses the cached report; apply runs the plan.' },
            updates: {
              type: 'array',
              description: 'For apply: plugins to update, identified by report id or package name.',
              items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' } }, required: ['id'] },
            },
            incompatible: {
              type: 'array',
              description: 'For apply: plugins to make compatible with the running dsh.',
              items: { type: 'object', properties: { id: { type: 'string' }, accept: { type: 'boolean' } }, required: ['id'] },
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, undefined, 2) }],
        },
        async execute(args, exec) {
          const input = args ?? {}
          exec.signal?.throwIfAborted?.()
          if (input.action === 'check' || input.action === 'show') return updater.summary()
          if (input.action !== 'apply') throw new Error('action must be check, show or apply')
          if (options.agentToolMirrorsPlan !== true) {
            throw new Error('this profile lets the user confirm plugin changes on the Plugins page only; set agentToolMirrorsPlan: true on the plugin-updater row to let the agent apply a plan too')
          }
          const resolve = (value) => updater.lastReport?.entries?.find((entry) => entry.id === value || entry.name === value)?.id ?? value
          // Once per call: the default ten-minute cache otherwise keeps reporting
          // the state before the change, which is exactly what "check" then shows.
          return updater.apply(
            {
              updates: (input.updates ?? []).map((item) => ({ id: resolve(item.id), version: item.version })),
              incompatible: (input.incompatible ?? []).map((item) => ({ id: resolve(item.id), accept: item.accept === true })),
            },
            { force: true },
          )
        },
      }),
      'dsh-plugin-updater: plugin_update tool',
    )
  })
}
