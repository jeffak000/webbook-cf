# webbook-cf · 极简书签导航站

> 一个跑在 Cloudflare Workers + KV 上的免费、无服务器书签导航站。自带访问密码锁和可分享的免密链接，打开即用，数据自己掌控。
>
> A serverless bookmark hub built on Cloudflare Workers + KV. Password-protected, with shareable keyless links. Free tier, zero backend to maintain, your data stays yours.

---

## ✨ 功能特性 / Features

- **分组 + 分类双层级**：书签按「分组（如 工作/个人）」和「分类（如 工具/影视）」组织，结构清晰。
  Groups + categories two-level organization.
- **全站访问锁**：未输密码前整站锁屏，数据接口全部 401，不泄露任何书签。
  Site-wide access gate: locked page + 401 APIs before auth.
- **免密分享链接**：后台生成 48 位长密钥，凭 `https://你的域名/k/<key>` 直接进入，旧链接可一键作废。
  Keyless share link: a 48-char key grants entry via `/k/<key>`, revocable anytime.
- **图标自动抓取**：按域名自动获取网站 favicon，浏览器端缓存 1 天。
  Auto favicon per domain, client-cached 1 day.
- **后台可视管理**：增删改书签/分类、改站点信息、改密码、管理免密密钥，全部在网页里完成。
  Full in-page admin: CRUD bookmarks, edit site info, rotate password & keys.
- **数据导入导出**：一键备份/恢复全部数据为 JSON。
  One-click JSON backup / restore.
- **极速首屏**：首屏单请求拉全量数据 + localStorage 快照，二次访问秒开。
  Single bootstrap request + localStorage snapshot → instant revisit.
- **长缓存策略**：静态资源按版本号缓存 1 年（immutable），改版自动生效，不必手动清缓存。
  Versioned static assets cached 1 year; new builds auto-refresh.
- **站内全局搜索**：标题 / 网址 / 备注 / 分类名实时过滤并高亮，`Ctrl/⌘+K` 聚焦、`Esc` 清空，跨所有分组与分类一次搜全。
  In-site global search: live filter + highlight across every group & category; `Ctrl/⌘+K` to focus, `Esc` to clear.
- **GitHub 检查更新**：页脚显示当前版本，设置里「检查更新」一键比对 GitHub 最新发行版，有新版直接跳转下载。
  "Check for update" in settings compares against the latest GitHub release and links to downloads.

---

## 🧱 架构 / Architecture

```
浏览器 ──HTTPS──> Cloudflare Worker (worker/index.js)
                    ├─ 访问锁拦截（未登录返回锁屏页 / 401）
                    ├─ /api/*  业务逻辑（书签/分类/图标/登录/免密）
                    ├─ Workers Assets 托管 public/ 静态前端
                    └─ Cloudflare KV (BOOKMARKS) 持久化数据
```

- 前端：`public/index.html` + `public/app.js`（原生 JS，无构建步骤）
- 后端：`worker/index.js`（单文件 Worker）
- 存储：Cloudflare KV 命名空间 `BOOKMARKS`，键为 `data/groups.json`、`data/categories.json`、`data/bookmarks.json`、`data/icons.json`、`data/access.json`、`data/password.json`、`data/site.json`

---

## 📋 环境要求 / Requirements

- 一个 Cloudflare 账号（免费版即可）
- 安装 Node.js（用于运行 wrangler 与 bump.js）
- 一个 Cloudflare **API 令牌**，需权限：
  - `Account > Workers Scripts > Edit`
  - `Account > Workers KV Storage > Edit`
- （可选）自定义域名已接入 Cloudflare；否则用 `*.workers.dev` 默认子域

---

## 🚀 部署步骤 / Deploy

```bash
# 1. 克隆
git clone https://github.com/jeffak000/webbook-cf.git
cd webbook-cf

# 2. 安装 wrangler
npm install wrangler

# 3. 创建 KV 命名空间，复制输出的 id
npx wrangler kv namespace create BOOKMARKS

# 4. 填配置：打开 wrangler.toml，把 account_id 和 KV id 换成你自己的
#    （自定义域名按需取消注释 [routes] 块）

# 5. 部署
npx wrangler deploy
```

部署后访问 `https://webbook-cf.<你的子域>.workers.dev`（或你的自定义域名）。
默认登录密码 `admin`，**请务必在后台设置里改掉，或用 `npx wrangler secret put APP_PASSWORD` 覆盖。**

