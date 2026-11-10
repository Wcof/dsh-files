# @dsh/files

宿主无关的本地文件能力插件。当前不包含独立 UI，DSH 原生工具与同源 API 共用内核。

## 目录与边界

- `src/protocol/commands.js` 是命令、参数和工具 schema 的唯一来源；保持原 43 条 wire 命令兼容。
- `src/core/` 管理文件操作、授权和资源；不得读取宿主服务。
- `src/adapters/` 只翻译传输与宿主契约，不能复制文件操作逻辑。
- `src/dsh-plugin.js` 是 Cordis 加载入口，`cordis.patch.yml` 引用包的 `./dsh` 导出；根导出保留 JS API。
- `test/` 使用 Node 内置测试，临时文件和系统命令必须隔离，不操作真实用户文件。
- `scripts/` 保存契约和真实宿主验证入口；外部源码、提取运行时和诊断日志放 `.tmp/<task>/`，不得成为运行依赖。

## 验证与文档

- 必跑 `npm run check`，涉及 DSH 契约再运行 `npm run check:dsh-runtime -- <runtime-node_modules>`。
- 真实运行时检查使用独立 Cordis 上下文和临时目录，不修改已安装 DSH 或用户 profile。
- `README.md` 记录使用方式；`docs/PLUGIN_CONTRACT.md`、`docs/AGENT_ADAPTERS.md`、`docs/CAPABILITY_MATRIX.md` 记录行为契约；`ROADMAP.md` 记录验证与剩余边界。
- 功能参考 Fanbox，不引入其 UI、终端、会话存储或产品数据依赖。
