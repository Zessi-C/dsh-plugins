/**
 * dsh-lan-gate — 浏览器半包（v0.11.0：安全收紧 + 兜底加固）。
 *
 * 本包只做两件事：
 *  1. cordis.patch.yml 把本包注册成 Loader 已启用条目 —— dsh-client-modules
 *     只扫描已启用的 Loader 条目来组装客户端启动图；
 *  2. 本文件在浏览器里补两处「非回环 + 明文 HTTP」下的能力缺口：
 *       a) isLoopback 改写 —— dsh 的 dsh-client-connection 只用
 *          isLoopbackHostname() 判断（localhost / [::1] / 127.0.0.0/8），
 *          非回环 origin 下设置页会以 unavailable 起步；
 *       b) 非安全上下文缺失的 crypto.randomUUID / navigator.clipboard 兜底。
 *
 * ## 两层结构（v0.10.0 引入，本次保留）
 *
 * b) 与 dsh 的模块系统**无关**，是页面能不能工作的底层能力，放在顶层立即执行；
 * a) 必须挂进 cordis（要拿 connection 服务），走 `window.__ModuleLoader__`。
 * 上游改掉 loader 契约时，第一层仍生效，第二层会在控制台明确告警。
 *
 * ## v0.11.0 的收紧：只对「私有/受信」地址放宽 isLoopback
 *
 * 之前用 `location.hostname` 自证：任何 origin 都被判为受信并关闭 dsh 的
 * 「非本机 → 设置页降级」保护。一旦门户被暴露在公网地址上，这个保护就白关了。
 * 现在只对私有/保留地址段（含 Tailscale 的 100.64/10 与 ts.net）放宽，
 * 公网域名保持 dsh 官方默认行为，并在控制台说明原因。
 *
 * 排查入口：浏览器控制台 `window.__DSH_LAN_GATE__`
 * （layer1Ran / loaderSeen / applyRan / trusted / trustedReason / isLoopbackAfter / errors）。
 */

