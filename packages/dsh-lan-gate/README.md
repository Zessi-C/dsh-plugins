# dsh-lan-gate

> **v0.7.0 起本插件是纯 client shim。** 宿主半包（listenHost 改写 + whois 门禁）
> 随多用户门户（dsh-portal + dsh@.service）落地已删除——实例只绑回环、由门户
> 统一鉴权，宿主半包没有生效场景，也没有需要兼容的旧部署。
> profile patch 里的 lan-gate 条目和配置可原样保留（apply 接受并忽略）。
> 需要考古或回归直连模式：checkout tag v0.6.1。下文 Phase 1 / Phase 2 的
> 架构说明保留作历史文档。

让 `dsh web` **直接监听 Tailscale IP**，并用 **tailnet 身份（tailscale whois）**做访问门禁，
同时保证在非 loopback origin 下**设置页功能完整**。

不需要中间转发进程，不需要 `systemd-socket-proxyd`，不需要绑定 `0.0.0.0`。

已在生产环境跑通，端到端实测：未授权 403 / 授权设备 401→303→200，
服务单元从 3 个降到 1 个。

---

## 仓库结构

```
lib/index.js                插件宿主入口（v0.7.0 起为最小 stub，无行为）
lib/client.js               浏览器半包：isLoopback 改写 + 非安全上下文 polyfill
bin/dsh-web-ctl             运维 CLI（单文件 Python，零依赖，本地/远程双模式）
cordis.patch.yml            本包的 Loader 条目注册层（client shim 注入的必要条件）
deploy/
  dsh-web.service           systemd user unit（已废弃：被门户 dsh@.service 取代）
  cordis.patch.example.yml  真实 patch 的示例：填上自己的 tailnet IP 与白名单再用
server/                     服务器端部署件：portal.py / 门户单元 / 实例包装脚本 /
                            PAM 定义 / 共享 npmrc —— 由 `dsh-web-ctl install` 落盘
                            （见 server/README.md；这批件原先全部手写在机器上、
                            不在版本管理里，是 2026-10-19 事故的土壤）
probe/                      写代码前验证 dsh 内部机制的一次性探针（见 probe/README.md）
docs/                       截图等证据 + deployment-inventory.md（部署面清单与缺口）
```

