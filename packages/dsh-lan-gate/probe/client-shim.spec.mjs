/**
 * client shim 行为测试（不需要浏览器，纯 Node + vm 模拟浏览器全局）。
 *
 * 跑法：node probe/client-shim.spec.mjs
 *
 * 覆盖：
 *  1. 私有地址（门户场景，CGNAT 段 100.64.0.0/10）→ 放宽 isLoopback
 *  2. 公网域名 → 不放宽，且说明原因（安全收紧）
 *  3. randomUUID 兜底：getRandomValues 可用 / 不可用（Math.random 降级）
 *  4. clipboard 兜底：writeText 可用；document.body 未就绪时明确 reject
 *  5. loader 契约缺失时，第一层兜底仍然生效
 *  6. IIFE 作用域：不往全局泄漏内部符号
 */

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function makeSandbox({ host = '100.64.0.1', withGetRandomValues = true,
                       withLoader = true, withBody = true, injectedHosts = null } = {}) {
  const modules = {};
  const loader = {
    load(def) {
      const exportsObj = def.factory((id) => modules[id]);
      modules[def.id] = exportsObj;
      return exportsObj;
    },
  };
  const sandbox = {
    console: { warn: () => {}, log: () => {}, error: () => {} },
    isSecureContext: false,
    location: { hostname: host },
    Uint8Array,
    Math,
    Promise,
    Error,
    setInterval: () => 0,
    clearInterval: () => {},
    crypto: withGetRandomValues
      ? { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (i * 37) % 256; return arr; } }
      : {},
    navigator: {},
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, select() {}, setSelectionRange() {}, value: '' }),
      body: withBody ? { appendChild() {}, removeChild() {} } : null,
      execCommand: () => true,
    },
  };
  if (withLoader) sandbox.__ModuleLoader__ = loader;
  if (injectedHosts) sandbox.__DSH_LAN_GATE_HOSTS__ = injectedHosts;
  sandbox.globalThis = sandbox;
  runInNewContext(SRC, sandbox, { filename: 'client.js' });
  return { sandbox, modules };
}

function fakeCtx(isLoopback = false) {
  return { connection: { isLoopback } };
}

const results = [];
function check(name, fn) {
  try { fn(); results.push([true, name]); }
  catch (e) { results.push([false, `${name} — ${e.message}`]); }
}

// 1) 门户场景：私有/保留段 → 放宽
check('私有地址(100.64.0.1) 放宽 isLoopback', () => {
  const { sandbox, modules } = makeSandbox({ host: '100.64.0.1' });
  const mod = modules['dsh-lan-gate'];
  mod.apply(fakeCtx(false));
  const d = sandbox.__DSH_LAN_GATE__;
  assert.equal(d.trusted, true, 'trusted 应为 true');
  assert.equal(d.isLoopbackAfter, true, 'isLoopback 应被改为 true');
  assert.equal(d.layer1Ran, true);
  assert.equal(d.loaderSeen, true);
});

// 2) 公网域名 → 不放宽（v0.11.0 的安全收紧）
check('公网域名不放宽 isLoopback，并说明原因', () => {
  const { sandbox, modules } = makeSandbox({ host: 'dsh.example.com' });
  const ctx = fakeCtx(false);
  modules['dsh-lan-gate'].apply(ctx);
  const d = sandbox.__DSH_LAN_GATE__;
  assert.equal(d.trusted, false, '公网地址不应被判为受信');
  assert.equal(ctx.connection.isLoopback, false, 'isLoopback 必须保持原值');
  assert.match(d.trustedReason, /公网/);
});

// 3) 各类私有段都应放行
for (const h of ['127.0.0.1', '10.1.2.3', '192.168.5.24', '172.20.0.1', 'localhost',
                 'kirby.tail1234.ts.net', 'fd7a:115c:a1e0::1']) {
  check(`私有段放行: ${h}`, () => {
    const { sandbox, modules } = makeSandbox({ host: h });
    modules['dsh-lan-gate'].apply(fakeCtx(false));
    assert.equal(sandbox.__DSH_LAN_GATE__.trusted, true);
    assert.equal(sandbox.__DSH_LAN_GATE__.isLoopbackAfter, true);
  });
}

// 4) randomUUID 兜底（getRandomValues 可用）
check('randomUUID 兜底生成合规 v4（crypto 源）', () => {
  const { sandbox } = makeSandbox();
  const d = sandbox.__DSH_LAN_GATE__;
  assert.equal(d.randomUUIDPatched, true);
  assert.match(d.randomUUIDSource, /getRandomValues/);
  assert.match(sandbox.crypto.randomUUID(), V4);
});

// 5) randomUUID 二次降级（getRandomValues 不可用）
check('randomUUID 二次降级（Math.random）仍生成合规 v4', () => {
  const { sandbox } = makeSandbox({ withGetRandomValues: false });
  const d = sandbox.__DSH_LAN_GATE__;
  assert.equal(d.randomUUIDPatched, true);
  assert.match(d.randomUUIDSource, /math-random/);
  assert.match(sandbox.crypto.randomUUID(), V4);
});

// 6) clipboard 兜底 + body 未就绪时明确 reject
check('clipboard 兜底可用；body 未就绪时明确报错', async () => {
  const ok = makeSandbox();
  assert.equal(ok.sandbox.__DSH_LAN_GATE__.clipboardPatched, true);
  assert.equal(typeof ok.sandbox.navigator.clipboard.writeText, 'function');
  await ok.sandbox.navigator.clipboard.writeText('hello');

  const noBody = makeSandbox({ withBody: false });
  await assert.rejects(() => noBody.sandbox.navigator.clipboard.writeText('x'),
    /document\.body/);
  await assert.rejects(() => noBody.sandbox.navigator.clipboard.readText(),
    /剪贴板/);
});

// 7) loader 缺失 → 第一层仍生效
check('loader 契约缺失时第一层兜底仍生效', () => {
  const { sandbox } = makeSandbox({ withLoader: false });
  const d = sandbox.__DSH_LAN_GATE__;
  assert.equal(d.loaderSeen, false);
  assert.equal(d.layer1Ran, true, '第一层必须仍然执行');
  assert.equal(d.randomUUIDPatched, true);
  assert.match(sandbox.crypto.randomUUID(), V4);
});

// 8) IIFE：不泄漏内部符号
check('IIFE 作用域：内部符号不泄漏到全局', () => {
  const { sandbox } = makeSandbox();
  for (const sym of ['__lgSafe', 'polyfillRandomUUID', 'diag', 'formatV4', 'isPrivateHostname']) {
    assert.equal(sandbox[sym], undefined, `${sym} 不应出现在全局`);
  }
  assert.ok(sandbox.__DSH_LAN_GATE__, '诊断对象应显式暴露');
});

// 汇总
const failed = results.filter(([ok]) => !ok);
for (const [ok, name] of results) console.log(`${ok ? '✓' : '✗'} ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
