# dsh-plugin-updater

检查并更新当前 dsh profile 里的插件。

它解决三类实际情况：

| 情况 | 页面显示 | 更新时做什么 |
| --- | --- | --- |
| npm 仓库里有新版本 | 已装 → 最新 | 安装**声明支持当前 dsh** 的最新版本 |
| 插件从 Git 仓库安装（含私有仓库） | 远端版本与发布标签 | 按记录的仓库重新安装 |
| 插件还能用，但声明的 dsh 范围落后 | 未满足的依赖要求 | 装一个兼容的新版本，或在已装清单里放宽范围 |

以 `file:` 或 `link:` 方式链接的本地目录不会联网检查。页面标为本地，宿主半部另外报告它的源码是否比构建产物新，因为过期的构建会在版本号不变的情况下继续运行旧代码。

## 用法

**插件页 → 插件更新**。标签页按状态分组列出所有插件：

- **可更新**：存在兼容的新版本。
- **版本不兼容**：已装版本不满足运行的 dsh。如果最新版高于当前 dsh，会同时给出两个动作：装一个仍兼容的版本，或记录精确版本豁免。
- **本地**：链接目录。
- **已是最新**、**读取失败**、**随 dsh 安装**（内置插件随 dsh 一起升级）。

勾选后点**应用所选**，任务在后台执行并显示进度条，页面可以继续使用，重载也不会丢失进度。每一项都通过插件管理器自己的接口安装，因此 pnpm、构建脚本策略、锁文件和 profile 补丁仍由 Harness 负责。重装会依据新包重新推导依赖规格、bundle 选中状态和行开关，所以本插件会在之后把这三项恢复。

**Agent 工具**：`plugin_update`，`action: "check"` 输出报告，`action: "apply"` 执行计划。除非在配置里把 `agentToolMirrorsPlan` 设为 `true`，否则拒绝执行，因为更新插件会替换用户正在运行的代码。

### 定时更新（宿主侧）

页面右上角的 **⏰ 定时更新** 设置检查频率和是否自动安装安全更新。这两项写进 profile 里 `plugin-updater` 行的配置（`autoCheckMinutes`、`autoApply`），由宿主按间隔执行，**关闭页面、关掉浏览器之后仍然继续**：

- 宿主每分钟比对一次时间，到点才真正探测各源仓库；上次尝试的时间记录在 profile 的 `.plugin-manager/updater-schedule.json`，所以重启 dsh 不会立刻重新探测。
- 自动安装只覆盖页面里同样算“安全”的更新：有兼容当前 dsh 的新版本。需要版本豁免、或需要用户确认的插件永远不会被自动改动。
- 单次探测失败会等下一个间隔再试，不会每分钟重试。
- 设置通过 Harness 的 Settings 服务写入，字段是 volatile 的，所以保存后无需重启；profile 不可写时对话框会直接说明。

## 私有仓库怎么更新

私有仓库不能匿名读取，必须提供凭据。本插件按以下顺序取 token：

1. **dsh 凭据存储**（推荐）。它把所有密钥收在 `~/.dsh/.credentials.yaml` 的 `refs:` 下，重启后依然有效，不必在 shell 里导出，也不会写进仓库。dsh 没有提供写入凭据的命令行，用下面任一方式存放：

   已装的 Mnemon 等插件在设置页提供凭据编辑入口，可以直接新建名为 `DSH_PLUGIN_UPDATER_TOKEN` 的条目；
   也可以直接编辑该文件，在 `refs:` 下按同样格式加一行（值就是 token 本身，注意用两个空格缩进）：

   ```yaml
   refs:
     DEEPSEEK_API_KEY: <已有值>
     DSH_PLUGIN_UPDATER_TOKEN: <你的 token>
   ```

   改完后重启 dsh 生效；此后本插件每次探测都会重新读取，轮换 token 不必再改配置。

2. **环境变量**。设置同名的 `DSH_PLUGIN_UPDATER_TOKEN` 即可，适合临时使用或容器环境。

3. **什么都没配**。此时退回 git 自己的凭据助手：只要本机执行过 `gh auth login`，私有仓库照样能读。

配置项 `gitTokenEnv` 可以改这个变量名，默认是 `DSH_PLUGIN_UPDATER_TOKEN`。

安全约束：

- token 只会发给 `github.com`、`gitlab.com`、`bitbucket.org` 这三个公共托管站点。其他地址（例如内网 GitLab）不会收到 token。
- token 通过 URL 内嵌方式只传给**单次** git 调用，不会写进 profile 的 `package.json`，也不会出现在报告里。
- 每次探测都重新读取凭据，轮换 token 后下一次检查即生效，不需要重启。

## 版本从哪里读

私有仓库没有公开的 raw 入口，无法读取指定提交里的 `package.json`。因此每个包发布时打一个 `<包名>-v<版本>` 标签，本插件用 `git ls-remote --tags` 读取，走的是和安装同一套凭据。没有打标签的仓库仍然可用，只是改为按提交判断。

## dsh 范围不兼容时怎么处理

Harness 拒绝加载声明要求不满足的插件。只有两条稳妥的路：

1. **换到接受当前运行时的版本**。逐个用 `semver.satisfies(runtime, range, { includePrerelease: true })` 筛选——和 Harness 的判断方式一致——取最新的兼容版本安装。
2. **就这一个精确版本接受风险**。用户确认后写入 Harness 自己的记录：在 profile 的 `compatibility.json` 里登记 `${name}@${version}` 与运行时版本，等价于 `dsh plugin allow-version`。

如果版本已经是最新、只是范围落后，则在已装清单的 `engines.dsh`（或 dsh peer 范围）后追加 `|| <运行时>`。这样能继续运行确实可用的代码，改动也留在可见的清单里，而不是藏进 profile 覆盖层。

## 配置

在 profile 的 `cordis.patch.yml` 里改 `plugin-updater` 行：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `timeoutMs` | `30000` | 单次仓库或 git 探测的超时。 |
| `probe` | `true` | 设为 `false` 时只列插件，不联网。 |
| `fallbackRegistry` | `https://registry.npmjs.org/` | profile 的 pnpm 仓库无响应时改问这个。 |
| `agentToolMirrorsPlan` | `false` | 允许 `plugin_update` 的 `apply` 真正改动插件。 |
| `gitTokenEnv` | `DSH_PLUGIN_UPDATER_TOKEN` | 私有仓库 token 的变量名。 |
| `autoCheckMinutes` | `0` | 后台检查间隔（分钟），`0` 表示关闭。volatile；页面上的“定时更新”写的就是它。 |
| `autoApply` | `false` | 后台检查发现兼容更新时自动安装。volatile；默认关闭。 |

## 依赖与限制

- Git 安装的插件需要 PATH 上有 `git`。
- 被 pnpm 拦下的构建脚本会以失败形式报出包名；在 `pnpm-workspace.yaml` 里批准后重试，和插件页的处理一致。
- 页面提示 `restart-required` 时需要重启 dsh：新的模块不会被就地加载。
- 随 dsh 安装的插件从不覆盖，否则会遮蔽 dsh 自带的副本。
- 定时更新由宿主执行，不依赖浏览器；但 `probe: false` 时后台也只做本地扫描，不联网。

MIT 许可。
