#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-portal —— 让每个 Linux 账号各自拥有一个 dsh web 实例的门户。

形态参照 RStudio Server / JupyterHub：一个入口 + Linux 账号密码登录 +
每人一个独立会话。dsh 自身没有多用户能力，也不支持子路径挂载
（客户端资源路径是根绝对的），所以这里采用「单端口 + 按 cookie 选后端」：

    浏览器 ──► dsh-portal(3080) ──► 127.0.0.1:(42000+uid)  每用户 dsh 实例

## 为什么必须改写 Host

dsh 自己有一道 Host/Origin 栅栏（`api-request-trust`）：Host 必须是回环，
或在 `--trusted-host` 列出的 authority 里；实测 Host 为 tailnet 地址时
`/api` 一律 403。门户把 Host 改写成 `127.0.0.1:<port>`，栅栏按回环放行。

顺带一个好处：dsh 的会话 cookie 名由 authority 派生（`cookieName(authority)`），
每人后端端口不同 → cookie 名天然不同，同一个浏览器里多人登录也不会互相覆盖。

## 安全边界（务必了解）

* 门户以 **root** 运行（PAM 校验 + 用 systemctl 起别人的用户单元），是这台
  机器上权限最高的 Web 组件，因此刻意**只用标准库**、代码尽量短。
* **明文 HTTP**：密码与 cookie 在应用层是明文，链路加密靠 WireGuard（tailnet 内）。
* **跨站仍被拒**：只有当 `Origin` 的 authority 等于公开 authority 时才改写；
  其它来源原样传给 dsh，由 dsh 自己的栅栏拒绝（DNS 重绑定的防护没有被削弱）。
* 不注入 `x-forwarded-*`：dsh 与插件（如 dshmarket 的重启路由）看到转发头会
  直接拒绝，认为「回环对端是代理，不是用户」。
"""

import argparse
import asyncio
import base64
import hashlib
import html
import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import time

try:
    import PAM  # python3-pam（apt: python3-pam）
except ImportError:  # pragma: no cover - 环境缺依赖时给出明确提示
    PAM = None


# ─────────────────────────── 配置 ───────────────────────────

DEFAULT_CONFIG = {
    "bind": "127.0.0.1",
    "port": 3090,
    # 除主 bind 之外再监听的地址（列表）。典型用法：主 bind 是 Tailscale IP，
    # 这里加 "127.0.0.1" 让本机浏览器也能走 localhost。这些地址和主 bind 一样是
    # 受信 authority（Host 校验仍只认"实际绑定的地址"）。只给回环或内网地址用。
    "bind_extra": [],
    # 浏览器可能用哪些 authority 访问本门户（host 或 host:port）。
    # 会自动加上「bind:port」与「bind」。**不要**把任意值交给客户端决定：
    # 请求头的 Host 必须命中这里，否则直接拒绝 —— 否则「Origin 与 Host 同源」
    # 这个判定会被 Host: evil.example + Origin: http://evil.example 绕过。
    "public_authorities": [],
    "public_authority": None,        # 可选：强制改写用的对外 authority（默认用通过校验的 Host）
    "pam_service": "dsh-portal",
    "backend_port_base": 42000,      # 后端端口 = base + uid
    "instance_unit": "dsh@{user}.service",
    "shim": "/opt/dsh/bin/dsh-instance",
    # 新用户首次登录时，把 client shim 装进他的 profile（否则设置页会废，见下）。
    # shim 复用 dsh-lan-gate 的浏览器半包：它改写 isLoopback + 补齐明文 HTTP 下
    # 缺失的 crypto.randomUUID / navigator.clipboard。宿主半包在 listenHost 为空时
    # 完全惰性（只绑回环的实例正需要它别插手）。
    "seed_client_shim": True,
    "shim_dir": "/opt/dsh/share/dsh-lan-gate",
    "backend_wait_seconds": 240,     # 新用户首次启动要 bootstrap 整个 profile（177 包），会比较久
    "secret_file": "/etc/dsh-portal/secret",
    "session_days": 30,
    # 空闲多久停掉实例。默认 24h 而不是 1h：dsh 的 agent 回合可以跑很久，而「在用」
    # 的信号只有 HTTP 请求与 WebSocket —— 一小时的上限会把正在跑长回合的实例停掉
    # （真实发生过的故障）。回收只停进程，工作区与数据都在磁盘上，下次登录自动拉起。
    "idle_minutes": 1440,
    # 按用户覆盖上面的 idle_minutes（key = 用户名，value = 分钟，0 = 永不回收该用户）。
    # 不写死在代码里：各人用法差别大（有人整天挂着长任务，有人偶尔点开看一眼）。
    "idle_minutes_by_user": {},
    "allow_users": [],               # 空 = 允许所有满足下面条件的账号
    "deny_users": ["root", "nobody", "daemon", "bin", "sys", "sync", "games",
                   "man", "lp", "mail", "news", "uucp", "proxy", "backup",
                   "list", "irc", "gnats", "systemd-network", "systemd-resolve",
                   "messagebus", "sshd", "ntp", "dnsmasq"],
    "min_uid": 1000,                 # 只允许普通用户（排除系统账号）
    "max_uid": 60000,
    "login_path": "/__portal/login",
    "logout_path": "/__portal/logout",
    "me_path": "/__portal/me",
    "health_path": "/__portal/healthz",
    "auth_path": "/__portal/auth",
    "log_file": "/var/log/dsh-portal/access.log",
    "max_failed_logins": 5,
    "failed_login_window": 600,
    "lockout_seconds": 600,
}

LOGIN_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh 登录</title>
<style>
 body{{margin:0;font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;
   display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f6f4;color:#2c2c2a}}
 .card{{width:320px;padding:28px 26px;background:#fff;border:1px solid #e3e2dc;border-radius:12px}}
 h1{{margin:0 0 4px;font-size:16px;font-weight:500}}
 p.sub{{margin:0 0 18px;font-size:12px;color:#888780}}
 label{{display:block;font-size:12px;color:#5f5e5a;margin:12px 0 4px}}
 input{{width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;
   border:1px solid #d3d1c7;border-radius:8px;background:#fbfbf9}}
 button{{width:100%;margin-top:18px;padding:9px;font-size:14px;border:0;border-radius:8px;
   background:#534AB7;color:#fff;cursor:pointer}}
 .err{{margin:0 0 12px;padding:8px 10px;font-size:12px;color:#A32D2D;
   background:#FCEBEB;border-radius:8px}}
 .note{{margin:0 0 12px;padding:8px 10px;font-size:12px;color:#3c5a37;
   background:#EDF5EA;border-radius:8px}}
 .foot{{margin-top:16px;font-size:11px;color:#b4b2a9;line-height:1.5}}
</style></head><body>
<form class="card" method="post" action="{login_path}">
  <h1>登录 dsh</h1>
  <p class="sub">用你在这台工作站上的 Linux 账号登录。每个人有自己的工作区和数据，互不影响。</p>
  {notice}
  {error}
  <label for="u">账号</label>
  <input id="u" name="username" autocomplete="username" autofocus>
  <label for="p">密码</label>
  <input id="p" name="password" type="password" autocomplete="current-password">
  <button type="submit">登录</button>
  <div class="foot">第一次登录会先为你准备环境，需要一小会儿。<br>
  长时间不用会自动停掉，下次登录再启动，数据不会丢。</div>
</form>
<script>
(function () {{
  // 退出登录后浏览器「后退」会撞上 bfcache 里的 dsh 页面：它的 SPA 会照常渲染，
  // 看着像「根本没退出去」。这里在该页被恢复时主动问一次门户「我还登录着吗」，
  // 已登出就换到登录页。只有本页这个「登录页」不是 SPA，才把这段发出去。
  window.addEventListener('pageshow', function (event) {{
    if (!event.persisted) return;
    fetch('/__portal/me', {{ credentials: 'same-origin', cache: 'no-store' }}).then(function (res) {{
      if (res.status === 401 || res.status === 403) {{ location.replace('{login_path}?logout=1'); }}
    }}, function () {{}});
  }});
}})();
</script>
</body></html>
"""


