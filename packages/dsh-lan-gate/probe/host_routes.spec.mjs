// 宿主半包探针：用假 ctx / 假 req-res 直接驱动 lib/index.js 的两条路由。
//
// 验证的是「重启按钮的服务端契约」：
//   · 路由注册与释放（webServer.register 的 disposer 被正确调用）
//   · ping 不校验令牌（重启后令牌会换，客户端正拿旧令牌轮询）
//   · restart 的三层门：令牌 → 同源 → 只在 systemd 托管时开放
//   · 放行后：202 先回，再 ctx.appExit(1)（非零码 = 单元 Restart=on-failure 才会拉起来）
//   · index.html 注入行里带着同一个令牌
//
// 运行：node probe/host_routes.spec.mjs

import { apply } from '../lib/index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  — ' + detail))
}

function makeCtx() {
  const routes = new Map()
  const effects = []
  const listeners = []
  const exits = []
  const ctx = {
    webServer: {
      protocol: 'http:',
      register(route) {
        if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    appExit(code) {
      exits.push(code)
    },
    effect(fn, label) {
      const disposer = fn()
      effects.push({ label, disposer })
    },
    on(name, fn, options) {
      listeners.push({ name, fn, options })
    },
  }
  return { ctx, routes, effects, listeners, exits }
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body || ''
    },
  }
}

