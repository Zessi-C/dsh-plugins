/**
 * host-probe.js — 一次性探针，用来在真实 dsh 启动环境里回答三个问题：
 *
 *   Q1. 插件 apply(ctx) 的 ctx 上到底有哪些服务名？（找 http / server / connection / webRuntime）
 *   Q2. 这几个候选服务的对象形状是什么？（有哪些方法，能不能 createServer / use / upgrade）
 *   Q3. Web 服务器的 Host/Origin 栅栏装在哪一层？插件有没有可控的钩子？
 *
 * 输出：写到 $DSH_HOME/logs/host-probe.json（避免被 dsh 自己的 stdout 吞掉）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.env.DSH_PROBE_OUT || `${process.env.DSH_HOME || process.env.HOME + '/.dsh'}/logs/host-probe.json`;

const CANDIDATE_SERVICES = [
  'http', 'httpServer', 'server', 'webServer', 'web', 'webRuntime', 'app', 'appRuntime',
  'connection', 'client', 'clientConnection', 'router', 'hono', 'koa', 'listener',
  'socket', 'net', 'io', 'logger', 'config', 'settings', 'storage', 'loader', 'root',
];

function describe(v, depth = 0) {
  if (v === null) return { type: 'null' };
  const t = typeof v;
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'function') return { type: 'function', name: v.name, arity: v.length, src: String(v).slice(0, 200) };
  if (t !== 'object') return { type: t, value: String(v).slice(0, 200) };

  const out = { type: 'object' };
  try { out.ctor = v.constructor && v.constructor.name; } catch (_) {}
  try { out.ownKeys = Object.getOwnPropertyNames(v).slice(0, 80); } catch (_) {}
  try {
    const proto = Object.getPrototypeOf(v);
    out.protoName = proto && proto.constructor && proto.constructor.name;
    out.protoKeys = proto ? Object.getOwnPropertyNames(proto).slice(0, 80) : null;
  } catch (_) {}
  try {
    out.symbols = Object.getOwnPropertySymbols(v).map(String).slice(0, 20);
  } catch (_) {}

  // 第二层：把看起来像服务的方法列出来（只列名字 + 签名，不递归对象，避免爆栈）
  if (depth === 0) {
    out.methods = {};
    for (const k of (out.ownKeys || [])) {
      try {
        const dv = v[k];
        if (typeof dv === 'function') out.methods[k] = { arity: dv.length, src: String(dv).slice(0, 160) };
      } catch (_) {}
    }
  }
  return out;
}

export const name = 'host-probe';

/** 不 inject，直接用 ctx 代理的 ownKeys 探测。 */
export function apply(ctx) {
  const report = {
    when: new Date().toISOString(),
    dshVersion: null,
    env: {
      DSH_HOME: process.env.DSH_HOME || null,
      cwd: process.cwd(),
    },
    ctxOwnKeys: null,
    ctxOwnKeysErr: null,
    services: {},
    globalServices: {},
    errors: [],
  };

  try {
    report.ctxOwnKeys = Object.getOwnPropertyNames(ctx).slice(0, 200);
  } catch (e) { report.ctxOwnKeysErr = String(e && e.message); }

  for (const k of CANDIDATE_SERVICES) {
    try {
      const v = ctx.get ? ctx.get(k) : ctx[k];
      report.services[k] = describe(v, 0);
    } catch (e) {
      report.services[k] = { error: String(e && e.message).slice(0, 200) };
    }
  }

  // 有些服务挂在全局符号表上 —— 把 cordis reflect 的服务表挖出来
  try {
    const syms = Object.getOwnPropertySymbols(globalThis);
    report.globalSymbols = syms.map(String).slice(0, 60);
    for (const s of syms) {
      const n = String(s);
      if (/cordis|dsh|reflect|service/i.test(n)) {
        try { report.globalServices[n] = describe(globalThis[s], 0); } catch (e) { report.globalServices[n] = String(e && e.message); }
      }
    }
  } catch (e) { report.errors.push('globals: ' + String(e && e.message)); }

  // cordis 的 Reflect 服务表（如果 ctx 上有）
  for (const holder of ['reflect', '$reflect', 'root', 'app']) {
    try {
      const h = ctx.get ? ctx.get(holder) : ctx[holder];
      if (!h) continue;
      if (h.store && typeof h.store === 'object') {
        report[`${holder}.store`] = Object.keys(h.store).slice(0, 100);
      }
      if (h.services && typeof h.services === 'object') {
        report[`${holder}.services`] = Object.keys(h.services).slice(0, 100);
      }
    } catch (_) {}
  }

  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2));
    process.stderr.write(`[host-probe] wrote ${OUT}\n`);
  } catch (e) {
    process.stderr.write(`[host-probe] write failed: ${e && e.message}\n`);
  }
}
