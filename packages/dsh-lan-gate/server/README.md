# `server/` —— 服务器端部署件（从线上机器回收入库）

本目录是**线上真源的回收入库**：这些文件原先只存在于这台门户宿主上，
仓库里没有任何副本。每份文件的目标落盘路径、权限与来源如下。

> 本目录里的文件是**只读参考 + 装机源**，不是运行目录。
> 真正生效的永远是 `/etc`、`/opt` 下那一份；改仓库不会改线上（反之亦然）。
> 落盘用 `dsh-web-ctl install`；想知道线上有没有被手改过，用 `dsh-web-ctl install --check`
> （sha256 比对，有差异退出码 1）。**本文件不再手工维护 sha256** —— 它一改就过期。

## 落盘对照表

| 仓库文件 | 目标路径 | 权限 | 来源 |
|---|---|---|---|
| `server/portal.py` | `/opt/dsh-portal/portal.py` | `0755` | `/opt/dsh-portal/portal.py`（线上唯一实现） |
| `server/dsh-portal.service` | `/etc/systemd/system/dsh-portal.service` | `0644` | 线上逐字节复制 |
| `server/dsh-instance` | `/opt/dsh/bin/dsh-instance` | `0755` | 线上逐字节复制 + `umask 077` |
| `server/pam.dsh-portal` | `/etc/pam.d/dsh-portal` | `0644` | 线上逐字节复制 |
| `server/config.example.json` | `/etc/dsh-portal/config.json` | `0640` | 由线上 config **去个人化**生成（见下） |
| `server/npmrc` | `/opt/dsh/node/etc/npmrc` | `0644` | 线上逐字节复制 |
| `server/logrotate.dsh-portal` | `/etc/logrotate.d/dsh-portal` | `0644` | 新建（线上原先没有任何轮转配置） |

### 唯一需要人工填值的文件

`config.example.json` 里只剩两个占位符，落盘前必须替换：

- `bind` → 本机 tailnet IP（`<TAILNET_IP>`）
- `public_authorities[]` → 同一个 IP 的两种 authority（`<TAILNET_IP>:3080`、`<TAILNET_IP>`）

### `bind_extra` —— 额外监听地址（可选，默认 `[]`）

`bind` 只能填一个地址，可有些场景需要**同时**听两个：主 `bind` 是 tailnet IP
（给别的设备用），而本机浏览器想走 `http://127.0.0.1:3080`。这时加：

```json
"bind_extra": ["127.0.0.1"]
```

- 每个额外地址起一个 `asyncio.start_server`，**共用同一个 handler 和同一个 Portal 实例**，
  会话、失败计数、锁定期、空闲回收全部共享（不是多进程）。
- 额外地址与主 `bind` 一样进受信 authority 集合（`addr` 与 `addr:port`，`port` 跟主配置走，
  不硬编码端口号）。
- 某个额外地址绑不上（地址不存在、被占用）只记 `warn` 日志，**不影响主监听**。
- 只填回环或内网地址。它和 `public_authorities` 的区别很重要：
  `public_authorities` 只是**放宽 Host 校验**，而 Host 校验正是反 DNS 重绑定的防线
  （见 `authority_ok()` 上的注释）——只为让 `127.0.0.1` 能打开就去改它是**错的**，
  因为那会让任意 Origin 在回环端口上通过校验。`bind_extra` 是**真的在那个地址上监听**，
  Host 校验仍只认"我们实际绑定的地址"。

其余键保留线上约定路径，**不要**改：

- `secret_file = /etc/dsh-portal/secret`（0600，由 portal.py 首启自动生成，**绝不入仓**）
- `log_file = /var/log/dsh-portal/access.log`
- `backend_port_base = 42000` ⇄ `dsh-instance` 里的 `42000 + uid` **必须一致**
- `pam_service = dsh-portal` ⇄ 本目录的 `pam.dsh-portal` 必须落成 `/etc/pam.d/dsh-portal`

## 系统依赖

| 依赖 | 用途 | 缺了会怎样 |
|---|---|---|
| `python3-pam`（apt `python3-pam`） | 门户用 PAM 校验 Linux 账号密码 | portal.py 直接 `sys.exit`，门户**拒绝启动**；`doctor` 的「python3-pam 可用」会报红 |
| `git`（可选） | `dsh-workspace-changes` 用 git 快照统计每轮改了哪些文件 | 仍能列出文件工具改过的文件，只是没有 git 级的增删行数 |
| `node` ≥ 26 | 实例运行时（`/opt/dsh/node`，共享一份） | 实例起不来；`doctor` 的「共享运行时 dsh」会报红 |

## 装机顺序（新机器 / 迁移）

```sh
# 0) 系统依赖（仓库此前未声明；缺它门户直接拒绝启动）
sudo apt-get install -y python3-pam

# 1) 目录与权限约定
sudo install -d -m 755 -o root -g root /etc/dsh-portal /opt/dsh-portal /opt/dsh/bin /var/log/dsh-portal

# 2) 门户实现 + 配置（配置先填 <TAILNET_IP>）
sudo install -m 755 -o root -g root server/portal.py  /opt/dsh-portal/portal.py
sudo install -m 640 -o root -g root server/config.example.json /etc/dsh-portal/config.json
sudo sed -i 's/<TAILNET_IP>/<你的 tailnet IP>/g' /etc/dsh-portal/config.json   # 落盘后务必替换

# 3) 实例 wrapper + PAM + systemd
sudo install -m 755 -o root -g root server/dsh-instance   /opt/dsh/bin/dsh-instance
sudo install -m 644 -o root -g root server/pam.dsh-portal /etc/pam.d/dsh-portal
sudo install -m 644 -o root -g root server/dsh-portal.service /etc/systemd/system/dsh-portal.service

# 4) 共享运行时的 npm 配置（必须对普通用户可读，否则 npm 静默回落官方源）
sudo install -m 644 -o root -g root server/npmrc /opt/dsh/node/etc/npmrc
# 注意：/opt/dsh/node 上若残留 default ACL（default:other::---），新建进去的文件
# 会重新变成其他人不可读 —— doctor 的「共享 npmrc 对普通用户可读」就是防这个的。

# 5) 审计日志轮转 + 收紧现有日志权限
sudo install -m 644 -o root -g root server/logrotate.dsh-portal /etc/logrotate.d/dsh-portal
sudo chmod 0640 /var/log/dsh-portal/access.log && sudo chgrp adm /var/log/dsh-portal/access.log

# 6) 启用（只复制 unit 文件不会开机自启，enable 符号链接是另一件事）
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-portal.service
```

上面 1–6 步等价于仓库里的 `dsh-web-ctl install`（它会顺带落盘实例模板单元）。

## 几条容易踩的约定

- **`~/.dsh` 必须是 0700**：里面有 `.credentials.yaml`。新建实例由 `dsh-instance`
  的 `umask 077` 保证；老用户由 portal.py 的 `harden_dsh_home()` 在登录准备阶段收敛。
- **日志不设 postrotate**：`AuditLog` 每次 `open(path,"a")` 写完即关、不持长期 fd，
  改名后下次写自然落到 `create` 的新文件上；发 restart/HUP 只会让所有在线用户瞬断。
- **config.json 只在不存在时才由示例生成**，`install` 绝不覆盖已有配置（里面有本机 IP）。
