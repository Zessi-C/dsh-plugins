# dsh 多用户门户 —— 部署件清单与缺口审计

- **审计时间**：2026-10-19 14:20–14:40 CST
- **宿主**：本机（Tailscale 宿主，门户与实例都跑在这里）
- **仓库**：`~/dsh-lan-gate`，分支 `main`，`68de414`（v0.12.0）
- **方式**：全程**只读**。root 可读文件用 `sudo -n`；未改 `/etc`、未重启任何服务、未 commit/push。
- **占位符约定**：本文遵循仓库既有约定 —— 真实 tailnet IP 记作 `<TAILNET_IP>`，
  对端节点记作 `<peer-ip>`，登录名记作 `<user-a>`/`<user-b>`/`<user-c>`。
  真实值只存在于线上机器，不入库。

---

## 0. 结论摘要

门户由 **4 个自制件**（portal.py / config.json / dsh-instance / pam.dsh-portal）
+ **3 个手工运维产物**（dsh-portal.service / npmrc / secret）
+ **2 类自动生成物**（dsh@.service、seed 目录）构成。
本次回收前，**其中 6 件在仓库里连名字都没有**。

| 判定 | 件数 | 说明 |
|---|---|---|
| 已在仓库（含真源在仓） | 3 类 | 仓库自身的 `bin/ lib/ deploy/ probe/`、`dsh@.service`（真源 = CLI 模板）、`/opt/dsh/share/dsh-lan-gate`（= 仓库内容，sha256 逐一相同） |
| 本次回收入 `server/` | 5+1 件 | 见 §4；`portal.py` 由另一个负责人（portal-dev）并行回收 |
| 仓库当前缺口（该入仓但还没有） | **12 条** | 见 §5 |
| 绝不能入仓 | **9 类** | 见 §6 |
| 本次排查发现的问题条目 | **7 条** | 见 §7（其中 G-2/G-5 是任务提示项的实测结论，G-1/G-3/G-4/G-6/G-7 为提示之外新发现） |

**最高优先级两条**（都会在"看起来很健康"的状态下静默失效）：

1. `portal.py` 全机单点、无源、无备份（§3）—— 丢失即门户需重写。
2. 共享 `npmrc` 的 ACL 授权对象是一个**不存在的 uid**，普通用户根本读不到它，
   npm 静默回落到公共 registry；而 `dsh-web-ctl doctor` 的对应检查项**仍显示通过**（§7 G-1）。

---

## 1. 排查范围与方法

```sh
# 已知路径逐件统计（路径/大小/mtime/权限/属主）
sudo -n stat -c '%n|%s|%y|%a|%U:%G' <每个部署件>

# 全盘找 portal.py（重点复核单点结论）
sudo -n find /opt /etc /usr/local /srv /root /home /data -maxdepth 6 -name portal.py
sudo -n find / -xdev -name 'portal*' -not -path '*/proc/*'     # 连 portal.py.* / *.bak 一起找

# 主动找"仓库完全没提到"的东西
sudo -n find /etc -iname '*dsh*'
ls -la /usr/local/bin /usr/local/sbin /home/*/.local/bin
sudo -n ls -la /etc/cron.d/ ; sudo -n crontab -l ; crontab -l ; sudo -n ls /var/spool/cron/crontabs/
systemctl list-timers --all ; systemctl list-unit-files | grep -iE 'dsh|portal'
ls -la /etc/logrotate.d/ ; sudo -n grep -ril dsh /etc/logrotate.d/
getfacl -n /opt/dsh/node /opt/dsh/node/etc/npmrc /opt/dsh/share/dsh-lan-gate
tailscale serve status ; sudo -n ss -ltnp
```

### 1.1 排查过、确认"没有"的地方

