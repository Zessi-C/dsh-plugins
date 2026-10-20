# probe/ — 一次性机制探针（已归档，勿作为部署件使用）

这些脚本是在正式写 `lib/index.js` 之前，用来**确认 dsh 内部机制**的探针。
它们不是插件的一部分，也不需要部署到 <HOST>。留在此处仅为追溯结论来源。

| 文件 | 目的 | 关键结论 |
|---|---|---|
| `host-probe.js` | 注入 25 个候选服务名 + `ctx.get` 探测，dump 服务表 | 取服务要用**服务名**（`webServer`），不是包名 |
| `host-probe2.js` | `inject: ['webServer']`，dump 实例 / Config / server / 路由表 / `ctx.reflect.store` | 拿到 `runtime.Config`、`server`（原生 `node:http` 的 `createServer`）；服务总数 86 |
| `host-probe3.js` | 验证 schemastery schema 能否被改写 | `Config.dict.host.list = [const("127.0.0.1"), const("0.0.0.0")]`，改 `.value` 真实引用有效；`toJSON()` 是快照、改了无效 |
| `host-probe4.js` | 对比三策略：S1 patch-schema / S2 patch-config / S3 own-server+whois | 采用 **S1 + S2 组合**（改 schema 过校验 + `internal/config` waterfall 改写最终值） |
| `patch-s1.yml` / `cordis.patch.yml` | 探针用的 profile patch | — |

## 结论复现要点

1. `--host` 的护栏在**两层**：`dsh-web-app/lib/startup.js:40`（flag 层，纯字符串比较）+ `dsh-host-webserver` 的 schemastery `Config`（zod 层）。只绕一层不够。
2. `internal/config` 是 `Fiber._resolveConfig`（`cordis/lib/index.js:1346`）里的 waterfall：
   `this.context.waterfall(this, "internal/config", config, () => config)`，
   **`this` 是 Fiber**，所以 `ctx.on('internal/config', fn, {global:true, prepend:true})` 里
   用 `this.name === 'WebServer'`（**服务类名**）而不是 loader 条目 id `webserver`。
3. `inject: ['webStartup']` 让 apply 早于 webserver；一旦写成 `['webStartup','webServer']`，
   apply 会晚到 config 校验之后，报 `$.host missing required value`。
4. 必须用 `this.runtime.Config`（当前 fiber 的 runtime），`createRequire` 自己解析出来的那份
   因 pnpm 硬链接会是**不同模块实例**，改了不生效。
5. `socket.pause()` / `prependListener('request')` 都拦不住 http 解析；
   最终采用**包装 `server.emit`**。
