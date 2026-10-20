# dsh-eval-kernel

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供常驻的 Python、R、JavaScript 解释器，并允许单元格直接调用 harness 自身的工具。

Agent 平时通过 `bash` 做计算，这意味着每个中间结果都要以文本形式穿过 shell 边界，并且要靠落盘文件才能保留到下一次调用。这个插件注册一个 `run_cell` 工具，按 `(agent, language)` 组合维持一个常驻解释器，于是 DataFrame、已拟合的模型、Seurat 对象都能在两次调用之间留在内存里。

[English](README.md) | 中文

## 功能

- **状态保持。** 变量、导入、已加载的数据跨调用存活。传 `reset: true` 换一个干净的解释器。
- **三种语言。** `py`（Python）、`r`（R）、`js`（JavaScript）。R 是对 omp `eval` 的扩展——它的后端枚举只有 `py` 和 `js`。
- **工具回调。** 单元格内可直接以普通函数调用 harness 工具，默认是 `read`、`write`、`edit`、`bash`、`grep`、`glob`。所以一个单元格可以用模型同一个 `read` 读 CSV，也可以中途开子代理。
- **失败不致中断。** 抛错的单元格返回 traceback，解释器继续存活，下一个单元格接着用同一份状态。
- **按 agent 隔离。** 两个 agent 不会共享解释器状态。

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

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `pythonBinary` | `python3` | `py` 使用的解释器 |
| `rBinary` | `Rscript` | `r` 使用的解释器 |
| `jsBinary` | `node` | `js` 使用的解释器 |
| `defaultLanguage` | `py` | 调用未指定 `language` 时的语言 |
| `timeoutMs` | `300000` | 单元格时限；`0` 表示不限时 |
| `maxOutputChars` | `30000` | 输出保留字符数，超出则首尾截断 |
| `bridgeTools` | `read, write, edit, bash, grep, glob` | 暴露给单元格的 harness 工具 |
| `idleTimeoutMs` | `1800000` | 空闲多久回收解释器；`0` 表示不回收 |

项目需要特定 R 版本时，把 `rBinary` 指向对应 conda 环境的 `Rscript`。

## 实现要点

- 每个解释器是一个子进程，通过 NDJSON 通信。宿主每行写一个 JSON 对象，子进程回送带类型的帧（`stdout`、`stderr`、`error`、`done`，回调走 `tool`）。
- **R 需要具名管道。** Linux 上 `Rscript` 在 stdin 是匿名管道时无法打开 `/dev/stdin`、`/dev/fd/0` 或 `/proc/self/fd/0`，所以 R 子进程从一个临时目录里的 FIFO 读取，拆卸时删除该目录。
- **R 的帧绕过 `sink()`。** 单元格输出靠把 R 的 stdout 连接重定向到临时文件来捕获，而帧走的是在任何 `sink()` 之前捕获的连接句柄，两者互不干扰。
- **Python 状态是显式的。** 单元格通过 `compile()`/`exec()` 跑在同一个命名空间字典上，不依赖 IPython，任何解释器都能用。
- **JavaScript 用代理作用域。** 声明被改写成普通赋值，通过 `with` 块在代理上解析；代理的 `has` 只对内核已拥有的名字返回 true，这样 `console`、`Error` 等全局量仍然可见。
- 工具通过 harness 的 `defineTool` 声明，它会把 schema DSL 编译成 OpenAI 兼容端点期望的标准 JSON Schema。手工拼装工具对象会让 `parameters` 保持成裸属性表，端点直接以 `invalid function call parameters`（`upstream_code: 11129`）拒绝。
- 错误在后续微任务里 reject（`queueMicrotask`）。在子进程的 `data` 回调里同步 reject，会在调用方尚未挂上处理函数时产生 unhandled rejection，杀掉的是宿主进程而不只是这个单元格。

## 许可

MIT
