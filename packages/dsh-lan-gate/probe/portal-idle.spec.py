#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""portal 的离线自测：空闲回收保活 + 日志分档 + $HOME/.dsh 权限 + 部署件基线。

只 import server/portal.py 一个模块，用临时目录当 secret_file / log_file，
`unit_active` / `unit_stop` 全部换成内存桩；部署件（dsh-instance、logrotate 配置）
只做静态内容检查。因此这个脚本：
  * 不启真门户、不监听任何端口；
  * 不碰 /etc、不碰 /var/log（路径全是 tempdir）；
  * 不动任何 systemd 单元（不会真的停实例）。

跑法：python3 probe/portal-idle.spec.py
"""

import asyncio
import importlib.util
import inspect
import os
import sys
import json
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.normpath(os.path.join(HERE, os.pardir, "server"))
PORTAL_PY = os.path.join(SERVER, "portal.py")
DASH_INSTANCE = os.path.join(SERVER, "dsh-instance")
LOGROTATE_CONF = os.path.join(SERVER, "logrotate.dsh-portal")

HOUR = 3600
DAY = 24 * HOUR


def load_portal():
    """按路径加载门户源文件（不当包 import：它本来就是单文件脚本）。"""
    spec = importlib.util.spec_from_file_location("dsh_portal_under_test", PORTAL_PY)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod          # Portal 里没有 dataclass，但注册一下更稳
    spec.loader.exec_module(mod)
    return mod


portal = load_portal()


class ConfigDefaultsTest(unittest.TestCase):
    """默认配置：24h + 空的按用户覆盖表。"""

    def test_default_idle_is_24h(self):
        self.assertEqual(portal.DEFAULT_CONFIG["idle_minutes"], 1440)

    def test_default_idle_at_least_a_day(self):
        # 需求是「至少 24h」；这里钉住下限，避免以后又被调回 60。
        self.assertGreaterEqual(portal.DEFAULT_CONFIG["idle_minutes"] * 60, DAY)

    def test_by_user_table_defaults_empty(self):
        self.assertEqual(portal.DEFAULT_CONFIG["idle_minutes_by_user"], {})

    def test_load_config_merges_by_user(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"idle_minutes": 60, "idle_minutes_by_user": {"alice": 0}}')
            cfg = portal.load_config(path)
            self.assertEqual(cfg["idle_minutes"], 60)
            self.assertEqual(cfg["idle_minutes_by_user"], {"alice": 0})

            # 老配置里没有这个键时，默认空表必须还在（不能被 update 抹掉）。
            with open(path, "w", encoding="utf-8") as fh:
                fh.write('{"idle_minutes": 60}')
            cfg = portal.load_config(path)
            self.assertEqual(cfg["idle_minutes_by_user"], {})


class IdleLimitTest(unittest.TestCase):
    """idle_limit_seconds：纯函数，按用户覆盖优先于全局值。"""

    def limit(self, **over):
        cfg = dict(portal.DEFAULT_CONFIG)
        cfg.update(over)
        return portal.idle_limit_seconds

    def test_global_default(self):
        self.assertEqual(self.limit()("alice", dict(portal.DEFAULT_CONFIG)), DAY)

    def test_user_override_wins(self):
        cfg = dict(portal.DEFAULT_CONFIG, idle_minutes_by_user={"alice": 5})
        self.assertEqual(portal.idle_limit_seconds("alice", cfg), 300)

    def test_user_override_zero_means_never(self):
        cfg = dict(portal.DEFAULT_CONFIG, idle_minutes_by_user={"alice": 0})
        self.assertIsNone(portal.idle_limit_seconds("alice", cfg))

    def test_global_zero_means_never(self):
        cfg = dict(portal.DEFAULT_CONFIG, idle_minutes=0)
        self.assertIsNone(portal.idle_limit_seconds("alice", cfg))

    def test_global_zero_does_not_disable_user_override(self):
        cfg = dict(portal.DEFAULT_CONFIG, idle_minutes=0,
                   idle_minutes_by_user={"alice": 30})
        self.assertEqual(portal.idle_limit_seconds("alice", cfg), 30 * 60)

    def test_unlisted_user_falls_back_to_global(self):
        cfg = dict(portal.DEFAULT_CONFIG, idle_minutes_by_user={"alice": 0})
        self.assertEqual(portal.idle_limit_seconds("bob", cfg), DAY)

    def test_negative_means_never_too(self):
        cfg = dict(portal.DEFAULT_CONFIG, idle_minutes_by_user={"alice": -5})
        self.assertIsNone(portal.idle_limit_seconds("alice", cfg))

    def test_missing_key_is_backward_compatible(self):
        cfg = {k: v for k, v in portal.DEFAULT_CONFIG.items()
               if k != "idle_minutes_by_user"}
        self.assertEqual(portal.idle_limit_seconds("alice", cfg), DAY)

    def test_garbage_value_fails_safe(self):
        # 配置写错时宁可不回收，也不能拿坏值去停别人的实例。
        cfg = dict(portal.DEFAULT_CONFIG, idle_minutes_by_user={"alice": "abc"})
        self.assertIsNone(portal.idle_limit_seconds("alice", cfg))


class ReapOnceTest(unittest.IsolatedAsyncioTestCase):
    """reap_once：真正决定「停不停」的那一遍扫描（reaper 只是套了个 60 秒节拍）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = dict(portal.DEFAULT_CONFIG)
        # 嵌套的覆盖表必须复制一份：dict() 是浅拷贝，直接改它会把 {"alice": 0} 写回
        # 模块级的 DEFAULT_CONFIG，污染后面所有用例。
        self.cfg["idle_minutes_by_user"] = dict(
            portal.DEFAULT_CONFIG["idle_minutes_by_user"])
        # secret / log 都落在临时目录：绝不碰 /etc 与 /var/log。
        self.cfg["secret_file"] = os.path.join(self.tmp.name, "secret")
        self.cfg["log_file"] = os.path.join(self.tmp.name, "access.log")
        self.portal = portal.Portal(self.cfg)
        self.stopped = []

        async def fake_active(name, cfg):
            return True                      # 桩：实例都是 active，不需要 systemctl

        async def fake_stop(name, cfg):
            self.stopped.append(name)        # 桩：只记录，不停任何单元
            return True

        for name, fn in (("unit_active", fake_active), ("unit_stop", fake_stop)):
            patcher = mock.patch.object(portal, name, fn)
            patcher.start()
            self.addCleanup(patcher.stop)

    def idle_for(self, user, seconds):
        self.portal.last_seen[user] = time.time() - seconds

    async def test_reaps_after_default_limit(self):
        self.idle_for("alice", 30 * HOUR)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, ["alice"])
        self.assertNotIn("alice", self.portal.last_seen)

    async def test_keeps_recently_active(self):
        self.idle_for("bob", 60)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])
        self.assertIn("bob", self.portal.last_seen)

    async def test_user_override_shortens_limit(self):
        self.cfg["idle_minutes_by_user"] = {"alice": 30}
        self.idle_for("alice", 2 * HOUR)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, ["alice"])

    async def test_user_override_lengthens_limit(self):
        self.cfg["idle_minutes_by_user"] = {"alice": 100000}
        self.idle_for("alice", 30 * HOUR)     # 超过全局 24h，但没超过该用户的上限
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])
        self.assertIn("alice", self.portal.last_seen)

    async def test_user_override_zero_never_reaped(self):
        # 0 = 永不回收（而不是「0 秒后立刻回收」）。
        self.cfg["idle_minutes_by_user"] = {"alice": 0}
        self.idle_for("alice", 100 * DAY)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])
        self.assertIn("alice", self.portal.last_seen)

    async def test_global_zero_disables_reaping(self):
        self.cfg["idle_minutes"] = 0
        self.idle_for("alice", 100 * DAY)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])

    async def test_global_zero_with_override_still_reaps_that_user(self):
        self.cfg["idle_minutes"] = 0
        self.cfg["idle_minutes_by_user"] = {"alice": 30}
        self.idle_for("alice", 2 * HOUR)
        self.idle_for("bob", 100 * DAY)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, ["alice"])   # bob 跟着全局 0，不动

    async def test_ws_open_blocks_reaping(self):
        self.idle_for("alice", 100 * DAY)           # 单看时间早该回收了
        before = self.portal.last_seen["alice"]
        self.portal._ws_enter("alice")
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])          # WS 还连着 → 绝不回收
        self.assertEqual(self.portal.last_seen["alice"], before)
        self.assertEqual(self.portal.ws_active, {"alice": 1})

    async def test_ws_close_restarts_idle_clock(self):
        self.idle_for("alice", 100 * DAY)
        self.portal._ws_enter("alice")
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])

        self.portal._ws_exit("alice")               # 长连接结束 = 刚用过
        self.assertEqual(self.portal.ws_active, {})  # 计数归零且不残留键
        self.assertLess(abs(time.time() - self.portal.last_seen["alice"]), 5)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])           # 空闲从断开时刻重新起算

        self.idle_for("alice", 30 * HOUR)            # 断开后又闲置 30h
        await self.portal.reap_once()
        self.assertEqual(self.stopped, ["alice"])

    async def test_ws_counter_pairs_without_leaking(self):
        self.portal._ws_enter("alice")
        self.portal._ws_enter("alice")               # 两个标签页
        self.assertEqual(self.portal.ws_active, {"alice": 2})
        self.portal._ws_exit("alice")
        self.assertEqual(self.portal.ws_active, {"alice": 1})
        self.portal._ws_exit("alice")
        self.assertEqual(self.portal.ws_active, {})  # 归零即删键
        self.portal._ws_exit("alice")                # 多余的 exit 不能把计数弄成负数
        self.assertEqual(self.portal.ws_active, {})

    async def test_reap_reads_live_config(self):
        # reaper 走 self.cfg：构造之后再改配置也要生效（不是启动时的快照）。
        self.idle_for("alice", 100 * DAY)
        self.portal.cfg["idle_minutes_by_user"]["alice"] = 0
        await self.portal.reap_once()
        self.assertEqual(self.stopped, [])
        # 同时钉住用例隔离：改实例的 cfg 不许写进模块级 DEFAULT_CONFIG。
        self.assertEqual(portal.DEFAULT_CONFIG["idle_minutes_by_user"], {})

    async def test_mixed_users_in_one_pass(self):
        self.cfg["idle_minutes_by_user"] = {"bob": 0, "dave": 30}
        self.idle_for("alice", 100 * DAY)
        self.portal._ws_enter("alice")               # WS 挂着
        self.idle_for("bob", 100 * DAY)              # 该用户永不回收
        self.idle_for("carol", 30 * HOUR)            # 默认 24h → 回收
        self.idle_for("dave", 2 * HOUR)              # 覆盖 30min → 回收
        self.idle_for("erin", 1 * HOUR)              # 刚用过 → 保留
        await self.portal.reap_once()
        self.assertEqual(sorted(self.stopped), ["carol", "dave"])
        self.assertEqual(sorted(self.portal.last_seen),
                         ["alice", "bob", "erin"])

    async def test_request_during_reap_scan_does_not_get_stopped(self):
        """回收器判»空闲»与真正 systemctl stop 之间插进来的请求必须救回实例。

        旧实现只拿扫描开始时的 `seen` 判断一次，然后 `await unit_active` /
        `await unit_stop`（真实环境里是两次 subprocess，几十毫秒）。
        用户恰好在这段时间点了一下页面，实例照样被停 —— 表现为「刚点就断」；
        更糟的是结尾的 `last_seen.pop` 把他刚刷新的时间戳也抹掉，
        下一次请求要再走一遍完整启动。
        """
        self.idle_for("alice", 100 * DAY)

        async def active_then_user_clicks(name, cfg):
            # 模拟：is-active 的 await 期间，用户的新请求抵达并刷新 last_seen
            self.portal.last_seen["alice"] = time.time()
            return True

        with mock.patch.object(portal, "unit_active", active_then_user_clicks):
            await self.portal.reap_once()
        self.assertEqual(self.stopped, [])            # 不能被停
        self.assertIn("alice", self.portal.last_seen)  # 新时间戳必须保留

    async def test_ws_opened_during_reap_scan_does_not_get_stopped(self):
        """同上，但插入的是「新开了一条 WS」——那也是人还在用。"""
        self.idle_for("alice", 100 * DAY)

        async def active_then_ws_opens(name, cfg):
            self.portal._ws_enter("alice")
            return True

        with mock.patch.object(portal, "unit_active", active_then_ws_opens):
            await self.portal.reap_once()
        self.assertEqual(self.stopped, [])

    async def test_genuinely_idle_user_is_still_reaped(self):
        # 反向保护：加了「重新看一眼」之后，真空闲的用户必须照旧被回收。
        self.idle_for("alice", 100 * DAY)
        await self.portal.reap_once()
        self.assertEqual(self.stopped, ["alice"])
        self.assertNotIn("alice", self.portal.last_seen)


