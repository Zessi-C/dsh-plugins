# dsh-eval-kernel

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供常驻的 Python、R、JavaScript 解释器，运行在会话自身的文件影响策略之下。

Agent 平时通过 `bash` 做计算，这意味着每个中间结果都要以文本形式穿过 shell 边界，并且要靠落盘文件才能保留到下一次调用。这个插件注册一个 `run_cell` 工具，按 `(agent, language)` 组合维持一个常驻解释器，于是 DataFrame、已拟合的模型、Seurat 对象都能在两次调用之间留在内存里。

[English](README.md) | 中文

## 功能

- **状态保持。** 变量、导入、已加载的数据跨调用存活。传 `reset: true` 换一个干净的解释器。
- **三种语言。** `py`（Python）、`r`（R）、`js`（JavaScript）。R 是对 omp `eval` 的扩展——它的后端枚举只有 `py` 和 `js`。
- **受约束。** 每个解释器都在发起它的那个会话的文件影响策略下启动，单元格无法靠读写绕开 harness 本身禁止的事情；它派生的子进程同样被约束。
- **策略跟随对话。** 每次调用都重新读取策略；一旦策略变化，解释器按新策略重启，而不是带着已撤销的限制继续活到进程结束。
- **失败不致中断。** 抛错的单元格返回 traceback，解释器继续存活，下一个单元格接着用同一份状态。
- **按 agent 隔离。** 两个 agent 不会共享解释器状态。
- **内存有界。** 边输出边封顶，空闲解释器会被回收，而不是一直留着；解释器自己的 stderr（Python 警告、R 的 `message()`）会并入该单元格的 stderr，而不是丢掉；写出去的大帧等子进程读走，不堆在宿主内存里。

## 安装

在本 monorepo 中：

```sh
dsh plugin --profile web add github:Zessi-C/dsh-plugins#main\&path:/packages/dsh-eval-kernel
```

之后重启 harness，让新的模块代际生效。

## 用法

Agent 调用 `run_cell`，传 `code` 和可选的 `language`：

```json
{"code": "import pandas as pd\ndf = pd.read_csv('data.csv')\nprint(df.shape)", "language": "py"}
```

下一次调用：

```json
{"code": "print(df.describe())", "language": "py"}
```

`df` 依然在。参数：`code`（必填）、`language`、`title`、`reset`、`timeoutMs`。

## 约束机制

解释器不是直接拉起的：它经由 dsh 的 `landlock-run` 启动器启动，授权表由会话策略推导而来。读操作全盘放行（`/`）；写操作只在策略允许的位置——`workspace-write` 下是工作区根目录与 `/tmp`，`read-only` 下一个都不给；两种情况都额外放行 `/dev/null`，因为打不开它的进程会以与策略无关的方式失败。

有两点比清单本身更重要：

- **这是「本次调用」的策略，不是插件的策略。** 每次调用都从 `ctx.sandboxPolicy.resolve({ session })` 重新解析。会话模式一旦变化——用户放宽或收窄、审批通过了一次提权——签名就变了，解释器会被替换，因为 landlock 规则集在 `exec` 之后无法放宽。单元格的 stderr 会写明这一点，不会让模型莫名其妙拿到一个空的命名空间。
- **由内核强制，而不是靠自觉。** 规则集跨 `fork`/`exec` 继承，所以单元格里用 `subprocess` 或 `system()` 派生的进程仍在其内。不存在进程内的逃生口，也不存在可供单元格绕路去够的宿主工具桥。

`danger-full-access` 直接放行、不加约束：这个模式的意义就是什么都不扣留，在这里再收窄会悄悄把它破坏掉。

如果要求了约束却给不出来，调用直接失败而不是降级——「看起来被关着其实没有」比拒绝启动更糟。可以用 `sandbox: false` 先把内核跑起来（那会去掉约束，仅供排障）。

> **平台说明。** 约束依赖 `landlock-run` 启动器，它是随 Linux 提供的。在功能探测报告启动器不可用的主机上，`run_cell` 拒绝启动；`sandbox: false` 是显式的退出开关。

### R 的私有临时目录

