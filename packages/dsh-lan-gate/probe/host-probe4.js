/**
 * host-probe4.js — 第四轮探针：真正打通「插件让 webServer 绑到 Tailscale IP」。
 *
 * 三种策略，逐个实测（每种都在干净的进程里跑，通过 DSH_STRATEGY 选择）：
 *   S1  patch-schema  : 在 apply 时把 WebServer.Config 的 refs 里 "127.0.0.1" 改成 tailnet IP，
 *                       然后由 patch 层把 webserver.config.host 设成 tailnet IP。
 *   S2  patch-config  : 只改实例上的 config.host（在 listen 前），再手动 re-listen。
 *   S3  own-server    : 完全不动 webServer，插件另起 net.createServer 监听 tailnet IP，
 *                       把 TCP 转发到 127.0.0.1:port。同时在第一层做 whois 白名单。
 *
 * 为了让 apply 早于 webserver 的 Service.init 执行，本插件必须 inject 一个
 * 顺序靠前的服务；这里 inject 'webStartup'（webserver inject 它，所以我们在它之前）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import net from 'node:net';

const OUT = process.env.DSH_PROBE4_OUT
  || `${process.env.DSH_HOME || process.env.HOME + '/.dsh'}/logs/host-probe4.json`;

const STRATEGY = process.env.DSH_STRATEGY || 'S1';
const TAILNET_IP = process.env.DSH_TAILNET_IP || '<TAILNET_IP>';
const GATE_PORT = Number(process.env.DSH_GATE_PORT || 8080);

export const name = 'host-probe4';
// inject 顺序决定 apply 时机：webStartup 比 webServer 早。
export const inject = ['webStartup'];

export function apply(ctx) {
  const r = { when: new Date().toISOString(), strategy: STRATEGY, tailnetIp: TAILNET_IP, steps: [] };
  const push = (k, v) => r.steps.push({ k, v: typeof v === 'string' ? v.slice(0, 1200) : v });
  const flush = () => {
    try {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(r, null, 2));
    } catch (_) {}
  };

  push('apply.ran', true);
  push('apply.webStartup', JSON.stringify(ctx.get('webStartup') || null).slice(0, 400));
  push('apply.webServer.exists', !!ctx.get('webServer'));

  // ---------- S1: 改写 schema ----------
  if (STRATEGY === 'S1') {
    try {
      const ws = ctx.get('webServer');
      if (!ws) {
        push('S1.skip', 'webServer not available at apply time');
      } else {
        const Ctor = ws.constructor;
        const Cfg = Ctor.Config;
        push('S1.before', JSON.stringify({ configHost: ws.config.host }));

        // schemastery 的序列化结构里 refs["348"].value === '127.0.0.1'
        const json = Cfg.toJSON();
        let patched = 0;
        for (const [k, ref] of Object.entries(json.refs || {})) {
          if (ref.type === 'const' && ref.value === '127.0.0.1') {
            ref.value = TAILNET_IP;
            patched += 1;
          }
        }
        push('S1.patchedRefs', patched);
        push('S1.afterJson', JSON.stringify(Cfg.toJSON()).slice(0, 300));

        // 同时把实例 config 也改掉
        try { ws.config.host = TAILNET_IP; push('S1.configHostAfter', ws.config.host); }
        catch (e) { push('S1.configHostErr', String(e && e.message)); }
      }
    } catch (e) { push('S1.err', String(e && e.stack).slice(0, 800)); }
  }

  // ---------- S3: 自建 net server + whois 白名单 ----------
  if (STRATEGY === 'S3') {
    try {
      const whoisCache = new Map();
      const whois = (ip) => new Promise((resolve) => {
        if (whoisCache.has(ip)) return resolve(whoisCache.get(ip));
        execFile('tailscale', ['whois', '--json', ip], { timeout: 2000 }, (err, stdout) => {
          let v = null;
          if (!err && stdout) {
            try {
              const j = JSON.parse(stdout);
              v = {
                stableId: j.Node && j.Node.StableID,
                name: j.Node && j.Node.Name,
                login: j.UserProfile && j.UserProfile.LoginName,
              };
            } catch (_) {}
          }
          whoisCache.set(ip, v);
          resolve(v);
        });
      });

      const target = () => {
        const ws = ctx.get('webServer');
        return (ws && ws.port) || 3080;
      };

      const srv = net.createServer(async (client) => {
        const peer = client.remoteAddress || '';
        const id = await whois(peer);
        r.whoisCalls = (r.whoisCalls || 0) + 1;
        r.lastPeer = { peer, id };
        if (!id) {
          push('S3.reject', `${peer} not a tailnet peer`);
          flush();
          client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        const up = net.connect(target(), '127.0.0.1');
        client.pipe(up); up.pipe(client);
        const kill = () => { client.destroy(); up.destroy(); };
        client.on('error', kill); up.on('error', kill);
      });
      srv.listen(GATE_PORT, TAILNET_IP, () => {
        push('S3.listening', `${TAILNET_IP}:${GATE_PORT}`);
        flush();
      });
      srv.on('error', (e) => { push('S3.listenErr', String(e && e.message)); flush(); });
      ctx.effect(() => () => { try { srv.close(); } catch (_) {} });
    } catch (e) { push('S3.err', String(e && e.stack).slice(0, 800)); }
  }

  flush();
}
