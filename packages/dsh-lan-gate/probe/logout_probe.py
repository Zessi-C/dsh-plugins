#!/usr/bin/env python3
"""门户登出链路探针：起一个假后端（模拟 dsh 的启动 token → 会话 cookie），
把真实 portal.py 挂上去，只验证「退出登录」这条路径，不碰真实实例、不碰 PAM。

覆盖：
  A. GET /__portal/logout?next=login  → 303 到登录页，清门户 cookie + 清上游 dsh-auth cookie
  B. GET /__portal/logout             → 303 到 /（保持脚本/外部链接的旧行为）
  C. POST /__portal/logout            → 同上（旧入口不回归）
  D. /__portal/login?logout=1         → 登录页出现「已经退出登录」提示
  E. 没登录时访问 /__portal/login      → 没有那条提示
"""
import asyncio
import hashlib
import importlib.util
import base64
import os
import re
import sys
import tempfile


PORTAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server", "portal.py")

spec = importlib.util.spec_from_file_location("portal", PORTAL)
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class FakeBackend:
    """最小的假实例：/?token=... 发 dsh-auth-<hash(127.0.0.1:port)> cookie。"""

    def __init__(self, port):
        self.port = port
        self.token = "tok-1234"
        self.hits = []

    async def handle(self, reader, writer):
        try:
            head = await reader.read(65536)
            self.hits.append(head.split(b"\r\n")[0].decode())
            cookie = portal.dsh_cookie_name(self.port)
            body = b"<html>fake dsh</html>"
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                + f"Content-Type: text/html\r\n".encode()
                + f"Set-Cookie: {cookie}=session-value; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000\r\n".encode()
                + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                + body)
            await writer.drain()
        finally:
            writer.close()