| 查了什么 | 结果 |
|---|---|
| `/usr/local/bin` 下 dsh 相关脚本 | **无**（9 个文件：cellsnp-lite/gh/knock/mihomo/mihomo.bak/seqkit/tailscale-keepalive.sh/update-mihomo-config.sh/wcurl） |
| `/usr/local/sbin` | **无** dsh 相关（`cgroup-owner-fix.sh`、`cleanup_rstudio_sessions.sh`、`pkg-update`） |
| `~/.local/bin` | 只有 `dsh-web-ctl`（仓库安装副本，sha256 与仓库一致）；其余用户家目录下无 dsh 脚本 |
| cron（`/etc/cron.d`、`/etc/crontab`、root/普通用户 crontab） | **无任何 dsh 相关任务**（root 只有 RStudio 清理；`<user-a>` 只有 mihomo/tailscale 保活） |
| systemd timer | 19 个，**无 dsh 相关** |
| 日志轮转 | `/etc/logrotate.d/` **无 dsh-portal**；portal.py 自身也不轮转 → **缺口**（§7 G-2） |
| 反向代理 | **无 nginx / caddy / apache**；`tailscale serve status` = `No serve config` |
| `/srv` | 空目录 |
| `/data` | 数据盘挂载点，无 dsh 件 |
| Docker | 4 个容器（open-notebook×2、filestash、natfrp），**均与 dsh 无关** |
| `/run` | 无 dsh 运行时文件（pid/lock/socket 均无） |
| `/root` | 无 portal 源码、无安装脚本、`.bash_history` 仅 121 B 且无 portal 记录 |
| `/var/backups` | 无 dsh 件 |
| `~/.config/dsh-web-ctl/config` | **不存在**（CLI 因此走"本机即宿主"分支） |

---

## 2. 完整清单

> "入仓"= 仓库里目前有没有这份文件的**内容**（或能再生它的真源）。
> "私值"= 是否含本机个人化值（tailnet IP / 登录名 / 节点名 / 密钥 / 主机名）。

### 2.1 systemd 单元

| ID | 路径 | 大小 | mtime | 来源 | 已入仓 | 含私值 | 丢失风险 |
|---|---|---|---|---|---|---|---|
| D-01 | `/etc/systemd/system/dsh-portal.service` | 597 B | 2026-09-24 17:27:54 | 手写（仓库 `deploy/` 无对应；`deploy/dsh-web.service` 是已废弃的 user unit，不是它） | ❌ → 本次入 `server/` | 否 | **中**：仅此一份，重装即丢 |
| D-02 | `/etc/systemd/system/dsh@.service` | 2621 B | 2026-10-19 14:09:23 | `dsh-web-ctl install-unit` 生成 | ✅ 真源 = `bin/dsh-web-ctl` 内 `INSTANCE_UNIT_TEMPLATE` | 否 | 低（可再生成） |
| D-03 | `/etc/systemd/system/dsh@.service.bak-20261019-123735` | 1525 B | 2026-09-25 10:55 | `install-unit` 自动备份（CLI 第 1471 行逻辑） | ❌ | 否 | 低；但**事故前唯一历史证据**（含 `MemoryMax=16G`） |
| D-04 | `/etc/systemd/system/dsh@.service.bak-20261019-124737` | 1821 B | 2026-10-19 12:37 | 同上（中间态 `MemoryMax=128G`） | ❌ | 否 | 低 |
| D-05 | `/etc/systemd/system/dsh@.service.bak-20261019-140141` | 1982 B | 2026-10-19 12:47 | 同上（开始移除 MemoryMax） | ❌ | 否 | 低 |
| D-06 | `/etc/systemd/system/dsh@.service.bak-20261019-140923` | 2375 B | 2026-10-19 14:01 | 同上（加 `KillMode=process`） | ❌ | 否 | 低 |
| D-07 | `/etc/systemd/system/multi-user.target.wants/dsh-portal.service` | 38 B（symlink） | 2026-09-24 21:23 | `systemctl enable` | ❌（状态未文档化） | 否 | 低（可 `enable` 恢复） |

### 2.2 门户本体与配置

| ID | 路径 | 大小 | mtime | 来源 | 已入仓 | 含私值 | 丢失风险 |
|---|---|---|---|---|---|---|---|
| D-08 | `/opt/dsh-portal/portal.py` | 54 036 B | 2026-09-27 12:26:53 | **来源不明**：无源目录、无备份、无 git 历史、无独立 GitHub 仓库（§3） | ❌ → portal-dev 并行回收 | 否（纯 stdlib，配置全外置） | **极高：单点，丢失=门户重写** |
| D-09 | `/etc/dsh-portal/config.json` | 526 B | 2026-09-24 21:23:55 | 手写 | ❌ → 本次去个人化入 `server/config.example.json` | **是**：tailnet IP ×3 处 | 中（可由去个人化版 + 本机 IP 重建） |
| D-10 | `/etc/dsh-portal/secret` | 65 B | 2026-09-24 17:31:07 | portal.py 首启 `secrets.token_hex(32)` 自动生成 | ❌ **且不得入仓** | **是**：会话签名密钥 | 低：丢失自动重建，代价 = 全体会话 cookie 失效 |
| D-11 | `/etc/dsh-portal/`（目录） | 4 KB | 2026-09-24 17:31 | portal.py `makedirs` / 手工 | ❌ | 否 | 低 |