class WiringTest(unittest.TestCase):
    """真实代码路径的接线检查：改坏了这里就说明保活/回收没接上。"""

    def test_upgrade_branch_accounts_ws(self):
        src = inspect.getsource(portal.Portal._proxy)
        self.assertIn("_ws_enter(", src)
        self.assertIn("_ws_exit(", src)

    def test_reaper_drives_reap_once(self):
        self.assertIn("reap_once", inspect.getsource(portal.Portal.reaper))

    def test_http_request_still_refreshes_last_seen(self):
        self.assertIn("self.last_seen[username] = time.time()",
                      inspect.getsource(portal.Portal._handle))

    def test_hardens_dsh_home_before_instance(self):
        # 权限必须在实例跑起来之前收敛，否则 seed/引导会先在 0755 目录里写凭据。
        src = inspect.getsource(portal.Portal._handle)
        self.assertIn("harden_dsh_home(", src)
        self.assertLess(src.index("harden_dsh_home("), src.index("ensure_instance("))


class RequestHeaderTest(unittest.TestCase):
    """反代请求头：绝不能让浏览器替上游 dsh 决定「我是谁」。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cfg = dict(portal.DEFAULT_CONFIG)
        cfg["secret_file"] = os.path.join(self.tmp.name, "secret")
        cfg["log_file"] = os.path.join(self.tmp.name, "access.log")
        self.portal = portal.Portal(cfg)

    def rewrite(self, headers, port=43001, authority="100.96.52.76:3080",
                upstream_cookie=None):
        head, _ = self.portal.rewrite_request_head(
            "GET", "/", "HTTP/1.1", headers, port, authority,
            upstream_cookie=upstream_cookie)
        return head.decode("latin1")

    def cookie_line(self, text):
        lines = [l for l in text.split("\r\n") if l.lower().startswith("cookie:")]
        return lines[0] if lines else None

    def test_upstream_session_cookie_is_stripped(self):
        """核心不变量：客户端带来的 dsh-auth-* 不许进上游。

        门户按**门户会话**决定这次请求代表谁，而上游 dsh 只认 dsh-auth-<hash>。
        若原样转发，B 账号拿到 A 那张 cookie 就能一个请求直接以 A 的身份操作
        A 的实例 —— 门户的账号隔离被绕过。
        """
        text = self.rewrite([("Host", "x"), ("Cookie", "dsh-auth-AAAA=STOLEN")])
        self.assertIsNone(self.cookie_line(text), text)

    def test_portal_cookie_survives_but_upstream_one_goes(self):
        text = self.rewrite([("Cookie", "dsh-portal-session=a.b.c; dsh-auth-XYZ=SECRET; other=1")])
        line = self.cookie_line(text)
        self.assertIsNotNone(line)
        self.assertNotIn("dsh-auth-", line)
        self.assertIn("dsh-portal-session=a.b.c", line)
        self.assertIn("other=1", line)

    def test_prefix_match_is_case_insensitive(self):
        # 上游/浏览器都可能换大小写；判断必须大小写无关。
        text = self.rewrite([("Cookie", "DSH-Auth-ABC=x")])
        self.assertIsNone(self.cookie_line(text), text)

    def test_harmless_cookie_is_passed_through(self):
        text = self.rewrite([("Cookie", "theme=dark")])
        self.assertIn("theme=dark", self.cookie_line(text) or "")

    def test_portal_session_is_injected_after_stripping(self):
        """剥离必须配注入，否则上游恒 401（v0.14.2 的无限 303 回归）。

        浏览器那张只用来判断「有没有会话」；真正的身份凭据由门户自己换来的
        upstream_cookie 注入。缺了注入这一步，请求到上游是「无 cookie」→ 401
        → 门户补发 Set-Cookie → 下一跳又被剥 → 用户永远停在重定向里。
        """
        text = self.rewrite([("Cookie", "dsh-auth-AAAA=STOLEN; theme=dark")],
                            upstream_cookie="dsh-auth-GOOD=session")
        line = self.cookie_line(text)
        self.assertIsNotNone(line, text)
        self.assertIn("dsh-auth-GOOD=session", line)
        self.assertNotIn("STOLEN", line)
        self.assertIn("theme=dark", line)

    def test_portal_session_injected_even_without_client_cookie(self):
        text = self.rewrite([("Host", "x")], upstream_cookie="dsh-auth-GOOD=session")
        self.assertIn("dsh-auth-GOOD=session", self.cookie_line(text) or "")

    def test_no_cookie_header_when_nothing_to_send(self):
        text = self.rewrite([("Cookie", "dsh-auth-AAAA=STOLEN")])
        self.assertIsNone(self.cookie_line(text), text)

    def test_cookie_header_appears_once(self):
        # 多条 Cookie 头 + 注入：必须合成一条，上游只解析第一条。
        text = self.rewrite([("Cookie", "a=1"), ("Cookie", "b=2")],
                            upstream_cookie="dsh-auth-GOOD=s")
        low = text.lower()
        self.assertEqual(low.count("\r\ncookie:"), 1, text)

    def test_hop_by_hop_headers_are_dropped(self):
        text = self.rewrite([("Connection", "keep-alive"), ("Keep-Alive", "timeout=5"),
                             ("Proxy-Connection", "keep-alive"),
                             ("Proxy-Authorization", "Basic x"), ("TE", "trailers")])
        low = text.lower()
        for gone in ("proxy-connection:", "proxy-authorization:", "keep-alive:"):
            self.assertNotIn(gone, low)
        # connection 由门户统一重写，且只能出现一次
        self.assertEqual(low.count("\r\nconnection:"), 1, text)

    def test_forwarding_headers_are_not_injected(self):
        # dsh 见到 x-forwarded-* 会认为「对端是代理，不是用户」并拒绝；
        # 客户端自己带来的那些也原样保留（这是 dsh 自己的判定，不是门户的安全边界）。
        text = self.rewrite([("Host", "x")])
        self.assertNotIn("x-forwarded-for", text.lower())
        self.assertNotIn("x-real-ip", text.lower())

    def test_host_always_rewritten_to_loopback_backend(self):
        text = self.rewrite([("Host", "evil.example")], port=43007)
        self.assertIn("host: 127.0.0.1:43007", text)
        self.assertNotIn("evil.example", text)


class HealthzTest(unittest.IsolatedAsyncioTestCase):
    """/__portal/healthz 是免登录端点：不能泄露任何账号相关数字。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cfg = dict(portal.DEFAULT_CONFIG)
        cfg["secret_file"] = os.path.join(self.tmp.name, "secret")
        cfg["log_file"] = os.path.join(self.tmp.name, "access.log")
        cfg["bind"], cfg["port"] = "127.0.0.1", 3099
        cfg["public_authorities"] = ["127.0.0.1:3099"]
        self.portal = portal.Portal(cfg)

    async def get(self, path, headers=None):
        payload = (f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:3099\r\n"
                   + "".join(f"{k}: {v}\r\n" for k, v in (headers or []))
                   + "\r\n").encode()

        class W:
            def __init__(self):
                self.buf = b""

            def write(self, data):
                self.buf += data

            async def drain(self):
                pass

            def get_extra_info(self, _k):
                return ("203.0.113.9", 1234)

        class R:
            def __init__(self, data):
                self.data = data

            async def read(self, n=4096):
                out, self.data = self.data[:n], self.data[n:]
                return out

        w = W()
        await self.portal.handle(R(payload), w)
        head, _, body = w.buf.partition(b"\r\n\r\n")
        return head.decode("latin1"), body

    async def test_healthz_is_unauthenticated(self):
        # 这个端点设计上就免登录（监控/反代健康检查在登录前用）—— 钉住这个语义，
        # 免得以后有人为了「别泄露数字」顺手把它改成要登录，反而打挂监控。
        head, body = await self.get("/__portal/healthz")
        self.assertIn("200", head.split("\r\n")[0])
        self.assertIs(json.loads(body).get("ok"), True)

    async def test_healthz_does_not_leak_instance_count(self):
        # 旧实现回 {"instances": len(last_seen)} —— 把「此刻有几个不同账号在用」
        # 告诉任何连得上门户的人（tailnet 内人人可达）。健康检查不需要这个数。
        self.portal.last_seen["alice"] = time.time()
        self.portal.last_seen["bob"] = time.time()
        _, body = await self.get("/__portal/healthz")
        self.assertEqual(json.loads(body), {"ok": True})
        self.assertNotIn("instances", body.decode())


