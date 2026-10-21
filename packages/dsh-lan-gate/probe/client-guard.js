// 登录页里的「后退撞上 bfcache 的 dsh 页面」兜底脚本（server/portal.py 的 LOGIN_PAGE 内联同一份）。
// probe/logout_probe.py 的 D0b 逐字比对两者，改任何一边都要同步另一边。
(function () {
  // 退出登录后浏览器「后退」会撞上 bfcache 里的 dsh 页面：它的 SPA 会照常渲染，
  // 看着像「根本没退出去」。这里在该页被恢复时主动问一次门户「我还登录着吗」，
  // 已登出就换到登录页。只有本页这个「登录页」不是 SPA，才把这段发出去。
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    fetch('/__portal/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
      if (res.status === 401 || res.status === 403) { location.replace('/__portal/login?logout=1'); }
    }, function () {});
  });
})();