### 2.3 实例入口、PAM、共享运行时

| ID | 路径 | 大小 | mtime | 来源 | 已入仓 | 含私值 | 丢失风险 |
|---|---|---|---|---|---|---|---|
| D-12 | `/opt/dsh/bin/dsh-instance` | 962 B | 2026-09-25 10:56:26 | 手写 wrapper（`dsh@.service` 的 `ExecStart`） | ❌ → 本次入 `server/` | 否 | **高**：实例唯一入口，端口公式与 `config.json` 强耦合 |
| D-13 | `/opt/dsh/node/etc/npmrc` | 290 B | 2026-09-24 21:23:02 | 手写 | ❌ → 本次入 `server/` | 否（仅公开镜像 + loopback 代理示例） | 中；**但当前 ACL 失效**（§7 G-1） |
| D-14 | `/etc/pam.d/dsh-portal` | 405 B | 2026-09-24 17:27:54 | 照 `/etc/pam.d/rstudio` 手写 | ❌ → 本次入 `server/` | 否 | **高**：缺它门户登录全挂 |
| D-15 | `/opt/dsh/node`（整棵，共享 Node 运行时） | 1.1 GB | 2026-09-24 21:22 | `npm install -g --prefix /opt/dsh/node`（README §部署） | ❌（可再生） | 否 | 低：可重装（node v26.10.0 / dsh 0.2.1-rc.2） |
| D-16 | `/opt/dsh/share/dsh-lan-gate/`（seed：`package.json` `lib/index.js` `lib/client.js` `cordis.patch.yml`） | 1 204 / 1 883 / 13 307 / 373 B | 2026-10-19 14:10 / 2026-09-27 12:29 | `dsh-web-ctl deploy` 从仓库拷贝 | ✅ **内容 = 仓库，sha256 四件逐一相同**，版本 0.12.0，无漂移 | 否 | 低 |

### 2.4 日志

| ID | 路径 | 大小 | mtime | 来源 | 已入仓 | 含私值 | 丢失风险 |
|---|---|---|---|---|---|---|---|
| D-17 | `/var/log/dsh-portal/`（目录，0755 root:root） | 4 KB | 2026-09-24 17:27 | portal.py 自建 | ❌ | 否 | 低 |
| D-18 | `/var/log/dsh-portal/access.log`（**0644 全机可读**） | 327 334 B / 2 326 行 | 2026-10-19 13:57:41 | portal.py 运行产出 | ❌（日志不入仓） | **是**：登录名、tailnet 对端 IP、访问路径 | 低（可再生）**但无轮转 = 无限增长**（§7 G-2/G-3） |

日志内容抽样（`"msg"` 计数）：`session bootstrap` 939、`upstream error` 871、`instance start` 162、
`login ok` 46、`login failed` 2、`login denied (account)` 13、`rejected unrecognized host` 14、
`seeding client shim` 3。含 `"ip": "<peer-ip>"` 字段（至少 3 个不同 tailnet 对端）。

### 2.5 用户侧（不入仓，但属于"部署面"）

| ID | 路径 | 大小 | mtime | 来源 | 已入仓 | 含私值 | 丢失风险 |
|---|---|---|---|---|---|---|---|
| D-19 | `~/.dsh/profiles/web/cordis.patch.yml`（每个用户一份真实 patch） | 6 525 B（`<user-a>`） | 2026-10-19 14:20:54 | 手写 / 沿 `deploy/cordis.patch.example.yml` | ❌（`.gitignore` 显式排除 `deploy/cordis.patch.yml`） | **是**：tailnet IP / 登录名 / 节点名 | 中：每个用户各自一份，无中心副本 |
| D-20 | `/home/*/.dsh/`（DSH_HOME 目录） | — | — | dsh 首启自建 | ❌ | 否 | 低 |
| D-21 | `/home/*/.dsh/.credentials.yaml`（0600） | 161 B（`<user-b>`） | 2026-10-01 | dsh 自建（cookie 签名密钥持久化处） | ❌ **不得入仓** | **是**：凭据 | 低：丢失需重新登录 |
| D-22 | `~/.dsh/logs/`（0600/0640） | 6 个文件，约 70 KB | 2026-10-17 | dsh 运行产出 | ❌（`.gitignore` 排除 `*.log`） | 是（会话/启动详情） | 低 |
| D-23 | `~/.local/bin/dsh-web-ctl`（CLI 安装副本） | 72 433 B | 2026-10-19 14:09 | 从仓库拷贝 | ✅ 内容 = 仓库（sha256 一致） | 否 | 低 |

