// 浏览器半包探针：用假的 window / document / fetch 把 lib/client.js 跑两遍，
// 验证「在门户后面」才注册退出按钮、点一下确实跳到门户登出地址。
import fs from 'node:fs'
import vm from 'node:vm'

const CLIENT = process.argv[2] || new URL("../lib/client.js", import.meta.url).pathname
const source = fs.readFileSync(CLIENT, 'utf8')

function makeEnv({ hostname, port, pageHost, meResponse, meHeaders = {}, docHeaders = {}, domPortal = false, lang = 'zh-CN' }) {
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
    contentType: 'text/html',
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
  const captured = {}
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    setTimeout: (fn, ms) => { if (ms < 1000) fn(); return { unref() {} } },
    clearTimeout() {}, setInterval: () => ({ unref() {} }), clearInterval() {},
    AbortController: globalThis.AbortController,
    URL: globalThis.URL,
    location,
    document,
    addEventListener() {},
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
  // 文档响应按 docHeaders 造；/__portal/me 按 meHeaders 造。
  const headersFor = (doc) => ({
    get(name) {
      const key = String(name).toLowerCase()
      const table = doc ? docHeaders : meHeaders
      const found = Object.keys(table).find((k) => k.toLowerCase() === key)
      return found ? table[found] : null
    },
  })
  sandbox.fetch = async (url, opts) => {
    calls.push({ url, opts: opts || {} })
    const doc = String(url).startsWith('http')
    return {
      ok: doc ? true : meResponse !== undefined,
      status: doc ? 200 : (meResponse !== undefined ? 200 : 404),
      headers: headersFor(doc),
      json: async () => (doc ? null : meResponse),
    }
  }
  sandbox.document.contentType = document.contentType || 'text/html'
  sandbox.document.title = domPortal ? 'dsh 登录' : 'DeepSeek Harness'
  sandbox.document.querySelector = (sel) => (domPortal && String(sel).includes('/__portal/login') ? {} : null)
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

// 5d) 只有 DOM 铁证（登录页标题）、探针也 404 的情况下，按钮仍要出现
//     —— 这是「IP + 反代 + 探针路由被吃掉」这类最坏组合的兜底。
{
  const env = makeEnv({
    hostname: '100.96.52.76', port: '3080',
    meResponse: undefined, meHeaders: {},
    domPortal: true,
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 900))
  fireInject()
  await new Promise((r) => setTimeout(r, 20))
  check('5d DOM 铁证 → 注册按钮', registrations.some((r) => r.id === 'lan-gate-signout'),
    JSON.stringify(registrations))
}

// 5e) 什么都没有（普通反代、探针也拿不到用户）→ 不注册
{
  const env = makeEnv({ hostname: '10.0.0.9', port: '8080', meResponse: undefined })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 900))
  fireInject()
  await new Promise((r) => setTimeout(r, 20))
  check('5e 三路都无 → 不注册', !registrations.some((r) => r.id === 'lan-gate-signout'))
}

// 5b) 用公开域名访问门户：origin 是 dsh.example:7998，门户把 Host 改写成 127.0.0.1:42001
//     ——「Host 和 origin 对不上」不代表「不在门户后面」，按钮必须照样出现。
{
  const env = makeEnv({
    hostname: 'dsh.103724.xyz', port: '7998',
    meResponse: { user: 'zeiss' },
    meHeaders: { 'X-Dsh-Portal-Host': '127.0.0.1:42001' },
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  fireInject()
  check('5b 用域名访问门户时按钮仍注册',
    registrations.some((r) => r.id === 'lan-gate-signout'), JSON.stringify(registrations))
}

// 5c) 没有反代（Host 与页面 origin 一致）→ 不是门户，不注册
{
  const env = makeEnv({
    hostname: 'dsh.example', port: '7998',
    meResponse: { user: 'zeiss' },
    meHeaders: { 'X-Dsh-Portal-Host': 'dsh.example:7998' },
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  fireInject()
  check('5c Host 与 origin 一致 → 不注册', !registrations.some((r) => r.id === 'lan-gate-signout'))
}

// 6) 门户标记：文档响应带 X-Dsh-Portal: 1 就记下标记，并且以后每次都告诉门户「别缓存」
{
  const env = makeEnv({
    hostname: '100.96.52.76', port: '3080',
    meResponse: { user: 'zeiss' },
    meHeaders: { 'X-Dsh-Portal-Host': '127.0.0.1:42001' },
    docHeaders: { 'X-Dsh-Portal': '1' },
  })
  const { registrations, fireInject } = run(env)
  await new Promise((r) => setTimeout(r, 30))
  fireInject()
  const docCalls = env.calls.filter((c) => String(c.url).startsWith('http'))
  check('6a 入口处向自己的文档地址发过一次标记请求', docCalls.length === 1, JSON.stringify(env.calls.map((c) => c.url)))
  check('6b 文档探测不带自定义头（浏览器导航时也带不了）',
    docCalls[0] && !docCalls[0].opts.headers, JSON.stringify(docCalls[0] && docCalls[0].opts))
  check('6c 文档响应带 X-Dsh-Portal 后写下了本地标记',
    env.sandbox.localStorage.getItem('dsh-lan-gate.portal') === '1',
    String(env.sandbox.localStorage.getItem('dsh-lan-gate.portal')))
  check('6d 门户后面的按钮照常注册', registrations.some((r) => r.id === 'lan-gate-signout'))
}

// 7) 没有门户头的普通反代：不写标记，按钮靠探针判断（仍不注册，因为探针没拿到用户）
{
  const env = makeEnv({ hostname: '10.0.0.9', port: '8080', meResponse: undefined, meHeaders: {} })
  const { registrations } = run(env)
  await new Promise((r) => setTimeout(r, 20))
  check('7 没有门户头 → 不写标记', env.sandbox.localStorage.getItem('dsh-lan-gate.portal') === null)
  check('7b 仍不注册按钮', !registrations.some((r) => r.id === 'lan-gate-signout'))
}

// 8) 纯判定：bfcache 恢复时什么时候才把人送回登录页
{
  const env = makeEnv({ hostname: '100.96.52.76', port: '3080', meResponse: { user: 'zeiss' } })
  const { mod } = run(env)
  const decide = mod.shouldLeaveRestoredPage
  const cases = [
    [{ mark: '1', portal: '1', bfcache: true, meStatus: 401 }, true, '点过退出 + bfcache + 已登出'],
    [{ mark: '1', portal: '1', bfcache: true, meStatus: 403 }, true, '点过退出 + bfcache + 403'],
    [{ mark: '1', portal: '1', bfcache: true, meStatus: 200 }, false, '仍登录着'],
    [{ mark: '0', portal: '0', bfcache: true, meStatus: 401 }, false, '没点过退出'],
    [{ mark: '1', portal: '0', bfcache: true, meStatus: 401 }, false, '不在门户后面'],
    [{ mark: '1', portal: '1', bfcache: false, meStatus: 401 }, false, '不是 bfcache 恢复'],
  ]
  for (const [input, want, label] of cases) {
    check('8 ' + label, decide(input) === want, JSON.stringify(input))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)