class SessionCookieTest(unittest.TestCase):
    """门户会话 cookie 的属性。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cfg = dict(portal.DEFAULT_CONFIG)
        cfg["secret_file"] = os.path.join(self.tmp.name, "secret")
        cfg["log_file"] = os.path.join(self.tmp.name, "access.log")
        self.portal = portal.Portal(cfg)

    def test_cookie_attributes(self):
        c = self.portal.make_cookie("alice")
        self.assertIn("Path=/", c)
        self.assertIn("HttpOnly", c)          # JS 读不到
        self.assertIn("SameSite=Lax", c)      # 跨站 POST（表单/跳转）不带
        self.assertIn("Max-Age=", c)

    def test_cookie_signature_is_hmac_bound_to_user(self):
        # 只改用户名、沿用别人的签名 → 必须读不出来。
        c = self.portal.make_cookie("alice").split(";")[0]
        value = c.split("=", 1)[1]
        _user, expires, sig = value.split(".")
        forged = f"dsh-portal-session=bob.{expires}.{sig}"
        self.assertIsNone(self.portal.read_session([("Cookie", forged)]))

    def test_expired_cookie_rejected(self):
        past = int(time.time()) - 10
        sig = self.portal._sign("alice", past)
        got = self.portal.read_session(
            [("Cookie", f"dsh-portal-session=alice.{past}.{sig}")])
        self.assertIsNone(got)

    def test_valid_cookie_roundtrips(self):
        c = self.portal.make_cookie("alice").split(";")[0]
        self.assertEqual(self.portal.read_session([("Cookie", c)]), "alice")


class UpstreamLogLevelTest(unittest.TestCase):
    """改动 A：上游状态码 → (level, msg) 的分档。"""

    def test_5xx_is_the_only_error_bucket(self):
        for status in (500, 502, 503, 599):
            self.assertEqual(portal.upstream_log_level(status),
                             ("error", "upstream error"))

    def test_404_is_info_not_found(self):
        self.assertEqual(portal.upstream_log_level(404),
                         ("info", "upstream not found"))

    def test_other_4xx_is_warn_refused(self):
        for status in (400, 401, 403, 409, 418):
            self.assertEqual(portal.upstream_log_level(status),
                             ("warn", "upstream refused"))

    def test_error_count_equals_real_5xx(self):
        """验收标准：按 msg=="upstream error" 统计的条数 == 真正 5xx 的条数。

        状态码分布照真的 access.log 构成（615×404，含 531 条 /api/changes.summary
        的正常 "Change summary unavailable."；250×403；4×404；2×409），末尾补 3 条
        真 5xx 作对照。旧实现下这 871 条全记成 "upstream error"，分档后必须只剩 3 条。
        """
        observed = ([404] * 615 + [403] * 250 + [404] * 4 + [409] * 2
                    + [500, 502, 503])
        rows = [portal.upstream_log_level(s) for s in observed]
        self.assertEqual(len(rows), 874)

        by_msg = {}
        for level, msg in rows:
            count, first_level = by_msg.get(msg, (0, level))
            by_msg[msg] = (count + 1, first_level)

        self.assertEqual(by_msg["upstream error"], (3, "error"))
        self.assertEqual(by_msg["upstream not found"], (619, "info"))   # 615 + 4
        self.assertEqual(by_msg["upstream refused"], (252, "warn"))     # 250 + 2

    def test_proxy_delegates_to_taxonomy(self):
        # 接线检查：msg 必须出自纯函数，_proxy 里不能又硬编码回 "upstream error"。
        src = inspect.getsource(portal.Portal._proxy)
        self.assertIn("upstream_log_level(status)", src)
        self.assertNotIn('"upstream error"', src)


class HardenDshHomeTest(unittest.TestCase):
    """改动 B（门户侧）：$HOME/.dsh 收敛到 0700。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cfg = dict(portal.DEFAULT_CONFIG)
        cfg["secret_file"] = os.path.join(self.tmp.name, "secret")
        cfg["log_file"] = os.path.join(self.tmp.name, "access.log")
        self.portal = portal.Portal(cfg)
        self.home = os.path.join(self.tmp.name, "home")
        os.makedirs(self.home)

    @staticmethod
    def mode(path):
        return os.stat(path).st_mode & 0o777

    def test_existing_0755_becomes_0700(self):
        dsh = os.path.join(self.home, ".dsh")
        os.makedirs(dsh)
        os.chmod(dsh, 0o755)
        self.portal.harden_dsh_home("alice", self.home)
        self.assertEqual(self.mode(dsh), 0o700)

    def test_missing_dir_is_noop_without_error(self):
        # 不存在就什么都不做（交给 dsh 按 umask 077 自己创建），且不能抛异常。
        self.portal.harden_dsh_home("alice", self.home)
        self.assertFalse(os.path.exists(os.path.join(self.home, ".dsh")))

    def test_already_0700_stays(self):
        dsh = os.path.join(self.home, ".dsh")
        os.makedirs(dsh, mode=0o700)
        os.chmod(dsh, 0o700)
        self.portal.harden_dsh_home("alice", self.home)
        self.assertEqual(self.mode(dsh), 0o700)

    def test_symlink_target_left_alone(self):
        # 尊重符号链接：不能顺着它把 $HOME 之外的目标目录改掉。
        target = os.path.join(self.tmp.name, "elsewhere")
        os.makedirs(target)
        os.chmod(target, 0o755)
        os.symlink(target, os.path.join(self.home, ".dsh"))
        self.portal.harden_dsh_home("alice", self.home)
        self.assertEqual(self.mode(target), 0o755)