### 2.6 仓库自身（7 类）

| ID | 内容 | 大小 | 已入仓 | 说明 |
|---|---|---|---|---|
| D-24 | `bin/dsh-web-ctl` | 72 433 B | ✅ | 运维 CLI；**`dsh@.service` 的唯一真源**，内含 `PORTAL_*`/`SHARED_NODE`/`WRAPPER`/`SEED_DIR` 全部服务端约定 |
| D-25 | `lib/index.js` `lib/client.js` `cordis.patch.yml` `package.json` | 1 883 / 13 307 / 373 / 1 204 B | ✅ | 浏览器半包；与 `/opt/dsh/share/dsh-lan-gate` 逐字节相同 |
| D-26 | `deploy/dsh-web.service` | 960 B | ✅ | 已废弃 user unit（被门户架构取代） |
| D-27 | `deploy/cordis.patch.example.yml` | 969 B | ✅ | 真实 patch 的去个人化示例 |
| D-28 | `probe/*` | 8 个文件 | ✅ | 一次性探针（仅覆盖浏览器半包，**无 portal.py 测试**） |
| D-29 | `docs/settings-page-on-tailnet-ip.png` | 73 559 B | ✅ | 截图证据 |
| D-30 | `README.md` | 23 060 B | ✅ | 未提及 portal.py 的存在，也未提及 §2.1–2.4 的任何一件 |

---

## 3. `portal.py` 单点复核（已知结论复核）

| 复核项 | 命令 | 结果 |
|---|---|---|
| 全盘是否只有一份 | `sudo -n find /opt /etc /usr/local /srv /root /home /data -maxdepth 6 -name portal.py` | **只有 `/opt/dsh-portal/portal.py`** |
| 有无 `portal.py.bak-*` / `portal*.py` 变体 | `sudo -n find / -xdev -name 'portal*'` | 命中的全是无关第三方（conda `libpq` 头文件、pytorch `skip/portal.py`、awscli 示例、docker overlay 里的 `portalocker`）→ **无备份、无变体** |
| 有无源目录 | 全盘无任何含门户源码的目录；`/root`、`/srv`、`/data`、`/var/backups` 均无 | **无** |
| 是否曾入过本仓库 | `git log --all --name-only \| grep -i portal` | **空：仓库历史里从未出现 `portal.py` 或 `server/`** |
| 有无独立 GitHub 仓库 | 本地仅 `origin = https://github.com/Zessi-C/dsh-plugins/tree/main/packages/dsh-lan-gate.git`；该仓库历史中无 portal.py | **无**（注：本次审计环境无法访问 web 搜索，此条为本地证据判定，未做在线二次确认） |
| 可复现性 | 运行时依赖：`/usr/bin/python3` 3.12.3 + `python3-pam` 0.4.2-18build2（apt）；代码仅用 stdlib | 依赖少、可读，但**代码本身无副本** |

**结论：已知结论成立 —— `portal.py` 全机只有一份，无源目录、无备份、从未入仓、无独立远端仓库。
它是整个门户唯一的"不可再生件"：`config.json`/`secret`/单元/包装脚本都能重建，它不能。**

安全与运行时事实（供接手人参考，非本人写权限）：

- sha256 = `aa676d099fdeb1aff780944568c12cb7cf49969c78214aedd89e02cd46be2526`，54 036 B / 1 200+ 行，`0755 root:root`。
- 进程以 **root** 运行（PAM 读 shadow + `systemctl` 起他人单元），`Restart=on-failure`。
- 监听 `<TAILNET_IP>:3080`（`ss -ltnp` 确认无中间转发进程；无反代、无 `tailscale serve`）。
- `access.log` 由 portal 自己写（`makedirs` + 追加），**不做任何轮转或截断**。
- 已在跑的实例：`dsh@<user-a>.service`，端口 `42000 + uid`（uid 1001 → **43001**，`ss` 实测吻合）。
- 当前运行时长 1 天 17 小时，内存 51.1 MB。

---

## 4. 本次回收入 `server/` 的 6 件