def load_config(path, overrides=None):
    cfg = dict(DEFAULT_CONFIG)
    if path and os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    for k, v in (overrides or {}).items():
        if v is not None:
            cfg[k] = v
    return cfg


def idle_limit_seconds(username, cfg):
    """该用户的实例空闲上限（秒）；None = 永不回收。

    按用户的 idle_minutes_by_user 优先于全局 idle_minutes。**0 一律是「永不回收」
    而不是「0 秒」**：后者会让想长期保留实例的用户每次扫描都被停掉，与配置意图
    正好相反。
    """
    per_user = (cfg.get("idle_minutes_by_user") or {}).get(username)
    minutes = cfg.get("idle_minutes") if per_user is None else per_user
    if minutes is None:
        return None
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        return None          # 配置写错时宁可不回收，也不要拿坏值去停别人的实例
    if minutes <= 0:
        return None
    return minutes * 60


# ─────────────────────────── 日志 ───────────────────────────

class AuditLog:
    def __init__(self, path):
        self.path = path
        self._ready = False

    def __call__(self, level, msg, **fields):
        line = json.dumps(
            {"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "level": level,
             "msg": msg, **fields}, ensure_ascii=False)
        sys.stderr.write(f"dsh-portal: {line}\n")
        try:
            if not self._ready:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                self._ready = True
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            pass  # 审计日志失败不影响服务


def upstream_log_level(status):
    """上游状态码 → (level, msg)，按「这条日志该不该惊动人」分档。

    审计是按 msg 统计的，而旧实现把 4xx/5xx 一律写成 "upstream error"：
    615 条**正常** 404（其中 531 条是 /api/changes.summary 在「该 seq 没有摘要」时
    回的正常应答 "Change summary unavailable."，路由本身存在）被算成了 615 次错误 ——
    按 msg 统计出来的 871 次「错误」里，真正需要看的 5xx 一条都没有。
    所以让 msg 自己表达发生了什么：
      * 5xx → "upstream error"：门户背后的实例真的坏了，这一档才配叫错误；
      * 404 → "upstream not found"：路由明确回了「没有」，是正常应答，info 足够；
      * 其它 4xx（403/409 等）→ "upstream refused"：后端拒绝了这次请求，
        要留痕给人看（比如 Origin 没改写导致的 403），但不需要告警。
    只对 status >= 400 调用（调用点已经这么判定）。
    """
    if status >= 500:
        return "error", "upstream error"
    if status == 404:
        return "info", "upstream not found"
    return "warn", "upstream refused"


# ─────────────────────────── PAM ───────────────────────────

def pam_authenticate(service, username, password):
    """用 PAM 校验 Linux 账号密码。返回 (ok, reason)。"""
    if PAM is None:
        return False, "python3-pam 未安装"

    def conv(auth, query_list, _user_data):
        answers = []
        for query, qtype in query_list:
            if qtype == PAM.PAM_PROMPT_ECHO_ON:
                answers.append((username, 0))
            elif qtype == PAM.PAM_PROMPT_ECHO_OFF:
                answers.append((password, 0))
            else:
                answers.append((None, 1))
        return answers

    try:
        pam = PAM.pam()
        pam.start(service, username, conv)
        pam.authenticate()
        pam.acct_mgmt()
        return True, "ok"
    except PAM.error as exc:  # type: ignore[attr-defined]
        return False, str(exc.args[0] if exc.args else exc)
    except Exception as exc:  # noqa: BLE001 - 任何异常都当失败，fail-closed
        return False, f"{type(exc).__name__}: {exc}"


# ─────────────────────────── 用户与实例 ───────────────────────────

def lookup_user(name):
    """返回 (uid, gid, home) 或 None。用 pwd 模块，避免 shell 注入。"""
    import pwd
    try:
        p = pwd.getpwnam(name)
    except KeyError:
        return None
    return p.pw_uid, p.pw_gid, p.pw_dir


def user_allowed(name, cfg):
    rec = lookup_user(name)
    if rec is None:
        return False, "账号不存在"
    uid = rec[0]
    if name in cfg["deny_users"]:
        return False, "账号在拒绝名单里"
    if not (cfg["min_uid"] <= uid <= cfg["max_uid"]):
        return False, f"uid {uid} 不在允许区间"
    allow = cfg.get("allow_users") or []
    if allow and name not in allow:
        return False, "账号不在允许名单里"
    return True, "ok"


def backend_port(uid, cfg):
    return cfg["backend_port_base"] + uid


DSH_COOKIE_PREFIX = "dsh-auth-"


def expire_cookie(header):
    """把上游发来的 Set-Cookie 改成「立即过期」的同一张 cookie（名字/Path 不变）。

    浏览器是按 (name, domain, path) 覆盖 cookie 的，所以只要把 Max-Age 置 0、
    并去掉具体的过期时间（Expires），就能在同一位置把它删掉。没有 Max-Age 的
    Set-Cookie 是「本次会话有效」的会话 cookie，补一条 Max-Age=0 同样能清。
    """
    head = header.split(";", 1)
    name, _, value = head[0].partition("=")
    if not name.strip():
        return header
    rest = head[1] if len(head) > 1 else ""
    kept = [p.strip() for p in rest.split(";")
            if p.strip() and not re.match(r"(?i)^(max-age|expires)\s*=", p.strip())]
    kept.append("Max-Age=0")
    return f"{name.strip()}={value.strip()}; " + "; ".join(kept)


def dsh_cookie_name(port):
    """dsh 为「哪个 authority」发的会话 cookie 叫什么名字。

    与 dsh-client-connection 里的 `cookieName(authority)` 完全一致：
        "dsh-auth-" + base64url(sha256(authority))
    实测逐字节核对过（`sha256("127.0.0.1:43001")` 得到的那串与浏览器里的一致）。

    **这里必须精确到名字，不能用「以 dsh-auth- 开头」这种模糊判断**：
    浏览器里往往还留着另一个 dsh（比如旧的 3080 实例）的 cookie，名字前缀一样，
    模糊判断会误以为「已有会话」而跳过引导，结果后端收到的是自己认不得的 cookie，
    直接在首页回 401 ——「dsh web authentication required」。
    """
    digest = hashlib.sha256(f"127.0.0.1:{port}".encode()).digest()
    return DSH_COOKIE_PREFIX + base64.urlsafe_b64encode(digest).decode().rstrip("=")


