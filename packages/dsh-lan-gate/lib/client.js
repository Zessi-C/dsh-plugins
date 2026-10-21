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
 *
 * ## v0.14.0：退出登录入口
 *
 * 门户是多用户入口，但 dsh 自己没有「我是谁 / 退出」的概念：换个账号只能手动
 * 敲 /__portal/logout。本版在侧边栏底部（设置上方）加一行「退出登录」，点了走
 * 门户的 /__portal/logout?next=login —— 门户清掉自己的会话 cookie 与上游 dsh
 * cookie，回到登录页，用哪个账号登录都行。
 *
 * 只在门户后面出现：门户把 Host 改写成 127.0.0.1:<port>，浏览器看到的 origin
 * 却是外部 authority，两者不同就是「我在一个反代后面」。直连实例（浏览器
 * origin 与 Host 一致）不渲染这行按钮，也就不多出对后端不存在的路由的探针。
 * 服务端是否真有这条路由由 /__portal/me 的可用性决定（见 probePortal）。
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
    portal: null,
    portalUser: null,
    logoutRegistered: null,
    logoutClicks: 0,
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

      /* ────────────────────────────────────────────────────────────
       * 退出登录：门户后面的多用户入口需要「换个人登录」的出口，
       * 而 dsh 自己没有这个概念。按钮落在侧边栏底部、设置行的上方。
       * ──────────────────────────────────────────────────────────── */

      const PORTAL_LOGOUT_TIMEOUT_MS = 8000;
      const PORTAL_PROBE_TIMEOUT_MS = 5000;
      const SIGN_OUT_STYLE_ID = 'dsh-lan-gate-signout';

      const React = require('react');
      const h = React.createElement;

      /** 本地化的界面文案；键集合以 zh 为准，en 必须一一对应。 */
      const DICTS = {
        zh: {
          ns: 'lanGate',
          signOut: '退出登录',
          signOutAria: '退出登录并切换账号',
          signingOut: '正在退出…',
          failed: '退出失败，请重试',
        },
        en: {
          ns: 'lanGate',
          signOut: 'Sign out',
          signOutAria: 'Sign out and switch account',
          signingOut: 'Signing out…',
          failed: 'Sign-out failed, please retry',
        },
      };

      /** 侧边栏行：与设置行同一套尺寸（宽版 42px，收起时 36px 圆钮）。 */
      const SIGN_OUT_CSS = `
.dlg-signout{box-sizing:border-box;display:flex;align-items:center;justify-content:center;
  width:100%;height:42px;margin:0;padding:0 10px 0 8px;gap:8px;
  border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;
  cursor:pointer;overflow:hidden}
.dlg-signout:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.dlg-signout:disabled{opacity:.6;cursor:default}
.dlg-signout:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:-2px}
.dlg-signout-icon{flex:none;display:inline-flex;align-items:center;justify-content:center}
.dlg-signout-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlg-signout[data-rail="true"]{width:36px;height:36px;padding:0;border-radius:var(--dsw-radius-md,8px)}
.dlg-signout[data-rail="true"] .dlg-signout-label{display:none}
.dlg-signout-err{color:var(--dsw-alias-state-error-primary,#A32D2D)}
`;

      function installSignOutStyle() {
        if (typeof document === 'undefined') return function () {};
        if (document.getElementById(SIGN_OUT_STYLE_ID)) return function () {};
        const tag = document.createElement('style');
        tag.id = SIGN_OUT_STYLE_ID;
        tag.textContent = SIGN_OUT_CSS;
        document.head.appendChild(tag);
        return function () { try { tag.remove(); } catch (_) {} };
      }

      /** 当前选中的语言：dsh 的 locale 服务有 getSnapshot().locale 就用它，否则用浏览器语言。 */
      function pickDict(locale) {
        let tag = null;
        try { tag = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null; } catch (_) {}
        const code = String((tag && (tag.locale || tag.language || tag.id)) || '')
          || safe(() => globalThis.navigator.language) || '';
        return /^zh/i.test(code) ? DICTS.zh : DICTS.en;
      }

      /** 由文档语言推断：门户登录页是中文的，dsh 也基本是中文用户，默认 zh。 */
      function defaultDict() {
        const lang = safe(() => globalThis.document && document.documentElement.lang)
          || safe(() => globalThis.navigator.language) || '';
        return /^zh/i.test(lang) ? DICTS.zh : DICTS.en;
      }

      /**
       * 门户判定：浏览器 origin 的 host 与请求里的 Host 不一致 → 前面有反代。
       * 门户正是把 Host 改写成 127.0.0.1:<port> 再转发的那一层。
       */
      function behindPortal() {
        const loc = safe(() => globalThis.location);
        if (!loc || !loc.hostname || loc.protocol === 'file:') return false;
        const pageHost = String(loc.hostname).toLowerCase();
        const pagePort = String(loc.port || (loc.protocol === 'https:' ? '443' : '80'));
        const want = (pagePort === '80' ? pageHost : pageHost + ':' + pagePort);
        return new Promise(function (resolve) {
          let done = false;
          const finish = function (value) {
            if (done) return;
            done = true;
            try { ctl.abort(); } catch (_) {}
            resolve(value);
          };
          const ctl = new AbortController();
          const timer = setTimeout(function () {
            // 探针不是必需的：超时就当作「不在门户后面」，按钮不出现。
            finish(false);
          }, PORTAL_PROBE_TIMEOUT_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
          safe(() => fetch('/__portal/me', {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            signal: ctl.signal,
          }).then(function (res) {
            const viaHost = String(safe(() => res.headers.get('x-dsh-portal-host')) || '');
            const authenticated = res.ok && res.headers.get('x-dsh-portal') !== null;
            return res.json().then(function (body) {
              return !!body && !!body.user;
            }, function () { return authenticated; }).then(function (hasUser) {
              clearTimeout(timer);
              finish(hasUser && (viaHost ? viaHost.toLowerCase().indexOf(want) < 0 : true));
            });
          }, function () {
            clearTimeout(timer);
            finish(false);
          }));
        });
      }

      /**
       * 退出动作只有一步：跳转到门户的登出地址。门户清掉自己与上游的 cookie
       * 后 303 到登录页；dsh 的 WebSocket 随页面跳转自动断开，无需我们插手。
       * 跳转是同步生效的，所以按钮不进入 busy 态 —— 先把标签换成「正在退出」，
       * 再发起跳转：失败时用户看到的是明确的错误文案，而不是以为点到了、其实没反应。
       */
      function goSignOut() {
        diag.logoutClicks += 1;
        safe(() => { globalThis.location.assign('/__portal/logout?next=login&ts=' + Date.now()); });
      }

      function SignOutButton(props) {
        if (props.__expand) return renderSignOut(props.t, 'idle', props.wide !== false);
        return h(SignOutInner, props);
      }

      /** 渲染按钮本体；拆出来是因为下面要提前返回，而 hooks 不能写在条件分支之后。 */
      function SignOutInner(props) {
        const [phase, setPhase] = React.useState('idle');
        return renderSignOut(props.t, phase, props.wide !== false);
      }

      function renderSignOut(t, phase, wide) {
        const onClick = function (event) {
          try { event.preventDefault(); event.stopPropagation(); } catch (_) {}
          if (phase !== 'idle') return;
          try {
            goSignOut();
          } catch (e) {
            warn('退出登录跳转失败：' + String(e && e.message));
          }
        };
        const label = phase === 'failed' ? t('failed') : phase === 'busy' ? t('signingOut') : t('signOut');
        return h('button', {
          type: 'button',
          className: 'dlg-signout',
          'data-rail': wide ? undefined : 'true',
          'aria-label': phase === 'failed' ? t('failed') : t('signOutAria'),
          title: label,
          disabled: phase === 'busy',
          onClick: onClick,
        },
        h('span', { className: 'dlg-signout-icon', 'aria-hidden': 'true' },
          h('svg', { viewBox: '0 0 24 24', width: wide ? 16 : 18, height: wide ? 16 : 18, fill: 'none' },
            h('path', {
              d: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3',
              stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
            }),
            h('path', {
              d: 'M10 8 6 12l4 4M6 12h9',
              stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
              strokeLinejoin: 'round',
            })
          )
        ),
        h('span', { className: 'dlg-signout-label' }, label));
      }

      /** 只在门户后面注册；dsh 直连（没有门户路由）时什么也不加。 */
      function mountSignOut(ctx) {
        return behindPortal().then(function (yes) {
          diag.portal = yes;
          if (!yes) { diag.logoutRegistered = 'skipped: no portal'; return; }
          const dict = safe(function () { return pickDict(ctx.locale); }) || defaultDict();
          // 门户上的账号（拿不到就留空，按钮照常出现）。
          const t = function (key) { return dict[key] || key; };
          safe(function () {
            if (ctx.locale && typeof ctx.locale.register === 'function') {
              ctx.locale.register(dict.ns || 'lanGate', { zh: DICTS.zh, en: DICTS.en });
            }
          });
          const register = function () {
            ctx.slots.register({
              name: 'sidebar.footer.action',
              id: 'lan-gate-signout',
              order: 50,
            }, function (props) { return h(SignOutButton, { wide: props.wide, t: t }); });
          };
          if (typeof ctx.slots.inject === 'function') ctx.slots.inject('sidebar.footer.action', register);
          else register();
          diag.logoutRegistered = true;
          // 顺手记下当前门户账号，排查「按钮点的到底是谁」时有用。
          safe(function () {
            fetch('/__portal/me', { credentials: 'same-origin', cache: 'no-store' })
              .then(function (res) { return res.json(); })
              .then(function (body) {
                if (body && body.user) { diag.portalUser = body.user; }
              }, function () {});
          });
        }).catch(function (e) {
          diag.logoutRegistered = 'FAILED: ' + String(e && e.message);
          warn('退出登录按钮挂载失败：' + String(e && e.message));
        });
      }

      const name = 'dsh-lan-gate';
      // Cordis 的 ctx 是代理：不声明 inject 就取不到服务（报
      // "cannot get property \"connection\" without inject"）。
      const inject = ['connection'];

      function apply(ctx) {
        diag.applyRan = true;
        // 门户判定与 isLoopback 改写彼此独立：即便受信判定没过（公网域名），
        // 门户自己也会种好 dsh 的 cookie，这时仍然应该有「退出登录」。
        const disposeStyle = installSignOutStyle();
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () {
            mountSignOut(ctx);
            return function () { disposeStyle(); };
          }, 'dsh-lan-gate: sign-out button');
        } else {
          mountSignOut(ctx);
        }
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