| 仓库文件 | 目标路径 | 权限 | 处理方式 | sha256（入库实测） |
|---|---|---|---|---|
| `server/dsh-portal.service` | `/etc/systemd/system/dsh-portal.service` | 0644 root:root | 逐字节复制 | `d2d29f46…913d0e0` |
| `server/dsh-instance` | `/opt/dsh/bin/dsh-instance` | 0755 root:root | 逐字节复制 | `cd39fcbd…c951b` |
| `server/pam.dsh-portal` | `/etc/pam.d/dsh-portal` | 0644 root:root | 逐字节复制 | `e0cb9969…f3f922` |
| `server/config.example.json` | `/etc/dsh-portal/config.json` | 0640 root:root | **去个人化**生成 | （非逐字节复制） |
| `server/npmrc` | `/opt/dsh/node/etc/npmrc` | 0640 root:root | 逐字节复制 | `2c263454…f8b758` |
| `server/README.md` | —（文档） | — | 落盘对照 + 装机顺序 | — |
| `server/portal.py` | `/opt/dsh-portal/portal.py` | 0755 root:root | **由 portal-dev 负责，本批未碰** | — |

### 4.1 `config.example.json` 去个人化自查

唯一改动 = 把真实 tailnet IP 换成占位符：

| 键 | 线上真实值类型 | 入库值 |
|---|---|---|
| `bind` | `<TAILNET_IP>` | `"<TAILNET_IP>"` |
| `public_authorities[0]` | `<TAILNET_IP>:3080` | `"<TAILNET_IP>:3080"` |
| `public_authorities[1]` | `<TAILNET_IP>` | `"<TAILNET_IP>"` |
| `bind_extra` | `[]` 或 `["127.0.0.1"]` | `[]`（入库保持空；`127.0.0.1` 是回环，不算泄密但入库无意义） |

自查结论：

- ✅ 无任何 IPv4/IPv6 字面量（正则扫全文，`0` 命中；`port`/`uid`/`seconds` 等纯数字除外）
- ✅ 无邮箱（`@` 0 命中）、无主机名、无登录名、无节点名
- ✅ 无 secret、无 token、无密码字段；`secret_file` 只留**路径**
- ✅ 保留线上路径约定：`/etc/dsh-portal/secret`、`/var/log/dsh-portal/access.log`、`backend_port_base=42000`、`pam_service=dsh-portal`
- ✅ JSON 合法、无注释、键序与线上一致（portal.py 严格 `json.load`，不能带注释）
- ✅ `public_authority: null`、`allow_users: []` 等空值原样保留（语义：不强制改写 authority / 允许全体普通用户）

其余 4 件逐字节复制的文件也已核对**不含** private 值：
`dsh-portal.service`（只有路径 + 公开 GitHub URL）、`dsh-instance`（只有 `127.0.0.1` 与端口公式）、
`pam.dsh-portal`（只有 PAM 栈名）、`npmrc`（只有公开镜像 + `127.0.0.1:7890` loopback 示例）。

---

## 5. 清单 A —— 仓库当前缺口（该入仓但还没有）

| # | 缺口 | 现状 | 建议归属 | 严重度 |
|---|---|---|---|---|
| A-1 | `/opt/dsh-portal/portal.py` 无任何副本 | 全机单点、无源、无备份 | `server/portal.py`（portal-dev 并行） | **P0** |
| A-2 | `/etc/pam.d/dsh-portal` 无副本 | 手写，缺它登录全挂 | `server/pam.dsh-portal`（本次已入） | P1 |
| A-3 | `/opt/dsh/bin/dsh-instance` 无副本 | 手写 wrapper，`ExecStart` 直接引用 | `server/dsh-instance`（本次已入） | P1 |
| A-4 | `/etc/systemd/system/dsh-portal.service` 无副本 | 手写 | `server/dsh-portal.service`（本次已入） | P1 |
| A-5 | `/etc/dsh-portal/config.json` 无副本 | 含真实 tailnet IP | `server/config.example.json`（本次已入） | P1 |
| A-6 | `/opt/dsh/node/etc/npmrc` 无副本 | 手写 | `server/npmrc`（本次已入） | P2 |
| A-7 | **系统依赖 `python3-pam` 未声明** | 仓库 README/CLI 依赖里都没有；缺它 portal.py 直接 `sys.exit` | 新增 `server/README.md` 已记；建议再进 `README.md` 依赖段 | **P1** |
| A-8 | **logrotate 配置不存在** | `/etc/logrotate.d/` 无 dsh-portal；portal 自身不轮转 | 需新写并入 `server/`（本次仅记录，未造文件——不在我的写范围内） | **P1** |
| A-9 | 启用状态（`systemctl enable` 符号链接）未文档化 | 只装 unit 文件不会开机自启 | `server/README.md` 已写装机顺序 | P2 |
| A-10 | 目录/权限约定未成文 | `0755 /etc/dsh-portal`、`0640 config.json`、`0600 secret`、`0755 /var/log/dsh-portal`、ACL 约定 | `docs/deployment-inventory.md` §8（本文） | P2 |
| A-11 | `dsh@.service.bak-*` 4 份无主备份无清理/归档策略 | 散落 `/etc`，含事故前后状态 | 建议 `dsh-web-ctl install-unit` 保留最近 N 份，或归档到 `docs/incidents/` | P3 |
| A-12 | `portal.py` 零测试覆盖 | `probe/` 只覆盖浏览器半包 | portal-dev 已在加 `probe/portal-idle.spec.py`（工作区已见未跟踪文件） | P2 |