### 一键部署脚本（可选）

`deploy.example.bat` 是 Windows 部署模板：自动 bump 版本号 → 部署 → 清 CDN 缓存。
把里面的占位符换成你自己的路径和凭据后，重命名为 `deploy.bat` 即可双击使用（已加入 `.gitignore`，不会上传）。

---

## 🔑 访问锁与免密链接 / Access Control

| 场景 | 行为 |
|---|---|
| 未登录访问 | 全站锁屏页，需输站点密码 |
| 数据接口 | 锁开启时全部 401，不泄露书签 |
| 免密链接 ` /k/<key>` | 密钥正确 → 签发 30 天 Cookie → 进站；错误 → 回锁屏页 |
| 后台管理 | 设置里可查看/复制/重生成/自定义免密密钥；可切换访问锁开关 |

> 免密链接适合「发给别人临时看」或「自己换设备免登录」。密钥 48 位，暴力破解不可行。

---

## ⚡ 缓存策略 / Caching

| 资源 | 缓存头 | 说明 |
|---|---|---|
| HTML `/` | `no-store` | 有访问锁，禁止缓存以防状态串号 |
| `app.js?v=<版本>` | `max-age=31536000, immutable` | 带版本号，改版自动取新 |
| 图标 | `max-age=2592000` | 服务端缓存 30 天 |
| 数据接口 | `no-store` | 实时生效 |

首屏通过内联 `window.__boot = fetch('/api/bootstrap?icons=1')` 抢在 `app.js` 下载前发请求，省一个 RTT；
二次访问用 localStorage 快照先渲染，后台静默刷新。

> 已开启 HTTP/3 + 0-RTT（在 Cloudflare 控制台「网络」中启用），对重复访问提速明显。
> `wrangler.toml` 中 `assets.run_worker_first = true` 保证静态资源也经过 Worker，访问锁对前端源码才真正生效。

---

## 💾 备份与恢复 / Backup & Restore

数据存在 Cloudflare KV，不在代码里。建议定期导出：

```bash
# 导出（用你自己的凭据，参考 restore.example.mjs 顶部说明）
node restore.example.mjs backup.json --yes   # 反向即恢复；先不带 --yes 预览
```

`restore.example.mjs` 从 `book-hub-data-backup-*.json` 结构恢复，凭据走环境变量，不写死。

---

## 📝 版本更新记录 / Changelog

| 版本 | 日期 | 更新内容 |
|---|---|---|
| v1.0 | 2026-09-10 | 初版：Cloudflare Workers + KV 部署，基础书签导航（分组/分类/图标/后台管理/导入导出）上线 `book.090803.xyz` |
| v2.0 | 2026-09-10 | 新增全站访问密码锁；后台可生成 48 位免密长密钥，凭 `/k/<key>` 免登录直接进入；修复未登录数据泄露 |
| v3.0 | 2026-09-10 | 性能优化：新增 `/api/bootstrap?icons=1` 单接口（5 请求→1 请求）；HTML 内联预取省一个 RTT；localStorage 快照首帧渲染；Worker 内缓存热点数据；开启 HTTP/3/0-RTT/Brotli |
| v4.0 | 2026-09-11 | 缓存加固：静态资源按版本号长缓存 1 年（immutable），改版自动生效；修复安全缺口——`run_worker_first` 强制静态资源过 Worker，未登录无法下载前端源码；新增 `bump.js` 自动版本号、`deploy.bat` 一键部署+清缓存；代码开源至 GitHub |
| v4.1 | 2026-09-11 | 新增站内全局搜索（跨分组/分类，实时高亮 + `Ctrl/⌘+K` 快捷键）；新增「检查更新」入口（页脚版本号 + 设置里比对 GitHub releases，配套 `version.json` 自检）；Cloudflare 端已上线 `book.090803.xyz` |

---

## 🔒 安全提醒 / Security

- 默认密码 `admin` 必须修改。
- 部署用的 API 令牌/全局密钥不要写进会提交的脚本；优先用 `wrangler secret`。
- 本仓库**不含任何真实凭据**；`wrangler.toml`、`deploy.example.bat`、`restore.example.mjs` 均为占位符模板。

---

## 📄 许可证 / License

MIT © jeffak000 — 自由使用、修改、分发。
