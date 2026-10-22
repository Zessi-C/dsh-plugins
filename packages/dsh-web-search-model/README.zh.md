# dsh-web-search-model

为 dsh 的网页搜索设置卡补一个**搜索模型**字段 —— 在原有那张卡上，而不是在它旁边再加一张。

- [它解决的问题](#它解决的问题)
- [如何接管这张卡](#如何接管这张卡)
- [维护](#维护)
- [模型字段](#模型字段)
- [目录结构](#目录结构)
- [安装](#安装)
- [修改源码后必须重新链接](#修改源码后必须重新链接)
- [卸载](#卸载)
- [已知限制](#已知限制)

---

## 它解决的问题

官方设置页 `@deepseek-ai/dsh-client-ui-settings-web-search` 只编辑
`web-search-deepseek` 命名空间的三个字段：

```
apiKeyEnv    凭据引用名
baseURL      接口地址
maxUses      单次请求最多搜索次数
```

提供方插件自身的 config schema 接受七个字段。其余三个 —— `model`、`apiVersion`
和 `maxTokens` —— 被刻意保留为**组合值**，界面上没有入口。上游包把这一点写在其
「已知限制」中：

> **只编辑命名空间的三个字段** —— 提供方的模型、API 版本与 token 预算保持组合值
> 不变；本页只编辑密钥、接口地址和搜索次数。

`model` 是最容易出问题的一个。提供方默认使用 `deepseek-v4-flash`，而自建与第三方
Anthropic 兼容网关通常并不提供这个 id，于是每次搜索都在网关侧被 HTTP 400 拒绝，
而设置页既看不到这个字段，也改不了它。

## 如何接管这张卡

**无法**往官方 React 组件里插入字段：它的 children 是硬编码的，组件实例也不可获取
—— 客户端模块只导出插件体，卡片组件被捕获在 factory 闭包里。

可行的路径是槽机制。`plugins.item` 是**按 id 分格的 list 槽**，
`SlotCore.entriesOfSlot` 在按 `(priority, order)` 升序排列的账本上取每格第一个
—— 因此**同一 id 下 priority 最小者渲染**。

```js
// dsh-client-ui-slots / SlotCore.entriesOfSlot
for (const entry of rec.entries) {          // 已按 priority 升序
  const cell = kind === "list" ? entry.options.id : void 0;
  if (seenCells.has(cell)) continue;        // 每格第一个胜出
  seenCells.add(cell);
  heads.push(entry);
}
```

因此本包以 `id: "web-search"` + `priority: -1` 注册。官方那张卡照常注册
（`priority: 0`；priority 不同不算冲突），但不渲染。槽机制明确记载了这一用法：
*「register at a different priority to shadow it (lowest renders)」*。

### 只出现一张卡

顶替只是其中一半。本包同时**是一个 bundle**，所以插件列表里会列出它，并按其包名向
`plugins.bundle.config` 索取「本 bundle 自己的配置页」。如果在那个页面上也渲染表单，
同一份设置就会在屏幕上出现两次：内置插件区一次，bundle 页面一次。

因此本包对 bundle 配置槽的注册**返回 `null`**。设置只存在于官方卡那一格里，界面上
因此只有一张网页搜索卡，而 bundle 仍然保持可见、可更新。

### 代价

接管意味着**整张卡归本包所有**。四个字段是官方客户端组件的忠实移植
（`apiKeyEnv` 走凭据域、`baseURL`、`maxUses`），另加一个 `model` 字段。上游新增或
变更的字段**不会**被自动继承；升级 dsh 后请对照
`@deepseek-ai/dsh-client-ui-settings-web-search/lib/client.js`。

若不希望承担这一代价，可以改回两张卡：把 `lib/client.js` 中 `plugins.item` 那条注册的
`id` 改为 `"web-search-model"`、去掉 `priority: -1`、把 `order` 改为 41。此时
`plugins.bundle.config` 那条注册必须改为渲染表单而不是 `null`，否则设置只剩下新卡
这一处入口。

## 维护

```sh
python3 check-drift.py
```

脚本会重新读取本插件依赖的全部上游契约，逐条报告 `ok` / `DRIFT`，发现漂移时以
非零状态退出：

| 检查项 | 失败后果 |
|---|---|
| `plugins.item` 仍是 list 槽 | 顶替失效：出现两张卡，或注册抛错 |
| 注册座位仍会分配顶替用的 priority | 同上 |
| `priority` 仍随 entry 存储、`entriesOfSlot` 仍按 id 取每格第一个 | 同上 |
| 官方卡槽 id 仍是 `web-search` | 顶替目标移动 —— 出现两张卡 |
| 官方卡 order 仍是 40 | 仅影响排序，无害 |
| 上游没有本插件未渲染的新字段 | 上游新增的字段不会显示在你的卡上 |
| 命名空间仍是 `web-search-deepseek` | 保存会被宿主拒绝 |
| 本插件用到的 primitives 导出仍然存在 | 卡片渲染直接抛错 |

默认路径与你的安装不符时，把脚本指向本地的 `@deepseek-ai` 包目录：

```sh
DSH_DS_PACKAGES=/path/to/@deepseek-ai python3 check-drift.py
```

脚本找不到的源会报 `skip missing file`，依赖它的检查不执行，其余检查照常决定退出码。
当前 dsh 版本把槽核心打进构建产物 `dsh-web-frontend`，UI primitives 则根本没有独立的
`lib/`，所以 primitives 那一项会报 `skip`。把这条消息理解为「本次安装未能检查」，
而不是「发生了漂移」。

**未覆盖的情况**：官方某个字段的**行为**变了（例如 `apiKeyEnv` 的解析规则），而
字段 id 没变。脚本看不出来，只能人工 diff。

## 模型字段

该字段是**自由文本**（`settingsTextField`）；下拉框列出的已知模型 id 仅作**建议**。

模型 id 是**网关的属性，不是本插件的属性**。写死白名单会重演本包要修的那个 bug：
网关新增了模型，插件却静默过期。因此网关接受的任意 id 都可以手填。

建议列表硬编码在 `lib/client.js` 的 `KNOWN_MODELS`。网关变动后刷新它：

```sh
curl -s -H "Authorization: Bearer $API_KEY" \
  "$GATEWAY_BASE_URL/models" \
  | python3 -c "import sys,json;print('\n'.join(m['id'] for m in json.load(sys.stdin)['data']))"
```

## 目录结构

```
package.json          dsh.bundle.patch 与 dsh.client 声明
cordis.patch.yml      把本包注册为 Loader 的已启用条目（宿主半包本身无行为）
lib/index.js          宿主半包：空的 apply，仅为占一条 Loader 条目
lib/client.js         浏览器半包：真正的实现
check-drift.py        上游契约检查
```

宿主半包必须存在且为空：`dsh-client-modules` 只扫描**已启用的 Loader 条目**来组装
客户端启动图，`dsh.client` 声明的 `./client` 正是经此送达浏览器。官方设置页采用
同样的模式。

## 安装

```sh
# 1. 在 <profile>/package.json 里登记依赖与 bundle：
#    "dependencies": { "dsh-web-search-model": "file:/path/to/dsh-web-search-model" }
#    "dsh.profile.bundles": [ ..., "dsh-web-search-model" ]

# 2. 安装
cd <profile> && pnpm install --prefer-offline

# 3. 确认组合结果
DSH_HOME=~/.dsh dsh --profile <profile> --dump-config | grep -A2 web-search-model

# 4. 重启实例 —— 新增模块根需要重启；仅改配置则是热加载。
```

## 修改源码后必须重新链接

`pnpm install` 以**硬链接**落盘，链接在安装那一刻按内容固定。改动 `lib/` 下任何
文件之后：

- `pnpm install` → *Already up to date*，不会重新链接 ❌
- `pnpm install --force` → 同样不会重新链接 ❌
- `rm -rf node_modules/dsh-web-search-model && pnpm install` → ✅ 唯一可靠的做法

否则 profile 的 `node_modules` 里仍是旧内容，而 `--dump-config` 看不出差别（它读
的是组合，不是内容）。验证：

```sh
cmp /path/to/dsh-web-search-model/lib/client.js \
    <profile>/node_modules/dsh-web-search-model/lib/client.js && echo same
```

## 卸载

从 profile 的 `dsh.profile.bundles` 与 `dependencies` 中删掉那两行，执行
`pnpm install`，然后重启。本包不写任何持久状态，删除后无残留 —— 官方那张卡会自行
恢复。

## 已知限制

- 只新增了 `model`。`apiVersion` 与 `maxTokens` 仍无入口；它们极少需要修改，确需
  修改时直接编辑 `cordis.patch.yml`。
- 建议列表是硬编码的，不会自动跟随网关。见上文的刷新命令。
- 接管了官方卡，因此不继承上游更新。见[代价](#代价)。
- 设置页的「已覆盖 / 恢复默认」来自共享表单模型：清空保存等于回到组合层（即
  `cordis.patch.yml` 中的值），而不是回到插件默认值。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
