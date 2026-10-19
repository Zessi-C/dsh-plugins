# dsh-vibe-orchestrator

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）提供 **Vibe 模式**，
改编自 [oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）的 vibe 模式。

主对话不再自己干活，而是变成 **director（导演）**：读取工作区、把你的需求拆成若干工作流，
分别派发给 `fast`、`good`、`expert` worker。它自己不能改文件、不能执行命令。

[English](README.md) | 中文

---

## 一个模式，三档 worker

模式选择器里**只有一个**条目：**Vibe**。三档是它派发出去的 worker，不是可选模式。

| 档位 | 默认路由 | 工具 | 定位 |
|---|---|---|---|
| `fast` | `agent2cli/deepseek-v4.1-flash` | 完整工作工具集 | 机械、需求明确的工作 |
| `good` | `agent2cli/Qwen3.8-Flash` | 完整工作工具集 | 设计、调试、需要判断的工作 |
| `expert` | `cpa/gemini-3.8-flash-high` | 可读全部、可写新计划 | 难题咨询 |

director 只保留读取与派发类工具。`write`、`edit`、`bash`、`pwsh` 既从它的工具列表里移除，
又由执行期 guard 拦截，所以它不会自己动手。

## 实现方式

只声明**一个** Agent preset `vibe`，它挂载完整工作工具集——因为所有 worker 都继承这个
preset。随后由 Host 行按角色塑形：

| Agent | 人格 | 应用的边界 |
|---|---|---|
| 根会话 | director | 摘掉写类工具，加入三个 `vibe_*` 工具 |
| `fast` worker | fast worker | 不变 |
| `good` worker | good worker | 不变 |
| `expert` worker | expert | 摘掉 `edit`、`bash`、`pwsh` |

worker 是普通子代理，继承父会话的 preset，因此它与兄弟的唯一区别就是派发时选定的模型
路由，以及上表的边界。档位记录在工具写入的持久 `label` 上（`expert · …`），所以 worker
冷恢复后边界依然成立。

塑形由两个事件驱动，因为会话有两条路径进入 preset：

- `agent/created`：创建时 header 里已记录该 preset 的会话。
- `agent-preset/selected`：之后才切换到该 preset 的空白会话。

切换到其它 preset 时，本行安装的一切都会被撤销。

### 为什么不用 Agent Teams

dsh 的实验性 Agent Teams 名册**不可回收**：第一个 provisioning 记录就永久占用一个成员名额
（创建失败的成员也一样），名字永不复用、不可删除；`interrupt_agent` 只能停当前 turn，
不释放名额。官方把嵌套团队与自动回收列为「未决定、未承诺」。

子代理没有这些限制：容量只是并发上限（`maxActiveSubagents`，默认 8），worker 结束即归还，
同时仍然具备续跑、`send_message`、interrupt 能力。

### 专家档的成本控制

专家**不设调用次数上限，也不设输出上限**。长期运行的会话不能被固定数字卡死，而被截断的
专家答复比多花的那点 token 更贵。成本改由策略控制：

1. **路由策略** —— 明确要求 director 只在 `fast` 与 `good` 都解决不了时才找专家。
2. **上下文隔离** —— spawn 出来的 worker 不继承 director 的对话历史，只拿到 brief。
3. **职责范围** —— 专家只给方案与写计划，不能改代码、不能执行命令，所以专家 turn 不会
   演变成一次改代码的会话。

### prompt 出处

director 人格与档位工具描述改编自 omp 的 vibe 模式源码：
`packages/coding-agent/src/prompts/system/vibe-mode-active.md` 与
`packages/coding-agent/src/prompts/tools/vibe-spawn.md`。director 的定位、worker 的档位描述、
Direction 规则、以及「必须读改动过的文件来核实 worker 的说法」这一条，都来自那里。

有四处不同，都是刻意的：

| omp | 本插件 | 原因 |
|---|---|---|
| 两档 | 三档 | `expert` 咨询档是本插件新增 |
| `vibe_send` / `vibe_kill` / `vibe_list` | `send_message` / `interrupt_agent` / `list_agents` | 用 dsh 自带的 worker 控制工具 |
| `vibe_wait` | 无 | dsh 会把 worker 结果作为完成通知投递 |
| director 只有 `read` | director 还有 `glob`、`grep` | 只读检索留在父会话，避免为每次查找付一次 worker 往返 |

## 安装

自包含：通过 `createRequire` 解析宿主自身的 `@deepseek-ai/*` 包，不需要自带 `node_modules`，
也不需要构建步骤。

```
plugin_manager install_bundle /path/to/dsh-vibe-orchestrator
```

该命令会把本包加入 profile 的 `dsh.profile.bundles` 并启用它唯一的 Loader 行。
刷新页面（或重启宿主）即可看到设置页。

### 前置条件

- dsh `0.2.1-rc.2`（本包读取的 `agent-preset` 私有契约）。
- 持久化会话存储（Web profile 默认已挂载）。
- 默认路由要存在于你的 provider 列表里；不存在就在设置页改掉。

## 设置

**Plugins → Vibe** 中每一档是一行，用两个和主对话同款的选择器：

- **模型菜单**：列出 Host 公布的全部路由，按 provider 分组，当前路由打勾；
- **思考强度菜单**：只列当前模型自己声明的档位，外加「不指定」（不发送强度，由模型自己决定）。

不需要手打任何 id。换模型时会自动清掉新模型不支持的强度档位。provider 与 model 作为
一次 revision 保护的单次写入提交，且所有字段都是 `volatile`，保存后下一次派发即生效，
无需重启宿主。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半：档位工具、按角色塑形、volatile 路由 |
| `lib/copy.js` | director 与 worker 人格、档位工具描述 |
| `lib/dsh.js` | 解析宿主自身的 `@deepseek-ai/*` 包 |
| `lib/client.js` | **Plugins → Vibe** 页面 |
| `cordis.patch.yml` | Host 行与唯一的 `vibe` preset |

## 与 omp vibe 的差异

| 方面 | omp | 本插件 |
|---|---|---|
| 激活方式 | `/vibe` 切换当前会话；plan/goal 模式下被禁止 | 按会话选择 Agent preset；plan 与 goal 工具根本不存在 |
| 状态持久化 | 会话日志里的 mode change 事件 | 会话 header 记录 preset |
| director 工具 | 工具集被**替换**为 `read`（+ 可选 `todo`）加 5 个 vibe 工具，连 `grep` 都没有 | preset 挂完整工具集，Host 行摘掉写类工具并加 3 个档位工具，保留 `glob` 与 `grep` |
| 档位数 | 2 档，差异仅在 bundled agent 与模型 | 3 档，差异在模型、人格、工具边界三处 |
| 专家咨询档 | 无 | 有；无 shell，可写计划 |
| worker 复用 | 一个工作流一个常驻会话，绝不再 spawn | 同一条规则，写进人格与工具描述；用 `send_message` 继续同一个 worker |
| 等待 | `vibe_wait` 阻塞到 worker turn 结束 | 不需要：dsh 会推送完成通知 |
| 终止 worker | `vibe_kill` | `interrupt_agent`（保留 inbox） |
| 退出模式 | 杀光 worker 并打墓碑 | 容量随 worker 结算自动归还，无需 kill-all |
| 路由配置 | 配置文件里的 `modelRoles` / `task.agentModelOverrides` | UI 实时设置页 |

## 已验证与未验证

已在 dsh `0.2.1-rc.2` 上验证：

- Host 行激活成功，模式清单中只有一个 Vibe preset；
- 包在删除 `node_modules` 后仍能加载；
- 组装出的 preset 携带完整工作工具集；
- 设置页可以渲染（框架、档位行、选择器、保存按钮）。

作者未验证：最新一版选择器菜单的实际渲染效果。所用组件的导出名与 props 都已对照
浏览器实际加载的客户端 bundle 核对（`Menu`、`MenuGroup`、`MenuItemButton`、`Button`
以及 check / chevron 图标），但编写环境没有浏览器控制能力。

## 许可

MIT