def read_response(raw):
    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.decode("latin1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    headers = []
    for line in lines[1:]:
        k, _, v = line.partition(":")
        headers.append((k.strip().lower(), v.strip()))
    return status, headers, body


async def request(port, method, target, cookie=None, host="127.0.0.1:3090"):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    req = [f"{method} {target} HTTP/1.1", f"Host: {host}",
           "Accept: text/html", "Connection: close"]
    if cookie:
        req.append(f"Cookie: {cookie}")
    writer.write(("\r\n".join(req) + "\r\n\r\n").encode())
    await writer.drain()
    raw = b""
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            break
        raw += chunk
    writer.close()
    return read_response(raw)


async def main():
    import pwd
    me = pwd.getpwuid(os.getuid())
    backend = FakeBackend(0)
    be_server = await asyncio.start_server(backend.handle, "127.0.0.1", 0)
    be_port = be_server.sockets[0].getsockname()[1]
    backend.port = be_port

    tmp = tempfile.mkdtemp()
    cfg = portal.load_config(None, {
        "bind": "127.0.0.1", "port": 3090,
        "secret_file": os.path.join(tmp, "secret"),
        "log_file": os.path.join(tmp, "access.log"),
        "backend_port_base": be_port - me.pw_uid,   # 保证 backend_port(uid) == 假后端端口
        "public_authorities": ["127.0.0.1:3090"],
        "max_failed_logins": 5,
    })
    p = portal.Portal(cfg)
    # 绕过「真正去 systemctl 起实例」的部分：实例已在跑，直接换会话
    async def ensure_instance(username, uid):
        return be_port
    p.ensure_instance = ensure_instance
    p.harden_dsh_home = lambda *a, **k: None

    server = await asyncio.start_server(p.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    portal_port = port

    results = []

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  — {detail}"))

    login_cookie = p.make_cookie(me.pw_name).split(";", 1)[0]

    # 先像浏览器一样「登录」一次：拿门户 cookie 与上游 cookie
    status, headers, _ = await request(portal_port, "GET", "/", cookie=login_cookie)
    dsh_name = portal.dsh_cookie_name(be_port)
    sets = [v for k, v in headers if k == "set-cookie"]
    upstream = [s for s in sets if s.startswith(dsh_name + "=")]
    check("A0 引导：首页返回 303 并下发上游 dsh cookie", status == 303 and bool(upstream),
          f"status={status} sets={sets}")
    upstream_cookie = upstream[0].split(";", 1)[0] if upstream else ""
    browser_cookie = login_cookie + "; " + upstream_cookie

    # A. 退出登录（dsh 里的链接形态）
    backend.hits.clear()
    status, headers, _ = await request(portal_port, "GET", "/__portal/logout?next=login",
                                       cookie=browser_cookie)
    loc = dict(headers).get("location")
    sets = [v for k, v in headers if k == "set-cookie"]
    portal_cleared = any(s.startswith("dsh-portal-session=;") and "Max-Age=0" in s for s in sets)
    upstream_cleared = any(s.startswith(dsh_name + "=") and "Max-Age=0" in s for s in sets)
    check("A1 303 到登录页", status == 303 and loc == "/__portal/login?logout=1", f"status={status} loc={loc}")
    check("A2 清门户会话 cookie", portal_cleared, str(sets))
    check("A3 清上游 dsh 会话 cookie", upstream_cleared, str(sets))
    check("A4 引导过上游（说明确实去找了那张 cookie）", bool(backend.hits), str(backend.hits))

    # B. 不带 next= 的旧形态
    status, headers, _ = await request(portal_port, "GET", "/__portal/logout", cookie=login_cookie)
    loc = dict(headers).get("location")
    check("B 旧行为保留：303 到 /", status == 303 and loc == "/", f"status={status} loc={loc}")

    # C. POST 入口不回归
    status, headers, _ = await request(portal_port, "POST", "/__portal/logout", cookie=login_cookie)
    check("C POST 入口仍可用", status == 303, f"status={status}")

    # D0. 登录页里的 bfcache 兜底脚本与 probe/client-guard.js 保持一致，
    #     否则「线上那一份」和「测过的那一份」会悄悄分叉。
    guard_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "client-guard.js")
    # 只比代码：文件头那几行注释是给人看的，不属于线上那一份。
    guard = "\n".join(line for line in open(guard_path, encoding="utf-8").read().splitlines()
                       if not line.startswith("//"))

    def squash(text):
        return re.sub(r"\s+", "", text)

    status, headers, page = await request(portal_port, "GET", "/__portal/login")
    page_text = page.decode("utf-8")
    inline = re.search(r"<script>(.*?)</script>", page_text, re.S)
    check("D0a 登录页内联了兜底脚本", inline is not None, page_text[-400:])
    check("D0b 与 probe/client-guard.js 逐字一致",
          inline is not None and squash(inline.group(1)) == squash(guard),
          (inline.group(1)[:200] if inline else ""))
    check("D0c 脚本里指向登录页", "/__portal/login?logout=1" in page_text)

    # D. 退出后的登录页提示
    status, headers, body = await request(portal_port, "GET", "/__portal/login?logout=1")
    check("D1 登录页 200", status == 200, f"status={status}")
    check("D2 出现「已经退出登录」提示", "已经退出登录" in body.decode("utf-8"), "")

    # E. 普通打开登录页不带提示
    status, headers, body = await request(portal_port, "GET", "/__portal/login")
    check("E 普通登录页没有退出提示", "已经退出登录" not in body.decode("utf-8"), "")

    # F. 未登录访问别的路径仍被引导到登录页（没被退出分支吃掉）
    status, headers, _ = await request(portal_port, "GET", "/somewhere")
    loc = dict(headers).get("location")
    check("F 未登录跳登录页", status == 303 and loc == "/__portal/login", f"status={status} loc={loc}")

    server.close()
    be_server.close()
    await server.wait_closed()
    await be_server.wait_closed()

    failed = [r for r in results if not r[1]]
    print()
    print(f"{len(results) - len(failed)}/{len(results)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
