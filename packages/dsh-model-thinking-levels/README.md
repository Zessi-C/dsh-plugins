# dsh-model-thinking-levels

给 DSH 的自定义模型 API 路由补上「思考档位」，并把能探测到的模型能力（上下文窗口、输出上限、输入模态、显示名）一起填进去。

> Unofficial DSH plugin. Per-model thinking levels and detected capabilities for custom `llm-pi-ai` routes, with gateway-side probing. MIT.

## 功能

- 在「设置 → 模型」的自定义 API 卡片里勾选每个模型支持的思考档位，写入该路由的 `reasoningEfforts`；
- **拖动排序模型**：每个模型一行，拖动行首的手柄即可调整先后（拖动时落点会画一条线，松手才生效；也可以聚焦手柄按 ↑ / ↓）。顺序和档位一起保存，写进该路由的 `models` 数组，所以模型选择器里这个提供方的顺序也跟着变；
- 打开面板时**自动探测网关接受哪些档位**（每个模型一次极小请求），并据此预填。网关没声明的档位仍然可选，但画成虚线，悬停提示「会被归并到相邻档位、勾了不生效」；
- 同一趟还会**探测每个模型的能力字段**并预填进条目：
  - `contextWindow` 上下文窗口；
  - `maxTokens` 最大输出 tokens；
  - `input` 输入模态（文本 / 图片）；
  - `name` 显示名。

  来源有两个，能拿到哪个用哪个：
  1. **网关自己的模型清单**（`GET /models`；Anthropic 协议走 `/v1/models`）。不同网关披露的字段差别很大：标准实现只给 id，OpenRouter/NewAPI/LiteLLM 形状的实现会带上下文、输出上限、模态和上游厂商（`owned_by`）。清单里有的能力，以网关为准。
  2. **已安装 pi-ai 目录里同一个 model id 的官方条目**。自定义路由本身不在目录里，但它服务的模型通常在里面：目录带着厂商公布的上下文窗口、输出上限、模态和档位表，按 id 匹配即可。网关按档位拆出来的别名（`gemini-3.8-flash-high`）会去掉 `-high` / `-low` 等后缀再找。

- 预填遵守两条规矩：
  - **只补空缺**：条目里已经写了的字段原样保留，不会被探测值覆盖；
  - **不一致只标出来**：条目里的值和探测值不同时，行内显示 `与探测值不一致：上下文 1,000,000 → 1,048,576`，点「采用探测值」才写进去。
- 档位取「网关接受的」与「官方目录支持的」交集（`off` 始终可选；两者没有交集时退回官方档位表）；官方目录明确说这个模型不推理时，即使网关给的是它自己的默认档位表，也按非推理处理（CLIProxyAPI 对没写 `thinking` 的自定义 provider 会默认 `low, medium, high`，那是网关的默认值，不是模型能力）；
- 一个提醒：`maxTokens` 写进条目后，也会成为这个模型**每次请求的默认输出上限**，同时参与上下文容量判断。探测值来自官方目录，网关上实际能接受多大以网关为准；不合适就直接在模型行里改掉。
- 未声明的模型预填成探测结果，通常点一次「保存」就完事；把档位全部取消勾选则写入 `reasoningEfforts: false`（显式非推理模型）。

面板只出现在**自定义 API 路由**（pi-ai 不内置的提供方）上。内置目录路由不动：它的 `models` 数组一旦写入就会整体替换内置目录，反而会把目录里的模型挤掉。

## 安装

```bash
dsh plugin --profile <profile> add github:Zessi-C/dsh-model-thinking-levels
```

也可以从本地目录装：`dsh plugin --profile <profile> add /absolute/path/to/dsh-model-thinking-levels`。

装完**重启 DSH**（Host 半是进程内模块，只刷新页面不生效）。

## 用法

设置 → 模型 → 你的自定义 API 卡片，里面会出现一行 `▸ 思考强度`：

1. 点开这一行。每个模型一行，右侧写着网关接受的档位，例如 `网关接受：低 / 中 / 高`；
2. 行下面那行小字是能力探测的结果：
   - `将补入：上下文 272,000、输出上限 128,000、模态 文本+图片、名称 GPT-6.1 Sol` —— 这些字段条目里没有，保存时写进去；
   - `与探测值不一致：上下文 1,000,000 → 1,048,576` —— 条目里已经有别的值，点「采用探测值」才覆盖；
   - 行尾注明来源：`来源：官方目录（openai）` 或 `来源：网关清单`；
   - 官方目录对同一个 id 给出多个互相矛盾的取值、又没有线索可以排序时，只提示 `官方目录给出多个取值（…），未自动填入`，不替你猜。
3. 勾选档位 → **保存**；
4. 回对话页，输入框上出现 Effort 行。

想让某个模型在模型选择器里靠前：拖动它行首的手柄往上挪，再**保存**。

想让某个模型不显示 Effort 行：把它的档位全部取消勾选再保存。