> 说明：`dsh@.service` 本身**不是**缺口 —— 它的真源已在 `bin/dsh-web-ctl`，属于"产物不入仓"的正确设计。

## 6. 清单 B —— 绝不能入仓

| # | 路径 / 内容 | 理由 | 现状保护 |
|---|---|---|---|
| B-1 | `/etc/dsh-portal/secret` | 会话 cookie 的 HMAC 签名密钥；入仓 = 任何人可伪造登录态 | `0600 root:root`；本批未复制 |
| B-2 | `/home/*/.dsh/.credentials.yaml` | dsh 凭据（cookie 签名密钥等） | `0600`；`.gitignore` 已排除 `.credentials.yaml` |
| B-3 | `/home/*/.dsh/.env` | 含 `HTTPS_PROXY` 等本机地址/凭据 | `.gitignore` 排除 `.env` |
| B-4 | `~/.dsh/profiles/web/cordis.patch.yml` | 真实 tailnet IP / 登录名 / 节点名白名单 | `.gitignore` 排除 `deploy/cordis.patch.yml`（**注意：只排除了 deploy/ 下那个名字**） |
| B-5 | `~/.config/dsh-web-ctl/config`（若存在） | 目标主机名 / 插件仓库绝对路径 | `.gitignore` 未显式排除此路径 —— 靠"在 `~/.config` 不在仓库"兜底 |
| B-6 | `/var/log/dsh-portal/access.log` | 登录名 + tailnet 对端 IP + 访问路径 + 失败登录 | `.gitignore` 排除 `*.log`、`logs/` |
| B-7 | `~/.dsh/logs/**` | 会话/启动详情 | 同上 |
| B-8 | `/etc/dsh-portal/config.json` 的**真实值** | tailnet IP；入仓必须用 `server/config.example.json` 的形式 | 本次只入占位版 |
| B-9 | dsh 的 `sessions/`、`storages/` | 会话与存储数据可能含对话内容 | `.gitignore` 已排除 |

---

## 7. 本次排查新发现的问题（7 条）

> G-2（日志轮转）与 G-5（目录权限约定）是任务里点名要查的项，这里给出实测结论；
> **G-1 / G-3 / G-4 / G-6 / G-7 是点名清单之外新发现的**，其中 G-1 最隐蔽。

### G-1 ⚠️ 共享 npmrc 的 ACL 指向不存在的 uid —— 检查项假阳性（**功能性**）

- `/opt/dsh/node` 与 `/opt/dsh/node/etc` 带**继承 ACL**，授权对象是 `user:998`。
- 本机 **uid 998 不存在**；998 是 **`docker` 组的 gid**（`getent group docker` → `docker:x:998:<user-a>,user`）。
  即：安装时把"组"误写成了"用户"（`setfacl -m u:998:...` 而不是 `g:docker:...`），该 ACL 项**永久失效**。
- 实测后果：
  - `<user-b>`、`<user-c>` 读不到 `/opt/dsh/node/etc/npmrc`（`test -r` 失败）；
  - `npm config get globalconfig` → `/opt/dsh/node/etc/npmrc`，但 `npm config get registry`
    → **`https://registry.npmjs.org/`**（共享配置里的 npmmirror **被静默忽略**，无警告）。
  - 唯一还能读到它的是 root，以及**在 `root` 组里的账号**（`<user-a>` 恰好在，所以"看起来正常"）。
