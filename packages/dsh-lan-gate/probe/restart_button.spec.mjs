// 浏览器半包探针：把 lib/client.js 放进假 window/React/cordis 里跑，
// 验证「重启实例」按钮的挂载条件、状态机、以及点下去之后的请求与刷新。
//
// 覆盖的契约：
//   · 宿主注入 managed=false（裸进程）时不挂按钮 —— 退出后没人拉起，宁可没有
//   · 有令牌时注册到 sidebar.footer.action（id=lan-gate-restart，order=40，压在退出登录上方）
//   · 状态机：idle → confirm → restart；busy 期间点击无效；failed 可重来
//   · 发起时带 X-Dsh-Lan-Gate-Token；轮询到 pid 变了才 reload；失败不 reload
//
// 运行：node probe/restart_button.spec.mjs

import fs from 'node:fs'
import vm from 'node:vm'

const CLIENT = process.argv[2] || new URL('../lib/client.js', import.meta.url).pathname
const source = fs.readFileSync(CLIENT, 'utf8')

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  }
}

function makeEnv({ managed = true, token = 'tok-0123456789abcdef', pid = 1111, lang = 'zh-CN' } = {}) {
  const captured = {}
  const reloads = []
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    // 计时器压缩成 1ms：轮询逻辑与真实一致，只是跑得快。
    setTimeout: (fn) => setTimeout(fn, 1),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    AbortController: globalThis.AbortController,
    URL: globalThis.URL,
    Date: globalThis.Date,
    Promise: globalThis.Promise,
    location: {
      hostname: '127.0.0.1',
      port: '43001',
      protocol: 'http:',
      href: 'http://127.0.0.1:43001/',
      assign() {},
      replace() {},
      reload() { reloads.push(Date.now()) },
    },
    document: {
      documentElement: { lang },
      head: { appendChild() {}, contains: () => false },
      body: {},
      contentType: 'text/html',
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => ({ id: '', textContent: '', remove() {}, setAttribute() {} }),
      createTextNode: () => ({}),
      addEventListener() {},
      contains: () => false,
    },
    isSecureContext: false,
    crypto: globalThis.crypto,
    navigator: { language: lang, clipboard: { writeText: async () => {} } },
    localStorage: (() => {
      const map = new Map()
      return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
      }
    })(),
    addEventListener() {},
    removeEventListener() {},
    fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => null }),
    __ModuleLoader__: {
      load(entry) {
        captured.entry = entry
        captured.mod = entry.factory((name) => {
          if (name === 'react') return fakeReact()
          throw new Error('unexpected require ' + name)
        })
      },
    },
  }
  if (token !== null) {
    sandbox.__DSH_LAN_GATE_RESTART__ = {
      token,
      pid,
      startedAt: 1,
      managed,
      pingPath: '/__lan-gate/ping',
      restartPath: '/__lan-gate/restart',
      tokenHeader: 'x-dsh-lan-gate-token',
    }
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  return { sandbox, captured, reloads }
}