def unit_for(name, cfg):
    return cfg["instance_unit"].format(user=name)


async def run_cmd(args, timeout=30):
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 124, b"timeout"
    return proc.returncode, out or b""


async def unit_active(name, cfg):
    rc, _ = await run_cmd(["systemctl", "is-active", "--quiet", unit_for(name, cfg)])
    return rc == 0


async def unit_start(name, cfg):
    rc, out = await run_cmd(["systemctl", "start", unit_for(name, cfg)], timeout=60)
    return rc == 0, out.decode("utf-8", "replace").strip()


async def unit_restart(name, cfg):
    rc, out = await run_cmd(["systemctl", "restart", unit_for(name, cfg)], timeout=60)
    return rc == 0, out.decode("utf-8", "replace").strip()


async def unit_stop(name, cfg):
    rc, _ = await run_cmd(["systemctl", "stop", unit_for(name, cfg)], timeout=60)
    return rc == 0


async def port_open(port, host="127.0.0.1", timeout=1.0):
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass
        return True
    except (OSError, asyncio.TimeoutError):
        return False


async def launch_token(name, cfg):
    """从 journal 里取该实例最近一次启动的 token。"""
    rc, out = await run_cmd(
        ["journalctl", "-u", unit_for(name, cfg), "--no-pager", "-n", "300", "-o", "cat"],
        timeout=20)
    toks = re.findall(r"token=([A-Za-z0-9_.\-]+)", out.decode("utf-8", "replace"))
    return toks[-1] if toks else None


# ─────────────────────────── HTTP 小工具 ───────────────────────────

def header_values(headers, name):
    return [v for k, v in headers if k.lower() == name]


def header_first(headers, name, default=None):
    vals = header_values(headers, name)
    return vals[0] if vals else default


async def read_head(reader, limit=65536, timeout=None):
    """读到请求/响应头的结束（\\r\\n\\r\\n）。返回 (head, leftover) 或 (None, b'')。

    `timeout=None` = **不设超时**。给后端响应用不设超时是刻意的：dsh 有些请求
    天然很慢（等模型、跑工具），猜一个数字去掐它只会制造「明明在跑却被中断」的
    故障。客户端的请求头才需要短超时（连上不发数据属于异常）。
    """
    buf = b""
    while True:
        try:
            if timeout is None:
                chunk = await reader.read(4096)
            else:
                chunk = await asyncio.wait_for(reader.read(4096), timeout)
        except asyncio.TimeoutError:
            return None, b""
        if not chunk:
            return None, b""
        buf += chunk
        idx = buf.find(b"\r\n\r\n")
        if idx >= 0:
            return buf[: idx + 4], buf[idx + 4:]
        if len(buf) > limit:
            return None, b""


def parse_head(head):
    text = head.decode("latin1")
    lines = text.split("\r\n")
    start = lines[0].split(" ", 2)
    if len(start) < 3:
        raise ValueError("bad request line")
    method, target, version = start
    headers = []
    for line in lines[1:]:
        if not line:
            continue
        key, _, value = line.partition(":")
        headers.append((key.strip(), value.strip()))
    return method, target, version, headers


def response(status, reason, headers, body=b""):
    out = [f"HTTP/1.1 {status} {reason}"]
    for k, v in headers:
        out.append(f"{k}: {v}")
    return ("\r\n".join(out) + "\r\n\r\n").encode("latin1") + body


def parse_query(target):
    if "?" not in target:
        return target, {}
    path, _, qs = target.partition("?")
    out = {}
    for pair in qs.split("&"):
        if not pair:
            continue
        k, _, v = pair.partition("=")
        out[k] = v
    return path, out


def unquote_plus(s):
    from urllib.parse import unquote_plus as _u
    return _u(s)


# ─────────────────────────── 门户 ───────────────────────────

