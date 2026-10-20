/**
 * host-probe3.js — 第三轮探针。目标是真正打通「插件把 webServer 绑到 Tailscale IP」。
 *
 * 思路（按侵入性从低到高，逐个尝试并记录结果）：
 *   S1. 改写 WebServer.Config 的 host 字段，把 z.union([const,const]) 换成 z.string()。
 *   S2. 若 S1 不可行，直接改 config 对象里的 host 值（在 Service.init 之前）。
 *   S3. 兜底：保留 loopback 监听，另起一个 net.Server 监听 tailnet IP 做 TCP 转发。
 *
 * 本轮先只做「可行性探测」，不真去监听 —— 只报告 schema 能不能被改写。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.DSH_PROBE3_OUT
  || `${process.env.DSH_HOME || process.env.HOME + '/.dsh'}/logs/host-probe3.json`;

export const name = 'host-probe3';
export const inject = ['webServer'];

export function apply(ctx) {
  const r = { when: new Date().toISOString(), steps: [] };
  const push = (k, v) => r.steps.push({ k, v: typeof v === 'string' ? v.slice(0, 1500) : v });

  const ws = ctx.webServer;
  const Ctor = ws && ws.constructor;

  push('now.host', ws && ws.host);
  push('now.config.host', ws && ws.config && ws.config.host);

  // ---- S1: 探测 zod schema 的可改写性 ----
  try {
    const Cfg = Ctor.Config;
    push('S1.Config.ownKeys', Object.getOwnPropertyNames(Cfg));
    push('S1.Config.symbols', Object.getOwnPropertySymbols(Cfg).map(String));
    // zod 的 shape 挂在 _def 或 .shape
    push('S1.shape.type', Cfg.shape ? typeof Cfg.shape : null);
    if (Cfg.shape) push('S1.shape.keys', Object.keys(Cfg.shape));
    push('S1._def.typeName', Cfg._def && Cfg._def.typeName);
    push('S1._def.keys', Cfg._def && Cfg._def.shape ? Object.keys(Cfg._def.shape) : null);
    if (Cfg._def && Cfg._def.shape && Cfg._def.shape.host) {
      const h = Cfg._def.shape.host;
      push('S1.host._def.typeName', h._def && h._def.typeName);
      push('S1.host._def.options', h._def && h._def.options ? h._def.options.map((o) => JSON.stringify(o._def && o._def.value)) : null);
    }
    push('S1.configurable', Object.getOwnPropertyDescriptor(Ctor, 'Config'));
  } catch (e) { push('S1.err', String(e && e.stack).slice(0, 800)); }

  // ---- S2: 尝试改 schema：把 host 换成允许任意字符串 ----
  try {
    // schemastery 的 API 探测
    const z = Object.getPrototypeOf(Ctor.Config);
    push('S2.protoKeys', Object.getOwnPropertyNames(z || {}).slice(0, 60));
  } catch (e) { push('S2.err', String(e && e.message)); }

  try {
    // 直接构造一个新的 schema 对象：利用 Cfg 的 constructor + _def 拷贝，替换 host
    const Cfg = Ctor.Config;
    const def = Cfg._def;
    push('S2.defHasShape', !!(def && def.shape));
    if (def && def.shape && def.shape.host) {
      // schemastery 的 const 类型：探测它内部结构
      push('S2.hostConst', JSON.stringify(def.shape.host && def.shape.host._def && def.shape.host._def.value));
      push('S2.hostCtor', def.shape.host && def.shape.host.constructor && def.shape.host.constructor.name);
    }
    // schemastery 顶层导出
    push('S2.CfgCtorName', Cfg.constructor && Cfg.constructor.name);
  } catch (e) { push('S2.err2', String(e && e.message)); }

  // ---- S3: config 对象本身能不能改 ----
  try {
    const c = ws.config;
    push('S3.configOwnKeys', Object.getOwnPropertyNames(c));
    const d = Object.getOwnPropertyDescriptor(c, 'host');
    push('S3.hostDesc', d ? { writable: d.writable, configurable: d.configurable, value: d.value } : null);
    // 真的试着改一下（不重新 listen，只看是否被允许）
    const before = c.host;
    try {
      c.host = '<TAILNET_IP>';
      push('S3.assign.hostAfter', c.host);
      c.host = before; // 还原
      push('S3.assign.restored', c.host === before);
    } catch (e) { push('S3.assign.err', String(e && e.message)); }
  } catch (e) { push('S3.err', String(e && e.message)); }

  // ---- S4: 看 server 是否允许重新 listen（关掉旧的再 listen 新的） ----
  try {
    push('S4.server.listening', ws.server && ws.server.listening);
    push('S4.server.hasClose', typeof (ws.server && ws.server.close));
    push('S4.server.hasListen', typeof (ws.server && ws.server.listen));
  } catch (e) { push('S4.err', String(e && e.message)); }

  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(r, null, 2));
    process.stderr.write(`[host-probe3] wrote ${OUT}\n`);
  } catch (e) {
    process.stderr.write(`[host-probe3] write failed: ${e && e.message}\n`);
  }
}