## 自检

三套离线检查，都不需要浏览器：

```bash
node tools/check-panel.mjs                                   # 面板：拖动排序 + 档位探测 + 能力预填/冲突/采用
node tools/check-detect.mjs --dsh /path/to/dsh               # 宿主：模型清单解析 + 目录匹配排序 + 两个 RPC 端点
node tools/check-host.mjs --dsh /path/to/dsh                # 宿主：通道注册
```

`check-panel.mjs` 用桩件加载真实的 `client.js`，跑真实的拖动处理器、键盘移动和保存路径，核对写出的 `models` 顺序、能力字段的预填/冲突/采用/歧义/非推理降级，以及探测失败的各种文案。`check-detect.mjs` 直接调 `index.js` 里的处理器与通道分发：用桩 `fetch` 喂各种形状的模型清单，核对命名空间与路径限制、路由自带请求头、环境变量凭据、清单体积上限；用真实 pi-ai 目录核对按 id 匹配与「厂商行优先 / `owned_by` 优先 / 协议一致 / 全一致 / 多数 / 无法排序」的排序结论。`check-host.mjs` 需要一份 DSH 检出（含 `node_modules/@deepseek-ai`），它在真的 Cordis 上加载真实的 `HostConnectionService` 和本插件的 `index.js`，断言探测通道确实注册到了 web server 上；没有检出时报告 SKIP。

`--dsh` 可以给检出根目录（其 `node_modules/@deepseek-ai` 里有 cordis），也可以给全局安装的位置（`.../node_modules/@deepseek-ai/dsh` 所在的上一级，此时两个脚本会沿 dsh 自己的 `node_modules` 找依赖）。

## 排查：探测失败

面板里的「探测失败」文案会直接说清是哪种：

- **HTTP 503** —— DSH 桌面端正在做应用更新。这段时间 `dsh-desktop-host` 会锁住整个 API 层，任何请求都返回 503。面板会自动重试一次，也可以点「重新探测」。
- **HTTP 405 / 404** —— 宿主侧的探测通道没注册，也就是 Host 半没生效。**重启 DSH** 即可。
- **其它** —— 网关自己回的错误，按文案里的状态码查；单个模型被拒时只有那一行标红，其余模型照常。

能力探测的失败互相独立：

- **`网关清单读取失败（…）`** —— 端点不提供或拒绝 `GET /models`，面板继续用官方目录的数据；两者都没有时这一行之外不会有预填。
- **`能力探测失败：…`** —— 调不到 Host 半（或 Host 半版本太旧没有 `detect` 端点）；档位探测照常工作，只是能力字段不预填。
- **`官方目录读不到…`** —— 这个部署里找不到 Host 半能读到的 pi-ai 安装；能力值改从网关清单来，两者都没有时同样不填。
- 官方目录里查不到这个 model id（自建模型名、中转站自定义别名）时，该行不显示能力信息，也不填任何值。

Host 半的通道注册有个坑，改 `index.js` 时别踩：`connection.rpc.handle()` 注册到**读取它的那个 Context 的 `webServer`** 上，而 Cordis 不允许读取没有 inject 过的服务。只 inject `connection` 会在回调里抛 `cannot get property "webServer" without inject`——这个异常发生在 `inject` 回调内部，没人上报，于是通道静默不存在，浏览器那个 POST 落到静态处理器，变成 405。所以这里和 `dsh-mnemon` 一样：inject `['connection', 'webServer']`，再 `web.extend({ webServer })`，从扩展后的 Context 读注册表。`tools/check-host.mjs` 会把这条契约钉住。

## 命令行探测

面板的档位探测是给 `reasoning_effort` 传一个非法值，表驱动的网关会把自己的档位表写进 400 报错里（`valid levels: low, medium, high`）。也可以单独跑：

```bash
node tools/probe-levels.mjs <baseURL> <model> [<model>...]
```

**一个坑**：CLIProxyAPI 对配置里手写的自定义 provider 模型，若模型条目没写 `thinking`，
会**默认**按 `low, medium, high` 校验——这是网关的默认值，不是模型的能力。
探测到恰好这三个档位时先怀疑是默认值，去上游 `/v1/models` 或网关配置里确认。
在网关侧显式声明即可修正：

```yaml
    models:
      - name: upstream-model-id
        alias: exposed-model-id
        thinking:
          levels: [high]
```

## 不装插件时的等效写法

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:
        baseURL: https://gateway.example.com/v1
        apiKeyEnv: MY_GATEWAY_KEY
        models:
          - id: model-a
            contextWindow: 272000      # 上下文窗口
            maxTokens: 128000          # 输出上限（同时会成为每次请求的默认上限）
            input: [text, image]       # 输入模态
            reasoningEfforts:          # 只声明网关真正接受的档位
              off:                     # 空值 = 支持关闭，且不发送思考字段
              low: low
              medium: medium
              high: high
```

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-model-thinking-levels
```

## License

MIT