function run(env) {
  vm.createContext(env.sandbox)
  vm.runInContext(source, env.sandbox, { filename: CLIENT })
  const mod = env.captured.mod
  if (!mod) throw new Error('没有调用 __ModuleLoader__.load')
  const registrations = []
  const ctx = {
    connection: { isLoopback: false },
    get(name) { return this[name] },
    locale: { register() {}, getSnapshot: () => ({ locale: env.sandbox.navigator.language }) },
    slots: {
      inject(name, fn) { registrations.push({ inject: name, fn }) },
      register(options, component) {
        registrations.push({ name: options.name, id: options.id, order: options.order, component })
        return () => {}
      },
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
  }
  mod.apply(ctx)
  for (const r of registrations) if (typeof r.fn === 'function') r.fn()
  return { registrations, mod }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  — ' + detail))
}

/* ── 1. 挂载条件 ────────────────────────────────────────────────── */

{
  const env = makeEnv()
  const { registrations } = run(env)
  const reg = registrations.find((r) => r.id === 'lan-gate-restart')
  check('1a 托管实例注册了重启按钮', !!reg, JSON.stringify(registrations.map((r) => r.id || r.inject)))
  check('1b 注册在 sidebar.footer.action、order=40（压在退出登录的 50 上方）',
    !!reg && reg.name === 'sidebar.footer.action' && reg.order === 40, JSON.stringify(reg && [reg.name, reg.order]))
  check('1c 注册前做了 slots.inject',
    registrations.some((r) => r.inject === 'sidebar.footer.action'))
  check('1d 组件是函数（不是调用结果）', !!reg && typeof reg.component === 'function')
  check('1e 诊断里记下了宿主配置',
    env.sandbox.__DSH_LAN_GATE__.restartRegistered === true
    && env.sandbox.__DSH_LAN_GATE__.restartConfig.managed === true,
    JSON.stringify(env.sandbox.__DSH_LAN_GATE__))
}

{
  const env = makeEnv({ managed: false })
  const { registrations } = run(env)
  check('2a 裸进程（managed=false）不挂按钮',
    !registrations.some((r) => r.id === 'lan-gate-restart'),
    JSON.stringify(registrations.map((r) => r.id || r.inject)))
  check('2b 诊断说明原因', env.sandbox.__DSH_LAN_GATE__.restartRegistered === 'no-config',
    JSON.stringify(env.sandbox.__DSH_LAN_GATE__.restartRegistered))
}

{
  const env = makeEnv({ token: null })
  const { registrations } = run(env)
  check('3a 没有宿主注入（老版本插件/静态部署）不挂按钮',
    !registrations.some((r) => r.id === 'lan-gate-restart'),
    JSON.stringify(registrations.map((r) => r.id || r.inject)))
}

/* ── 2. 状态机与渲染 ───────────────────────────────────────────── */

{
  const env = makeEnv()
  const { mod, registrations } = run(env)
  const { restartNextPhase, renderRestart, restartConfig } = mod.restartInternals
  check('4a idle → confirm', restartNextPhase('idle') === 'confirm')
  check('4b confirm → restart', restartNextPhase('confirm') === 'restart')
  check('4c busy 期间点击无效', restartNextPhase('busy') === 'busy')
  check('4d failed → 可重来（confirm）', restartNextPhase('failed') === 'confirm')
  check('4e 宿主配置带令牌才返回', restartConfig()?.token === 'tok-0123456789abcdef',
    JSON.stringify(restartConfig()))

  const h = (type, props, ...children) => ({ type, props: props || {}, children })
  const t = (key) => ({
    restart: '重启实例',
    restartAria: '重启这个 dsh 实例',
    restartHint: '会中断正在跑的回合；已起的后台任务不会跟着停。',
    restartConfirm: '再点一次重启',
    restartConfirmHint: '再点一次就重启。正在跑的 agent 回合会立刻中断。',
    restarting: '正在重启…',
    restartFailed: '重启失败，再点重试',
  }[key] || key)
  const labelOf = (el) => el.children.map((c) => (typeof c === 'string' ? c : c?.children)).flat().filter((x) => typeof x === 'string')
  const hasText = (el, text) => labelOf(el).some((x) => x.includes(text))
  const idle = renderRestart(t, 'idle', true, () => {}, h)
  check('5a 宽版：文字「重启实例」', idle.props.className === 'dlg-signout dlg-restart' && hasText(idle, '重启实例'),
    JSON.stringify(idle))
  check('5b idle 可点、title 说明代价', idle.props.disabled === false && idle.props.title.includes('中断'))
  const confirm = renderRestart(t, 'confirm', true, () => {}, h)
  check('5c confirm 态换文案与 data-phase',
    confirm.props['data-phase'] === 'confirm' && hasText(confirm, '再点一次重启'))
  const busy = renderRestart(t, 'busy', true, () => {}, h)
  check('5d busy 态禁用', busy.props.disabled === true && hasText(busy, '正在重启…'))
  const failed = renderRestart(t, 'failed', true, () => {}, h)
  check('5e failed 态可再点', failed.props.disabled === false && hasText(failed, '重启失败'))
  const rail = renderRestart(t, 'idle', false, () => {}, h)
  check('5f 收起态走 rail 形态', rail.props['data-rail'] === 'true')

  // 组件本体：走 __expand 的静态分支（与 probe/client_shim_probe.mjs 同一手法）
  const reg = registrations.find((r) => r.id === 'lan-gate-restart')
  let el = reg.component({ wide: true })
  if (typeof el.type === 'function') el = el.type({ ...el.props, __expand: true })
  check('5g 组件渲染出 button', el && el.type === 'button', JSON.stringify(el && el.type))
}

/* ── 3. 点下去之后：POST → 轮询 pid → reload ────────────────────── */

{
  const env = makeEnv()
  const { mod } = run(env)
  const calls = []
  let pingCount = 0
  env.sandbox.fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (String(url) === '/__lan-gate/restart') {
      return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({ ok: true, restarting: true }) }
    }
    pingCount += 1
    // 前两次还是旧进程（重启窗口），第三次是新进程。
    const pid = pingCount < 3 ? 1111 : 2222
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, pid }) }
  }
  const phases = []
  let reloaded = 0
  const cfg = env.sandbox.__DSH_LAN_GATE_RESTART__
  const ok = await mod.restartInternals.startRestartFlow(cfg, {
    report: (p) => phases.push(p),
    reload: () => { reloaded += 1 },
  })
  const post = calls.find((c) => c.url === '/__lan-gate/restart')
  check('6a 发起了一次 POST /__lan-gate/restart', !!post && post.opts.method === 'POST', JSON.stringify(calls))
  check('6b 带令牌头', post && post.opts.headers['x-dsh-lan-gate-token'] === cfg.token,
    JSON.stringify(post && post.opts.headers))
  check('6c 同源凭据', post && post.opts.credentials === 'same-origin')
  check('6d 轮询到 pid 变化后 reload 一次', ok === true && reloaded === 1 && pingCount >= 3,
    JSON.stringify({ ok, reloaded, pingCount }))
  check('6e 阶段序列 busy → done', phases.join(',') === 'busy,done', phases.join(','))
  check('6f 诊断记下了新 pid', env.sandbox.__DSH_LAN_GATE__.restartPidAfter === 2222,
    JSON.stringify(env.sandbox.__DSH_LAN_GATE__.restartPidAfter))
}

{
  const env = makeEnv()
  const { mod } = run(env)
  env.sandbox.fetch = async (url) => {
    if (String(url) === '/__lan-gate/restart') {
      return {
        ok: false,
        status: 409,
        headers: { get: () => null },
        json: async () => ({ ok: false, error: 'not-systemd-managed', detail: '不是 systemd 拉起的' }),
      }
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, pid: 1111 }) }
  }
  const phases = []
  let reloaded = 0
  const cfg = env.sandbox.__DSH_LAN_GATE_RESTART__
  const ok = await mod.restartInternals.startRestartFlow(cfg, {
    report: (p) => phases.push(p),
    reload: () => { reloaded += 1 },
  })
  check('7a 服务端拒绝 → 返回 false 且不 reload', ok === false && reloaded === 0,
    JSON.stringify({ ok, reloaded }))
  check('7b 阶段落到 failed', phases.join(',') === 'busy,failed', phases.join(','))
  check('7c 诊断里有错误原因',
    String(env.sandbox.__DSH_LAN_GATE__.restartError).includes('not-systemd-managed'),
    JSON.stringify(env.sandbox.__DSH_LAN_GATE__.restartError))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