class InstanceWrapperTest(unittest.TestCase):
    """改动 B（实例侧）：包装脚本在 exec 前 umask 077，其余原样。"""

    def setUp(self):
        with open(DASH_INSTANCE, encoding="utf-8") as fh:
            self.text = fh.read()

    def test_umask_before_exec(self):
        self.assertIn("umask 077", self.text)
        self.assertLess(self.text.index("umask 077"),
                        self.text.index("exec /opt/dsh/node/bin/node"))

    def test_existing_semantics_untouched(self):
        self.assertIn("set -eu", self.text)
        self.assertIn('PATH="/opt/dsh/node/bin:${USER_PATHS}${PATH}"', self.text)
        self.assertIn('--profile web --no-open --host 127.0.0.1 --port "$PORT" "$@"',
                      self.text)


class LogrotateConfTest(unittest.TestCase):
    """改动 C：/etc/logrotate.d/dsh-portal 的仓库基线。"""

    def setUp(self):
        with open(LOGROTATE_CONF, encoding="utf-8") as fh:
            self.text = fh.read()

    def config_lines(self):
        """去掉注释后的有效配置行（注释里为解释判断依据，本来就该出现 postrotate）。"""
        out = []
        for line in self.text.splitlines():
            code = line.split("#", 1)[0].strip()
            if code:
                out.append(code)
        return out

    def test_path_and_retention_directives(self):
        body = "\n".join(self.config_lines())
        self.assertIn("/var/log/dsh-portal/access.log {", body)
        for directive in ("daily", "rotate 30", "compress", "delaycompress",
                          "missingok", "notifempty"):
            self.assertIn(directive, body)
        self.assertIn("}", body)

    def test_create_is_0640_root_adm(self):
        self.assertIn("create 0640 root adm", "\n".join(self.config_lines()))

    def test_no_postrotate_signal(self):
        # portal.py 每次 open(path, "a") 追加、写完即关，不持长期 fd ——
        # 轮转不需要任何信号；写 restart/HUP 只会让所有在线用户瞬断。
        body = " ".join(self.config_lines())
        for token in ("postrotate", "prerotate", "restart", "HUP", "kill", "systemctl"):
            self.assertNotIn(token, body)

    def test_comment_explains_why_no_signal(self):
        comments = "\n".join(line for line in self.text.splitlines()
                             if line.strip().startswith("#"))
        self.assertIn('open(path, "a")', comments)
        self.assertIn("长期", comments)


