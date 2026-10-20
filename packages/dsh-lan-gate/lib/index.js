/**
 * dsh-lan-gate v0.7.0 —— 纯 client shim。
 *
 * 本包现在只剩两件事：
 *   1. cordis.patch.yml 把本包注册成 Loader 已启用条目 —— dsh-client-modules
 *      只扫描已启用的 Loader 条目来组装客户端启动图；
 *   2. package.json 的 dsh.client 声明 ./client，浏览器端拿到
 *      isLoopbackHostname 改写 + 明文 HTTP 非安全上下文的 crypto API 兜底。
 *
 * ## 历史背景：宿主半包为什么没了
 *
 * v0.6.x 之前本文件还有约 400 行「宿主半包」：
 *   - Phase 1：放宽 WebServer host schema + 拦 internal/config 改写 listenHost，
 *     让 dsh 直接绑 Tailscale IP（绕过官方只允许 127.0.0.1 的限制）；
 *   - Phase 2：包装 server.emit 做 tailscale whois 门禁（fail-closed）。
 *
 * 多用户门户（dsh-portal + dsh@.service，实例只绑 127.0.0.1:(42000+uid)，
 * 由门户统一做 PAM 鉴权与会话引导）落地后，实例永远处于 listenHost 为空的
 * 惰性路径，宿主半包不再有任何生效场景，也没有需要兼容的旧部署
 * （单实例 dsh-web.service 已删除）——故整体移除。
 * 需要考古或回归直连模式：checkout tag v0.6.1。
 *
 * ## 形态兼容
 *
 * profile 的 cordis.patch.yml 仍会给本条目传 listenHost / allowedLogins /
 * allowedNodes / enforceWhois 等配置 —— apply 有意接受并忽略它们，
 * 这样旧 profile patch 无需任何修改。
 */

export const name = 'dsh-lan-gate';

// 不声明 inject：宿主侧没有任何行为，不该去等任何一个服务 ——
// 万一服务名变化（或该服务在某些 profile 里不存在），声明 inject 会让 apply
// 永远不执行，排查时会被误判成「插件没加载」。
export function apply() {
  // 纯 client shim：宿主侧无行为。保留入口以满足 Loader 的插件形态。
}
