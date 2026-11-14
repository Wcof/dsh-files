# Goal：以 Fanbox 为功能基准补齐文件页面

- 目标：以 `/Users/ldh/Downloads/project/fanbox` 的「文件浏览／搜索／预览」链路为基准，逐项比对 `@dsh/files` 页面并补齐缺失功能；保持当前项目 Finder 风格视觉、双语文案与零依赖无构建形态，不回退为 fanbox 外观。
- 边界：只修改 `dsh-files`；不改 fanbox；43 条 wire 命令与 25 个工具目录保持兼容；不引入终端、agent 会话、产品数据依赖；CSP／同源限制只能收紧不能放松（HTML 预览走 CSP `sandbox` 响应头隔离）。

## 基准比对清单（fanbox → dsh-files）

| # | fanbox 功能 | 当前状态 | 动作 |
|---|---|---|---|
| 1 | ⌘K 全局模糊搜索 + `内容:` 全文 | 页面只有当前目录搜索；后端 `locate` 已实现 | 新增全局搜索浮层（overlay），↑↓ 导航、回车进入/预览，支持 `内容:` 前缀全文 |
| 2 | `/` 当前目录筛选 | 无 | 列表客户端过滤（复用已加载条目，不清空后端结果） |
| 3 | 项目徽章 node/web/py/rs/go | 后端 `probeProjects` 已实现，页面未接 | list_dir 传 `probeProjects`，卡片渲染徽章 |
| 4 | Markdown 渲染预览 | 纯文本 | 新增零依赖渲染器（DOM 构建防注入），本地图片走 raw 路由 |
| 5 | 代码语法高亮 | 纯文本 | 新增轻量高亮器（常见语言，行数上限） |
| 6 | HTML 实时成品预览 | 当纯文本 | raw 路由扩展 html 类型 + `CSP: sandbox` 响应头，页面 iframe `sandbox` 渲染；页面 CSP 增加 frame-src |
| 7 | 透明图棋盘格 | 无 | 预览图棋盘格垫底 |
| 8 | 图片缩略图 | 全部图标 | 网格/列表图片条目懒加载缩略图（raw 路由，失败回退图标） |
| 9 | 磁盘占用透视 | 后端 `disk_usage` 已实现，页面未接 | 「更多」入口 → 磁盘面板：条形榜、下钻、返回 |
| 10 | ⌘↵ 编辑器打开 | 后端 `editor` 命令未在页面暴露 | 菜单 + 快捷键接入 |
| 11 | ⌘B 折叠侧栏 | 只有按钮 | 快捷键接入 |
| 12 | 未保存守卫、Esc/Enter/空格 | 已有 | 保持，回归验证 |
| 13 | HEIC 解码 | 浏览器限制 | 维持现状（图标 + 系统打开），不引入解码器 |

## 验证方式

- `npm run check`（全量测试 + 契约门禁）通过；新增模块各补 Node 单测（渲染器注入防护、高亮语言覆盖、过滤与徽章行为、磁盘面板数据映射）。
- 隔离浏览器页面回归：全局搜索、筛选、徽章、Markdown/HTML/代码/图片预览、磁盘面板、快捷键。
- 真实 DSH 运行时检查按需执行 `npm run check:dsh-runtime`（涉及页面资产清单变化时必须）。

## 交付

- 代码改动集中在 `web/`（新模块 + app/styles/locale/index）与 `src/adapters/dsh-web.js`、`src/adapters/dsh.js`、`src/core/preview.js`（raw 路由 html 支持与 CSP）。
- 更新 `README.md`、`docs/PLUGIN_CONTRACT.md`、`docs/CAPABILITY_MATRIX.md`、`ROADMAP.md`。
- 不推送、不发布，提交由用户决定。