> **实例模板单元 `dsh@.service` 不在 `deploy/` 里** —— 它的唯一真源是
> `bin/dsh-web-ctl` 里的 `INSTANCE_UNIT_TEMPLATE`，用 `dsh-web-ctl install-unit`
> 落盘。原因是手写在机器上的单元会漂移且无人评审：2026-10-19 的「任务反复中断」
> 事故就来自一份手写单元里那个没人看过的 `MemoryMax=16G`（详见
> [实例单元](#实例单元dshservice为什么不能设内存上限)）。

**本仓库不含任何个人化配置** —— tailnet IP、Tailscale 登录名、节点名、主机别名
一律以 `<TAILNET_IP>` / `<YOUR_TAILSCALE_LOGIN>` / `<node-a>` / `<HOST>` 占位。
真实值请放在本机（见下），不要提交。

`.gitignore` 已排除：日志、`.env`、`.credentials.yaml`、dsh 的 `sessions/` 与 `storages/`、
以及 `deploy/cordis.patch.yml`（你本机那份真实 patch）。

## 系统依赖

| 依赖 | 用途 | 缺了会怎样 |
|---|---|---|
| `python3-pam` | 门户用 PAM 校验 Linux 账号密码 | `portal.py` 直接退出，**门户起不来**（`doctor` 的「python3-pam 可用」报红） |
| `git`（可选） | `dsh-workspace-changes` 统计每轮改了哪些文件 | 仍能列出文件工具改过的文件，只少 git 级的增删行数 |
| `node` ≥ 26 | 实例运行时，共享一份装在 `/opt/dsh/node` | 实例起不来（`doctor` 的「共享运行时 dsh」报红） |
| `logrotate` | 轮转 `/var/log/dsh-portal/access.log` | 日志无限增长（≈12.8 KB/天）；装机见 `server/README.md` |

### 本机配置放在哪

| 内容 | 位置 | 是否入库 |
|---|---|---|
| CLI 目标主机 / 插件仓库路径 | `~/.config/dsh-web-ctl/config` | ❌ |
| 真实 profile patch | `~/.dsh/profiles/web/cordis.patch.yml`（服务器上） | ❌ |
| 源码里的真实值 | 一律用占位符，真实值只留在上面两处 | ❌ |

---

## 为什么需要它

`dsh web --host` 只接受 `127.0.0.1` / `0.0.0.0`，且运行时**显式拒绝** `0.0.0.0`
（`intentionally not supported yet for safety`）。想在 tailnet 上访问，绕不过去。

而即使把页面通过别的方式暴露出去，还有第二个坑：dsh 的 `dsh-client-connection`
用 `isLoopbackHostname()` 判断（只认 `localhost` / `[::1]` / `127.0.0.0/8`），
非 loopback origin 下设置页以 `unavailable` 起步，报
`settings are unavailable in this browser` —— **设置打不开，等于没用**。

另外明文 HTTP 的 IP origin 是**非安全上下文**（`isSecureContext=false`），
`crypto.randomUUID` / `crypto.subtle` / `navigator.clipboard` 全部 `undefined`。

本插件一次解决这三件事。

---

## 两个半包的分工

```
┌─ 宿主半包  lib/index.js ──────────────────────────────────────┐
│  1. 改写 WebServer 的 schemastery schema：把 host 的 enum       │
│     从 ["127.0.0.1","0.0.0.0"] 换成自定义 tailnet IP            │
│  2. 挂 internal/config waterfall：把最终 config.host 钉成该 IP   │
│  3. 包装 server.emit，对 request/upgrade 做 tailscale whois 鉴权 │
│     → 非白名单设备直接 403，fail-closed                          │
│  4. 事件日志落盘 ~/.dsh/logs/lan-gate.log（ADMIT / DENY）        │
└───────────────────────────────────────────────────────────────┘
┌─ 浏览器半包  lib/client.js ───────────────────────────────────┐
│  1. 把受信 hostname 上的 connection.isLoopback 改成 true        │
│     → 设置页正常读写                                            │
│  2. 补齐非安全上下文缺失的 crypto.randomUUID 与 navigator.clipboard │
│  3. 门户后面显示「退出登录」按钮（v0.14.0，见下节）                │
│  4. 诊断暴露在 window.__DSH_LAN_GATE__                          │
└───────────────────────────────────────────────────────────────┘
```

### 退出登录 / 换账号（v0.14.0）

门户是多用户入口，但 dsh 本身没有「我是谁」的概念，换账号只能手动敲
`/__portal/logout`。v0.14.0 在侧边栏底部（设置行上方，`sidebar.footer.action`
席位）加了一行「退出登录」：

```
用户点「退出登录」
  → GET /__portal/logout?next=login&ts=…        （插件）
  → 门户清 dsh-portal-session 与上游 dsh-auth-* cookie
  → 303 /__portal/login?logout=1               （门户）
  → 登录页 + 「已经退出登录。用哪个账号登录都可以。」提示
```

**只在门户后面出现**：插件先探一次 `/__portal/me`，用「浏览器 origin 的 host
与门户改写后的 `X-Dsh-Portal-Host` 不一致」判定自己在不在门户后面，并要求该
接口回一个已登录用户；直连实例（`127.0.0.1:43001` 或桌面端）不渲染这行按钮，
也就不会多出对后端不存在的路由的请求。

门户侧改动（`server/portal.py`）：

- `/__portal/logout` 现在 **GET 与 POST 都接受**（浏览器点链接只会发 GET）；
- 清 cookie 时**顺带清上游那张 `dsh-auth-*`**：cookie 清空后再为本次请求引导
  一次，把上游 `Set-Cookie` 改写成 `Max-Age=0` 一起下发。否则「退出」只是丢了
  门户会话，同一标签页里仍能带着旧的上游 cookie 继续用 —— 那就不算退出；
- 不带 `?next=login` 的旧调用行为不变（仍 303 到 `/`），脚本与外部链接不受影响。

验证：`probe/` 之外另有一份一次性的双端探针（门户登出链路 + 浏览器按钮挂载），
见下文「验证」。

---

## 配置（profile patch 层）

`~/.dsh/profiles/<name>/cordis.patch.yml`：

```yaml
- id: lan-gate
  config:
    listenHost: "<TAILNET_IP>"          # 本机 tailnet 地址
    allowedLogins: "you@example.com"     # 逗号分隔，按 Tailscale 登录名
    allowedNodes: "<node-a>,<node-b>"    # 逗号分隔，按节点名
```

也可用环境变量覆盖：`DSH_LAN_GATE_HOST` / `_LOGINS` / `_NODES` / `_ENFORCE` / `_LOG`。

**鉴权语义**：`allowedLogins` 与 `allowedNodes` 非空时**都要满足**（AND）；
都留空则 `enforceWhois=false`，退化为不做鉴权（仅建议在已受其他手段保护的网络上用）。
`tailscale whois` 查不到身份时**直接拒绝**（fail-closed）。

---

## 部署

```bash
# 1. 插件放到 dsh 的插件目录
mkdir -p ~/.dsh/plugins/dsh-lan-gate/lib
cp lib/index.js lib/client.js ~/.dsh/plugins/dsh-lan-gate/lib/
cp package.json ~/.dsh/plugins/dsh-lan-gate/

# 2. 写 profile patch：照抄 deploy/cordis.patch.example.yml，
#    把 <TAILNET_IP> / <YOUR_TAILSCALE_LOGIN> / <node-a> 换成自己的真实值，
#    落到目标主机的 ~/.dsh/profiles/<name>/cordis.patch.yml

# 3. systemd user unit：注意 PATH 必须含 nvm 的 node
#    见 deploy/dsh-web.service

systemctl --user daemon-reload
systemctl --user enable --now dsh-web.service
```

`deploy/cordis.patch.example.yml` 是模板；真实 patch 含你的 tailnet IP 与白名单，
**不要提交**（`.gitignore` 已排除 `deploy/cordis.patch.yml`）。
改完 IP / 白名单后记得 `systemctl --user daemon-reload && systemctl --user restart dsh-web.service`。

### ⚠️ `--trusted-host` 是必需的（漏了会导致前端一直「重新连接中」）

dsh 给 `/api` 加了一道 **browser-trust fence**：请求的 `Host` 必须是受信 authority，
否则 **`/api/*` 一律 403**。而**首页仍然 200** —— 所以只看首页的验证会漏掉这类故障。

```ini
ExecStart=... dsh --profile web --no-open \
    --trusted-host <TAILNET_IP> --trusted-host <TAILNET_IP>:3080
```

要看 ts.net 域名访问，再加 `--trusted-host <node>.<tailnet>.ts.net`
与 `--trusted-host <node>.<tailnet>.ts.net:443`（可重复）。

**症状对照**（都指向同一个根因）：

| 现象 | 实际原因 |
|---|---|
| 右上角一直「重新连接中」（转圈） | 每个 `/api` 调用都 403，客户端建不起会话 |
| 设置页报 `permission catalog has no active Host connection` | 同上 |
| 设置页报 `llm/listProviders failed … HTTP 403` | 同上 |
| 但**首页、加载页、静态资源都正常** | 栅栏只管 `/api`，不管静态资源 |

**排查捷径**：门禁日志里 **DENY 数为 0** 就说明不是本插件的 whois 门禁挡的，
而是 dsh 自己的信任栅栏 —— 去查单元的 `--trusted-host`。

`dsh-web-ctl verify` 里有两条专门测这个（`/api 通过信任栅栏` / `伪造 Host 被拦`），
`dsh-web-ctl doctor` 也会检查单元是否传了 `--trusted-host`。

### 单元为什么固定用 Node ≥26

这条和插件本身无关，只是**单元模板的一个前提**，写在这里免得被改坏：

Node 内置的 undici 与 dsh 依赖的 npm undici 必须**同大版本**，否则 dsh 里所有
裸 `fetch()` 都**不跟随重定向**（HuggingFace 的 `resolve/` 地址会得到
302/307/308 而不是最终对象，模型下载因此失败）。

| Node 线 | 内置 undici |
|---|---|
| Node 22 | 6.24.1 |
| Node 24（LTS） | 7.24.4 ← 与 dsh 的 8.x 错配 |
| **Node 26** | **8.10.2** ← 同大版本 ✓ |

内置 undici 编译在 Node 二进制里，**不能单独升级**，同一 LTS 线内升小版本也没用
（v24.14.1 与 v24.15.0 都是 7.24.4）—— 所以用 Node 26。

---

## 验证

```bash
# 门户端点
ss -ltn | grep 3080
curl -s -o /dev/null -w '%{http_code}\n' http://<TAILNET_IP>:3080/__portal/login   # → 200

# 登出链路（浏览器里点完「退出登录」应看到登录页与提示；命令行等价形态）
curl -sI "http://<TAILNET_IP>:3080/__portal/logout?next=login" | grep -iE '^(HTTP|location|set-cookie)'
# → 303 / Set-Cookie: dsh-portal-session=;…Max-Age=0 / Set-Cookie: dsh-auth-…=;…Max-Age=0

# 监听地址（直连实例；门户架好之后不应再把 dsh 绑到 tailnet IP）
ss -ltn | grep 3080

# 门禁日志
tail -f ~/.dsh/logs/lan-gate.log
# 2026-09-24T01:45:53.819Z [ADMIT] 100.x.y.z <node-b> <you@example.com> :: tailnet peer

# 端到端
TOKEN=$(ssh <HOST> "tail -1 ~/.dsh/logs/dsh-web.out.log" | grep -o 'token=.*' | cut -d= -f2)
curl -c /tmp/c.txt "http://<tailnet-ip>:3080/?token=$TOKEN"   # → 303
curl -b /tmp/c.txt "http://<tailnet-ip>:3080/"               # → 200, <title>DeepSeek Harness</title>
```

浏览器打开 `http://<tailnet-ip>:3080/`，设置页（Models 等）应完整渲染；
控制台执行 `__DSH_LAN_GATE__` 可看诊断。

---

## 运维 CLI：`dsh-web-ctl`

单文件 Python（无第三方依赖），装在 `~/.local/bin/dsh-web-ctl`。
**本机就是宿主时自动切本地执行**；否则按下面的顺序解析目标主机。

v0.6.0 起面向**多用户门户**架构（单实例 `dsh-web.service` 已废弃）：

```
浏览器 ──► dsh-portal(3080, PAM 登录) ──► 127.0.0.1:(42000+uid) 每用户 dsh 实例
```

- `dsh-portal.service`：系统单元（root），门户 + 反代 + 审计
- `dsh@<user>.service`：系统模板单元，每用户一个回环实例
- `/opt/dsh/node`：共享 Node 运行时，dsh 全局只装这一份

服务器端操作需要 root（目标机 ssh 账号有**免密 sudo** 即可）。

```bash
dsh-web-ctl status        # 门户 / 实例表 / tailnet / 最近审计事件 / 访问地址
dsh-web-ctl users         # 用过 dsh 的账号与其实例状态（插件副本 legacy/seed）
dsh-web-ctl login         # 访问地址（登录 = Linux 账号密码，PAM）
dsh-web-ctl token         # （已废弃）PAM 门户没有启动 token
dsh-web-ctl peers         # 按用户聚合的审计统计（登录/引导/拒绝）
dsh-web-ctl doctor        # 21 项自检（端口公式、单元内存/连坐、部署件漂移、npmrc 可读性…）
dsh-web-ctl verify        # 六段端到端（从本机当浏览器客户端实测门户）
dsh-web-ctl logs -n 50    # 门户 journal；`logs <user>` 看某用户的实例
dsh-web-ctl gate -n 30    # 审计日志尾部（人话化）
dsh-web-ctl restart       # 无参 = 门户 + 所有活动实例一起滚；`restart <user>` = 单个实例
                          #   （start / stop 同理；enable / disable 只作用于门户 ——
                          #    实例是登录后按需拉起的，不需要开机自启）
dsh-web-ctl deploy        # 上传插件：共享 seed 目录 + 各用户遗留副本，滚动重启实例
dsh-web-ctl update        # 更新共享运行时里的 dsh 并滚动重启活动实例
dsh-web-ctl install-unit  # 写实例模板单元 dsh@.service（唯一真源在 CLI 内）
                          #   --print 只打印供评审；--diff 只显示与目标机的差异
dsh-web-ctl install       # 安装服务器端部署件（仓库 server/ → 目标机），并顺带落盘实例单元
                          #   portal.py / 门户单元 / dsh-instance / PAM / config 示例 /
                          #   npmrc / logrotate，逐件比对，改动**不留 .bak**（版本在 git 里）
                          #   --check 只比对不落盘（发现"机器上被手改过"的漂移，退出码 1）
                          #   仓库位置：--dir → $DSH_LAN_GATE_REPO → config 的 plugin_repo
dsh-web-ctl status --json # 机器可读（--json 放子命令前后都行）
```

`update` 会对照 npm 上的 dist-tag 显示版本，按语义化版本判断「可升级 / 低于当前」
（不会把更旧的 tag 当成升级），安装后自动滚动重启实例并跑一遍自检：

```bash
dsh-web-ctl update --check           # 只看有没有更新
dsh-web-ctl update                   # 默认装 next
dsh-web-ctl update --tag alpha       # 指定 tag
dsh-web-ctl update --force           # 同版本也强制重装
dsh-web-ctl update --online          # 强制联网刷新元数据（默认走缓存优先）
```

### 实例单元（`dsh@.service`）：为什么**不能**设内存上限

`dsh@.service` 是每用户实例的模板单元，由 `dsh-web-ctl install-unit` 落盘
（唯一真源在 `bin/dsh-web-ctl` 的 `INSTANCE_UNIT_TEMPLATE`）。

它有三项看起来"多余"、其实缺一不可的设置，**改回去会复现 2026-10-19 的事故**：

| 设置 | 值 | 不这样的后果 |
|---|---|---|
| `MemoryMax` / `MemoryHigh` | **故意不设** | agent 在 bash 里起的训练任务（scANVI 等）**必然**跑在本实例的 cgroup 里（它们就是 dsh 的子进程）。一旦设了硬上限，任务顶爆即触发 cgroup OOM |
| `OOMPolicy` | `continue` | 默认 `stop`：**任意**子进程被 OOM，systemd 会把整个实例停掉 |
| `KillMode` | `process` | 默认 `mixed`：任何一次停止/重启（门户空闲回收、升级、崩溃重启）会 SIGKILL 掉 cgroup 内所有训练任务 |

三者组合出的故障链，正是用户看到的那句话：

```
scANVI 训练涨到 16G → cgroup OOM → OOMPolicy=stop 把整个实例停掉
   → 浏览器显示「DSH 进程在本轮完成前退出 / 本轮已中止」
```

因此**不要在这个单元上限制内存**：cgroup 里的进程不止 dsh 本体，把 agent 起的
重任务算在 dsh 账上，账一定算错。要限制请按用户限
（`user-<uid>.slice` 的 `MemoryHigh` —— 它只节流、不杀进程）。

`doctor` 把这三项作为**硬失败**检查（名称：`实例单元不设内存硬上限`、
`实例单元 OOM/停止不连坐`）：

```bash
dsh-web-ctl install-unit --print   # 只打印，供评审
dsh-web-ctl install-unit --diff    # 与目标机现有单元对比（有差异时退出码 1）
dsh-web-ctl install-unit           # 落盘 + daemon-reload
                                   #   已运行的实例需 dsh-web-ctl restart <user> 才吃到
```

> 代价：`KillMode=process` 意味着实例重启后训练任务会留下来继续跑，成为孤儿进程，
> 需要人工或定时清理。

### 门户的空闲回收：为什么默认 24h、为什么"有 WebSocket 就不回收"

门户（`dsh-portal`）为共享机设计：登录时按需拉起实例，空闲则停掉，避免 N 个账号
各挂一个常驻进程。判定逻辑在 `server/portal.py` 的 `reap_once()`：

| 配置 | 默认 | 含义 |
|---|---|---|
| `idle_minutes` | `1440`（24h） | 全局空闲上限。**不是 1h**：dsh 的 agent 回合可以跑很久，而"人还在用"的信号只有 HTTP 请求与 WebSocket |
| `idle_minutes_by_user` | `{}` | 按用户覆盖；`0` = **永不回收**该用户。给整天挂长任务的人用 |

**回收只在"没有 WebSocket 连接"时才会发生。** 浏览器开着页面就说明人在用（哪怕
一帧都没发、一个 HTTP 请求都没有）—— 这是修过的一个真 bug：原先只看 `last_seen`
（仅在代理 HTTP 请求时刷新），一条挂着 WS 的长回合会被中途停掉，用户看到
「本轮已中止」，而日志里只有一行 `instance stopped (idle)`。修法是活跃 WS 计数，
`_ws_enter`/`_ws_exit` 写在同一协程的 `try/finally` 里恰好配平，断开时才把
`last_seen` 刷成当前时刻（空闲从"断开"起算，而不是"握手"）。

> 代价与取舍：页面开着不放（且没有任何请求）的实例会一直不回收。这是有意选择 ——
> 误杀正在跑任务的实例，代价远大于多留一个实例。要限制内存请按用户限，别在
> `dsh@.service` 上设硬上限（见上一节）。

### 浏览器半包的两层结构（v0.10.0 起）

`lib/client.js` 拆成两层，是为了**不把鸡蛋放在 dsh 内部契约里**：

| 层 | 做什么 | 依赖 |
|---|---|---|
| 第一层（顶层立即执行） | `crypto.randomUUID` / `navigator.clipboard` 兜底 | 无 |
| 第二层（`__ModuleLoader__.load`） | `isLoopback` 改写（设置页可用性的关键） | dsh 的模块加载器 |

明文 HTTP 的 IP origin 是非安全上下文，第一层补的是**页面能不能工作**的底层能力；
第二层才需要挂进 cordis。以前两层都写在 `load()` 里 —— 上游一旦改掉
`window.__ModuleLoader__`，整个文件都不执行且无声无息（排查时会误判成「插件没生效」）。

加固点：
- loader 不可用时 `console.warn` 明确告警，第一层兜底照旧生效
- 除 `conn.isLoopback` 外，也尽力覆盖 connection 模块导出的 `isLoopbackHostname`
- 30 秒内拿不到 connection 服务时告警，不再静默放弃

排查入口：浏览器控制台看 `window.__DSH_LAN_GATE__`
（`layer1Ran` / `loaderSeen` / `applyRan` / `isLoopbackAfter` / `errors`）。

**已知不能消除的风险**：`window.__ModuleLoader__` 是 dsh 的内部契约，
上游改名时第二层会失效（第一层仍兜底）。这属于押注上游，只能在 dsh 升级后
回归「设置页能否打开」来发现。

### 出站代理：用户级，不写在单元里

插件市场的目录是 `awesome-dsh-plugin.com/plugins.json`（4.4MB）。实例是 systemd
单元，**不继承登录 shell 的代理变量**；直连时这个文件的正文传输会被拖到
**38 秒**（响应头很快，慢的是正文），超过 dsh 的 30s×2 上限 →
「插件目录加载失败」。走本机代理只要 **1.1 秒**。

dsh 自带 `@deepseek-ai/dsh-http-proxy`：**为每个 profile** 解析代理策略，
取值优先级「进程环境变量 > `$DSH_HOME/.env`」，作用域就是**该用户自己的实例进程**。
所以代理的正确位置是用户自己的 `~/.dsh/.env`：

```bash
# 每个用户按自己的需要配（这是 zeiss 目前的配置）
printf 'HTTPS_PROXY=http://127.0.0.1:7890\nHTTP_PROXY=http://127.0.0.1:7890\n' >> ~/.dsh/.env
```

单元里**只留一个开关**，不写地址——写死会压掉用户自己的 `.env`：

```
Environment=NODE_USE_ENV_PROXY=1     # Node 的 fetch(undici) 默认不读 HTTP_PROXY
```

回环由 dsh-http-proxy 内部强制绕过，不需要自己设 `NO_PROXY`。

运维可见性：`dsh-web-ctl users` 有「出站代理」列（显示每人配了什么 / 未配即直连），
`doctor` 检查单元开关是否开启、有没有误写死地址（读 `systemctl cat dsh@.service`；
模板单元的 `show -p Environment` 拿不到单元文件里写的值）。

### 安装为什么跑在 systemd 单元里

`npm install -g` 是**不可中断**的长任务：中途被杀会留下半成品 ——
旧的 `dsh` 符号链接被删、新的还没改名（残留 `.dsh-XXXXXX`），
结果就是 `dsh: command not found` + 包数不足（实测 460/651）。

所以 `update` **不把安装挂在 ssh 会话上**，也**不给它设超时上限**。
v0.6.0 起安装目标是共享运行时，跑在**系统**单元（root）里：

```
sudo systemd-run --unit=dsh-update --collect \
    --setenv=PATH=/opt/dsh/node/bin:/usr/local/bin:/usr/bin:/bin \
    /opt/dsh/node/bin/npm install -g --prefix /opt/dsh/node \
    @deepseek-ai/dsh@<tag> --no-audit --no-fund --prefer-offline
```

然后轮询单元状态（每次都是短调用）。带来两个好处：

- **Ctrl-C、断线、退出 ssh 都不会中断安装** —— 命令随时可以安全退出；
- **不需要猜任何超时数字**。想调长短都不必，安装跑多久就等多久。

> 单元必须显式给 `PATH`：`npm` 是 `#!/usr/bin/env node` 的脚本，
> 而 systemd 的环境里没有 nvm 的 PATH，否则直接退出码 127
> （`env: node: No such file or directory`）。这也正是 `dsh-web.service` 要设 PATH 的原因。

### 为什么默认 `--prefer-offline`

目标版本已经先用 `npm view` 解析过了，再让 npm 逐个包去 revalidate 元数据纯属浪费。
实测**同一棵树**：联网 revalidate 卡了 11 分钟没进展 vs 缓存优先 **22 秒**完成。
缓存冷时会自动回退到网络，所以默认开着是安全的；要强制刷新用 `--online`。

安装异常时可以脱离 CLI 直接观察：

```bash
journalctl --user -u dsh-update.service -f
```

### 更新 dsh 为什么不用重装插件

`~/.dsh/profiles/<name>/` 里两处机制保证了这点：

| 内容 | 形态 | 更新 dsh 后 |
|---|---|---|
| `@deepseek-ai/dsh-*`（约 196 个包） | `node_modules/@deepseek-ai/*` 是**符号链接** | 指向全局安装，**自动跟着变** |
| `dsh-lan-gate`（本插件） | `package.json` 里的 `file:` 依赖 | **独立**，不受更新影响 |

所以流程就是 **`npm i -g @deepseek-ai/dsh@<tag>` → 重启服务**，插件自动加载。
更新后如果行为异常，先看 `~/.dsh/logs/lan-gate.log` 有没有
`widened WebServer host schema` / `whois gate armed` 这两行——它们是插件生效的标志。

> ⚠️ 插件依赖 dsh 的内部实现（schemastery schema 结构、`internal/config`
> waterfall 钩子、`server.emit`、`isLoopbackHostname`）。**大版本升级前建议先验插件**：
> 把新版本装到临时目录检查这些点是否还在，而不是直接替换全局安装。

### 目标主机怎么来

**仓库里不写死任何主机名。** 按优先级解析：

1. `--host <host>`
2. 环境变量 `$DSH_WEB_HOST`
3. 本机配置文件 `~/.config/dsh-web-ctl/config`

三项都没有、且本机就是宿主时，自动本地执行；否则报错并给出上面三种写法。

本机配置文件（**不入库**）格式：

```ini
# ~/.config/dsh-web-ctl/config
host = my-server
plugin_repo = /path/to/dsh-lan-gate
```

### `deploy` 的源码目录

按顺序探测：

1. `--dir <路径>` 显式指定
2. `$DSH_LAN_GATE_REPO` 环境变量（指仓库根目录即可）
3. 本机配置里的 `plugin_repo`
4. 脚本同级的 `../lib`（即**在仓库副本里运行** `<repo>/bin/dsh-web-ctl deploy`）
5. 脚本同级的 `lib`（脚本被放在仓库根目录时）

装在 `~/.local/bin/` 的那份副本找不到源码（它的 `../lib` 是 `~/.local/lib`），
所以从安装副本部署时要带上 `--dir`、设好环境变量、或写进本机配置。
都没有时会打印可操作的报错，不会静默失败。

`doctor` 里最有用的一项是 **`配置 listenHost 与当前 tailnet IP 一致`** ——
配置文件把 tailnet IP 写死了，而 tailnet 重建/IP 变更后服务会绑不上，这一项会立刻报出来。

`verify` 刻意从**运行 CLI 的那台机器**当客户端发起，而不是在服务端自测 —— 这才是真实路径。

## 为什么不上 TLS

实测扫过全部客户端 bundle，明文 HTTP 下唯一还缺的只有 `navigator.clipboard`：

| API | 命中包 | 明文 HTTP 下 | 处理 |
|---|---|---|---|
| `crypto.randomUUID` | `dsh-client-ui-conversation` | 抛错 | 插件 polyfill ✅ |
| `navigator.clipboard` | `dsh-cordis-client-runner` | `undefined`，复制 session ID 静默失效 | 插件 polyfill ✅ |
| `crypto.subtle` | 无 | — | 不涉及 |
| `getUserMedia` / `mediaDevices` / `serviceWorker` / `showSaveFilePicker` / `geolocation` | 无 | — | 不涉及 |

而 TLS 的**唯一实际收益**就是把页面变成 secure context（以上两项可改用原生实现）。
**传输机密性上是零收益**：Tailscale 本身就是 WireGuard 端到端加密。

代价却很高：`100.64.0.0/10` 是 CGNAT 私有段，**公信 CA 不会为它签发证书**。于是：

| 路线 | 可信证书 | 按 IP 访问 |
|---|---|---|
| 自签证书 + IP | ❌ 每台客户端装 CA | ✅ |
| `.ts.net` + `tailscale cert` | ✅ | ❌ |
| 自有域名 + DNS-01 | ✅ | ❌ |

没有一条能同时满足「可信证书」+「按 IP 访问」。**结论：用 polyfill 换掉整套证书体系。**

## 已知边界

- **不做 TLS**（理由见上）。明文 HTTP 下 `isSecureContext=false`，靠 polyfill 兜底。
- **whois 缓存 60s**：tailnet 拓扑变化最多 60s 后才生效。
- **`/api/settings` 从 curl 直接返回 403 是正常的** —— 那是 dsh 自身
  `/api` 的 browser-trust 栅栏（校验 Origin/Referer），不是本插件的门禁。
- **tailnet IP 变化需要改配置**：`listenHost` 是写死的，`dsh-web-ctl doctor` 会检查这一项。
- API key 等凭据属用户侧配置，不在本插件范围内。