- 影响路径真实存在：portal 首次登录给用户 seed shim 时会 `setuid` 到该用户再跑
  `dsh plugin add`（`/opt/dsh-portal/portal.py` 的 `demote()`），npm 就在普通用户身份下执行。
- 为什么没被发现：`dsh-web-ctl doctor` 的「共享 npmrc（npmmirror + maxsockets）」项
  以 root/sudo 身份检查"文件存在 + 有 maxsockets" → **永远通过**。
- 建议：`setfacl` 改 `g:docker` 或直接用可继承的组权限；`doctor` 增加"以普通用户身份实读 npmrc"的检查。

### G-2 ⚠️ 门户访问日志无轮转（**容量 + 合规**）

- `/etc/logrotate.d/` 无 dsh-portal；`portal.py` 内无任何 rotate/truncate/size 逻辑。
- 现状：25 天 2 326 行 / 327 KB → 约 **12.8 KB/天、4.6 MB/年**（当前量级不紧迫，但**无上限**；
  一旦被刷登录或访问量上来就是无限增长，且无任何告警）。
- 关联：`/var/log/dsh-portal/` 目录也是手工/自建，没有 `tmpfiles.d` 或 logrotate 负责创建与重建。

### G-3 ⚠️ 日志权限 0644 全机可读（**横向信息暴露**）

- `/var/log/dsh-portal/access.log` = `-rw-r--r-- root root`：**这台多用户机器上任何用户都能读**。
- 内容含全部用户的登录名、tailnet 对端 IP、失败登录尝试（`login failed` / `login denied`）、
  访问路径。即用户 A 能看到用户 B 何时从哪个 tailnet 节点登录、何时失败。
- 建议：`0640 root:adm`（或专用组），并由 logrotate 固化该权限。

### G-4 ⚠️ 系统依赖未声明（**装机即坏**）

- `python3-pam`（apt，0.4.2-18build2）是 portal.py 的硬依赖，缺失时
  `sys.exit("dsh-portal: 缺少 python3-pam（apt install python3-pam）")`，门户根本不启动。
- 仓库里**没有任何地方**写下这条依赖（README 依赖段、`dsh-web-ctl doctor` 有 `PY_PAM` 检查但仓库外的机器无从得知）。
- 建议：README 增加"宿主依赖：`python3-pam`"一行；`server/README.md` 已补（本次）。

### G-5 `DSH_HOME` 目录权限不统一（**约定缺失**）

- `/home/<user-b>/.dsh` = `0755`，而 `/home/<user-a>/.dsh`、`/home/<user-c>/.dsh` = `0700`。
- 0755 那份目录下 `.anonymous-user-id` 是 `0644` → 全机可读；`.credentials.yaml` 仍 0600，未直接泄密，
  但**没有任何入口强制 DSH_HOME 权限**（portal 建目录、dsh 首启、手工创建三条路径各写各的）。
- 建议：把 `0700 $DSH_HOME` 写进部署约定（`server/README.md` 的目录权限段）。

### G-6 上游错误噪声无人消费（**可观测性**）

- 25 天里 `upstream error` 871 次、`session bootstrap failed` 41 次、`instance unavailable` 21 次，
  全部只落 `access.log`，无任何监控/告警；日志再一被删就彻底断案。
- 建议：与 G-2 的轮转一起做，至少保留 N 天并可 grep。

### G-7 `/etc` 下 4 份无主 `.bak-*` 单元的漂移风险（**运维卫生**）

- `dsh@.service.bak-20261019-*` ×4 由 CLI 自动生成，命名、位置、保留策略都不在仓库文档里；
  新人若 `systemctl cat dsh@.service` 看错文件，或误把 `.bak` 当成回滚源，会重现
  `MemoryMax=16G` 那类事故（这 4 份里**恰好有一份就是 16G 版本**）。
- 注：这也说明"唯一真源在 CLI"的设计是对的 —— 但**备份的清理**没有设计。

### 观察项（非缺口）

- `dsh-instance` 里 `PATH="/opt/dsh/node/bin:..."`，而 `dsh@.service` 的 `Environment=PATH` 已含
  `/opt/dsh/node/bin` → 实例进程 PATH 里该目录出现两次。无害，记录备查。
- 门户无 TLS 是 README 已论证的设计选择（Tailscale 自身 WireGuard 加密）；
  同时**没有任何反代**（无 nginx/caddy、`tailscale serve` 无配置），3080 直接监听 tailnet IP ——
  与 README「无中间转发进程」一致，属**确认**而非缺口。

---

## 8. 附录：约定的目录与权限矩阵（本文压实，供装机复核）

