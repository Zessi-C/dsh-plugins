# dsh-model-thinking-levels

给 DSH 的自定义模型 API 路由补上「思考强度」设置。

> Unofficial DSH plugin. Per-model thinking levels for custom `llm-pi-ai` routes, with gateway-side capability probing. MIT.

## 功能

- 在「设置 → 模型」的自定义 API 卡片里勾选每个模型支持的思考档位，写入该路由的 `reasoningEfforts`；
- **拖动排序模型**：每个模型一行，拖动行首的手柄即可调整先后（拖动时落点会画一条线，松手才生效；也可以聚焦手柄按 ↑ / ↓）。顺序和档位一起保存，写进该路由的 `models` 数组，所以模型选择器里这个提供方的顺序也跟着变；
- 打开面板时**自动探测网关接受哪些档位**（每个模型一次极小请求），并据此预填。网关没声明的档位仍然可选，但画成虚线，悬停提示「会被归并到相邻档位、勾了不生效」；
- 未声明的模型预填成网关的档位，通常点一次「保存」就完事；把档位全部取消勾选则写入 `reasoningEfforts: false`（显式非推理模型）。

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
2. 勾选档位 → **保存**；
3. 回对话页，输入框上出现 Effort 行。

想让某个模型在模型选择器里靠前：拖动它行首的手柄往上挪，再**保存**。

想让某个模型不显示 Effort 行：把它的档位全部取消勾选再保存。

## 自检

两套离线检查，都不需要浏览器：

```bash
node tools/check-panel.mjs                                          # 面板：拖动排序 + 探测记账
node tools/check-host.mjs --dsh /path/to/dsh                        # 宿主：通道注册
```

`check-panel.mjs` 用桩件加载真实的 `client.js`，跑真实的拖动处理器、键盘移动和保存路径，核对写出的 `models` 顺序与探测失败的各种文案。`check-host.mjs` 需要一份 DSH 检出（含 `node_modules/@deepseek-ai`），它在真的 Cordis 上加载真实的 `HostConnectionService` 和本插件的 `index.js`，断言探测通道确实注册到了 web server 上；没有检出时报告 SKIP。

## 排查：探测失败

面板里的「探测失败」文案会直接说清是哪种：

- **HTTP 503** —— DSH 桌面端正在做应用更新。这段时间 `dsh-desktop-host` 会锁住整个 API 层，任何请求都返回 503。面板会自动重试一次，也可以点「重新探测」。
- **HTTP 405 / 404** —— 宿主侧的探测通道没注册，也就是 Host 半没生效。**重启 DSH** 即可。
- **其它** —— 网关自己回的错误，按文案里的状态码查；单个模型被拒时只有那一行标红，其余模型照常。

Host 半的通道注册有个坑，改 `index.js` 时别踩：`connection.rpc.handle()` 注册到**读取它的那个 Context 的 `webServer`** 上，而 Cordis 不允许读取没有 inject 过的服务。只 inject `connection` 会在回调里抛 `cannot get property "webServer" without inject`——这个异常发生在 `inject` 回调内部，没人上报，于是通道静默不存在，浏览器那个 POST 落到静态处理器，变成 405。所以这里和 `dsh-mnemon` 一样：inject `['connection', 'webServer']`，再 `web.extend({ webServer })`，从扩展后的 Context 读注册表。`tools/check-host.mjs` 会把这条契约钉住。

## 命令行探测

面板的自动探测用的是同一个办法：给 `reasoning_effort` 传一个非法值，表驱动的网关会把
自己的档位表写进 400 报错里（`valid levels: low, medium, high`）。也可以单独跑：

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
            reasoningEfforts:      # 只声明网关真正接受的档位
              off:                 # 空值 = 支持关闭，且不发送思考字段
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