`Rscript` 在启动时会创建会话临时目录，因此在 `read-only` 下它还没接手第一个单元格就退出了。所以无论哪种模式，R 都会拿到一个私有临时目录：由插件创建、单独授权（绝不是整个 `/tmp`）、作为 `TMPDIR` 导出、随解释器一起删除。这是在不让策略变宽的前提下让 R 可用的最小做法。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `pythonBinary` | `python3` | `py` 使用的解释器 |
| `rBinary` | `Rscript` | `r` 使用的解释器 |
| `jsBinary` | `node` | `js` 使用的解释器 |
| `defaultLanguage` | `py` | 调用未指定 `language` 时的语言 |
| `timeoutMs` | `300000` | 单元格时限；`0` 表示不限时 |
| `maxOutputChars` | `30000` | 输出保留字符数，超出则首尾截断 |
| `sandbox` | `true` | 让解释器受会话策略约束；`false` 表示用宿主自身的权限运行 |
| `idleTimeoutMs` | `1800000` | 空闲多久回收解释器；`0` 表示不回收 |

项目需要特定 R 版本时，把 `rBinary` 指向对应 conda 环境的 `Rscript`。

## 内存与生命周期

解释器是一个装着上一个单元格所留下东西的进程，所以它的生命周期是显式管理的：

- **输出边收边封顶。** 在循环里 `print` 是最容易让宿主吃下几个 GB 的方式。每条流只保留 4 MiB（首尾各半）并记录丢弃量，于是失控的输出只花固定预算。
- **空闲解释器会被回收。** 超过 `idleTimeoutMs` 就杀掉进程、归还内存。下一次调用起一个新解释器，并在 stderr 里说明，而不是默默返回一个空命名空间。仍在执行单元格的会话不会被回收：扫描只针对「最后一个单元格结束至今超过该时长」的解释器。
- **死掉的解释器会被替换。** 崩溃、被中止、超时的进程会在下次调用时重启，而不是让之后的每个单元格都失败。因此超时或被取消的调用会丢掉解释器里的变量，`run_cell` 会在错误里写明这一点，而不是只回一个裸的 rejection。
- **`reset: true`** 按需丢弃解释器，这是释放不再需要的大对象的方式。
- **拆卸时释放管道。** 启动失败会关闭它的帧管道并清理它创建的目录；一个没关的管道会让宿主的 event loop 永远无法退出。

## 实现要点

- 每个解释器是一个子进程，通过 NDJSON 通信。宿主每行写一个 JSON 对象，子进程回送带类型的帧（`stdout`、`stderr`、`error`、`done`）。
- **R 需要具名管道。** Linux 上 `Rscript` 在 stdin 是匿名管道时无法打开 `/dev/stdin`、`/dev/fd/0` 或 `/proc/self/fd/0`，所以 R 子进程从一个临时目录里的 FIFO 读取，拆卸时删除该目录。
- **R 在内存里捕获输出。** 单元格输出用 `sink()` 重定向到 `textConnection` 而不是临时文件，这样在策略不给任何可写目录时内核依然可用。帧走的是在任何 `sink()` 之前捕获的连接句柄，两者互不干扰；单元格自己漏掉的 `sink()` 会在下一个帧写出前被收回，所以一个不小心的单元格不会吞掉之后所有的应答。
- **Python 状态是显式的。** 单元格通过 `compile()`/`exec()` 跑在同一个命名空间字典上，不依赖 IPython，任何解释器都能用。
- **JavaScript 用代理作用域。** 声明被改写成普通赋值，通过 `with` 块在代理上解析；代理的 `has` 只对内核已拥有的名字返回 true，这样 `console`、`Error` 等全局量仍然可见。
- 工具通过 harness 的 `defineTool` 声明，它会把 schema DSL 编译成 OpenAI 兼容端点期望的标准 JSON Schema。手工拼装工具对象会让 `parameters` 保持成裸属性表，端点直接以 `invalid function call parameters`（`upstream_code: 11129`）拒绝。
- 错误在后续微任务里 reject（`queueMicrotask`）。在子进程的 `data` 回调里同步 reject，会在调用方尚未挂上处理函数时产生 unhandled rejection，杀掉的是宿主进程而不只是这个单元格。

## 从 0.1.0 迁移

0.1.0 允许单元格以普通函数调用 harness 工具（`read`、`write`、`edit`、`bash`、`grep`、`glob`），走的是宿主桥接。这个桥接已被移除，理由见上：它只约束了单次调用，而解释器本身完全没有约束，于是它暗示了一条自己守不住的边界——任何单元格一句 `open()` 就能绕开。

替代方案更强，而且不需要配置：整个解释器都在策略之下，所以单元格里的普通文件读写本来就被管住了。`bridgeTools` 已删除；配置里仍写着它会被忽略。若单元格需要策略不允许的东西，请用 `bash`（或提高模式），而不是去找单元格内的桥。

## 许可

MIT
