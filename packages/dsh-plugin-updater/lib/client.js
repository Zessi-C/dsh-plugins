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
      checking: '正在检查',
      refreshTip: '重新核对 npm 仓库、Git 远端与 dsh 版本要求',
      'summary:total': '个插件',
      'summary:updates': '个可更新',
      'summary:blocked': '个高于 dsh',
      sectionUpdates: '可更新',
      sectionBlocked: '版本不兼容',
      sectionUnknown: '无法核对',
      sectionLocal: '本地插件',
      sectionBuiltin: '随 dsh 安装',
      sectionCurrent: '已是最新',
      sectionError: '读取失败',
      colName: '插件',
      colVersion: '当前版本',
      colLatest: '目标版本',
      colDsh: 'dsh 要求',
      colActions: '操作',
      update: '更新',
      'updateTo:one': '更新至',
      accept: '接受风险',
      acceptTitle: '记录精确版本豁免',
      acceptBodyHead: '将在 profile 的 compatibility.json 中登记该版本可在当前 dsh 上运行：',
      acceptBodyTail: '此项仅放宽启动检查。插件代码是否真正兼容需自行判断，Harness 提示该操作可能导致崩溃或数据丢失。',
      acceptConfirm: '确认登记',
      cancel: '取消',
      apply: '应用',
      applying: '处理中',
      selected: '已选',
      'selected:one': '项',
      applyDone: '已完成',
      progressTitle: '更新进行中',
      progressDone: '更新完成',
      dismiss: '收起',
      notSelected: '尚未选择任何项目',
      reloadHint: '部分插件需重启 dsh 后才会加载新代码。',
      latestCompatible: '可用',
      noCompatible: '无兼容版本',
      blockedLatestHead: '最新版未声明支持当前 dsh：',
      upToDate: '已是最新',
      satisfied: '满足',
      blocked: '不满足',
      exempted: '已豁免',
      undoExemption: '撤销豁免',
      unknown: '未知',
      unverified: '私有仓库或离线，浏览器端无法读取版本',
      local: '本地目录',
      localLinked: '本地目录（link/file），不联网核对',
      localStale: '源码新于构建产物，需重新构建',
      builtinNote: '随 dsh 升级',
      requirements: '未满足的要求',
      registry: '仓库',
      gitRemote: 'Git 远端',
      gitHeadHead: '远端 HEAD',
      errorNote: '读取失败',
      failed: '失败',
      empty: '当前没有已安装的第三方插件。',
      unavailable: '此 profile 中插件管理器不可用。',
      noRemote: '浏览器无法访问插件管理器服务。',
      noRepair: '内置插件随 dsh 升级。',
      needsRestart: '需重启 dsh',
      appliedNow: '已生效',
      searchPlaceholder: '筛选插件',
      showAll: '显示全部',
      releaseChannel: '发布通道',
      tokenTitle: '私有仓库凭据',
      tokenHint: '用于读取私有仓库的 token。保存在 dsh 凭据存储（~/.dsh/.credentials.yaml），仅发送至 github.com、gitlab.com、bitbucket.org。',
      tokenPlaceholder: '粘贴 GitHub token（需 repo 权限）',
      tokenSave: '保存',
      tokenClear: '清除',
      tokenConfigured: '已配置',
      tokenMissing: '未配置',
      tokenSaved: '已保存',
      tokenCleared: '已清除',
      tokenFailed: '操作失败',
      tokenOpen: '凭据',
    }

    const en = {
      tab: 'Plugin updates',
      refresh: 'Check for updates',
      checking: 'Checking',
      refreshTip: 'Re-check the npm registry, Git remotes and dsh requirement ranges',
      'summary:total': 'plugins',
      'summary:updates': 'updates',
      'summary:blocked': 'above dsh',
      sectionUpdates: 'Updates available',
      sectionBlocked: 'Not compatible',
      sectionUnknown: 'Unverified',
      sectionLocal: 'Local plugins',
      sectionBuiltin: 'Shipped with dsh',
      sectionCurrent: 'Up to date',
      sectionError: 'Unreadable',
      colName: 'Plugin',
      colVersion: 'Installed',
      colLatest: 'Target',
      colDsh: 'dsh requirement',
      colActions: 'Actions',
      update: 'Update',
      'updateTo:one': 'Update to',
      accept: 'Accept risk',
      acceptTitle: 'Record an exact-version exemption',
      acceptBodyHead: "Record in the profile's compatibility.json that this version may run on this dsh:",
      acceptBodyTail: 'This only relaxes the startup check. Whether the plugin code really fits is your judgement, and the Harness warns that running it may cause crashes or data loss.',
      acceptConfirm: 'Record exemption',
      cancel: 'Cancel',
      apply: 'Apply',
      applying: 'Working',
      selected: 'selected',
      'selected:one': 'item(s)',
      applyDone: 'Done',
      progressTitle: 'Updating',
      progressDone: 'Update finished',
      dismiss: 'Hide',
      notSelected: 'Nothing is selected',
      reloadHint: 'Some plugins load their new code only after dsh restarts.',
      latestCompatible: 'available',
      noCompatible: 'none compatible',
      blockedLatestHead: 'newest release does not declare this dsh:',
      upToDate: 'Up to date',
      satisfied: 'met',
      blocked: 'unmet',
      exempted: 'exempted',
      undoExemption: 'Undo exemption',
      unknown: 'unknown',
      unverified: 'private or offline; the browser cannot read the version',
      local: 'Local',
      localLinked: 'Local directory (link/file); not checked over the network',
      localStale: 'Sources are newer than the build output',
      builtinNote: 'Updated with dsh',
      requirements: 'Unmet requirements',
      registry: 'registry',
      gitRemote: 'git remote',
      gitHeadHead: 'remote HEAD',
      errorNote: 'Could not read',
      failed: 'Failed',
      empty: 'No third-party plugins are installed.',
      unavailable: 'The plugin manager is unavailable in this profile.',
      noRemote: 'The browser cannot reach the plugin manager service.',
      noRepair: 'Shipped with dsh; update dsh itself.',
      needsRestart: 'Restart dsh',
      appliedNow: 'Applied',
      searchPlaceholder: 'Filter plugins',
      showAll: 'Show all',
      releaseChannel: 'Release channel',
      tokenTitle: 'Private repository credential',
      tokenHint: 'Token for private repositories. Stored in the dsh credential store (~/.dsh/.credentials.yaml) and sent only to github.com, gitlab.com and bitbucket.org.',
      tokenPlaceholder: 'Paste a GitHub token with repo scope',
      tokenSave: 'Save',
      tokenClear: 'Clear',
      tokenConfigured: 'configured',
      tokenMissing: 'not configured',
      tokenSaved: 'Saved',
      tokenCleared: 'Cleared',
      tokenFailed: 'Failed',
      tokenOpen: 'Credential',
    }

    //#endregion

    //#region styles

    const CSS = `
.pu-root{
  --pu-gap:16px;
  --pu-cols:26px minmax(180px,1.6fr) minmax(84px,.7fr) minmax(84px,.7fr) minmax(120px,1fr) minmax(160px,auto);
  display:flex;flex-direction:column;gap:20px;padding:8px 0 32px;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;
  font-variant-numeric:tabular-nums;
}
.pu-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:4px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.pu-spacer{flex:1}
.pu-context{color:var(--dsw-alias-label-secondary);font-size:12px;letter-spacing:.01em}
.pu-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 11px;font:inherit;font-size:12.5px;
  cursor:pointer;transition:background .12s,border-color .12s,opacity .12s;white-space:nowrap}
.pu-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.pu-btn:disabled{opacity:.5;cursor:default}
.pu-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pu-btn-sm{padding:3px 9px;font-size:12px;border-radius:6px}
.pu-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.pu-btn-primary:hover:not(:disabled){filter:brightness(1.06)}
.pu-filter{flex:0 0 190px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 10px;font:inherit;font-size:12.5px}
.pu-filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.pu-section{display:flex;flex-direction:column;gap:8px}
.pu-section-head{display:flex;align-items:baseline;gap:8px;margin:0}
.pu-section-title{font-size:13px;font-weight:600;letter-spacing:.01em}
.pu-count{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:0 7px;line-height:18px}
.pu-list{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1)}
.pu-head-row,.pu-row{display:grid;grid-template-columns:var(--pu-cols);gap:12px;align-items:center;
  padding:8px 14px}
.pu-head-row{background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);
  padding-top:6px;padding-bottom:6px}
.pu-head-cell{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);
  letter-spacing:.03em;text-transform:none}
.pu-head-actions{text-align:right}
.pu-row{border-top:1px solid var(--dsw-alias-border-l1)}
.pu-row:first-of-type{border-top:none}
.pu-row:hover{background:var(--dsw-alias-bg-layer-2)}
.pu-cell{min-width:0}
.pu-cell-check{display:flex;align-items:center;justify-content:center}
.pu-check{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0}
.pu-name{display:flex;flex-direction:column;gap:1px;min-width:0}
.pu-name-title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pu-name-pkg{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pu-num{text-align:right;font-size:12.5px;white-space:nowrap}
.pu-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pu-dim{color:var(--dsw-alias-label-secondary);font-size:12px}
.pu-err{color:var(--dsw-alias-state-error-primary)}
.pu-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pu-badge{display:inline-flex;align-items:center;border-radius:5px;padding:1px 7px;
  font-size:11px;line-height:17px;white-space:nowrap;border:1px solid transparent;font-weight:500}
.pu-badge-update{background:rgba(35,134,54,.12);color:var(--dsw-alias-state-success-primary);border-color:rgba(35,134,54,.3)}
.pu-badge-blocked{background:rgba(191,90,0,.12);color:var(--dsw-alias-state-warn-primary);border-color:rgba(191,90,0,.3)}
.pu-badge-error{background:rgba(190,30,30,.12);color:var(--dsw-alias-state-error-primary);border-color:rgba(190,30,30,.3)}
.pu-badge-muted{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.pu-actions{display:flex;gap:6px;justify-content:flex-end;align-items:center;flex-wrap:nowrap}
.pu-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.pu-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.pu-task{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:9px}
.pu-task-head{display:flex;align-items:baseline;gap:10px;font-size:12.5px}
.pu-task-head strong{font-weight:600}
.pu-bar-track{height:3px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.pu-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.pu-progress{display:flex;flex-direction:column;gap:5px}
.pu-progress-item{display:flex;justify-content:space-between;gap:12px;font-size:12px}
.pu-token{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:9px}
.pu-token-head{display:flex;align-items:baseline;gap:10px;font-size:12.5px}
.pu-token-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.pu-token-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pu-token-input{flex:1 1 260px;min-width:200px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.pu-ok{color:var(--dsw-alias-state-success-primary);font-size:11.5px}
.pu-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;align-items:center;
  justify-content:center;z-index:1000;padding:24px}
.pu-modal{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l1);border-radius:12px;max-width:520px;width:100%;
  padding:20px;display:flex;flex-direction:column;gap:14px;box-shadow:0 18px 48px rgba(0,0,0,.32)}
.pu-modal h3{margin:0;font-size:14px;font-weight:600}
.pu-modal p{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.65}
.pu-modal-foot{display:flex;justify-content:flex-end;gap:8px}
@media (max-width:900px){
  .pu-root{--pu-cols:24px minmax(140px,1fr) minmax(70px,.6fr) minmax(70px,.6fr) minmax(140px,auto)}
  .pu-col-hide,.pu-head-row .pu-col-hide{display:none}
}
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
        h(
          'h3',
          { className: 'pu-section-head' },
          h('span', { className: 'pu-section-title' }, props.title),
          h('span', { className: 'pu-count' }, String(props.entries.length)),
        ),
        h(
          'div',
          { className: 'pu-list', role: 'table', 'aria-label': props.title },
          h(
            'div',
            { className: 'pu-head-row', role: 'row' },
            h('span', { className: 'pu-head-cell', 'aria-hidden': 'true' }),
            h('span', { className: 'pu-head-cell', role: 'columnheader' }, props.columns.name),
            h('span', { className: 'pu-head-cell pu-num', role: 'columnheader' }, props.columns.version),
            h('span', { className: 'pu-head-cell pu-num', role: 'columnheader' }, props.columns.latest),
            h('span', { className: 'pu-head-cell pu-col-hide', role: 'columnheader' }, props.columns.dsh),
            h('span', { className: 'pu-head-cell pu-head-actions', role: 'columnheader' }, props.columns.actions),
          ),
          props.entries.map(props.render),
        ),
      )
    }

    /**
     * Show a render failure in place of a blank panel.
     *
     * A functional component cannot catch the errors of its own subtree: the
     * exception is thrown during reconciliation, after the element that created
     * it has already returned. Only a class component's lifecycle sees it, which
     * is why this boundary exists beside the tab rather than a try/catch inside
     * the registration callback.
     */
    class TabBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-plugin-updater] tab render failed', error, info?.componentStack)
      }

      render() {
        const { error } = this.state
        if (error === null) return h(PluginUpdaterTab, this.props)
        return h(
          'div',
          { className: 'pu-root' },
          h('div', { className: 'pu-error', style: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 } },
            `render failed: ${String(error?.message ?? error)}\n${String(error?.stack ?? '').split('\n').slice(0, 8).join('\n')}`),
        )
      }
    }

    /**
     * The Plugins page tab. It renders its own content into the page's tab body,
     * so every control and row is drawn here; the page keeps the header and tabs.
     */
    function PluginUpdaterTab(props) {
      const { t, ctx } = props
      const [state, setState] = React.useState({ phase: 'idle', report: null, selected: {}, notice: null, applied: [] })
      const [query, setQuery] = React.useState('')
      const [pending, setPending] = React.useState(null)
      const [token, setToken] = React.useState({ open: false, configured: false, draft: '', busy: false, notice: null })
      const scanId = React.useRef(0)

      const runScan = React.useCallback(async () => {
        const mine = ++scanId.current
        setState((current) => ({ ...current, phase: 'checking', notice: null }))
        try {
          const runtime = await hostRuntime(ctx)
          const report = await scanProfile(ctx, runtime, () => scanId.current === mine)
          if (report === undefined || scanId.current !== mine) return
          setState((current) => ({ ...current, phase: 'ready', report }))
        } catch (error) {
          if (scanId.current !== mine) return
          setState((current) => ({ ...current, phase: 'error', notice: String(error?.message ?? error) }))
        }
      }, [ctx])

      React.useEffect(() => {
        void runScan()
      }, [runScan])

      const toggle = React.useCallback((id) => {
        setState((current) => {
          const selected = { ...current.selected }
          if (selected[id] === undefined) selected[id] = { accept: false }
          else delete selected[id]
          return { ...current, selected }
        })
      }, [])

      const report = state.report
      const entries = report?.entries ?? []
      const filtered = query.trim() === '' ? entries : entries.filter((entry) => `${entry.name} ${entry.title}`.toLowerCase().includes(query.trim().toLowerCase()))
      const groups = {
        updates: filtered.filter((entry) => entry.status === 'update'),
        blocked: filtered.filter((entry) => entry.status === 'incompatible' || entry.status === 'incompatible-update'),
        local: filtered.filter((entry) => entry.status === 'local'),
        unknown: filtered.filter((entry) => entry.status === 'unknown'),
        current: filtered.filter((entry) => entry.status === 'current'),
        builtin: filtered.filter((entry) => entry.status === 'builtin'),
        error: filtered.filter((entry) => entry.status === 'error'),
      }
      const selectedIds = Object.keys(state.selected)
      const busy = taskStore.state?.running === true

      /**
       * Run the chosen items in the background, one at a time.
       *
       * The page stays usable: progress is published to the shared task store,
       * each item settles independently, and a failure does not cancel the rest.
       */
      const startRun = React.useCallback(
        (plan) => {
          if (plan.length === 0) return
          void (async () => {
            const items = plan.map((item) => ({ name: item.entry.name, status: 'pending', detail: null }))
            publishTask({ running: true, items: [...items], done: 0, total: plan.length })
            for (let index = 0; index < plan.length; index += 1) {
              const item = plan[index]
              items[index] = { ...items[index], status: 'running' }
              publishTask({ running: true, items: [...items], done: index, total: plan.length })
              let outcome
              try {
                outcome = await moveOne(ctx, t, item.entry, item.accept)
              } catch (error) {
                outcome = { ok: false, message: String(error?.message ?? error) }
              }
              items[index] = {
                name: item.entry.name,
                status: outcome.ok === false ? 'failed' : 'done',
                detail: outcome.message ?? (outcome.ok === false ? t('failed') : t('appliedNow')),
              }
              publishTask({ running: true, items: [...items], done: index + 1, total: plan.length })
            }
            publishTask({ running: false, items: [...items], done: plan.length, total: plan.length })
            // The list is stale now; refresh it without holding the run open.
            void runScan()
          })()
        },
        [ctx, runScan, t],
      )

      const applySelected = React.useCallback(() => {
        if (selectedIds.length === 0) {
          setState((current) => ({ ...current, notice: t('notSelected') }))
          return
        }
        const plan = selectedIds
          .map((id) => ({ entry: entries.find((candidate) => candidate.id === id), accept: state.selected[id]?.accept === true }))
          .filter((item) => item.entry !== undefined)
        setState((current) => ({ ...current, selected: {}, notice: null }))
        startRun(plan)
      }, [entries, selectedIds, startRun, state.selected, t])

      const requestApply = React.useCallback((id, entry) => {
        if (entry === undefined) return
        // A plugin whose declared dsh range is unmet needs an explicit choice,
        // because accepting it can crash the application.
        setPending({ kind: entry.dsh.ok ? 'confirm' : 'accept', id, entry })
      }, [])

      const confirmPending = React.useCallback(() => {
        if (pending === null) return
        const item = { entry: pending.entry, accept: pending.kind === 'accept' }
        setPending(null)
        setState((current) => ({ ...current, selected: {} }))
        startRun([item])
      }, [pending, startRun])

      /** Withdraw the exact-version exemption recorded for one plugin. */
      const undoExemption = React.useCallback(
        async (entry) => {
          try {
            const answer = await ctx.remote.pluginManager.setVersionExemption(`${entry.name}@${entry.version}`, RUNTIME_VERSION, false)
            if (answer?.ok === false) {
              setState((current) => ({ ...current, notice: `${t('tokenFailed')}: ${answer.error?.code ?? ''}` }))
              return
            }
            await runScan()
          } catch (error) {
            setState((current) => ({ ...current, notice: String(error?.message ?? error) }))
          }
        },
        [ctx, runScan, t],
      )

      /**
       * The version shown in the "latest" column: the release the page would
       * install. A row with nothing newer shows its own version instead.
       */
      const latestText = (entry) => {
        if (entry === undefined) return '—'
        if (entry.kind === 'builtin') return entry.version ?? '—'
        if (entry.status === 'local') return t('local')
        if (entry.status === 'unknown') return t('unknown')
        if (entry.probe?.compatibleLatest !== undefined) return entry.probe.compatibleLatest
        if (entry.status === 'incompatible-update' && entry.probe?.blockedLatest !== undefined) return entry.probe.blockedLatest
        if (entry.probe?.latest !== undefined) return entry.probe.latest
        return entry.version ?? '—'
      }

      /** The dsh-requirement cell: the first unmet requirement, or none. */
      const requirementText = (entry) => {
        const unmet = entry?.dsh?.requirements ?? {}
        const names = Object.keys(unmet)
        if (names.length === 0) return t('satisfied')
        return `${names[0]} ${unmet[names[0]]}`
      }

      const columns = {
        name: t('colName'),
        version: t('colVersion'),
        latest: t('colLatest'),
        dsh: t('colDsh'),
        actions: t('colActions'),
      }

      /** One titled table of rows. */
      const section = (title, entries) => h(Section, { key: title, title, entries, columns, render: row })

      const row = (entry) => {
        const selectable = entry.status === 'update' || entry.status === 'incompatible' || entry.status === 'incompatible-update'
        const checked = state.selected[entry.id] !== undefined
        const exempted = entry.exempted === true
        const unmet = entry.dsh?.ok === false
        return h(
          'div',
          { className: 'pu-row', key: entry.id, role: 'row' },
          h(
            'span',
            { className: 'pu-cell pu-cell-check', role: 'cell' },
            selectable
              ? h('input', {
                  type: 'checkbox',
                  className: 'pu-check',
                  checked,
                  disabled: busy,
                  'aria-label': `${t('colName')}: ${entry.title}`,
                  onChange: () => toggle(entry.id),
                })
              : null,
          ),
          h(
            'span',
            { className: 'pu-cell pu-name', role: 'cell' },
            h('span', { className: 'pu-name-title', title: entry.title }, entry.title),
            h('span', { className: 'pu-name-pkg', title: entry.spec ?? entry.name }, entry.name),
          ),
          h('span', { className: 'pu-cell pu-num pu-mono', role: 'cell' }, entry.version ?? '—'),
          h('span', { className: 'pu-cell pu-num pu-mono', role: 'cell' }, latestText(entry)),
          h(
            'span',
            { className: 'pu-cell pu-col-hide', role: 'cell' },
            unmet ? h(Badge, { tone: 'blocked' }, t('blocked')) : exempted ? h(Badge, { tone: 'muted' }, t('exempted')) : h('span', { className: 'pu-dim' }, requirementText(entry)),
          ),
          h(
            'span',
            { className: 'pu-cell pu-actions', role: 'cell' },
            entry.status === 'update' || entry.status === 'incompatible-update'
              ? h('button', { type: 'button', className: 'pu-btn pu-btn-primary pu-btn-sm', disabled: busy, onClick: () => requestApply(entry.id, entry) }, `${t('updateTo:one')} ${latestText(entry)}`)
              : null,
            unmet ? h('button', { type: 'button', className: 'pu-btn pu-btn-sm', disabled: busy, onClick: () => requestApply(entry.id, entry) }, t('accept')) : null,
            exempted ? h('button', { type: 'button', className: 'pu-btn pu-btn-sm', disabled: busy, onClick: () => void undoExemption(entry) }, t('undoExemption')) : null,
            entry.status === 'builtin' ? h('span', { className: 'pu-dim pu-note' }, t('builtinNote')) : null,
            entry.status === 'current' ? h('span', { className: 'pu-dim pu-note' }, t('upToDate')) : null,
            entry.status === 'local' ? h('span', { className: 'pu-dim pu-note' }, t('local')) : null,
            entry.status === 'unknown' ? h('span', { className: 'pu-dim pu-note' }, t('unknown')) : null,
            entry.status === 'error' ? h('span', { className: 'pu-err pu-note' }, entry.probe?.note ?? t('errorNote')) : null,
          ),
        )
      }

      /** Read whether the token is already stored, without exposing its value. */
      const readToken = React.useCallback(async () => {
        try {
          const answer = await ctx.remote.credentials.describe([TOKEN_REF])
          const info = answer?.ok === true ? answer.value?.[TOKEN_REF] : undefined
          setToken((current) => ({ ...current, configured: info?.configured === true }))
        } catch {
          setToken((current) => ({ ...current, configured: false }))
        }
      }, [ctx])

      /** Save the pasted token into the dsh credential store. */
      const saveToken = React.useCallback(async () => {
        const value = token.draft.trim()
        if (value === '') return
        setToken((current) => ({ ...current, busy: true, notice: null }))
        try {
          const answer = await ctx.remote.credentials.set(TOKEN_REF, value)
          const failed = answer?.ok === false
          setToken((current) => ({
            ...current,
            busy: false,
            draft: failed ? current.draft : '',
            configured: failed ? current.configured : true,
            notice: failed ? `${t('tokenFailed')}: ${answer?.error?.code ?? ''}` : t('tokenSaved'),
          }))
        } catch (error) {
          setToken((current) => ({ ...current, busy: false, notice: `${t('tokenFailed')}: ${String(error?.message ?? error)}` }))
        }
      }, [ctx, t, token.draft])

      /** Remove the stored token. */
      const clearToken = React.useCallback(async () => {
        setToken((current) => ({ ...current, busy: true, notice: null }))
        try {
          const answer = await ctx.remote.credentials.unset(TOKEN_REF)
          const failed = answer?.ok === false
          setToken((current) => ({
            ...current,
            busy: false,
            configured: failed ? current.configured : false,
            notice: failed ? `${t('tokenFailed')}: ${answer?.error?.code ?? ''}` : t('tokenCleared'),
          }))
        } catch (error) {
          setToken((current) => ({ ...current, busy: false, notice: `${t('tokenFailed')}: ${String(error?.message ?? error)}` }))
        }
      }, [ctx, t])

      const toggleToken = React.useCallback(() => {
        setToken((current) => {
          const open = !current.open
          return { ...current, open, notice: null }
        })
        void readToken()
      }, [readToken])

      const tokenPanel =
        token.open === false
          ? null
          : h(
              'div',
              { className: 'pu-token' },
              h(
                'div',
                { className: 'pu-token-head' },
                h('strong', null, t('tokenTitle')),
                h('span', { className: token.configured ? 'pu-ok' : 'pu-dim' }, token.configured ? t('tokenConfigured') : t('tokenMissing')),
              ),
              h('p', { className: 'pu-token-hint' }, t('tokenHint')),
              h(
                'div',
                { className: 'pu-token-row' },
                h('input', {
                  className: 'pu-filter pu-token-input',
                  type: 'password',
                  autoComplete: 'off',
                  placeholder: t('tokenPlaceholder'),
                  value: token.draft,
                  disabled: token.busy,
                  onChange: (event) => setToken((current) => ({ ...current, draft: event.target.value })),
                }),
                h('button', { type: 'button', className: 'pu-btn pu-btn-primary', disabled: token.busy || token.draft.trim() === '', onClick: () => void saveToken() }, t('tokenSave')),
                h('button', { type: 'button', className: 'pu-btn', disabled: token.busy || !token.configured, onClick: () => void clearToken() }, t('tokenClear')),
              ),
              token.notice === null ? null : h('div', { className: 'pu-note' }, token.notice),
            )

      const header = h(
        'div',
        { className: 'pu-toolbar' },
        h(
          'button',
          { type: 'button', className: 'pu-btn', disabled: busy || state.phase === 'checking', title: t('refreshTip'), onClick: () => void runScan() },
          state.phase === 'checking' ? t('checking') : t('refresh'),
        ),
        h('input', { className: 'pu-filter', type: 'search', placeholder: t('searchPlaceholder'), value: query, onChange: (event) => setQuery(event.target.value) }),
        h('button', { type: 'button', className: 'pu-btn', 'aria-expanded': token.open, onClick: toggleToken }, t('tokenOpen')),
        h('span', { className: 'pu-spacer' }),
        report === null
          ? null
          : h(
              'span',
              { className: 'pu-context' },
              `${entries.length} ${t('summary:total')} · ${groups.updates.length} ${t('summary:updates')} · ${groups.blocked.length} ${t('summary:blocked')} ${report.runtime} · ${new Date(report.scannedAt).toLocaleTimeString()}`,
            ),
        selectedIds.length === 0
          ? null
          : h(
              'button',
              { type: 'button', className: 'pu-btn pu-btn-primary', disabled: busy, onClick: () => void applySelected() },
              busy ? t('applying') : `${t('apply')} · ${selectedIds.length} ${t('selected:one')}`,
            ),
      )

      const body = () => {
        if (state.phase === 'checking' && report === null) return h('div', { className: 'pu-empty' }, t('checking'))
        if (state.phase === 'error') return h('div', { className: 'pu-error' }, state.notice ?? t('noRemote'))
        if (report === null) return null
        if (entries.length === 0) return h('div', { className: 'pu-empty' }, t('empty'))
        return h(
          React.Fragment,
          null,
          section(t('sectionUpdates'), groups.updates),
          section(t('sectionBlocked'), groups.blocked),
          section(t('sectionLocal'), groups.local),
          section(t('sectionUnknown'), groups.unknown),
          section(t('sectionCurrent'), groups.current),
          section(t('sectionError'), groups.error),
          section(t('sectionBuiltin'), groups.builtin),
          state.notice === null ? null : h('div', { className: 'pu-note' }, state.notice),
        )
      }

      const modal =
        pending === null
          ? null
          : h(
              'div',
              { className: 'pu-modal-backdrop', role: 'presentation', onClick: (event) => event.target === event.currentTarget && setPending(null) },
              h(
                'div',
                { className: 'pu-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pu-modal-title' },
                h('h3', { id: 'pu-modal-title' }, pending.kind === 'accept' ? t('acceptTitle') : `${t('updateTo:one')} ${latestText(pending.entry)}`),
                pending.kind === 'accept'
                  ? h('p', null, `${t('acceptBodyHead')} ${pending.entry.name}@${pending.entry.version} → dsh ${report?.runtime ?? ''}。${t('acceptBodyTail')}`)
                  : h('p', null, pending.entry.name),
                h(
                  'div',
                  { className: 'pu-modal-foot' },
                  h('button', { type: 'button', className: 'pu-btn', onClick: () => setPending(null) }, t('cancel')),
                  h('button', { type: 'button', className: 'pu-btn pu-btn-primary', onClick: () => void confirmPending() }, pending.kind === 'accept' ? t('acceptConfirm') : t('update')),
                ),
              ),
            )

      const task = useBackgroundTask()
      const taskPanel =
        task === null
          ? null
          : h(
              'div',
              { className: 'pu-task', role: 'status', 'aria-live': 'polite' },
              h(
                'div',
                { className: 'pu-task-head' },
                h('strong', null, task.running ? t('progressTitle') : t('progressDone')),
                h('span', { className: 'pu-dim' }, `${task.done}/${task.total}`),
                h('span', { className: 'pu-spacer' }),
                task.running
                  ? null
                  : h('button', { type: 'button', className: 'pu-btn', onClick: () => publishTask(null) }, t('dismiss')),
              ),
              h(
                'div',
                { className: 'pu-bar-track' },
                h('div', {
                  className: 'pu-bar-fill',
                  style: { width: `${task.total === 0 ? 0 : Math.round((task.done / task.total) * 100)}%` },
                }),
              ),
              h(
                'div',
                { className: 'pu-progress' },
                task.items.map((item) =>
                  h(
                    'div',
                    { className: 'pu-progress-item', key: item.name },
                    h('span', null, item.name),
                    h(
                      'span',
                      { className: item.status === 'failed' ? 'pu-error' : 'pu-dim' },
                      item.status === 'running'
                        ? t('applying')
                        : item.status === 'failed'
                          ? item.detail ?? t('failed')
                          : item.status === 'done'
                            ? item.detail ?? t('applyDone')
                            : '',
                    ),
                  ),
                ),
              ),
            )

      return h(
        'div',
        { className: 'pu-root' },
        header,
        tokenPanel,
        body(),
        modal,
        taskPanel,
        report === null || (groups.updates.length === 0 && groups.blocked.length === 0) ? null : h('div', { className: 'pu-note' }, t('reloadHint')),
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
          (props) => h(TabBoundary, { ...props, t, ctx }),
        ),
      )
    }

    return { name: 'dsh-plugin-updater', inject, apply }
  },
})