| 路径 | 期望权限 | 期望属主 | 谁创建 |
|---|---|---|---|
| `/etc/systemd/system/dsh-portal.service` | `0644` | `root:root` | 人工（`server/dsh-portal.service`） |
| `/etc/systemd/system/dsh@.service` | `0644` | `root:root` | `dsh-web-ctl install-unit` |
| `/etc/dsh-portal/` | `0755` | `root:root` | 人工 / portal.py `makedirs` |
| `/etc/dsh-portal/config.json` | `0640` | `root:root` | 人工（`server/config.example.json` 去个人化后落盘） |
| `/etc/dsh-portal/secret` | `0600` | `root:root` | portal.py 首启自动生成 |
| `/opt/dsh-portal/portal.py` | `0755` | `root:root` | 人工（`server/portal.py`） |
| `/opt/dsh/bin/dsh-instance` | `0755` | `root:root` | 人工（`server/dsh-instance`） |
| `/etc/pam.d/dsh-portal` | `0644` | `root:root` | 人工（`server/pam.dsh-portal`） |
| `/opt/dsh/node/`（共享运行时） | `0755` + 可继承 ACL | `root:root` | `npm install -g --prefix` |
| `/opt/dsh/node/etc/npmrc` | `0640` | `root:root` | 人工（`server/npmrc`）；**当前 ACL 失效，见 G-1** |
| `/opt/dsh/share/dsh-lan-gate/` | `a+rX`（`0755`/`0755`/`0644`） | `root:root` | `dsh-web-ctl deploy`（v0.11.2 起强制 `chmod -R a+rX`） |
| `/var/log/dsh-portal/` | `0755`（建议 `0750 root:adm`） | `root:root` | portal.py `makedirs`；**无人负责重建/轮转，见 G-2** |
| `/var/log/dsh-portal/access.log` | 当前 `0644` → **建议 `0640 root:adm`** | `root:root` | portal.py 追加写，见 G-3 |
| `~/.dsh/` | `0700`（当前不一致，见 G-5） | 用户本人 | dsh 首启 |
| `~/.dsh/logs/` | `0700` | 用户本人 | dsh 运行产出 |

### 链路与端口（实测）

```
浏览器 ──<TAILNET_IP>:3080──► dsh-portal（root，python3，PAM 登录 + 反代 + 审计）
                                │  无 TLS、无中间反代（Tailscale 自带 WireGuard 加密）
                                └─► 127.0.0.1:(42000 + uid)  每用户 dsh 实例
                                       dsh@<user>.service ─ ExecStart=/opt/dsh/bin/dsh-instance
                                       dsh 0.2.1-rc.2 on /opt/dsh/node (node v26.10.0)
```

- `42000` 是 `config.json:backend_port_base` 与 `dsh-instance:DSH_INSTANCE_PORT` 的**共同约定**，改一处必须改两处
  （`dsh-web-ctl doctor` 有「端口公式一致」检查项）。
- 实测：`dsh@<user-a>.service`（uid 1001）→ `127.0.0.1:43001`；门户 `PID 3782036` 监听 `<TAILNET_IP>:3080`。
- 私钥/密钥落点：`/etc/dsh-portal/secret`（会话签名）、`~/.dsh/.credentials.yaml`（每用户）。

---

## 9. 复现本审计

```sh
sudo -n stat -c '%n|%s|%y|%a|%U:%G' \
  /etc/systemd/system/dsh-portal.service \
  /etc/dsh-portal/config.json /etc/dsh-portal/secret \
  /opt/dsh-portal/portal.py /opt/dsh/bin/dsh-instance \
  /opt/dsh/node/etc/npmrc /etc/pam.d/dsh-portal \
  /var/log/dsh-portal/access.log

sudo -n find /opt /etc /usr/local /srv /root /home /data -maxdepth 6 -name portal.py
sudo -n find /etc -iname '*dsh*'
git -C ~/dsh-lan-gate log --all --name-only --pretty=format: | grep -i portal   # 应为空
ls -la /etc/logrotate.d/ | grep -i dsh                                                    # 应为空
getfacl -n /opt/dsh/node/etc/npmrc                                                        # 看 user:998
sudo -n -u <user-b> test -r /opt/dsh/node/etc/npmrc; echo $?                              # 1 = 读不到
sudo -n -u <user-b> env PATH=/opt/dsh/node/bin:/usr/bin:/bin npm config get registry      # npmjs.org = 回落
```
