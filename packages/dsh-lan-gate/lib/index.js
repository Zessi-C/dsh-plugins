/**
 * dsh-lan-gate v0.15.0 —— 浏览器 shim + 一个「重启本实例」的宿主端点。
 *
 * ## 这个包现在做三件事
 *
 *   1. cordis.patch.yml 把本包注册成 Loader 已启用条目 —— dsh-client-modules
 *      只扫描已启用的 Loader 条目来组装客户端启动图；
 *   2. package.json 的 dsh.client 声明 ./client，浏览器端拿到
 *      isLoopbackHostname 改写 + 明文 HTTP 非安全上下文的 crypto API 兜底
 *      + 侧边栏「退出登录 / 重启实例」两行；
 *   3. 本文件（宿主半包）给「重启实例」提供两条路由与一个页面令牌。
 *
 * ## 为什么重启要由实例自己发起（v0.15.0）
 *
 * 运维侧本来就有 `dsh-web-ctl restart <user>`，但那条路要开终端、要 root。
 * 用户真正需要的是「改完插件/配置，在页面里点一下就重来」。
 *
 * 实例本身**没有权限** `systemctl restart dsh@<user>`（系统单元，root 才动得了），
 * 但它不需要这个权限：单元里写着 `Restart=on-failure`，只要主进程以**非零码**
 * 退出，systemd 会在 `RestartSec=2` 后把它重新拉起来。所以这里用的是
 * `ctx.appExit(1)` —— 走 launcher 的优雅关闭（先 dispose 整棵树，最多 5 秒，
 * 之后由 shutdown 控制器强制退出），而不是 `process.exit(1)` 那种硬跳。
 *
 * 代价与边界，写在这里免得以后被当成 bug：
 *   - 只对 systemd 托管（`INVOCATION_ID` 存在）的实例开放。手动 `dsh web` 起的
 *     进程退出后没人拉起，所以那种情况下**路由直接回 409，客户端也不渲染按钮**。
 *   - `KillMode=process`（单元里刻意设的）：重启只杀主进程，agent 在 bash 里起的
 *     训练任务会作为孤儿进程继续跑。**正在跑的 agent 回合会丢**（它的父进程没了），
 *     所以客户端把「再点一次确认」放在真正发起之前。
 *   - 重启后浏览器那份会话 cookie 仍然有效（签名密钥持久化在
 *     `$DSH_HOME/.credentials.yaml`），门户侧则由既有的 401 重新引导路径换新。
 *
 * ## 鉴权：为什么是「页面令牌 + 自定义头 + 同源」
 *
 * 路由挂在 webserver 上，不经过 dsh 的 `/api` 信任栅栏，所以得自己把门。
 * 三层，缺一层都能被绕过：
 *
 *   1. **令牌**：启动时 `randomBytes(24)`，通过 `webserver/index-inject` 的
 *      `{kind:'global'}` 行注入到 index.html。index.html 本身要鉴权才发得出来
 *      （没有 dsh 会话时首页就是 401），所以拿到令牌等价于「已经在用这个实例」。
 *   2. **自定义请求头**：跨站表单发不出自定义头；跨站 fetch 带它要过 CORS 预检，
 *      而这里不应答 OPTIONS —— 于是恶意页面连请求都构造不出来。
 *   3. **同源**：带 Origin 时必须与本次请求的 Host 一致。门户会把两者都改写成
 *      `127.0.0.1:<port>`（`rewrite_request_head`），所以门户后面同样成立。
 *
 * 残留风险（如实记录）：本机同用户的进程本来就能 kill 掉这个进程，令牌对它不构成
 * 新的约束；它防的是**跨站**触发，不是本机进程。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const name = 'dsh-lan-gate';

/**
 * `webServer`：注册路由。
 * `appExit`：launcher 提供的退出请求（`@deepseek-ai/dsh-cmdline` 的 `ctx.appExit`），
 *   走优雅关闭路径。两个都必须注入 —— Cordis 不允许访问未声明的服务。
 */
export const inject = ['webServer', 'appExit'];

const PING_PATH = '/__lan-gate/ping';
const RESTART_PATH = '/__lan-gate/restart';
const TOKEN_HEADER = 'x-dsh-lan-gate-token';
const GLOBAL_KEY = '__DSH_LAN_GATE_RESTART__';

/** 非零退出码 = 失败 → systemd 的 `Restart=on-failure` 才会重新拉起。 */
const EXIT_CODE = 1;
/** 先让 202 回到浏览器，再开始关树（否则客户端只会看到连接被重置）。 */
const EXIT_DELAY_MS = 250;
/** 优雅关闭的兜底：`appExit` 内部有自己的 5s 上限，这里再留一道。 */
const FORCE_EXIT_MS = 15000;