class Portal:
    def __init__(self, cfg):
        self.cfg = cfg
        self.log = AuditLog(cfg["log_file"])
        self.secret = self._load_secret()
        self.last_seen = {}
        # username -> 当前挂着的 WebSocket 条数（空闲回收的保活依据，见 _ws_enter）
        self.ws_active = {}
        self.failures = {}
        self.starting = {}
        self.seeded = set()
        # username -> 门户为该用户换来的实例会话 cookie（转发时注入上游）
        self.sessions = {}
        allowed = {a.lower().strip() for a in (cfg.get("public_authorities") or [])}
        bind, port = cfg["bind"], cfg["port"]
        allowed |= {f"{bind}:{port}", bind, f"localhost:{port}", f"127.0.0.1:{port}"}
        # 额外绑定的地址同样受信（它们和主 bind 一样是"我们真的在听"的地址）。
        # 只跟主 bind 共享同一个 port —— 不要硬编码任何具体端口号。
        for extra in (cfg.get("bind_extra") or []):
            extra = (extra or "").strip()
            if extra:
                allowed |= {extra.lower(), f"{extra.lower()}:{port}"}
        self.allowed_authorities = {a for a in allowed if a}

    def authority_ok(self, host_header):
        """Host 必须是我们认得的 authority，否则拒绝（防 Host 混淆）。"""
        if not host_header:
            return None
        host = host_header.strip().lower()
        return host if host in self.allowed_authorities else None

    # —— 会话 cookie ——

    def _load_secret(self):
        path = self.cfg["secret_file"]
        try:
            with open(path, "rb") as fh:
                data = fh.read().strip()
            if data:
                return data
        except OSError:
            pass
        data = secrets.token_hex(32).encode()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data + b"\n")
        return data

    def _sign(self, username, expires):
        payload = f"{username}.{expires}".encode()
        return hmac.new(self.secret, payload, hashlib.sha256).hexdigest()

    def make_cookie(self, username):
        expires = int(time.time()) + self.cfg["session_days"] * 86400
        value = f"{username}.{expires}.{self._sign(username, expires)}"
        return (f"dsh-portal-session={value}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={self.cfg['session_days'] * 86400}")

    def read_session(self, headers):
        raw = header_first(headers, "cookie", "") or ""
        for part in raw.split(";"):
            name, _, value = part.strip().partition("=")
            if name != "dsh-portal-session":
                continue
            bits = value.split(".")
            if len(bits) != 3:
                return None
            username, expires, sig = bits
            try:
                if int(expires) < time.time():
                    return None
            except ValueError:
                return None
            if hmac.compare_digest(sig, self._sign(username, expires)):
                return username
            return None
        return None

    def clear_cookie(self):
        return "dsh-portal-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    # —— 登录限速 ——

    def locked(self, ip, username):
        rec = self.failures.get((ip, username))
        if not rec:
            return 0
        count, first, until = rec
        if until and until > time.time():
            return int(until - time.time())
        if time.time() - first > self.cfg["failed_login_window"]:
            self.failures.pop((ip, username), None)
        return 0

    def note_failure(self, ip, username):
        now = time.time()
        count, first, _ = self.failures.get((ip, username), (0, now, 0))
        if now - first > self.cfg["failed_login_window"]:
            count, first = 0, now
        count += 1
        until = now + self.cfg["lockout_seconds"] if count >= self.cfg["max_failed_logins"] else 0
        self.failures[(ip, username)] = (count, first, until)
        return count

    # —— 实例生命周期 ——

    def harden_dsh_home(self, username, home):
        """准备环境前，把该用户已存在的 $HOME/.dsh 收敛到 0700（G-5）。

        ~/.dsh 里有 .credentials.yaml（模型/网关凭据），而它的权限完全取决于
        「当初是谁、按什么 umask 建的」—— 同一台机器上实测有的用户 0755，
        同机其它账号可以直接读走凭据。已有的用户从这里收敛；新建的由实例包装脚本
        的 umask 077 保证（见 server/dsh-instance）。
        只动这一层目录本身、不递归：子文件由 dsh 自己按 umask 创建。
        失败（权限不足、NFS 等）只记日志、绝不中断登录 —— 权限没收紧是安全问题，
        把用户挡在门外是可用性事故，后者更急。
        """
        path = os.path.join(home, ".dsh")
        try:
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                # 尊重符号链接：跟随 chmod 会去改 $HOME 之外的目标，那是别人的目录。
                self.log("warn", "dsh home is a symlink, perms left alone",
                         user=username, path=path)
                return
            if not stat.S_ISDIR(st.st_mode):
                return
            if stat.S_IMODE(st.st_mode) == 0o700:
                return
            os.chmod(path, 0o700)
            self.log("info", "dsh home perms tightened", user=username,
                     path=path, was=oct(stat.S_IMODE(st.st_mode)))
        except FileNotFoundError:
            return          # 还不存在：交给 dsh 自己创建（那时 umask 已经是对的）
        except OSError as exc:
            self.log("warn", "dsh home perms not tightened", user=username,
                     path=path, detail=f"{type(exc).__name__}: {exc}")

    async def ensure_instance(self, username, uid):
        port = backend_port(uid, self.cfg)
        if await port_open(port):
            return port
        # 这里曾经漏了 await：协程对象恒为真，条件退化成「只看端口」，
        # 而且每帧刷一条 RuntimeWarning。
        if await unit_active(username, self.cfg) and await port_open(port, timeout=3):
            return port

        task = self.starting.get(username)
        if task is None:
            async def boot():
                ok, msg = await unit_start(username, self.cfg)
                self.log("info", "instance start", user=username, ok=ok, detail=msg[:200])
                wait = self.cfg.get("backend_wait_seconds", 240)
                for _ in range(wait * 2):    # 新用户首启要 bootstrap 整个 profile，可能几分钟
                    if await port_open(port):
                        return True
                    await asyncio.sleep(0.5)
                return False
            task = self.starting[username] = asyncio.create_task(boot())
        try:
            ok = await asyncio.wait_for(asyncio.shield(task), timeout=None)
        finally:
            if task.done():
                self.starting.pop(username, None)
        if not ok:
            return None
        await self.seed_client_shim(username)
        return port

    async def seed_client_shim(self, username):
        """给用户的 profile 装上 client shim（缺才装）。

        没有它，dsh 的浏览器端会把「页面 origin 不是回环」当成「你不是本机」，
        设置页（模型配置等）直接以 unavailable 起步。shim 复用 dsh-lan-gate 的
        浏览器半包（`isLoopback` 改写 + 明文 HTTP 的 randomUUID/clipboard 兜底），
        宿主半包在 listenHost 为空时惰性 —— 回环实例正需要它别插手。
        """
        cfg = self.cfg
        if not cfg.get("seed_client_shim") or username in self.seeded:
            return
        rec = lookup_user(username)
        if not rec:
            return
        uid, gid, home = rec
        profile_dir = os.path.join(home, ".dsh", "profiles", "web")
        pkg = os.path.join(profile_dir, "package.json")
        try:
            with open(pkg, encoding="utf-8") as fh:
                manifest = json.load(fh)
            bundles = (manifest.get("dsh", {}).get("profile", {}) or {}).get("bundles") or []
            if "dsh-lan-gate" in bundles:
                self.seeded.add(username)
                return
        except (OSError, json.JSONDecodeError):
            # 新用户：manifest 还没生成（profile 由 dsh 首次写入时才创建）。
            # 不能在这里跳过 —— 否则首次登录永远拿不到 shim。继续走安装，
            # dsh plugin add 会把 profile 目录和 manifest 一并建出来。
            self.log("info", "seed: fresh profile, installing shim", user=username)

        cmd = ["/bin/sh", "-c",
               'mkdir -p "$1" && cd "$1" && exec /opt/dsh/node/bin/dsh plugin --profile web add "$2"',
               "dsh-seed", profile_dir, f"file:{cfg['shim_dir']}"]
        env = {"HOME": home, "PATH": f"/opt/dsh/node/bin:/usr/local/bin:/usr/bin:/bin",
               "NODE_ENV": "production"}

        def demote():  # 以该用户身份跑，装出来的文件归他
            os.setgid(gid)
            os.initgroups(username, gid)
            os.setuid(uid)

        self.log("info", "seeding client shim", user=username)
        proc = await asyncio.create_subprocess_exec(
            *cmd, cwd=profile_dir, env=env, preexec_fn=demote,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=600)
        except asyncio.TimeoutError:
            proc.kill()
            self.log("error", "seed timed out", user=username)
            return
        if proc.returncode != 0:
            self.log("error", "seed failed", user=username,
                     detail=out.decode("utf-8", "replace")[-300:])
            return
        self.seeded.add(username)
        self.log("info", "seed ok — restarting instance", user=username)
        await unit_restart(username, cfg)
        for _ in range(60):
            if await port_open(backend_port(uid, cfg)):
                break
            await asyncio.sleep(0.5)

    async def bootstrap_session(self, username, port, restart=False):
        """用实例的启动 token 换 dsh 的会话 cookie（浏览器永不接触 token）。"""
        if restart:
            await unit_restart(username, self.cfg)
            for _ in range(40):
                if await port_open(port):
                    break
                await asyncio.sleep(0.5)
        token = await launch_token(username, self.cfg)
        if not token:
            return None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", port), timeout=10)
        except OSError:
            return None
        try:
            req = (f"GET /?token={token} HTTP/1.1\r\n"
                   f"Host: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").encode()
            writer.write(req)
            await writer.drain()
            head, _ = await read_head(reader, timeout=20)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass
        if not head:
            return None
        try:
            _, _, _, headers = parse_head(head)
        except ValueError:
            return None
        sets = header_values(headers, "set-cookie")
        return sets or None

    async def ensure_session(self, username, port, force=False):
        """保证手里有一份该用户的实例会话 cookie（没有就去换一份）。

        门户自己持有会话、转发时注入，浏览器那张可能过期的 cookie 就不参与上游认证 ——
        这样实例重启换 token 之后，用户侧一次 401 都不会看到。
        """
        if not force and self.sessions.get(username):
            return self.sessions[username]
        sets = await self.bootstrap_session(username, port)
        if not sets:
            sets = await self.bootstrap_session(username, port, restart=True)
        if not sets:
            return None
        cookie = "; ".join(s.split(";", 1)[0].strip() for s in sets if s.strip())
        if not cookie:
            return None
        self.sessions[username] = cookie
        return cookie

    # —— 反代 ——

    def rewrite_request_head(self, method, target, version, headers, port, public_authority):
        upstream_host = f"127.0.0.1:{port}"
        is_upgrade = (header_first(headers, "upgrade", "") or "").lower() == "websocket"
        # `connection` / `upgrade` 必须由我们统一重写：原样转发再加一条会让
        # Upgrade 头重复，ws 库解析成 "websocket, websocket" 后直接回 400。
        drop = {"connection", "keep-alive", "proxy-connection", "proxy-authorization",
                "upgrade"}
        out = [f"{method} {target} {version or 'HTTP/1.1'}"]
        saw_origin = False
        for key, value in headers:
            low = key.lower()
            if low in drop:
                continue
            if low == "host":
                out.append(f"host: {upstream_host}")
                continue
            if low == "origin":
                saw_origin = True
                if public_authority:
                    # 只在本站 origin 时改写，跨站 origin 原样留给 dsh 拒绝
                    if value.rstrip("/").lower() in (
                            f"http://{public_authority}".lower(), f"https://{public_authority}".lower()):
                        out.append(f"origin: http://{upstream_host}")
                    else:
                        out.append(f"origin: {value}")
                else:
                    out.append(f"origin: {value}")
                continue
            if low == "referer" and public_authority:
                out.append("referer: " + re.sub(
                    r"^https?://" + re.escape(public_authority), f"http://{upstream_host}",
                    value, flags=re.I))
                continue
            out.append(f"{key}: {value}")
        if not saw_origin:
            # 浏览器对同源 GET **不发 Origin**，而 dsh 的部分 /api（实测
            # /api/task-board/state）在没有 Origin 时直接 403 —— 表现就是
            # 「任务面板」这类插件永远加载不出来，而别的接口却好好的。
            # 门户是可信反代，这里补回环 Origin，与带 Origin 的请求一致处理。
            out.append(f"origin: http://{upstream_host}")
        out.append(f"connection: {'Upgrade' if is_upgrade else 'close'}")
        if is_upgrade:
            out.append("upgrade: websocket")
        return ("\r\n".join(out) + "\r\n\r\n").encode("latin1"), is_upgrade

    def rewrite_response_head(self, head, port, public_authority):
        if not public_authority:
            return head
        text = head.decode("latin1")
        head_only, sep, rest = text.partition("\r\n\r\n")
        lines = head_only.split("\r\n")
        fixed = [lines[0]]
        for line in lines[1:]:
            if line.lower().startswith("location:"):
                value = line.split(":", 1)[1].strip()
                value = re.sub(r"^https?://(127\.0\.0\.1|localhost|\[::1\]):" + str(port),
                               f"http://{public_authority}", value, flags=re.I)
                fixed.append(f"location: {value}")
            else:
                fixed.append(line)
        return ("\r\n".join(fixed) + sep + rest).encode("latin1")

    async def pipe(self, reader, writer):
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                writer.write(data)
                await writer.drain()
        except (OSError, asyncio.TimeoutError, ConnectionResetError):
            pass
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def _forward_body(self, reader, headers, leftover, up_writer):
        """把请求体（content-length 或 chunked）原样转发到后端。"""
        cl = header_first(headers, "content-length")
        te = (header_first(headers, "transfer-encoding", "") or "").lower()
        if cl:
            need = int(cl)
            if leftover:
                up_writer.write(leftover[:need])
                need -= min(need, len(leftover))
            while need > 0:
                chunk = await reader.read(min(65536, need))
                if not chunk:
                    raise ConnectionError("client closed mid-body")
                up_writer.write(chunk)
                need -= len(chunk)
            await up_writer.drain()
            return
        if "chunked" in te:
            buf = leftover
            while True:
                while b"\r\n" not in buf:
                    more = await reader.read(65536)
                    if not more:
                        raise ConnectionError("client closed in chunk header")
                    buf += more
                idx = buf.index(b"\r\n")
                size_line = buf[:idx]
                try:
                    size = int(size_line.split(b";")[0].strip() or b"0", 16)
                except ValueError:
                    raise ConnectionError("bad chunk size")
                total = idx + 2 + size + 2
                while len(buf) < total:
                    more = await reader.read(65536)
                    if not more:
                        raise ConnectionError("client closed in chunk data")
                    buf += more
                up_writer.write(buf[:total])
                buf = buf[total:]
                await up_writer.drain()
                if size == 0:
                    while True:                      # trailer 段
                        while len(buf) < 2:
                            more = await reader.read(65536)
                            if not more:
                                return
                            buf += more
                        if buf.startswith(b"\r\n"):
                            up_writer.write(b"\r\n")
                            await up_writer.drain()
                            return
                        j = buf.find(b"\r\n")
                        if j < 0:
                            continue
                        up_writer.write(buf[: j + 2])
                        buf = buf[j + 2:]
                        await up_writer.drain()
        # 无 body

    # —— 主处理 ——

    async def handle(self, reader, writer):
        peer = writer.get_extra_info("peername")
        ip = peer[0] if peer else "?"
        try:
            await self._handle(reader, writer, ip)
        except Exception as exc:  # noqa: BLE001
            self.log("error", "request failed", ip=ip, detail=f"{type(exc).__name__}: {exc}")
            try:
                body = "服务器这边出错了，请刷新页面再试一次。\n"
                writer.write(response(502, "Bad Gateway", [
                    ("Content-Type", "text/plain; charset=utf-8"),
                    ("Content-Length", str(len(body.encode()))), ("Connection", "close")],
                    body.encode()))
                await writer.drain()
            except Exception:  # noqa: BLE001
                pass
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def _handle(self, reader, writer, ip):
        cfg = self.cfg
        head, leftover = await read_head(reader, timeout=60)
        if not head:
            return
        try:
            method, target, version, headers = parse_head(head)
        except ValueError:
            writer.write(response(400, "Bad Request", [("Connection", "close")]))
            await writer.drain()
            return

        path, query = parse_query(target)
        host_header = header_first(headers, "host", "") or ""
        public_authority = self.authority_ok(host_header)
        if not public_authority:
            # Host 不在受信列表 → 拒绝。这同时保护了「Origin 与 Host 同源」这个判定：
            # 不能让客户端自己声明自己是谁（否则 Host: evil.example + 同源 Origin
            # 就能绕过跨站检查，等于拆掉反 DNS 重绑定的防护）。
            self.log("warn", "rejected unrecognized host", ip=ip, host=host_header,
                     path=path)
            with_port = sorted(a for a in self.allowed_authorities if ":" in a)
            others = sorted(a for a in self.allowed_authorities if ":" not in a)
            good = "\n".join(f"    http://{a}/" for a in (with_port or others))
            body = ("这个网址打不开 dsh。\n\n"
                    "请改用下面这个地址：\n"
                    f"{good}\n"
                    "（如果你确实需要用别的域名访问，请把它加进 "
                    "/etc/dsh-portal/config.json 的 public_authorities，然后重启 dsh-portal。）\n")
            writer.write(response(403, "Forbidden", [
                ("Content-Type", "text/plain; charset=utf-8"),
                ("Content-Length", str(len(body.encode()))), ("Connection", "close")],
                body.encode()))
            await writer.drain()
            return
        if cfg.get("public_authority"):
            public_authority = cfg["public_authority"]

        # —— 门户自身端点 ——
        if path == cfg["health_path"]:
            body = json.dumps({"ok": True, "instances": len(self.last_seen)}).encode()
            writer.write(response(200, "OK", [
                ("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                ("Connection", "close")], body))
            await writer.drain()
            return

        # dsh 里的「退出登录」是一个普通链接，浏览器只会发 GET —— 不能要求先发表单 POST。
        # 跨站风险只有「被别人悄悄登出」，而清掉 cookie 本来就等于没登录，
        # 不构成安全损失（SameSite=Lax 下别的站点发起的顶层 GET 也带不上这个 cookie），
        # 所以 GET 与 POST 共用一个出口。
        if path == cfg["logout_path"] and method in ("GET", "POST"):
            self.log("info", "logout", ip=ip, via=method.lower())
            # 安全 + 不留痕：cookie 清空后再为本次请求引导一次，把上游那张本来只该
            # 交给浏览器的 dsh 会话 cookie 一并清掉（Max-Age=0）。否则「退出登录」只丢
            # 门户会话，退出后的同一页面仍带着上游 cookie 可以继续用 —— 那就不算退出。
            # （上游 cookie 名字按后端端口派生，属于本账号自己的实例，不会碰到别人。）
            upstream_sets = []
            session_user = self.read_session(headers)
            rec = lookup_user(session_user) if session_user else None
            if rec:
                port = backend_port(rec[0], cfg)
                for one in (await self.bootstrap_session(session_user, port) or []):
                    if one.split("=", 1)[0].strip():
                        upstream_sets.append(expire_cookie(one))

            # ?next=login：退出来的这次直接落在登录页并给出提示；
            # 其余调用方（脚本、外部链接）保持原来的「跳到 /，未登录就 303 去登录页」。
            _, qs = parse_query(target)
            next_to = "login" == str(qs.get("next", "")).lower()
            target_path = (cfg["login_path"] + "?logout=1") if next_to else "/"
            writer.write(response(303, "See Other", [
                ("Location", target_path), ("Set-Cookie", self.clear_cookie()),
                ("Content-Length", "0"), ("Cache-Control", "no-store"),
                ("Connection", "close")]
                + [("Set-Cookie", one) for one in upstream_sets]))
            await writer.drain()
            return

        if path == cfg["login_path"] and method == "POST":
            await self._do_login(reader, writer, headers, leftover, ip, public_authority)
            return

        if path == cfg["auth_path"] and method == "POST":
            await self._do_auth_api(reader, writer, headers, leftover, ip)
            return

        username = self.read_session(headers)
        if not username:
            if path == cfg["login_path"]:
                # ?logout=1 只用于换账号时给个提示：明确告诉用户「已经退出来了」，
                # 否则会以为点错了、或以为上一个账号还挂着。
                _, qs = parse_query(target)
                logged_out = str(qs.get("logout", "")).lower() in ("1", "true", "yes")
                await self._serve_login(
                    writer, notice="已经退出登录。用哪个账号登录都可以。" if logged_out else None)
            else:
                writer.write(response(303, "See Other", [
                    ("Location", cfg["login_path"]), ("Content-Length", "0"),
                    ("Connection", "close")]))
                await writer.drain()
            return

        if path == cfg["me_path"]:
            uid = lookup_user(username)[0]
            body = json.dumps({
                "user": username, "uid": uid,
                "backend_port": backend_port(uid, cfg),
                "unit": unit_for(username, cfg),
            }, ensure_ascii=False).encode()
            writer.write(response(200, "OK", [
                ("Content-Type", "application/json"), ("Content-Length", str(len(body))),
                ("Connection", "close")], body))
            await writer.drain()
            return

        # —— 需要后端实例 ——
        allowed, why = user_allowed(username, cfg)
        if not allowed:
            self.log("warn", "session user no longer allowed", user=username, detail=why)
            await self._serve_login(writer, "该账号已不可用：" + why)
            return

        rec = lookup_user(username)
        # 准备环境的第一步：先把 ~/.dsh 收敛到 0700（G-5），再让实例跑起来 ——
        # 顺序很重要，否则 seed/引导会先在 0755 的目录里写出凭据文件。
        self.harden_dsh_home(username, rec[2])
        port = await self.ensure_instance(username, rec[0])
        if not port:
            body = ("正在为你在服务器上准备 dsh 环境（第一次要几分钟），请稍后刷新本页。\n"
                    f"如果超过十分钟还不行，请把这个告诉管理员：\n"
                    f"    journalctl -u dsh@{username} -n 50\n")
            writer.write(response(503, "Service Unavailable", [
                ("Content-Type", "text/plain; charset=utf-8"),
                ("Content-Length", str(len(body.encode()))), ("Connection", "close")],
                body.encode()))
            await writer.drain()
            self.log("error", "instance unavailable", user=username)
            return

        # 浏览器有没有「这个实例」认的会话 cookie？名字必须精确到 authority 的哈希。
        # 浏览器里常常还留着**别的** dsh 实例（比如旧的 3080 单用户实例）的同前缀
        # cookie —— 用「以 dsh-auth- 开头」这种模糊判断会误判成已登录，
        # 后端收到自己认不得的 cookie，就在首页回 401，表现为登录后打不开。
        expected = dsh_cookie_name(port)
        cookie_names = []
        for value in header_values(headers, "cookie"):
            cookie_names += [p.strip().partition("=")[0] for p in value.split(";")]
        has_dsh_cookie = expected in cookie_names
        if not has_dsh_cookie:
            is_upgrade = (header_first(headers, "upgrade", "") or "").lower() == "websocket"
            if is_upgrade:
                body = ("你的浏览器还没有 dsh 的登录会话。请先刷新一次首页"
                        "（会自动完成登录），再发起长连接。\n")
                writer.write(response(401, "Unauthorized", [
                    ("Content-Type", "text/plain; charset=utf-8"),
                    ("Content-Length", str(len(body.encode()))), ("Connection", "close")],
                    body.encode()))
                await writer.drain()
                self.log("warn", "upgrade before bootstrap", user=username)
                return
            sets = await self.bootstrap_session(username, port)
            if not sets:
                self.log("warn", "bootstrap retry after restart", user=username, port=port)
                sets = await self.bootstrap_session(username, port, restart=True)
            if sets:
                self.log("info", "session bootstrap", user=username, port=port)
                # 首次使用的关键顺序：profile manifest 是引导过程催生的 ——
                # 引导前的 seed 必然跳过（manifest 还不存在），新用户第一次登录
                # 就拿不到 shim。所以引导成功后补一次 seed；seed 装完会重启实例，
                # 因此再引导一次，把新 token 的会话交给浏览器。
                await self.seed_client_shim(username)
                fresh = await self.bootstrap_session(username, port)
                if fresh:
                    sets = fresh
                writer.write(response(303, "See Other", [
                    ("Location", target), ("Content-Length", "0"),
                    ("Connection", "close")] + [("Set-Cookie", s) for s in sets]))
                await writer.drain()
                return
            self.log("error", "session bootstrap failed", user=username, port=port)
            body = ("你的 dsh 没能完成登录初始化，请刷新页面再试一次。\n"
                    f"如果一直这样，请在服务器上查看日志：journalctl -u dsh@{username}\n")
            writer.write(response(503, "Service Unavailable", [
                ("Content-Type", "text/plain; charset=utf-8"),
                ("Content-Length", str(len(body.encode()))), ("Connection", "close")],
                body.encode()))
            await writer.drain()
            return

        self.last_seen[username] = time.time()
        await self._proxy(reader, writer, method, target, version, headers,
                          leftover, port, username, public_authority)

    async def _serve_login(self, writer, error=None, notice=None):
        # notice/error 是门户自己的固定文案，但 error 也可能带账号相关的说明 ——
        # 逐个转义，别让它有机会往登录页里塞标签。
        body = LOGIN_PAGE.format(
            login_path=self.cfg["login_path"],
            notice=f'<p class="note">{html.escape(notice)}</p>' if notice else "",
            error=f'<p class="err">{html.escape(error)}</p>' if error else "").encode()
        writer.write(response(200, "OK", [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"), ("Connection", "close")], body))
        await writer.drain()

    async def _read_body(self, reader, headers, leftover, limit=65536):
        cl = header_first(headers, "content-length")
        if not cl:
            return b""
        need = min(int(cl), limit)
        body = leftover[:need]
        need -= len(body)
        while need > 0:
            chunk = await reader.read(need)
            if not chunk:
                break
            body += chunk
            need -= len(chunk)
        return body

    async def authenticate(self, username, password, ip):
        """表单与 JSON 两个入口共用的认证逻辑。返回 (ok, message)。"""
        cfg = self.cfg
        if not username or not password:
            return False, "请填写账号和密码"

        wait = self.locked(ip, username)
        if wait > 0:
            self.log("warn", "login throttled", ip=ip, user=username, wait=wait)
            hint = f"{wait} 秒" if wait < 120 else f"{(wait + 59) // 60} 分钟"
            return False, f"密码错得太多次了，请过 {hint} 再试。"

        allowed, why = user_allowed(username, cfg)
        if not allowed:
            self.note_failure(ip, username)
            self.log("warn", "login denied (account)", ip=ip, user=username, detail=why)
            return False, "这个账号不能登录 dsh。请用你自己的 Linux 账号。"

        loop = asyncio.get_running_loop()
        ok, reason = await loop.run_in_executor(
            None, pam_authenticate, cfg["pam_service"], username, password)
        if not ok:
            attempts = self.note_failure(ip, username)
            self.log("warn", "login failed", ip=ip, user=username,
                     detail=reason, attempts=attempts)
            left = cfg["max_failed_logins"] - attempts
            tail = f"（还剩 {left} 次机会）" if 0 < left <= 2 else ""
            return False, "账号或密码不对。" + tail

        self.failures.pop((ip, username), None)
        self.log("info", "login ok", ip=ip, user=username)
        return True, "ok"

    async def _do_login(self, reader, writer, headers, leftover, ip, public_authority):
        body = await self._read_body(reader, headers, leftover)
        form = {}
        for pair in body.decode("utf-8", "replace").split("&"):
            if not pair:
                continue
            k, _, v = pair.partition("=")
            form[unquote_plus(k)] = unquote_plus(v)
        username = (form.get("username") or "").strip()
        password = form.get("password") or ""

        ok, message = await self.authenticate(username, password, ip)
        if not ok:
            await self._serve_login(writer, message)
            return
        writer.write(response(303, "See Other", [
            ("Location", "/"), ("Set-Cookie", self.make_cookie(username)),
            ("Content-Length", "0"), ("Connection", "close")]))
        await writer.drain()

    async def _do_auth_api(self, reader, writer, headers, leftover, ip):
        """JSON 入口，便于脚本/CLI 取会话（与表单同一套判定与限速）。"""
        body = await self._read_body(reader, headers, leftover)
        try:
            payload = json.loads(body.decode("utf-8", "replace") or "{}")
        except json.JSONDecodeError:
            payload = {}
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        ok, message = await self.authenticate(username, password, ip)
        out = json.dumps({"ok": ok, "user": username if ok else None,
                          "message": message}, ensure_ascii=False).encode()
        extra = [("Set-Cookie", self.make_cookie(username))] if ok else []
        writer.write(response(200 if ok else 401, "OK" if ok else "Unauthorized", [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(out))), ("Cache-Control", "no-store"),
            ("Connection", "close")] + extra, out))
        await writer.drain()

    async def _proxy(self, reader, writer, method, target, version, headers,
                     leftover, port, username, public_authority):
        try:
            up_r, up_w = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", port), timeout=10)
        except OSError as exc:
            self.log("error", "upstream connect failed", user=username, port=port,
                     detail=str(exc))
            writer.write(response(502, "Bad Gateway", [
                ("Content-Type", "text/plain; charset=utf-8"), ("Connection", "close")]))
            await writer.drain()
            return

        try:
            head, is_upgrade = self.rewrite_request_head(
                method, target, version, headers, port, public_authority)
            up_w.write(head)
            await up_w.drain()
            has_body = bool(header_first(headers, "content-length")
                            or header_first(headers, "transfer-encoding"))
            if has_body:
                await self._forward_body(reader, headers, leftover, up_w)

            # 故意不设超时：dsh 有天然很慢的请求，猜数字去掐只会制造假故障
            rhead, rleft = await read_head(up_r, timeout=None)
            if not rhead:
                self.log("warn", "empty upstream response", user=username, port=port)
                return

            # 兜底：实例重启后启动 token 会变，浏览器手里的实例 cookie 随即失效，
            # 任何请求（首页、/api 读写、插件操作）都可能回 401 ——
            # 表现为设置页「Host 操作失败：登录状态已失效，请刷新页面后重试」。
            # 以前只对 GET / 重新引导，所以 /api 上的 401 被原样透给用户，
            # 只能手动刷新页面。现在对**所有非升级请求**都重新引导。
            try:
                status = int(rhead.split(b"\r\n", 1)[0].split(b" ")[1])
            except (IndexError, ValueError):
                status = 0
            path_only, _ = parse_query(target)
            # 上游 4xx/5xx 留痕：dsh 的 /api 信任栅栏只认回环 Origin，
            # 一旦某个请求的 Origin 没被改写成回环就是 403 —— 没有这条日志根本查不到。
            # level/msg 交给 upstream_log_level 分档：404 是正常应答，不能记成 error。
            if status >= 400:
                o = header_first(headers, "origin", "") or ""
                lvl, msg = upstream_log_level(status)
                self.log(lvl, msg, user=username, status=status,
                         path=path_only, origin=o[:80], ws=is_upgrade)
            # 注意：WebSocket 升级请求也要覆盖 —— dsh 的 Host 实时连接走 WS，
            # 握手被 401 拒绝时 is_upgrade 为真但状态码不是 101，
            # 若把它排除，浏览器只会一直「重试连接 Host」而永远好不了。
            if status == 401:
                self.log("warn", "upstream 401 → re-bootstrap", user=username,
                         port=port, path=path_only, ws=is_upgrade)
                sets = await self.bootstrap_session(username, port)
                if not sets:
                    sets = await self.bootstrap_session(username, port, restart=True)
                if sets:
                    if method == "GET" and not is_upgrade:
                        # 幂等：换好 cookie 让浏览器重走一次，用户无感。
                        writer.write(response(303, "See Other", [
                            ("Location", target), ("Content-Length", "0"),
                            ("Cache-Control", "no-store"), ("Connection", "close")]
                            + [("Set-Cookie", s) for s in sets]))
                    else:
                        # 非 GET（/api 的写操作、插件安装等）：请求体已经往上游发过，
                        # 不能安全重放 —— 把新 cookie 交给浏览器，dsh 的「重试连接 Host」
                        # 会带着它重试并成功，不再需要手动刷新页面。
                        writer.write(response(401, "Unauthorized", [
                            ("Content-Length", "0"), ("Cache-Control", "no-store"),
                            ("X-Dsh-Portal-Reauth", "1"), ("Connection", "close")]
                            + [("Set-Cookie", s) for s in sets]))
                    await writer.drain()
                    return

            rhead = self.rewrite_response_head(rhead, port, public_authority)
            writer.write(rhead)
            await writer.drain()
            if rleft:
                writer.write(rleft)
                await writer.drain()

            if is_upgrade:
                # WebSocket：两个方向都要转发，任一侧关闭即结束（否则会有一侧永远挂着）
                #
                # 这条长连接本身就是「人还在用」的证据：agent 跑长回合时浏览器只挂着
                # WS，一个 HTTP 请求都不发，last_seen 因此纹丝不动 —— 只看 last_seen
                # 的回收器会把正在跑任务的实例停掉。这里登记活跃 WS，回收器见到就跳过。
                self._ws_enter(username)
                try:
                    t1 = asyncio.create_task(self.pipe(reader, up_w))
                    t2 = asyncio.create_task(self.pipe(up_r, writer))
                    done, pending = await asyncio.wait(
                        {t1, t2}, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                finally:
                    # 与 _ws_enter 在同一个协程里配对：无论正常结束、抛异常还是被取消，
                    # finally 都恰好执行一次 _ws_exit，所以计数不会只增不减。
                    self._ws_exit(username)
            else:
                await self.pipe(up_r, writer)      # 后端 Connection: close → 读到 EOF 即结束
        finally:
            for w in (up_w,):
                try:
                    w.close()
                except Exception:  # noqa: BLE001
                    pass

    # —— 空闲回收 ——

    def _ws_enter(self, username):
        """登记一条活跃 WebSocket。

        用计数而不是布尔：同一个人可能开着多个标签页、每个标签页一条 WS，
        一条连接结束不能把另一条的保活一起抹掉。
        """
        self.ws_active[username] = self.ws_active.get(username, 0) + 1

    def _ws_exit(self, username):
        left = self.ws_active.get(username, 1) - 1
        if left > 0:
            self.ws_active[username] = left
        else:
            self.ws_active.pop(username, None)   # 归零即删键，长跑的门户里键不会越积越多
        # 空闲从「断开时刻」起算而不是握手时刻：连接期间没有 HTTP 请求，沿用握手时的
        # last_seen 会让一条 20 小时的长连接刚结束就被判成空闲。
        self.last_seen[username] = time.time()

    async def reap_once(self):
        """扫一遍 last_seen，把确实空闲的实例停掉。

        单独拆出来（而不是塞在 while 里）是为了能在离线自测里直接驱动一次回收，
        不必等 reaper 的 60 秒节拍，也不用起真门户。
        """
        cfg = self.cfg
        now = time.time()
        for user, seen in list(self.last_seen.items()):
            limit = idle_limit_seconds(user, cfg)
            if limit is None:
                continue                      # 全局或该用户关掉了回收
            if self.ws_active.get(user, 0) > 0:
                # WS 还连着就是人还在用（哪怕一帧都没发、一个 HTTP 请求都没发）：
                # 这条判定优先于时间比较，所以「WS 挂着」的实例绝不会被回收。
                continue
            if now - seen < limit:
                continue
            if await unit_active(user, cfg):
                await unit_stop(user, cfg)
                self.log("info", "instance stopped (idle)", user=user,
                         idle=int(now - seen))
            self.last_seen.pop(user, None)

    async def reaper(self):
        while True:
            await asyncio.sleep(60)
            await self.reap_once()


# ─────────────────────────── 入口 ───────────────────────────

async def serve(cfg):
    portal = Portal(cfg)
    host, port = cfg["bind"], cfg["port"]
    server = await asyncio.start_server(portal.handle, host, port, backlog=128)
    portal.log("info", "portal listening", bind=host, port=port,
               mode="all-system-users" if not cfg.get("allow_users") else "allowlist",
               idle_minutes=cfg["idle_minutes"])
    # 额外监听地址：同一个 handler，同一个 Portal 状态（会话、限流都共享）。
    # 某个额外地址绑不上（例如该地址此刻不存在）只记 warn，不影响主监听。
    extras = []
    for extra in (cfg.get("bind_extra") or []):
        extra = (extra or "").strip()
        if not extra or extra == host:
            continue
        try:
            srv = await asyncio.start_server(portal.handle, extra, port, backlog=128)
        except OSError as exc:
            portal.log("warn", "extra bind failed", bind=extra, port=port,
                       detail=f"{exc.__class__.__name__}: {exc}")
            continue
        extras.append(srv)
        portal.log("info", "portal listening (extra)", bind=extra, port=port)
    asyncio.create_task(portal.reaper())
    for srv in extras:
        await srv.start_serving()
    async with server:
        await server.serve_forever()


async def print_status(cfg):
    import pwd
    users = sorted((p.pw_name, p.pw_uid) for p in pwd.getpwall()
                   if cfg["min_uid"] <= p.pw_uid <= cfg["max_uid"])
    print(f"门户: {cfg['bind']}:{cfg['port']}  PAM 服务: {cfg['pam_service']}")
    print(f"后端端口公式: {cfg['backend_port_base']} + uid")
    for name, uid in users:
        allowed, why = user_allowed(name, cfg)
        if not allowed:
            continue
        active = await unit_active(name, cfg)
        print(f"  {name:<16} uid={uid:<6} port={backend_port(uid, cfg):<6} "
              f"unit={'active' if active else 'stopped'}")


def main():
    ap = argparse.ArgumentParser(description="dsh 多用户门户")
    ap.add_argument("--config", default="/etc/dsh-portal/config.json")
    ap.add_argument("--bind")
    ap.add_argument("--port", type=int)
    ap.add_argument("--public-authority")
    ap.add_argument("--log-file")
    ap.add_argument("--status", action="store_true", help="打印各用户实例状态后退出")
    args = ap.parse_args()

    cfg = load_config(args.config, {
        "bind": args.bind, "port": args.port,
        "public_authority": args.public_authority, "log_file": args.log_file,
    })
    if PAM is None:
        sys.exit("dsh-portal: 缺少 python3-pam（apt install python3-pam）")
    if os.geteuid() != 0:
        sys.exit("dsh-portal: 需要 root（PAM 读 shadow + 用 systemctl 起他人的用户单元）")

    if args.status:
        asyncio.run(print_status(cfg))
        return
    try:
        asyncio.run(serve(cfg))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
