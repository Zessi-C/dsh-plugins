window.__ModuleLoader__.load({
  id: 'dsh-plugin-updater',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace; must match the Host row's locale resources. */
    const NS = 'plugin-updater'

    /** Credential reference the Host reads for private repositories. */
    const TOKEN_REF = 'DSH_PLUGIN_UPDATER_TOKEN'

    /**
     * The update run in flight.
     *
     * A package update takes as long as pnpm does, and installing any bundle
     * recomposes the client graph, which can remount this page. Keeping the run
     * outside the component means a remount shows the progress instead of
     * losing it, and the page never has to block on the operation.
     */
    const taskStore = { state: null, listeners: new Set() }

    function publishTask(next) {
      taskStore.state = next
      for (const listener of [...taskStore.listeners]) listener()
    }

    /** Subscribe a component to the background run. */
    function useBackgroundTask() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1)
        taskStore.listeners.add(listener)
        return () => taskStore.listeners.delete(listener)
      }, [])
      return taskStore.state
    }

    /**
     * Report ids the Host agent tool uses, mirrored here so a plan chosen on the
     * page reads exactly like one the agent would build.
     */
    const LOCAL = (name) => `profile:${name}`

    //#region dictionaries

    const zh = {
      tab: '插件更新',
      refresh: '检查更新',
      checking: '正在检查…',
      refreshTip: '重新探测 npm registry、git 远端和 dsh 兼容范围',
      'summary:total': '插件',
      'summary:updates': '可更新',
      'summary:blocked': '超出 dsh',
      sectionUpdates: '可更新',
      sectionBlocked: '版本不兼容',
      sectionCurrent: '已是最新',
      sectionLocal: '本地插件',
      sectionBuiltin: '随 dsh 安装',
      sectionError: '读取失败',
      update: '更新',
      'updateTo:one': '更新到',
      accept: '接受风险',
      acceptTitle: '记录精确版本豁免',
      acceptBodyHead: '将在 profile 的 compatibility.json 中记录这条精确版本豁免：',
      acceptBodyTail: '这只是在启动检查里放行，插件的代码是否真的适配由你判断；Harness 官方说明该操作可能导致崩溃或数据丢失。',
      acceptConfirm: '记录豁免',
      cancel: '取消',
      apply: '应用所选',
      applying: '正在应用…',
      'selected:one': '已选',
      applyDone: '应用完成',
      reloadHint: '有些插件需要重启 dsh 才会加载新代码；重启前页面会保留原状态。',
      colName: '插件',
      colVersion: '已装',
      colLatest: '最新',
      colDsh: 'dsh 要求',
      colActions: '操作',
      latestCompatible: '可用',
      noCompatible: '无兼容版本',
      blockedLatestHead: '最新版不声明支持当前 dsh：',
      upToDate: '已是最新',
      satisfied: '满足',
      sectionUnknown: '无法核对',
      unknown: '未知',
      unverified: '私有仓库或离线，浏览器端无法读取版本',
      tokenTitle: '私有仓库凭据',
      tokenHint: '读取私有仓库需要的 token，保存在 dsh 凭据存储里（~/.dsh/.credentials.yaml），只发给 github.com、gitlab.com、bitbucket.org。',
      tokenPlaceholder: '粘贴 GitHub token（repo 权限即可）',
      tokenSave: '保存',
      tokenClear: '清除',
      tokenConfigured: '已配置',
      tokenMissing: '未配置',
      tokenSaved: '已保存',
      tokenCleared: '已清除',
      tokenFailed: '操作失败',
      tokenOpen: '凭据',
      progressDone: '更新完成',
      dismiss: '收起',
      exempted: '已豁免',
      undoExemption: '撤销豁免',
      local: '本地目录',
      localLinked: '本地目录（link/file），不联网探测',
      localStale: '源码比构建产物新，需要重新构建',
      builtinNote: '随 dsh 一起升级',
      requirements: '不满足的要求',
      registry: 'registry',
      gitRemote: 'git 远端',
      gitHeadHead: '远端 HEAD',
      errorNote: '读取失败',
      clear: '清除全部豁免',
      'clearDone:one': '已清除豁免数',
      clearNone: '没有可清除的豁免',
      empty: '没有已安装的第三方插件。',
      unavailable: '插件管理器在此 profile 中不可用。',
      noRemote: '浏览器端无法访问插件管理器服务。',
      noRepair: '仅随 dsh 安装的插件：升级 dsh 本身即可。',
      needsRestart: '需要重启 dsh',
      appliedNow: '已生效',
      failed: '失败',
      notSelected: '未选择任何更新。',
      progressTitle: '正在更新',
      target: '目标',
      searchPlaceholder: '筛选插件…',
      showAll: '显示全部',
      releaseChannel: '发布通道',
    }

    const en = {
      tab: 'Plugin updates',
      refresh: 'Check for updates',
      checking: 'Checking…',
      refreshTip: 'Probe the npm registry, git remotes and dsh requirement ranges again',
      'summary:total': 'plugins',
      'summary:updates': 'updates',
      'summary:blocked': 'above dsh',
      sectionUpdates: 'Updates',
      sectionBlocked: 'Not compatible',
      sectionCurrent: 'Up to date',
      sectionLocal: 'Local plugins',
      sectionBuiltin: 'Shipped with dsh',
      sectionError: 'Unreadable',
      update: 'Update',
      'updateTo:one': 'Update to',
      accept: 'Accept risk',
      acceptTitle: 'Record an exact-version exemption',
      acceptBodyHead: "Record in the profile's compatibility.json that this exact version may run on this dsh:",
      acceptBodyTail: 'It only relaxes the startup check; whether the plugin code really fits is your judgement, and the Harness warns that running it may cause crashes or data loss.',
      acceptConfirm: 'Record exemption',
      cancel: 'Cancel',
      apply: 'Apply selected',
      applying: 'Applying…',
      'selected:one': 'selected',
      applyDone: 'Applied',
      reloadHint: 'Some plugins load their new code only after dsh restarts.',
      colName: 'Plugin',
      colVersion: 'Installed',
      colLatest: 'Latest',
      colDsh: 'dsh requirement',
      colActions: 'Actions',
      latestCompatible: 'available',
      noCompatible: 'none compatible',
      blockedLatestHead: 'newest release does not declare this dsh:',
      upToDate: 'Up to date',
      satisfied: 'met',
      sectionUnknown: 'Unverified',
      unknown: 'unknown',
      unverified: 'private or offline; the browser cannot read the version',
      tokenTitle: 'Private repository credential',
      tokenHint: 'Token for private repositories. It is stored in the dsh credential store (~/.dsh/.credentials.yaml) and sent only to github.com, gitlab.com and bitbucket.org.',
      tokenPlaceholder: 'Paste a GitHub token with repo scope',
      tokenSave: 'Save',
      tokenClear: 'Clear',
      tokenConfigured: 'configured',
      tokenMissing: 'not configured',
      tokenSaved: 'Saved',
      tokenCleared: 'Cleared',
      tokenFailed: 'Failed',
      tokenOpen: 'Credential',
      progressDone: 'Finished',
      dismiss: 'Hide',
      exempted: 'exempted',
      undoExemption: 'Undo exemption',
      local: 'Local',
      localLinked: 'Local directory (link/file); not probed over the network',
      localStale: 'Sources are newer than the build output; rebuild the package',
      builtinNote: 'Updated with dsh',
      requirements: 'Unmet requirements',
      registry: 'registry',
      gitRemote: 'git remote',
      gitHeadHead: 'remote HEAD',
      errorNote: 'Could not read',
      clear: 'Clear all exemptions',
      'clearDone:one': 'cleared exemptions',
      clearNone: 'Nothing to clear',
      empty: 'No third-party plugins are installed.',
      unavailable: 'The plugin manager is unavailable in this profile.',
      noRemote: 'The browser cannot reach the plugin manager service.',
      noRepair: 'Shipped with dsh; update dsh itself.',
      needsRestart: 'Restart dsh to load the new code',
      appliedNow: 'Applied',
      failed: 'Failed',
      notSelected: 'Nothing was selected.',
      progressTitle: 'Updating',
      target: 'Target',
      searchPlaceholder: 'Filter plugins…',
      showAll: 'Show all',
      releaseChannel: 'Release channel',
    }

    //#endregion

    //#region styles

    const CSS = `
.pu-root{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.pu-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pu-spacer{flex:1}
.pu-summary{color:var(--dsw-alias-label-secondary);font-size:12px}
.pu-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:12.5px;cursor:pointer;transition:background .12s,border-color .12s,opacity .12s}
.pu-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pu-btn:disabled{opacity:.55;cursor:default}
.pu-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pu-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.pu-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.92}
.pu-search{flex:0 0 200px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 10px;font:inherit;font-size:12.5px}
.pu-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pu-section{display:flex;flex-direction:column;gap:8px}
.pu-section-head{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);text-transform:none}
.pu-count{font-weight:400;color:var(--dsw-alias-state-idle-primary)}
.pu-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.pu-row{display:grid;grid-template-columns:24px minmax(150px,1.4fr) minmax(70px,.6fr) minmax(90px,.8fr) minmax(130px,1.4fr) auto;gap:10px;align-items:center;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.pu-row:first-child{border-top:none}
.pu-row:hover{background:var(--dsw-alias-bg-layer-2)}
.pu-head-row{background:transparent;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:600;padding-top:7px;padding-bottom:7px}
.pu-head-row:hover{background:transparent}
.pu-name{display:flex;flex-direction:column;gap:2px;min-width:0}
.pu-name-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pu-name-pkg{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pu-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.pu-dim{color:var(--dsw-alias-label-secondary)}
.pu-badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;white-space:nowrap;border:1px solid transparent}
.pu-badge-update{background:rgba(35,134,54,.12);color:var(--dsw-alias-state-success-primary);border-color:rgba(35,134,54,.35)}
.pu-badge-blocked{background:rgba(191,90,0,.12);color:var(--dsw-alias-state-warn-primary);border-color:rgba(191,90,0,.35)}
.pu-badge-error{background:rgba(190,30,30,.12);color:var(--dsw-alias-state-error-primary);border-color:rgba(190,30,30,.35)}
.pu-badge-muted{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.pu-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.pu-note{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pu-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.pu-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px}
.pu-modal{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;max-width:560px;width:100%;padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 48px rgba(0,0,0,.35)}
.pu-modal h3{margin:0;font-size:15px;font-weight:600}
.pu-modal p{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.pu-modal-foot{display:flex;justify-content:flex-end;gap:8px}
.pu-progress{display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto}
.pu-progress-item{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:7px}
.pu-progress-item:first-child{border-top:none;padding-top:0}
.pu-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.pu-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
@media (max-width:820px){.pu-row{grid-template-columns:24px 1fr auto;row-gap:6px}.pu-head-row{display:none}.pu-col-hide{display:none}}
.pu-token{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.pu-token-head{display:flex;align-items:baseline;gap:10px;font-size:12.5px}
.pu-token-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.pu-token-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pu-token-input{flex:1 1 260px;min-width:200px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pu-ok{color:var(--dsw-alias-state-success-primary);font-size:11.5px}
.pu-task{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px;display:flex;flex-direction:column;gap:8px}
.pu-task-head{display:flex;align-items:baseline;gap:10px;font-size:12.5px}
.pu-bar-track{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.pu-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
`

    //#endregion

    //#region helpers

    /**
     * Compare two versions. The Host half owns the authoritative semver engine;
     * the browser only needs an ordering for display and for picking the newer
     * of two releases, which this comparison covers.
     */
    function compareVersions(a, b) {
      const parse = (value) => {
        const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value ?? ''))
        return match === null ? undefined : { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] }
      }
      const left = parse(a)
      const right = parse(b)
      if (left === undefined || right === undefined) return 0
      for (let index = 0; index < 3; index += 1) {
        if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index]
      }
      if (left.pre === undefined && right.pre === undefined) return 0
      if (left.pre === undefined) return 1
      if (right.pre === undefined) return -1
      return left.pre < right.pre ? -1 : left.pre > right.pre ? 1 : 0
    }

    /**
     * Whether a version satisfies a range, mirroring
     * `semver.satisfies(v, r, { includePrerelease: true })` for the range forms
     * package manifests use. The Host half answers this authoritatively for the
     * report it serves the agent; the page needs it to decide what to offer.
     */
    function satisfies(version, range) {
      if (typeof range !== 'string' || range.trim() === '') return true
      return range
        .split('||')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .some((part) => satisfiesSet(version, part))
    }

    function satisfiesSet(version, range) {
      const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(range)
      if (hyphen !== null) return compareVersions(version, hyphen[1]) >= 0 && compareVersions(version, hyphen[2]) <= 0
      let low = '0.0.0'
      let lowExclusive = false
      let high
      let highExclusive = true
      for (const token of range.split(/\s+/).filter((part) => part !== '')) {
        const match = /^(\^|~|>=|>|<=|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(token)
        if (match === null) {
          const loose = /^(\^|~)?\s*v?(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(token)
          if (loose === null) continue
          const operator = loose[1]
          const major = Number(loose[2])
          const looseMinor = loose[3] === undefined || /^[xX*]$/.test(loose[3])
          const loosePatch = loose[4] === undefined || /^[xX*]$/.test(loose[4])
          const minor = looseMinor ? 0 : Number(loose[3])
          const patch = loosePatch ? 0 : Number(loose[4])
          low = `${major}.${minor}.${patch}`
          if (operator === '~') high = `${major}.${minor + 1}.0-0`
          else if (operator === '^' || looseMinor) high = major > 0 ? `${major + 1}.0.0-0` : `0.${minor + 1}.0-0`
          else if (loosePatch) high = `${major}.${minor + 1}.0-0`
          else high = low
          continue
        }
        const operator = match[1] ?? '='
        const value = match[2]
        if (operator === '<' || operator === '<=') {
          high = value
          highExclusive = operator === '<'
          continue
        }
        if (operator === '>' || operator === '>=') {
          if (compareVersions(value, low) > 0) {
            low = value
            lowExclusive = operator === '>'
          }
          continue
        }
        const [major, minor] = value.split('.').map(Number)
        if (operator === '^') {
          low = value
          high = major > 0 ? `${major + 1}.0.0-0` : `0.${minor + 1}.0-0`
        } else if (operator === '~') {
          low = value
          high = `${major}.${minor + 1}.0-0`
        } else {
          low = value
          high = value
          highExclusive = false
        }
      }
      if (compareVersions(version, low) < 0) return false
      if (lowExclusive && compareVersions(version, low) === 0) return false
      if (high !== undefined) {
        const order = compareVersions(version, high)
        if (order > 0 || (order === 0 && highExclusive)) return false
      }
      return true
    }

    /** Reproduce the Host's dsh requirement rule for one manifest. */
    function dshRequirements(manifest, runtime) {
      const engines = manifest?.engines ?? {}
      const peers = manifest?.peerDependencies ?? {}
      const all = {}
      const unmet = {}
      if (typeof engines.dsh === 'string') {
        all['engines.dsh'] = engines.dsh
        if (!satisfies(runtime, engines.dsh)) unmet['engines.dsh'] = engines.dsh
        return { all, unmet }
      }
      for (const [name, range] of Object.entries(peers)) {
        if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
        if (typeof range !== 'string') continue
        all[name] = range
        const effective = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range
        if (!satisfies(runtime, effective)) unmet[name] = range
      }
      return { all, unmet }
    }

    /** Classify the dependency spec recorded in the profile manifest. */
    /**
     * Split a git fragment into the ref and the package subdirectory, mirroring
     * the Host's parser. pnpm writes both into one fragment joined by `&`, so
     * reading it as a bare ref loses the package directory.
     */
    function parseFragment(fragment) {
      if (typeof fragment !== 'string' || fragment === '') return {}
      let ref
      let subdirectory
      for (const part of fragment.split('&')) {
        const trimmed = part.trim()
        if (trimmed === '') continue
        const match = /^path[:=](.*)$/i.exec(trimmed)
        if (match !== null) {
          const value = match[1].replace(/^\/+|\/+$/g, '')
          if (value !== '') subdirectory = value
          continue
        }
        if (ref === undefined) ref = trimmed
      }
      return { ...(ref === undefined || ref === '' ? {} : { ref }), ...(subdirectory === undefined ? {} : { subdirectory }) }
    }

    const fragmentOf = (text) => (text.includes('#') ? text.slice(text.indexOf('#') + 1) : undefined)

    function classifySpec(spec) {
      const text = String(spec ?? '').trim()
      if (text === '') return { kind: 'npm' }
      if (/^(file:|link:|portal:|workspace:)/i.test(text)) return { kind: 'local' }
      if (/^(github|gitlab|bitbucket):/i.test(text)) {
        const colon = text.indexOf(':')
        const scheme = text.slice(0, colon)
        const rest = text.slice(colon + 1)
        const hash = rest.indexOf('#')
        const path = hash === -1 ? rest : rest.slice(0, hash)
        return { kind: 'git', host: scheme, url: `https://${scheme}.com/${path}`, ...parseFragment(hash === -1 ? undefined : rest.slice(hash + 1)) }
      }
      if (/^(git\+|git@|git:\/\/)/i.test(text) || /\.git(?:#|$)/.test(text)) return { kind: 'git', url: text, ...parseFragment(fragmentOf(text)) }
      if (/^https?:\/\//i.test(text)) return { kind: /\.tgz(?:#.*)?$/i.test(text) ? 'tarball' : 'git', url: text, ...parseFragment(fragmentOf(text)) }
      if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:#.*)?$/.test(text)) {
        const hash = text.indexOf('#')
        const path = hash === -1 ? text : text.slice(0, hash)
        return { kind: 'git', host: 'github', url: `https://github.com/${path}`, ...parseFragment(hash === -1 ? undefined : text.slice(hash + 1)) }
      }
      return { kind: 'npm' }
    }

    /** The https URL git and pnpm both accept. */
    function normaliseGitUrl(url) {
      let text = String(url ?? '')
      if (text.startsWith('github:')) text = `https://github.com/${text.slice(7)}`
      if (/^git@([^:]+):/.test(text)) text = text.replace(/^git@([^:]+):/, 'https://$1/')
      if (text.startsWith('git+')) text = text.slice(4)
      return text.replace(/#.*$/, '').replace(/\.git$/, '')
    }

    /** Fetch JSON with a timeout. */
    async function fetchJson(url, options = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000)
      try {
        const response = await fetch(url, { headers: options.headers, signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.json()
      } finally {
        clearTimeout(timer)
      }
    }

    /** The registries to ask: the manager's view first, then the official one. */
    async function registryCandidates(ctx) {
      const found = []
      try {
        const answer = await ctx.remote.pluginManager.registries()
        if (answer?.ok === true) {
          if (typeof answer.value.resolved === 'string') found.push(answer.value.resolved)
          for (const registry of answer.value.fallbackRegistries ?? []) found.push(registry)
          if (typeof answer.value.registry === 'string') found.push(answer.value.registry)
        }
      } catch {
        /* fall back to the official registry */
      }
      found.push('https://registry.npmjs.org/')
      return [...new Set(found.filter((entry) => typeof entry === 'string' && entry !== '').map((entry) => `${entry.replace(/\/+$/, '')}/`))]
    }

    /** Read a package's registry document from the first registry that answers. */
    async function packument(registries, packageName) {
      const encoded = packageName.startsWith('@') ? `@${encodeURIComponent(packageName.slice(1))}` : encodeURIComponent(packageName)
      for (const registry of registries) {
        try {
          const document = await fetchJson(`${registry}${encoded}`, { headers: { accept: 'application/vnd.npm.install-json, application/json' } })
          if (document !== null && typeof document.versions === 'object') return { ...document, registry }
        } catch {
          /* try the next registry */
        }
      }
      return undefined
    }

    /**
     * Read a git plugin's manifest from a public raw endpoint.
     *
     * The browser cannot run git and holds no repository credential, so a
     * private repository is simply unreadable here; the caller then reports the
     * plugin as unverified instead of guessing that it has an update.
     *
     * @param {object} parsed - Result of classifySpec.
     * @param {string} runtime - Running dsh version.
     * @returns {Promise<{ version: string, dshOk: boolean } | undefined>} Manifest facts, or undefined.
     */
    async function gitRawManifest(parsed, runtime) {
      const url = normaliseGitUrl(parsed.url)
      const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
      if (match === null) return undefined
      const [, host, owner, repo] = match
      const base =
        host === 'github.com'
          ? `https://raw.githubusercontent.com/${owner}/${repo}`
          : host === 'gitlab.com'
            ? `https://gitlab.com/${owner}/${repo}/-/raw`
            : host === 'bitbucket.org'
              ? `https://bitbucket.org/${owner}/${repo}/raw`
              : undefined
      if (base === undefined) return undefined
      const ref = typeof parsed.ref === 'string' && parsed.ref !== '' ? parsed.ref : 'main'
      const sub = typeof parsed.subdirectory === 'string' && parsed.subdirectory !== '' ? `${parsed.subdirectory}/` : ''
      try {
        const manifest = await fetchJson(`${base}/${ref}/${sub}package.json`, { timeoutMs: 12000 })
        if (manifest === null || typeof manifest.version !== 'string') return undefined
        const facts = dshRequirements(manifest, runtime)
        return { version: manifest.version, dshOk: Object.keys(facts.unmet).length === 0 }
      } catch {
        return undefined
      }
    }

    /** True when both versions name the same commit prefix. */
    function sameCommit(a, b) {
      if (typeof a !== 'string' || typeof b !== 'string') return false
      const short = (value) => value.slice(0, 7)
      return short(a) === short(b)
    }

    /** The head commit a recorded spec already pins, when it pins one. */
    function pinnedCommit(spec) {
      const match = /#([0-9a-f]{7,40})$/.exec(String(spec ?? ''))
      return match === null ? undefined : match[1]
    }

    //#endregion

    //#region controller

    /** One scan of the profile's plugins, exactly as the page lists them. */
    async function scanProfile(ctx, runtime, isCurrent) {
      const remote = ctx.remote?.pluginManager
      if (remote === undefined) throw new Error('no remote')
      const [bundlesAnswer, pluginsAnswer] = await Promise.all([remote.listBundles(), remote.listPlugins()])
      if (bundlesAnswer?.ok !== true || pluginsAnswer?.ok !== true) throw new Error('list failed')
      const bundles = bundlesAnswer.value
      const registries = await registryCandidates(ctx)
      // The page offers a precise undo, so it needs the recorded exemptions.
      let exemptions = {}
      try {
        const granted = await remote.listVersionExemptions?.()
        if (granted?.ok === true) exemptions = granted.value?.exemptions ?? {}
      } catch {
        exemptions = {}
      }
      const entries = await Promise.all(
        bundles.map(async (bundle) => {
          const shipped = bundle.availability === 'installation'
          const base = {
            id: shipped ? `builtin:${bundle.name}` : bundle.availability === 'profile' ? LOCAL(bundle.name) : `${bundle.availability}:${bundle.name}`,
            name: bundle.name,
            title: resolveTitle(bundle),
            version: bundle.version,
            spec: bundle.source,
            enabled: bundle.enabled,
            builtin: shipped,
            installed: bundle.availability === 'profile' && bundle.installed === true,
            rows: bundle.rows ?? [],
          }
          if (shipped) return { ...base, kind: 'builtin', status: 'builtin', dsh: { ok: true, requirements: {} }, probe: { status: 'ok', note: '' } }
          if (!base.installed) return { ...base, kind: 'missing', status: 'error', dsh: { ok: true, requirements: {} }, probe: { status: 'error', note: 'not installed' } }
          const parsed = classifySpec(bundle.source)
          const kind = parsed.kind
          let manifest
          if (parsed.host === 'github' || kind === 'git') {
            // The manifest of a git plugin is not on the profile's disk in a
            // comparable form; the probe below compares versions from the remote.
            manifest = undefined
          }
          const requirements = dshRequirements(manifest ?? {}, runtime)
          const dshOk = Object.keys(requirements.unmet).length === 0
          const exempted = (exemptions[`${bundle.name}@${base.version}`] ?? []).includes(runtime)
          if (kind === 'local') {
            return { ...base, kind, exempted, status: dshOk ? 'local' : 'incompatible', dsh: { ok: dshOk, requirements: requirements.unmet }, probe: { status: 'ok', note: 'local' } }
          }
          return { ...base, kind, exempted, status: 'checking', dsh: { ok: dshOk, requirements: requirements.unmet }, probe: { status: 'pending' }, parsed }
        }),
      )
      // Probe every npm and git plugin; discard results from a superseded scan.
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.parsed === undefined) return
          const parsed = entry.parsed
          if (parsed.kind === 'npm') {
            const document = await packument(registries, entry.name)
            if (document === undefined) {
              entry.probe = { status: 'error', note: 'no registry answered' }
            } else {
              const releases = Object.keys(document.versions)
                .map((version) => {
                  const facts = dshRequirements(document.versions[version] ?? {}, runtime)
                  return { version, deprecated: typeof document.versions[version]?.deprecated === 'string', dshOk: Object.keys(facts.unmet).length === 0 }
                })
                .sort((a, b) => compareVersions(a.version, b.version))
              const newer = releases.filter((release) => !release.deprecated && compareVersions(release.version, entry.version) > 0)
              const compatible = newer.filter((release) => release.dshOk)
              const blocked = newer.filter((release) => !release.dshOk)
              entry.probe = {
                status: 'ok',
                registry: document.registry,
                latest: document['dist-tags']?.latest,
                compatibleLatest: compatible.length === 0 ? undefined : compatible[compatible.length - 1].version,
                blockedLatest: blocked.length === 0 ? undefined : blocked[blocked.length - 1].version,
                requirements: blocked.length === 0 ? undefined : blocked[blocked.length - 1].requirements,
              }
              entry.hasUpdate = compatible.length > 0
            }
            return
          }
          // A git plugin: read its manifest where the host allows it, and otherwise
          // say the version is unverified rather than claim an update.
          const remote = await gitRawManifest(parsed, runtime)
          if (remote !== undefined) {
            const newer = compareVersions(remote.version, entry.version) > 0
            entry.probe = {
              status: 'ok',
              url: normaliseGitUrl(parsed.url),
              pinned: pinnedCommit(entry.spec),
              latest: remote.version,
              ...(newer ? { compatibleLatest: remote.version } : {}),
            }
            entry.hasUpdate = newer && remote.dshOk
            entry.remoteDshOk = remote.dshOk
          } else {
            entry.probe = {
              status: 'unknown',
              url: normaliseGitUrl(parsed.url),
              pinned: pinnedCommit(entry.spec),
              note: 'unverified',
            }
            entry.hasUpdate = false
          }
        }),
      )
      if (!isCurrent()) return undefined
      for (const entry of entries) {
        if (entry.builtin) continue
        if (entry.probe.status === 'error') {
          entry.status = 'error'
          continue
        }
        if (!entry.dsh.ok) {
          entry.status = entry.probe.blockedLatest === undefined ? 'incompatible' : 'incompatible-update'
          continue
        }
        if (entry.hasUpdate === true) {
          entry.status = 'update'
          continue
        }
        if (entry.kind === 'local') {
          entry.status = 'local'
          continue
        }
        entry.status = entry.probe.status === 'unknown' ? 'unknown' : 'current'
      }
      return { runtime, registries, entries, scannedAt: new Date().toISOString() }
    }

    /** Localised display text from a bundle's meta block. */
    function resolveTitle(bundle) {
      const title = bundle?.meta?.title
      if (typeof title === 'string') return title
      if (title !== null && typeof title === 'object') return title?.zh ?? title?.['zh-CN'] ?? title?.en ?? bundle.name
      return bundle.name
    }

    /** Compact components the page is built from. */
    function Badge(props) {
      return h('span', { className: `pu-badge pu-badge-${props.tone}` }, props.children)
    }

    function Section(props) {
      if (props.entries.length === 0) return null
      return h(
        'section',
        { className: 'pu-section' },
        h('div', { className: 'pu-section-head' }, props.title, h('span', { className: 'pu-count' }, String(props.entries.length))),
        h('div', { className: 'pu-list' }, props.entries.map(props.render)),
      )
    }

    /**
     * The Plugins page tab. It renders its own content into the page's tab body,
     * so every control and row is drawn here; the page keeps the header and tabs.
     */
    function PluginUpdaterTab(props) {
      const { t, ctx } = props
      const [probe, setProbe] = React.useState('probe: start')
      React.useEffect(() => {
        let alive = true
        void (async () => {
          const steps = []
          try {
            steps.push(`remote=${typeof ctx?.remote}`)
            steps.push(`pluginManager=${typeof ctx?.remote?.pluginManager}`)
            const bundles = await ctx.remote.pluginManager.listBundles()
            steps.push(`listBundles ok=${bundles?.ok} n=${Array.isArray(bundles?.value) ? bundles.value.length : 'n/a'}`)
          } catch (error) {
            steps.push(`ERROR ${String(error?.message ?? error)}`)
          }
          if (alive) setProbe(steps.join(' | '))
        })()
        return () => { alive = false }
      }, [ctx])
      return h('div', { style: { padding: 16, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.8 } },
        h('div', null, t('tokenOpen')),
        h('div', null, probe),
      )
    }

    /**
     * The running dsh version, read from the page's own boot facts.
     *
     * The Client build writes the runtime version into the boot payload, so the
     * page compares declared ranges against exactly the version that would
     * enforce them. When that is unavailable the values are simply left unknown
     * and the page says so instead of guessing.
     */
    let RUNTIME_VERSION = ''
    function hostRuntime(ctx) {
      if (RUNTIME_VERSION !== '') return Promise.resolve(RUNTIME_VERSION)
      const facts = readBootFacts()
      RUNTIME_VERSION = facts === undefined ? 'unknown' : facts
      return Promise.resolve(RUNTIME_VERSION)
    }

    /**
     * Read `window.__DSH_BOOT__.release.version`, the Host release label the
     * module graph publishes when the Host reports one.
     * @returns the version label, or undefined when the boot payload omits it.
     */
    function readBootFacts() {
      try {
        const release = typeof window !== 'undefined' ? window.__DSH_BOOT__?.release : undefined
        return typeof release?.version === 'string' && release.version !== '' ? release.version : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Carry out one plugin's move through the plugin manager's own API.
     *
     * update      — reinstall from the newest compatible release (npm) or the
     *               recorded remote (git).
     * incompatible — install a release the registry declares compatible, or,
     *               with `accept`, record the exact-version exemption.
     */
    async function moveOne(ctx, t, entry, accept) {
      const remote = ctx.remote.pluginManager
      if (accept === true && (entry.status === 'incompatible' || entry.status === 'incompatible-update')) {
        try {
          const answer = await remote.setVersionExemption(`${entry.name}@${entry.version}`, RUNTIME_VERSION, true, true)
          if (answer?.ok === false) return { ok: false, message: answer.error?.code ?? 'failed' }
          return { ok: true, message: t('appliedNow') }
        } catch (error) {
          return { ok: false, message: String(error?.message ?? error) }
        }
      }
      const target = entry.probe?.compatibleLatest ?? undefined
      if (entry.kind === 'git') {
        const spec = normaliseGitUrl(entry.probe?.url ?? entry.spec)
        return reinstallBundle(ctx, t, entry, spec)
      }
      if (target === undefined) return { ok: false, message: t('noCompatible') }
      return reinstallBundle(ctx, t, entry, `${entry.name}@${target}`)
    }

    /** Replace one installed bundle with an exact spec, keeping rows and enablement. */
    async function reinstallBundle(ctx, t, entry, spec) {
      const remote = ctx.remote.pluginManager
      try {
        const removed = await remote.removeBundle(entry.name)
        if (removed?.ok === false && removed.error?.code !== 'stop-profile') return { ok: false, message: removed.error?.code ?? t('failed') }
        const installed = await remote.installBundle(spec, { enabled: entry.enabled !== false, saveExact: true })
        if (installed?.ok === false) return { ok: false, message: installed.error?.code ?? t('failed') }
        const pendingBuilds = installed?.pendingBuilds
        if (Array.isArray(pendingBuilds) && pendingBuilds.length > 0) return { ok: false, message: `build scripts blocked: ${pendingBuilds.join(', ')}` }
        const application = installed?.application
        return {
          ok: application !== 'failed',
          message: application === 'restart-required' ? t('needsRestart') : t('appliedNow'),
        }
      } catch (error) {
        return { ok: false, message: String(error?.message ?? error) }
      }
    }

    /** Remove every exemption the profile records for this runtime. */
    async function clearAllExemptions(ctx) {
      const remote = ctx.remote.pluginManager
      try {
        const answer = await remote.listVersionExemptions()
        if (answer?.ok !== true) return { removed: 0 }
        let removed = 0
        for (const [key, versions] of Object.entries(answer.value.exemptions ?? {})) {
          for (const version of versions ?? []) {
            if (version !== RUNTIME_VERSION) continue
            const result = await remote.setVersionExemption(key, version, false)
            if (result?.ok !== false) removed += 1
          }
        }
        return { removed }
      } catch {
        return { removed: 0 }
      }
    }

    //#endregion

    const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.credentials']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-updater: dictionaries')
      const t = ctx.locale.bind(NS)
      const disposers = []
      const styleTags = new Set()
      const installStyles = () => {
        if (typeof document === 'undefined') return () => undefined
        const tag = document.createElement('style')
        tag.setAttribute('data-dyn', 'dsh-plugin-updater')
        tag.textContent = CSS
        document.head.appendChild(tag)
        styleTags.add(tag)
        return () => {
          styleTags.delete(tag)
          tag.remove()
        }
      }
      disposers.push(installStyles())
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) dispose()
      }, 'dsh-plugin-updater: styles')

      ctx.slots.inject('plugins.tab', () =>
        ctx.slots.register(
          {
            name: 'plugins.tab',
            id: 'updater',
            order: 20,
            label: () => t('tab'),
            locale: NS,
          },
          (props) => h(PluginUpdaterTab, { ...props, t, ctx }),
        ),
      )
    }

    return { name: 'dsh-plugin-updater', inject, apply }
  },
})