class BindExtraTest(unittest.IsolatedAsyncioTestCase):
    """bind_extra：主 bind 之外再听几个地址，且**只**放行真的在听的 authority。

    核心不变量：Host 校验是反 DNS 重绑定的防线。所以 bind_extra 必须
    「真的在那个地址上监听」，而不是「把地址塞进 public_authorities」——
    后者会让回环端口上任意 Origin 都过校验。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = dict(portal.DEFAULT_CONFIG)
        self.base["secret_file"] = os.path.join(self.tmp.name, "secret")
        self.base["log_file"] = os.path.join(self.tmp.name, "access.log")
        # public_authorities 一条都不留：本类验证的是「绑定即受信」，
        # 不能被显式白名单掩盖。
        self.base["public_authorities"] = []

    def portal_for(self, **over):
        cfg = dict(self.base)
        cfg.update(over)
        return portal.Portal(cfg)

    # —— 默认值与向后兼容 ——

    def test_default_is_empty(self):
        self.assertEqual(portal.DEFAULT_CONFIG["bind_extra"], [])

    def test_missing_key_is_backward_compatible(self):
        # 老 config.json 没有这个键：authority 集合必须与改动前完全一致。
        p = self.portal_for(bind="10.0.0.5", port=3080)
        self.assertEqual(
            sorted(p.allowed_authorities),
            ["10.0.0.5", "10.0.0.5:3080", "127.0.0.1:3080", "localhost:3080"])

    # —— 受信 authority ——

    def test_extra_bind_is_a_trusted_authority(self):
        p = self.portal_for(bind="10.0.0.5", port=3080, bind_extra=["127.0.0.1"])
        self.assertEqual(p.authority_ok("127.0.0.1:3080"), "127.0.0.1:3080")
        self.assertEqual(p.authority_ok("127.0.0.1"), "127.0.0.1")
        # 主 bind 一个都没少。
        self.assertEqual(p.authority_ok("10.0.0.5:3080"), "10.0.0.5:3080")

    def test_extra_bind_follows_configured_port(self):
        # 端口是配置项：非默认端口下，绝不能凭空冒出一个 :3080。
        p = self.portal_for(bind="10.0.0.5", port=9999, bind_extra=["127.0.0.1"])
        self.assertEqual(p.authority_ok("127.0.0.1:9999"), "127.0.0.1:9999")
        self.assertIsNone(p.authority_ok("127.0.0.1:3080"))

    def test_unknown_host_still_rejected(self):
        p = self.portal_for(bind="10.0.0.5", port=3080, bind_extra=["127.0.0.1"])
        for host in ("evil.example", "evil.example:3080", "10.0.0.6:3080"):
            self.assertIsNone(p.authority_ok(host), host)

    def test_blank_entries_are_ignored(self):
        p = self.portal_for(bind="10.0.0.5", port=3080,
                            bind_extra=["", "  ", "127.0.0.1"])
        self.assertEqual(
            sorted(p.allowed_authorities),
            ["10.0.0.5", "10.0.0.5:3080", "127.0.0.1", "127.0.0.1:3080",
             "localhost:3080"])

    # —— 真实绑定行为 ——

    async def test_extra_bind_listens_and_shares_one_handler(self):
        # 主 bind 用 127.0.0.1:0（临时端口），额外地址用 ::1 —— 都不需要 root。
        p = self.portal_for(bind="127.0.0.1", port=0)
        main = await asyncio.start_server(p.handle, "127.0.0.1", 0)
        port = main.sockets[0].getsockname()[1]
        try:
            extra = await asyncio.start_server(p.handle, "::1", port)
        finally:
            main.close()
            await main.wait_closed()
        try:
            self.assertEqual(extra.sockets[0].getsockname()[1], port)
        finally:
            extra.close()
            await extra.wait_closed()

    async def test_unbindable_extra_is_skipped(self):
        # 绑不上的地址只 WARN，不能让主监听跟着崩。
        with self.assertRaises(OSError):
            srv = await asyncio.start_server(
                lambda r, w: None, "192.0.2.99", 0)   # TEST-NET-1，必然不可绑
            srv.close()

    # —— 部署件一致性 ——

    def test_example_config_has_bind_extra(self):
        import json
        path = os.path.join(SERVER, "config.example.json")
        with open(path, encoding="utf-8") as fh:
            cfg = json.load(fh)
        self.assertEqual(cfg["bind_extra"], [])


if __name__ == "__main__":
    print(f"portal 离线自测  (源文件: {PORTAL_PY})")
    unittest.main(verbosity=2)