(function () {
  'use strict';

  var diag = {
    plugin: 'dsh-lan-gate',
    version: '0.11.0',
    layer1Ran: false,
    applyRan: false,
    loaderSeen: false,
    host: null,
    trusted: null,
    trustedReason: null,
    isLoopbackBefore: null,
    isLoopbackAfter: null,
    randomUUIDPatched: null,
    randomUUIDSource: null,
    clipboardPatched: null,
    tries: 0,
    errors: [],
  };
  try { globalThis.__DSH_LAN_GATE__ = diag; } catch (_) {}

  function safe(f) { try { return f(); } catch (_) { return undefined; } }

  function warn(msg) {
    try { console.warn('[dsh-lan-gate] ' + msg); } catch (_) {}
    diag.errors.push(msg);
  }

  /* ──────────────────────────────────────────────────────────────
   * 第一层：与 loader 无关的兜底（立即执行）
   * ────────────────────────────────────────────────────────────── */

  function formatV4(b) {
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
    return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
  }

  function polyfillRandomUUID() {
    try {
      if (globalThis.isSecureContext) { diag.randomUUIDPatched = false; return; }
      const c = globalThis.crypto;
      if (!c) { diag.randomUUIDPatched = 'no-crypto'; return; }
      if (typeof c.randomUUID === 'function') { diag.randomUUIDPatched = false; return; }

      if (typeof c.getRandomValues === 'function') {
        c.randomUUID = () => {
          const b = c.getRandomValues(new Uint8Array(16));
          b[6] = (b[6] & 0x0f) | 0x40;
          b[8] = (b[8] & 0x3f) | 0x80;
          return formatV4(b);
        };
        diag.randomUUIDSource = 'crypto.getRandomValues';
      } else {
        // 二次降级：没有 getRandomValues 时也不能让「生成会话 ID」直接崩掉 ——
        // 这里只用于前端 ID，不是密钥材料，Math.random 足够，但要如实标注来源。
        c.randomUUID = () => {
          const b = new Uint8Array(16);
          for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
          b[6] = (b[6] & 0x0f) | 0x40;
          b[8] = (b[8] & 0x3f) | 0x80;
          return formatV4(b);
        };
        diag.randomUUIDSource = 'math-random (getRandomValues 不可用)';
      }
      diag.randomUUIDPatched = true;
    } catch (e) {
      diag.randomUUIDPatched = 'FAILED: ' + String(e && e.message);
    }
  }

  function polyfillClipboard() {
    try {
      const nav = globalThis.navigator;
      if (!nav) { diag.clipboardPatched = 'no-navigator'; return; }
      if (nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        diag.clipboardPatched = false;   // 原生可用，无需兜底
        return;
      }
      const writeText = (text) => new Promise((resolve, reject) => {
        try {
          // document.body 还没就绪时（脚本早于 body 执行）明确报错，
          // 不要留一个「点了复制但没反应」的哑状态。
          if (!document || !document.body) {
            reject(new Error('document.body 未就绪，无法用 execCommand 兜底复制'));
            return;
          }
          const ta = document.createElement('textarea');
          ta.value = text === null || text === undefined ? '' : String(text);
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          ta.style.left = '-1000px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, ta.value.length);
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) resolve(); else reject(new Error('execCommand("copy") 返回 false'));
        } catch (e) {
          reject(e);
        }
      });
      // readText 在非安全上下文下没有可靠实现 —— 给一个明确 reject，
      // 好过留 undefined 让调用方抛「不是函数」。
      const readText = () => Promise.reject(
        new Error('非安全上下文下无法读取剪贴板（需 HTTPS 或 localhost）'));
      const shim = { writeText, readText };
      try {
        Object.defineProperty(nav, 'clipboard', { value: shim, configurable: true });
      } catch (_) {
        try { nav.clipboard = shim; } catch (_) {}
      }
      diag.clipboardPatched = !!(nav.clipboard && typeof nav.clipboard.writeText === 'function');
    } catch (e) {
      diag.clipboardPatched = 'FAILED: ' + String(e && e.message);
    }
  }

  polyfillRandomUUID();
  polyfillClipboard();
  diag.layer1Ran = true;

  /* ──────────────────────────────────────────────────────────────
   * 受信判定：只对私有/保留地址段放宽 isLoopback
   * ────────────────────────────────────────────────────────────── */

  function isPrivateHostname(host) {
    if (!host) return false;
    const h = String(host).toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (!h) return false;
    if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true;
    if (h === 'ts.net' || h.endsWith('.ts.net')) return true;   // Tailscale MagicDNS
    // IPv6：回环 / 链路本地 / 唯一本地（Tailscale ULA 落在 fc00::/7 里）
    if (h === '::1' || h.indexOf(':') >= 0) {
      return h === '::1' || h.startsWith('fe8') || h.startsWith('fe9')
        || h.startsWith('fea') || h.startsWith('feb') || h.startsWith('fc')
        || h.startsWith('fd');
    }
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;              // 127/8、10/8、0/8
    if (a === 172 && b >= 16 && b <= 31) return true;               // 172.16/12
    if (a === 192 && b === 168) return true;                        // 192.168/16
    if (a === 169 && b === 254) return true;                        // link-local
    if (a === 100 && b >= 64 && b <= 127) return true;              // 100.64/10（Tailscale CGNAT）
    return false;
  }

  function trustDecision() {
    const injected = globalThis.__DSH_LAN_GATE_HOSTS__;
    const host = safe(() => globalThis.location.hostname);
    if (Array.isArray(injected) && injected.length > 0) {
      const ok = !host || injected.some((h) => String(h).toLowerCase() === host);
      return { ok, reason: ok ? '宿主注入白名单' : '不在宿主注入白名单内' };
    }
    if (!host) return { ok: false, reason: '取不到 location.hostname' };
    if (isPrivateHostname(host)) return { ok: true, reason: '私有/受信地址段' };
    return { ok: false, reason: '公网地址，保持 dsh 官方默认（不放宽 isLoopback）' };
  }

  /* ──────────────────────────────────────────────────────────────
   * 第二层：cordis 插件（依赖 dsh 的模块加载器）
   * ────────────────────────────────────────────────────────────── */

  const loader = safe(() => globalThis.__ModuleLoader__);

  if (!loader || typeof loader.load !== 'function') {
    diag.loaderSeen = false;
    warn('window.__ModuleLoader__ 不可用 —— isLoopback 改写未生效（设置页可能显示 unavailable）；'
      + 'crypto/clipboard 兜底已在第一层生效。');
    return;
  }

  diag.loaderSeen = true;
  loader.load({
    id: 'dsh-lan-gate',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      /** 除 conn.isLoopback 外，也尽力覆盖模块导出的判定函数。 */
      function patchConnectionModule() {
        for (const id of ['@deepseek-ai/dsh-client-connection', 'dsh-client-connection']) {
          try {
            const mod = typeof require === 'function' ? require(id) : null;
            if (mod && typeof mod.isLoopbackHostname === 'function') {
              mod.isLoopbackHostname = () => true;
              diag.modulePatched = id;
              return;
            }
          } catch (_) { /* 拿不到就跳过：下面还有 conn.isLoopback 兜底 */ }
        }
      }

      function trustOrigin(ctx) {
        try {
          diag.host = safe(() => globalThis.location.hostname);
          const decision = trustDecision();
          diag.trusted = decision.ok;
          diag.trustedReason = decision.reason;
          if (!diag.trusted) {
            // 不放宽也要留声：否则「设置页不可用」会被误判成插件坏了。
            warn('未放宽 isLoopback：' + decision.reason
              + '（host=' + diag.host + '）；如需放宽请把该地址加入'
              + 'window.__DSH_LAN_GATE_HOSTS__，或改用私有/受信地址访问。');
            return true;    // 不是失败，是有意保持官方行为
          }

          const conn = (ctx && safe(() => ctx.connection))
            || (ctx && typeof ctx.get === 'function' ? ctx.get('connection') : null);
          if (!conn) return false;
          diag.isLoopbackBefore = conn.isLoopback;
          if (conn.isLoopback === true) return true;

          patchConnectionModule();

          try {
            Object.defineProperty(conn, 'isLoopback', { get: () => true, configurable: true });
            diag.definePropertyOk = true;
          } catch (e) {
            diag.definePropertyOk = 'FAILED: ' + String(e && e.message);
          }
          if (diag.definePropertyOk !== true) {
            try { conn.isLoopback = true; diag.assignOk = true; }
            catch (e) { diag.assignOk = 'FAILED: ' + String(e && e.message); }
          }
          diag.isLoopbackAfter = conn.isLoopback;
          return diag.isLoopbackAfter === true;
        } catch (e) {
          warn(String(e && e.message));
          return false;
        }
      }

      const name = 'dsh-lan-gate';
      // Cordis 的 ctx 是代理：不声明 inject 就取不到服务（报
      // "cannot get property \"connection\" without inject"）。
      const inject = ['connection'];

      function apply(ctx) {
        diag.applyRan = true;
        if (trustOrigin(ctx)) return;
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          diag.tries = tries;
          if (trustOrigin(ctx) || tries >= 150) {
            clearInterval(timer);
            if (tries >= 150 && diag.isLoopbackAfter !== true) {
              // 静默失败最难查 —— 这里必须留声。
              warn('connection 服务 30s 内未就绪，isLoopback 改写未生效');
            }
          }
        }, 200);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }

      exports.name = name;
      exports.inject = inject;
      exports.apply = apply;
      return module.exports;
    }
  });
})();
