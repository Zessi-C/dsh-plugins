// 浏览器半包探针：用假的 window / document / fetch 把 lib/client.js 跑两遍，
// 验证「在门户后面」才注册退出按钮、点一下确实跳到门户登出地址。
import fs from 'node:fs'
import vm from 'node:vm'

const CLIENT = process.argv[2] || new URL("../lib/client.js", import.meta.url).pathname
const source = fs.readFileSync(CLIENT, 'utf8')

function makeEnv({ hostname, port, pageHost, meResponse, meHeaders = {}, lang = 'zh-CN' }) {
  const appended = []
  const head = {
    appendChild(node) { appended.push(node) },
    contains(node) { return appended.includes(node) },
  }
  const style = () => {
    const node = {
      id: '', textContent: '', dataset: {},
      setAttribute() {}, remove() { const i = appended.indexOf(node); if (i >= 0) appended.splice(i, 1) },
      querySelector() { return null },
    }
    return node
  }
  const document = {
    head,
    body: {},
    documentElement: { lang },
    getElementById: (id) => appended.find((n) => n.id === id) || null,
    querySelector: () => null,
    createElement: () => style(),
    createTextNode: () => ({}),
    contains: () => false,
    addEventListener() {},
  }
  const navigations = []
  const location = {
    hostname, port, protocol: 'http:', href: `http://${hostname}:${port}/`,
    assign(url) { navigations.push(url) },
    replace(url) { navigations.push(url) },
  }
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts })
    const headers = {
      get(name) {
        const key = String(name).toLowerCase()
        const found = Object.keys(meHeaders).find((k) => k.toLowerCase() === key)
        return found ? meHeaders[found] : null
      },
    }
    const ok = meResponse !== undefined
    return { ok, status: ok ? 200 : 404, headers, json: async () => meResponse }
  }
  const captured = {}
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout: (fn, ms) => { if (ms < 1000) fn(); return { unref() {} } },
    clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    AbortController: globalThis.AbortController,
    URL: globalThis.URL,
    location,
    document,
    fetch: fetchImpl,
    isSecureContext: false,
    crypto: globalThis.crypto,
    navigator: { language: lang, clipboard: { writeText: async () => {} } },
    __ModuleLoader__: {
      load(entry) {
        captured.entry = entry
        const mod = entry.factory((name) => {
          if (name === 'react') {
            return {
              createElement: (type, props, ...children) => ({ type, props, children }),
              useState: (initial) => [initial, () => {}],
              useEffect() {}, useMemo: (fn) => fn(), useCallback: (fn) => fn(), useRef: (v) => ({ current: v }),
            }
          }
          throw new Error('unexpected require ' + name)
        })
        captured.mod = mod
      },
    },
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  return { sandbox, calls, navigations, appended, captured, pageHost }
}

/** 运行一份客户端半包并执行它的 apply（用最小 ctx 模拟 cordis 客户端环境）。 */
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
      inject(name, fn) { registrations.push({ inject: name, fn }); },
      register(options, component) { registrations.push({ name: options.name, id: options.id, order: options.order, component }); return () => {}; },
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  }
  mod.apply(ctx)
  return { registrations, mod, fireInject() { for (const r of registrations) if (typeof r.fn === 'function') r.fn() } }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  — ' + detail))
}

// 1) 门户后面：origin 100.96.52.76:3080，门户改写 Host 为 127.0.0.1:42001
{
  const env = makeEnv({
    hostname: '100.96.52.76', port: '3080',
    meResponse: { user: 'zeiss', uid: 1000 },
    meHeaders: { 'X-Dsh-Portal-Host': '127.0.0.1:42001' },
  })
  const { registrations, mod, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  fireInject()
  check('1a 在门户后面注册了 sidebar.footer.action',
    registrations.some((r) => r.name === 'sidebar.footer.action' && r.id === 'lan-gate-signout'),
    JSON.stringify(registrations))
  check('1b 注册前做了 slots.inject',
    registrations.some((r) => r.inject === 'sidebar.footer.action'), JSON.stringify(registrations))
  check('1c 探针请求 /__portal/me',
    env.calls.some((c) => c.url === '/__portal/me'), JSON.stringify(env.calls.map((c) => c.url)))
  const reg = registrations.find((r) => r.id === 'lan-gate-signout')
  let el = reg.component({ wide: true })
  if (typeof el.type === 'function') el = el.type({ ...el.props, __expand: true })
  check('0 渲染出 button 元素', el && el.type === 'button', JSON.stringify(el && el.type))
  const texts = (el && el.children || []).map((c) => (typeof c === 'string' ? c : c && c.children)).flat().filter((x) => typeof x === 'string')
  check('1d 宽版渲染出文字按钮', el.type === 'button' && el.props.className === 'dlg-signout'
    && texts.includes('退出登录'), JSON.stringify(texts))
  el.props.onClick({ preventDefault() {}, stopPropagation() {} })
  check('1e 点击后跳到门户登出地址并带 next=login',
    env.navigations.length === 1 && /^\/__portal\/logout\?next=login/.test(env.navigations[0]),
    JSON.stringify(env.navigations))
  check('1f 组件是函数（不是调用结果）', typeof reg.component === 'function')
  check('1g 样式只装一次', env.sandbox.__DSH_LAN_GATE__.logoutRegistered === true
    || env.sandbox.__DSH_LAN_GATE__?.logoutRegistered === true, JSON.stringify(env.sandbox.__DSH_LAN_GATE__?.logoutRegistered))
}

// 2) 直连实例：浏览器 origin 与 Host 一致，不注册
{
  const env = makeEnv({
    hostname: '127.0.0.1', port: '43001',
    meResponse: undefined,
    meHeaders: {},
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  fireInject()
  check('2a 直连时不注册退出按钮', !registrations.some((r) => r.id === 'lan-gate-signout'),
    JSON.stringify(registrations))
}

// 3) 有反代但不是门户（/__portal/me 404 或被别的服务接住）→ 不注册
{
  const env = makeEnv({
    hostname: '10.0.0.9', port: '8080',
    meResponse: undefined,
    meHeaders: {},
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  fireInject()
  check('3 反代但没有门户 → 不注册', !registrations.some((r) => r.id === 'lan-gate-signout'))
}

// 4) 门户后面但 /__portal/me 返回了空用户 → 不注册（说明还没登录/路由不对）
{
  const env = makeEnv({
    hostname: '100.96.52.76', port: '3080',
    meResponse: { user: null },
    meHeaders: { 'X-Dsh-Portal-Host': '127.0.0.1:42001' },
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  fireInject()
  check('4 没拿到门户用户 → 不注册', !registrations.some((r) => r.id === 'lan-gate-signout'))
}

// 5) 英文界面
{
  const env = makeEnv({
    hostname: '100.96.52.76', port: '3080',
    meResponse: { user: 'zeiss' },
    meHeaders: { 'X-Dsh-Portal-Host': '127.0.0.1:42001' },
    lang: 'en-US',
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  fireInject()
  const reg = registrations.find((r) => r.id === 'lan-gate-signout')
  let el = reg && reg.component({ wide: true })
  if (el && typeof el.type === 'function') el = el.type({ ...el.props, __expand: true })
  check('5 英文界面显示 Sign out',
    !!el && (el.children || []).map((c) => (typeof c === 'string' ? c : c && c.children)).flat().filter((x) => typeof x === 'string').includes('Sign out'),
    JSON.stringify(el && el.props))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
