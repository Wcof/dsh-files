# @dsh/files

宿主无关的本地文件能力插件。DSH 文件管理页面、原生工具与同源 API 共用内核。

## 目录与边界

- `src/protocol/commands.js` 是命令、参数和工具 schema 的唯一来源；保持原 43 条 wire 命令兼容。
- `src/core/` 管理文件操作、授权和资源；不得读取宿主服务。
- `src/adapters/` 只翻译传输与宿主契约，不能复制文件操作逻辑。
- `src/dsh-plugin.js` 是 Cordis 加载入口，根导出同时保留 JS API 并暴露 Cordis 生命周期；patch 必须引用包根，DSH 浏览器模块发现会忽略子路径。
- `client.js` 仅注册 DSH 侧栏与主面板；`web/` 是直接随包分发的原生 HTML/CSS/ESM 页面，不需要构建；`src/adapters/dsh-web.js` 只提供固定静态资产。页面文件操作统一经过现有同源 API，不访问宿主私有数据。
- `locale/` 保存双语插件展示元数据；`web/locale.js` 保存页面文案。页面动态内容用 DOM 文本写入，文本编辑保留 mtime 条件、截断文件不得保存。
- `test/` 使用 Node 内置测试，临时文件和系统命令必须隔离，不操作真实用户文件。
- `scripts/` 保存契约和真实宿主验证入口；外部源码、提取运行时和诊断日志放 `.tmp/<task>/`，不得成为运行依赖。

## 验证与文档

- 必跑 `npm run check`，涉及 DSH 契约再运行 `npm run check:dsh-runtime -- <runtime-node_modules>`。
- 真实运行时检查使用独立 Cordis 上下文和临时目录，不修改已安装 DSH 或用户 profile。
- 页面变更必须验证侧栏发现、静态资产和真实 API 交互；浏览器验证只使用隔离文件目录，覆盖编辑冲突、取消与只读状态。
- `README.md` 记录使用方式；`docs/PLUGIN_CONTRACT.md`、`docs/AGENT_ADAPTERS.md`、`docs/CAPABILITY_MATRIX.md` 记录行为契约；`ROADMAP.md` 记录验证与剩余边界。
- 功能参考 Fanbox，不引入其 UI、终端、会话存储或产品数据依赖。