function sendJson(res, status, payload) {
  let body = '';
  try {
    body = JSON.stringify(payload);
  } catch {
    body = '{"ok":false}';
  }
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
      Connection: 'close',
    });
    res.end(body);
  } catch {
    // 客户端已经走了（比如重启时页面被卸载）：没有可补救的动作。
  }
}

export function apply(ctx) {
  const token = randomBytes(24).toString('base64url');
  const pid = process.pid;
  const startedAt = Date.now();
  // systemd 为每个被它拉起的进程注入 INVOCATION_ID。没有它 = 裸进程/手动启动，
  // 退出后没人拉起 —— 这种情况下开放重启就是把实例弄死，所以直接关掉这个能力。
  const managed = typeof process.env.INVOCATION_ID === 'string'
    && process.env.INVOCATION_ID.length > 0;
  const state = { restarting: false, requestedAt: 0, requestedFrom: null };

  function tokenOk(req) {
    const got = req.headers[TOKEN_HEADER];
    if (typeof got !== 'string' || got.length === 0) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin.length === 0) return true;   // 交给令牌
    const host = req.headers.host;
    if (typeof host !== 'string' || host.length === 0) return false;
    const protocol = ctx.webServer && ctx.webServer.protocol ? ctx.webServer.protocol : 'http:';
    return origin.replace(/\/+$/, '').toLowerCase() === `${protocol}//${host}`.toLowerCase();
  }

  function handlePing(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    // 故意**不校验令牌**：重启后进程换了，令牌也换了，而客户端正拿着旧令牌
    // 轮询「新进程起来没有」。它要的只是「pid 变了没有」，这里不泄露任何凭据。
    sendJson(res, 200, {
      ok: true,
      pid,
      startedAt,
      managed,
      restarting: state.restarting,
      restartPath: RESTART_PATH,
    });
  }

  function handleRestart(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
      return;
    }
    if (!tokenOk(req)) {
      sendJson(res, 403, { ok: false, error: 'bad-token' });
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'cross-origin' });
      return;
    }
    if (!managed) {
      sendJson(res, 409, {
        ok: false,
        error: 'not-systemd-managed',
        detail: '这个 dsh 进程不是 systemd 拉起的，退出后没有人会把它拉回来。'
          + '请用 dsh-web-ctl restart <user> 或手动重启。',
      });
      return;
    }
    if (state.restarting) {
      sendJson(res, 409, { ok: false, error: 'already-restarting', requestedAt: state.requestedAt });
      return;
    }

    state.restarting = true;
    state.requestedAt = Date.now();
    state.requestedFrom = typeof (req.socket && req.socket.remoteAddress) === 'string'
      ? req.socket.remoteAddress : null;

    // 留痕到 journal：重启之后进程换了，日志是唯一能回答「谁在什么时候点的」的地方。
    process.stderr.write(
      `[dsh-lan-gate] restart requested pid=${pid} from=${state.requestedFrom || '?'}`
      + ` → graceful exit ${EXIT_CODE} (systemd Restart=on-failure)\n`);

    sendJson(res, 202, { ok: true, restarting: true, pid, exitCode: EXIT_CODE });

    const force = setTimeout(() => {
      // appExit 没能把进程带走（dispose 卡住等）：按约定的非零码硬退，
      // 保证「点了按钮就一定会重启」这个承诺不被一个卡死的插件破坏。
      process.stderr.write('[dsh-lan-gate] graceful exit timed out → force exit\n');
      process.exit(EXIT_CODE);
    }, FORCE_EXIT_MS);
    if (typeof force.unref === 'function') force.unref();

    const kick = setTimeout(() => {
      try {
        ctx.appExit(EXIT_CODE);
      } catch (error) {
        process.stderr.write(
          `[dsh-lan-gate] appExit failed: ${String(error && error.message)} → force exit\n`);
        process.exit(EXIT_CODE);
      }
    }, EXIT_DELAY_MS);
    if (typeof kick.unref === 'function') kick.unref();
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: PING_PATH, handler: handlePing }),
      ctx.webServer.register({ kind: 'exact', path: RESTART_PATH, handler: handleRestart }),
    ];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 已经被 webServer 拆掉了：重复释放没有意义，也不该把 dispose 弄炸。
        }
      }
    };
  }, 'dsh-lan-gate: restart routes');

  // 每次渲染 index.html 都重新发一行：令牌随进程走，重启后新页面自然拿到新的。
  // `global: true` 是必须的 —— 本条目与 webserver 不是同一个 fiber 作用域。
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return;
    table.push({
      kind: 'global',
      name: GLOBAL_KEY,
      value: {
        token,
        pid,
        startedAt,
        managed,
        pingPath: PING_PATH,
        restartPath: RESTART_PATH,
        tokenHeader: TOKEN_HEADER,
      },
    });
  }, { global: true });
}
