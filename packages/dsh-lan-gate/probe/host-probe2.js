/**
 * host-probe2.js — 第二轮探针，回答「插件如何在宿主侧拿到 webServer 服务实例并改造它」。
 *
 * 关键假设（本轮验证）：
 *   A. 声明 inject: ['webServer'] 后，ctx.webServer 就是 WebServer 实例；
 *   B. WebServer.Config 是 zod schema 静态属性，改写它可以让非 loopback host 通过校验；
 *   C. webServer.server 是 node:http Server，可直接在 'upgrade' / 'request' 上挂钩做鉴权；
 *   D. webServer.register* / registerUpgrade 是路由级钩子。
 *
 * 输出写到 $DSH_HOME/logs/host-probe2.json。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.DSH_PROBE2_OUT
  || `${process.env.DSH_HOME || process.env.HOME + '/.dsh'}/logs/host-probe2.json`;

export const name = 'host-probe2';
export const inject = ['webServer'];

function snap(v, keys) {
  const o = {};
  for (const k of keys) {
    try { o[k] = typeof v[k] === 'function' ? `[fn arity=${v[k].length}]` : v[k]; } catch (e) { o[k] = `<err ${e && e.message}>`; }
  }
  return o;
}

export function apply(ctx) {
  const r = { when: new Date().toISOString(), steps: [] };
  const push = (k, v) => r.steps.push({ k, v });

  try {
    // A. 服务实例
    const ws = ctx.webServer;
    push('A.webServer.typeof', typeof ws);
    push('A.webServer.ctor', ws && ws.constructor && ws.constructor.name);
    push('A.webServer.name', ws && ws.name);
    push('A.webServer.snap', snap(ws, ['name', 'host', 'port', 'listenedPort']));
    push('A.webServer.ownKeys', ws ? Object.getOwnPropertyNames(ws) : null);
    push('A.webServer.protoKeys', ws ? Object.getOwnPropertyNames(Object.getPrototypeOf(ws) || {}) : null);

    // B. Config schema —— 能不能改写
    const Ctor = ws && ws.constructor;
    push('B.Config.exists', !!(Ctor && Ctor.Config));
    try {
      push('B.Config.type', Ctor && Ctor.Config && Ctor.Config.constructor && Ctor.Config.constructor.name);
      push('B.Config.serialize', Ctor && Ctor.Config && typeof Ctor.Config.toJSON === 'function'
        ? JSON.stringify(Ctor.Config.toJSON()).slice(0, 400) : null);
    } catch (e) { push('B.Config.err', String(e && e.message)); }

    // B2. 尝试给 Config 加上 tailnet host 的允许值（如果它支持 union 扩展）
    try {
      push('B.Config.describe', Ctor && Ctor.Config && typeof Ctor.Config.describe === 'function'
        ? String(Ctor.Config.describe()).slice(0, 200) : null);
    } catch (e) { push('B.Config.describe.err', String(e && e.message)); }

    // C. 底层 node:http server
    push('C.server.exists', !!ws.server);
    push('C.server.ctor', ws.server && ws.server.constructor && ws.server.constructor.name);
    push('C.server.listening', ws.server && ws.server.listening);
    try {
      const addr = ws.server && ws.server.address && ws.server.address();
      push('C.server.address', addr ? JSON.stringify(addr) : null);
    } catch (e) { push('C.server.address.err', String(e && e.message)); }
    push('C.server.listenerCounts', ws.server ? {
      request: ws.server.listenerCount('request'),
      upgrade: ws.server.listenerCount('upgrade'),
      connection: ws.server.listenerCount('connection'),
    } : null);

    // D. 路由 API
    push('D.register', typeof ws.register);
    push('D.registerUpgrade', typeof ws.registerUpgrade);
    push('D.registerFallback', typeof ws.registerFallback);
    push('D.tapIndex', typeof ws.tapIndex);
    push('D.exact.size', ws.exact ? ws.exact.size : null);
    push('D.prefixes.size', ws.prefixes ? ws.prefixes.size : null);
    push('D.upgrades.size', ws.upgrades ? ws.upgrades.size : null);
    push('D.prefixes.keys', ws.prefixes ? [...ws.prefixes.keys()].slice(0, 40) : null);
    push('D.upgrades.keys', ws.upgrades ? [...ws.upgrades.keys()].slice(0, 40) : null);
    push('D.exact.keys', ws.exact ? [...ws.exact.keys()].slice(0, 40) : null);

    // E. webRuntime —— 看它有没有 trustedHosts
    try {
      const wr = ctx.get('webRuntime');
      push('E.webRuntime.type', typeof wr);
      if (wr) {
        push('E.webRuntime.ctor', wr.constructor && wr.constructor.name);
        push('E.webRuntime.config', JSON.stringify(wr.config || {}).slice(0, 400));
        push('E.webRuntime.trustedHosts', JSON.stringify(wr.trustedHosts || null).slice(0, 400));
      }
    } catch (e) { push('E.err', String(e && e.message)); }

    // F. webStartup
    try {
      const wsu = ctx.get('webStartup');
      push('F.webStartup.type', typeof wsu);
      if (wsu) push('F.webStartup.value', JSON.stringify(wsu).slice(0, 400));
    } catch (e) { push('F.err', String(e && e.message)); }

    // G. reflect 服务表里所有已注册的名字
    try {
      const store = ctx.reflect && ctx.reflect.store;
      if (store) {
        const names = [];
        for (const sym of Object.getOwnPropertySymbols(store)) {
          const impl = store[sym];
          if (impl && impl.name) names.push({ name: impl.name, fiber: impl.fiber && impl.fiber.name });
        }
        push('G.serviceTable', names.slice(0, 120));
      }
    } catch (e) { push('G.err', String(e && e.message)); }
  } catch (e) {
    push('FATAL', String(e && e.stack).slice(0, 1200));
  }

  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(r, null, 2));
    process.stderr.write(`[host-probe2] wrote ${OUT}\n`);
  } catch (e) {
    process.stderr.write(`[host-probe2] write failed: ${e && e.message}\n`);
  }
}