async function call(route, { method = 'GET', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const res = makeRes()
  await route.handler({ method, headers, socket: { remoteAddress } }, res)
  let json = null
  try {
    json = JSON.parse(res.body || 'null')
  } catch {
    json = null
  }
  return { status: res.status, json, headers: res.headers }
}

/** 注入行里的令牌 = 唯一可信来源（客户端就是从 index.html 拿它的）。 */
function injectedGlobal(listeners) {
  const table = []
  for (const entry of listeners) {
    if (entry.name === 'webserver/index-inject') entry.fn(table)
  }
  return table.find((row) => row.kind === 'global' && row.name === '__DSH_LAN_GATE_RESTART__')
}

const previousInvocation = process.env.INVOCATION_ID
process.env.INVOCATION_ID = 'test-invocation-id'

/* ── 1. 托管实例：注册、注入、鉴权、放行 ─────────────────────────── */

{
  const { ctx, routes, effects, listeners, exits } = makeCtx()
  apply(ctx)

  check('1a 注册了 ping 与 restart 两条路由',
    routes.has('/__lan-gate/ping') && routes.has('/__lan-gate/restart'),
    JSON.stringify([...routes.keys()]))
  check('1b 两条路由都是 exact',
    routes.get('/__lan-gate/ping').kind === 'exact'
    && routes.get('/__lan-gate/restart').kind === 'exact')
  check('1c 注册了 index-inject 监听且带 global',
    listeners.some((l) => l.name === 'webserver/index-inject' && l.options?.global === true),
    JSON.stringify(listeners.map((l) => [l.name, l.options])))
  check('1d 注册了 dispose effect', effects.length === 1 && typeof effects[0].disposer === 'function',
    JSON.stringify(effects.map((e) => e.label)))

  const injected = injectedGlobal(listeners)
  check('1e 注入行带令牌/pid/managed/两条路径',
    !!injected && typeof injected.value.token === 'string' && injected.value.token.length >= 16
    && injected.value.pid === process.pid && injected.value.managed === true
    && injected.value.pingPath === '/__lan-gate/ping'
    && injected.value.restartPath === '/__lan-gate/restart',
    JSON.stringify(injected && injected.value))

  const ping = await call(routes.get('/__lan-gate/ping'))
  check('1f ping 无令牌也回 200，且报 pid / managed',
    ping.status === 200 && ping.json.pid === process.pid && ping.json.managed === true,
    JSON.stringify(ping))
  check('1g ping 回 no-store', String(ping.headers['Cache-Control']).includes('no-store'))

  const badMethod = await call(routes.get('/__lan-gate/restart'), { method: 'GET' })
  check('1h GET restart → 405', badMethod.status === 405 && badMethod.json.error === 'method-not-allowed',
    JSON.stringify(badMethod))

  const noToken = await call(routes.get('/__lan-gate/restart'), { method: 'POST' })
  check('1i 没令牌 → 403 bad-token', noToken.status === 403 && noToken.json.error === 'bad-token',
    JSON.stringify(noToken))

  const wrongToken = await call(routes.get('/__lan-gate/restart'), {
    method: 'POST', headers: { 'x-dsh-lan-gate-token': 'x'.repeat(injected.value.token.length) },
  })
  check('1j 令牌长度对但内容错 → 403', wrongToken.status === 403 && wrongToken.json.error === 'bad-token',
    JSON.stringify(wrongToken))

  const crossOrigin = await call(routes.get('/__lan-gate/restart'), {
    method: 'POST',
    headers: {
      'x-dsh-lan-gate-token': injected.value.token,
      origin: 'http://evil.example',
      host: '127.0.0.1:43001',
    },
  })
  check('1k 跨站 Origin → 403 cross-origin',
    crossOrigin.status === 403 && crossOrigin.json.error === 'cross-origin', JSON.stringify(crossOrigin))

  const ok = await call(routes.get('/__lan-gate/restart'), {
    method: 'POST',
    headers: {
      'x-dsh-lan-gate-token': injected.value.token,
      origin: 'http://127.0.0.1:43001',
      host: '127.0.0.1:43001',
    },
  })
  check('1l 令牌 + 同源 → 202', ok.status === 202 && ok.json.restarting === true, JSON.stringify(ok))
  check('1m 202 里带 exitCode=1（非零才会被 Restart=on-failure 拉起）', ok.json.exitCode === 1,
    JSON.stringify(ok.json))

  const second = await call(routes.get('/__lan-gate/restart'), {
    method: 'POST', headers: { 'x-dsh-lan-gate-token': injected.value.token },
  })
  check('1n 并发第二次 → 409 already-restarting',
    second.status === 409 && second.json.error === 'already-restarting', JSON.stringify(second))

  check('1o 202 先回，appExit 还没被调用（延迟 250ms）', exits.length === 0, JSON.stringify(exits))
  await new Promise((r) => setTimeout(r, 400))
  check('1p 之后以 1 请求 appExit', exits.length === 1 && exits[0] === 1, JSON.stringify(exits))

  const disposer = effects[0].disposer
  disposer()
  check('1q dispose 后两条路由都撤掉', !routes.has('/__lan-gate/ping') && !routes.has('/__lan-gate/restart'),
    JSON.stringify([...routes.keys()]))
}

/* ── 2. 裸进程（没有 INVOCATION_ID）：一律拒绝，绝不把自己弄死 ────── */

{
  delete process.env.INVOCATION_ID
  const { ctx, routes, listeners, exits } = makeCtx()
  apply(ctx)
  const injected = injectedGlobal(listeners)
  check('2a 注入行 managed=false', injected.value.managed === false, JSON.stringify(injected.value))
  const ping = await call(routes.get('/__lan-gate/ping'))
  check('2b ping 仍然可用（只报状态）', ping.status === 200 && ping.json.managed === false)
  const refused = await call(routes.get('/__lan-gate/restart'), {
    method: 'POST', headers: { 'x-dsh-lan-gate-token': injected.value.token },
  })
  check('2c restart → 409 not-systemd-managed',
    refused.status === 409 && refused.json.error === 'not-systemd-managed', JSON.stringify(refused))
  await new Promise((r) => setTimeout(r, 400))
  check('2d 没有请求 appExit', exits.length === 0, JSON.stringify(exits))
}

if (previousInvocation === undefined) delete process.env.INVOCATION_ID
else process.env.INVOCATION_ID = previousInvocation

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
