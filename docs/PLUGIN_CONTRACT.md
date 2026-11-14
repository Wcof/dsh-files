# 插件契约 · @dsh/files v0.2.2

> 本文是插件的正式契约：边界、对外接口、输入输出、依赖项、配置项。
> 命令级行为对照见 [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)，智能体接入见
> [AGENT_ADAPTERS.md](AGENT_ADAPTERS.md)。契约由 `npm run check` 强制校验。

---

## 1. 定位与边界

### 1.1 插件做什么

把「一套完整的文件能力」以宿主无关的方式提供给任意智能体宿主：

- 目录浏览 / 元信息 / 磁盘占用 / 快速访问根
- 文本读取、图片 / PDF / 音视频有界预览（工具）；文件页面另用同源整文件流做无上限内置预览
- 名称与内容搜索、全局定位
- 创建、原子写（乐观锁）、重命名、复制、移动、复制副本、批量、回收站
- 归档列表 / 创建 / 安全解包
- 分块导入、文件系统监听、任务取消、事件通知
- 统一工具目录、统一校验、统一错误模型、可插拔 OS 集成
- DSH 左侧「文件」入口和随包分发的文件管理页面，文件操作复用同源 API

### 1.2 插件不做什么（边界外）

| 不做 | 原因 / 由谁负责 |
|---|---|
| 不加载 Natives 或其他产品的 UI | DSH 页面由本包 `web/` 提供；其他宿主可通过 API 自绘 |
| 不代理外部产品页面 | DSH 主面板只嵌入同源 `/dsh-files/`，不连接额外服务 |
| 不管理会话、Cookie、CSRF、Origin、端口租约 | 宿主传输层职责；HTTP/DSH 适配器只做同源校验 |
| 不拥有产品数据库、工作区、主题、偏好、设置 | 原 `workspace_*` / `settings_*` / `preferences_*` 命令不属于 file 能力，未纳入 |
| 不注册 `.app`、Dock、LaunchServices、Native Messaging、登录启动项 | 不是产品，只是可插拔能力 |
| 不读写 `~/.natives`、不硬编码 8770、不加载 `ChromeExtension/` 资产 | 去除 AiNative 强耦合；可选兼容后端由宿主注入 |
| 不把业务数据自动送进模型上下文 | 工具化访问由宿主显式调用，插件不主动推送 |
| 不永久删除文件 | `trash` 一律是移动到回收站（或注入的处理器） |

### 1.3 依赖方向（单向，禁止反向）

```
adapters  ──依赖──>  core/service  ──依赖──>  protocol
   │                      │
   │                      └──> core/backend(接口) <── local / natives-core / 自定义
   └──> tool-definitions ──> protocol/commands
```

- `src/protocol/`、`src/core/`、`src/tool-definitions.js` **不得** import 任何 `src/adapters/` 模块。
- `src/core/local-backend.js` 及其子模块**不得**读取 `process.env`、不得 import AiNative 路径、
  不得使用 `os.homedir()` 作为隐式配置（统一由 `AccessPolicy` 注入的 `config.homeDir` 决定）。
- 只有 `src/config.js` 读环境变量；只有 `src/host.js` 做全局组装。

---

## 2. 对外接口

一共 4 层，全部由 `src/index.js` 导出。**新增智能体只需第 4 层**。

### 2.1 组合入口

```js
createFilePlugin(config?, env?) -> FilePlugin
```

| 成员 | 签名 | 说明 |
|---|---|---|
| `call` | `(method, params?, options?) => Promise<any>` | 结构化 API；失败抛 `FilePluginError` |
| `handle` | `(request) => Promise<FileResponse>` | 原协议 wire API；**永不抛**，错误落在 `error` 字段 |
| `tools` | `() => ToolDefinition[]` | 全智能体共享的工具目录 |
| `describe` | `() => object` | 边界 / 配置 / 策略 / 能力 / 限制的自描述 |
| `attach` | `(adapter \| adapter[] ) => Promise<handle \| handle[]>` | 接入智能体 |
| `start` | `() => Promise<FilePlugin>` | 接入 `config.adapters` 中声明的适配器 |
| `dispose` | `() => Promise<void>` | 停止适配器、取消任务、释放监听与导入会话 |
| `service` / `backend` / `policy` / `config` | 对象 | 供高级宿主直接组合或替换 |

### 2.2 统一工具接口（智能体主用）

```js
plugin.tools() // [{ name: 'file_list_dir', method: 'list_dir', description,
               //    inputSchema: { type:'object', properties, required, additionalProperties:false },
               //    annotations: { readOnlyHint, destructiveHint } }, ...]
```

工具名规则 `file_<命令名>`。所有适配器（DSH / zcode / MCP / HTTP）消费**同一份**目录；
`callTool(service, name, args)` 是共享调用入口。默认只暴露对智能体有意义的工具
（`tool: true`），43 个命令仍全部可通过 `call`/`handle` 调用。
`toolOptions.prefix/include/exclude` 决定实际工具目录，`exclude` 优先，未公开工具不能通过 `tools/call` 绕过。
DSH 原生安装入口为包根 `@dsh/files`；`@dsh/files/dsh` 保留供直接导入，但组合包 patch 必须使用包根以支持浏览器发现，见 `docs/AGENT_ADAPTERS.md`。

### 2.3 统一适配器接口

```ts
interface HostAdapter {
  name: string;
  start(ctx: { service: FileService; config: object; log: Function }): Promise<any>;
  stop(): Promise<void>;
  describe(): object;
}
```

适配器只做两件事：把宿主请求翻译成 `service.handle({id, method, params})`，把 `service` 的
工具目录与事件翻译成宿主形态。**不得**复制能力实现、命令表或校验规则。

方言翻译属于适配器职责：wire 层恒要求字符串 `id`（见 §3.1），而宿主可能用数字 id。
`zcode` 适配器把数字 id 转成字符串下传、并按宿主原始类型回显；`dsh` / `http` 的 `POST /rpc`
直接暴露 wire 契约，不做这层转换。

### 2.4 可替换能力后端接口

```ts
interface Backend {
  name: string;
  init?(): Promise<void>;
  handle(method: string, params: object, ctx: TaskContext): Promise<any>;
  dispose(): Promise<void>;
  capabilities?: object;
}
```

`TaskContext = { requestId, owner, signal: AbortSignal, progress: Function, emit: Function, config }`。
内置 `local`（默认，零依赖）与 `natives-core`（可选，转发原 Core）；宿主可传任意实现。

---

## 3. 输入输出

### 3.1 Wire 协议（与原 AiNative native-messaging 协议一致）

```jsonc
// 请求
{ "id": "req-1", "method": "list_dir", "params": { "path": "~/Documents", "limit": 50 } }
// 成功
{ "id": "req-1", "ok": true,  "result": { /* 见下 */ } }
// 失败
{ "id": "req-1", "ok": false, "error": "path not in allowed directories" }
```

- `id`：1..128 字节非空字符串；`method`：1..64 字节且必须在命令表内；`params` 必须是对象。
- 参数采用**严格白名单**：任何未声明的键 → `unknown parameter: <key>`（移植自
  `protocol.rs::validate_request`）。
- 命令表中的必填项和 `copy/move` 的成对路径在后端调用前验证；`params:null` 拒绝。
- `uploadId` 为 1..128 个英文字母、数字、下划线或短横线，不能包含路径分隔符。
- 字符串参数 ≤ 4 MiB；`import_chunk.data` ≤ 700000 字符；`paths` 为 1..200 项、每项 ≤ 4096 字符；
  `limit` 1..2000；`offset` ≤ 100000；`sortBy` ∈ `name|size|mtime|kind`；`sortDir` ∈ `asc|desc`；
  `conflict` ∈ `rename|skip`；`expectedMtime` 必须是有限数；布尔参数必须真是布尔值。

### 3.2 返回类型（完整声明见 `src/protocol/types.d.ts`）

| 类型 | 关键字段 |
|---|---|
| `FileEntry` | `name, path, isDir, kind, hidden, size, mtime, btime, symlink?, projectBadge?, dirHint?` |
| `ListDirResult` | `path, parent, entries[], project?, hasMore`（分页） |
| `StatResult` | `found, path, name?, isDir?, kind?, size?, mtime?, btime?, symlink?, dirHint?`；不存在返回 `{found:false}` 而非报错 |
| `ReadFileResult` | `content, truncated, size, mtime, kind, encoding`；> 2 MiB 截断到 256 KiB |
| `WriteResult` | `path, mtime, conflict`；旧版本不符或文件被删除时 `conflict:true`，删除时 `mtime:null`；同一实例同一路径串行写入，保留已有文件权限 |
| `PreviewResult` | `data`(base64), `mimeType, size, mtime` |
| `DiskUsageResult` | `path, bytes, files, directories, truncated, errors, items[]` |
| `SearchResult` | `entries[], hasMore, truncated, contentUnavailable` |
| `BatchResult` | `ok, copied?/moved?/duplicated?/trashed?, skipped?, errors[], count, cancelled?`；单项失败不中断批次 |

字段命名、`camelCase` 序列化、目录 4096 字节占位、Finder 式目录优先排序、自然排序
（`file2 < file10`）、毫秒时间戳均与原 Rust 实现一致。

### 3.3 错误模型

wire 的 `error` 恒为**字符串**；内部使用结构化 `FilePluginError { code, message, detail }`。

| code | HTTP | 含义 |
|---|---|---|
| `INVALID_REQUEST` / `UNKNOWN_PARAMETER` / `INVALID_PARAMETER` | 400 | 信封或参数不合法 |
| `UNSUPPORTED_METHOD` | 404 | 命令不在白名单 |
| `FORBIDDEN` / `PATH_DENIED` | 403 | 写被禁用 / 路径越界 / 敏感目录 / `..` / 悬空符号链接 |
| `NOT_FOUND` | 404 | 文件或导入会话不存在 |
| `CONFLICT` | 409 | 目标冲突、导入未完成、mtime 乐观锁冲突 |
| `CAPABILITY_UNAVAILABLE` | 501 | OS 能力被禁用且未注入处理器 |
| `BACKEND_UNAVAILABLE` | 503 | 可选兼容后端不可用 |
| `TOO_MANY_TASKS` | 429 | 重操作并发超过 `maxConcurrentTasks`（仅 `search`/`locate`/`read_file`/`archive_list`/`create_zip`/`extract_archive`/`*_batch`）；`import_begin` 超 `maxConcurrentImports` |
| `CANCELLED` / `TIMEOUT` / `INTERNAL` | 500 | 取消 / 命令超时 / 内部错误 |

安全文案：内部错误与含路径分隔符的消息一律替换为 `文件操作失败`（对齐 `protocol.rs::safe_error`），
避免把绝对路径泄漏给模型或渲染页。结构化 API (`call`) 保留完整错误供宿主记录。

---

## 4. 依赖项

### 4.1 必需依赖

| 项 | 说明 |
|---|---|
| Node.js >= 20.11 | ESM、`AbortSignal.any`、`fs.watch`、`node:test` |
| npm 依赖 | **零**（`dependencies: {}`） |
| Node 内置模块 | `node:fs`, `node:fs/promises`, `node:path`, `node:os`, `node:http`, `node:child_process`, `node:stream` |

### 4.2 可选依赖（全部可注入 / 可关闭）

`security.allowSystemCommands = false` 时，以下 OS 命令一个都不会被调用；启用时默认通过
`config.tools.commandRunner`（默认 `spawn`）调用，宿主可逐个替换成注入处理器：

| 命令 | 用途 | 注入钩子 |
|---|---|---|
| macOS/Linux `zip` / `unzip` / `tar`；Windows `tar` | 归档创建、列表、安全解包 | `archiveHandler` |
| `open` / `xdg-open` / Windows `powershell.exe` | 打开 / 编辑器 / 在访达中显示 / 打开回收站 | `openHandler`, `openTrashHandler` |
| `pbcopy` / `osascript` / `wl-copy` | 路径 / 图片剪贴板 | `clipboardHandler` |
| `mdfind` | 全局定位加速 | `locateHandler` |
| `pdftotext` | PDF 内容搜索 | `pdfTextHandler` |
| macOS/XDG 回收站目录；Windows PowerShell + .NET 系统回收站 | `trash`（移动，非删除） | `trashHandler` |

`security.allowSystemCommands = false` 且未注入对应钩子时，命令返回可读的
`CAPABILITY_UNAVAILABLE`，不会静默降级也不会偷偷执行。

### 4.3 明确不依赖

- ❌ AiNative / Natives 的任何 Rust crate、npm 包、JS 模块或文件路径
- ❌ `native-file-host` 进程、8770 端口、`~/.natives`、`~/.natives-local`
- ❌ `ChromeExtension/` 前端资产、`files.html`、主题 CSS、产品数据库
- ❌ DSH 客户端包、React、zcode SDK、MCP SDK（适配器只用宿主注入的普通对象 / 流）
- ❌ 任何固定监听端口（HTTP 适配器默认 `port: 0`，由 OS 分配）

### 4.4 可选兼容后端

`backend: 'natives-core'` 时，插件通过 `config.backendOptions.rpc(request)`（或 HTTP endpoint）
转发**原样命令**到宿主已有的 AiNative Core，行为即原 Rust 实现。默认不启用、不注入任何
Natives 代码，session/CSRF/Origin 由宿主在 `rpc` 中处理。

---

## 5. 配置项

`createFilePlugin(config, env)` 中 `config` 优先于 `env`。全部项均有默认值。

| 配置 | 类型 | 默认值 | 环境变量 | 说明 |
|---|---|---|---|---|
| `backend` | `'local' \| 'natives-core' \| Backend` | `'local'` | `DSH_FILES_BACKEND` | 能力实现，可整体替换 |
| `backendOptions.rpc` | function | — | — | 兼容后端的注入式 RPC（推荐） |
| `backendOptions.endpoint` | string | `http://127.0.0.1:8770/web/rpc` | `DSH_FILES_CORE_RPC_URL` | 仅兼容后端的回退地址，非代码依赖 |
| `backendOptions.headers` | object | `{}` | — | 供宿主注入会话 / CSRF 头 |
| `backendOptions.timeoutMs` | number | `30000` | — | 兼容后端 RPC 超时 |
| `homeDir` | 绝对路径 | `os.homedir()` | `DSH_FILES_HOME` | `~` 展开与默认允许根 |
| `stateDir` | 绝对路径 | `<home>/.dsh/files` | `DSH_FILES_STATE_DIR` | 插件状态目录；导入暂存改为目标同目录，避免跨卷 hard_link 失败 |
| `tempDir` | 绝对路径 | `os.tmpdir()` | `DSH_FILES_TMP` | 临时目录白名单 |
| `allowedRoots` | string[] | `[]` | — | 额外允许的根（绝对路径） |
| `deniedNames` | string[] | `.ssh, .gnupg, .aws, .config/gh, .kube` | — | 敏感目录黑名单 |
| `externalVolumePrefixes` | string[] | `/Volumes, /media, /mnt` | — | 外部卷前缀 |
| `allowExternalVolumes` | boolean | `true` | — | 卷根只读、其下可写 |
| `security.safeErrors` | boolean | `true` | — | 屏蔽内部错误中的路径 |
| `security.allowWrite` | boolean | `true` | `DSH_FILES_ALLOW_WRITE` | 关掉即只读模式 |
| `security.allowSystemCommands` | boolean | `true` | `DSH_FILES_ALLOW_SYSTEM_COMMANDS` | 关掉即禁用全部 OS 命令 |
| `security.allowControlCommands` | boolean | `true` | — | 关掉即禁用取消类命令 |
| `limits.*` | object | 见下 | — | 所有有界限制，逐项可覆盖 |
| `tools.*` | function | 见 §4.2 | — | OS 能力注入钩子 |
| `events.onChanged / onFsChanged / onProgress / onError` | function | — | — | 事件回调 |
| `adapters` | (string \| descriptor)[] | `[]` | — | `start()` 时接入的适配器 |
| `http.host / port / token` | string / number | `127.0.0.1 / 0 / ''` | `DSH_FILES_HTTP_PORT`, `DSH_FILES_HTTP_TOKEN` | HTTP 适配器；`0` = 系统分配端口 |
| `log` | function | noop | — | 宿主日志（不得记录 token / 文件内容） |

### 5.1 `limits` 默认（对齐原 Rust 常量）

| 键 | 默认 | 键 | 默认 |
|---|---|---|---|
| `maxFullRead` | 2 MiB | `maxTruncatedRead` | 256 KiB |
| `maxImportBytes` | 2 GiB | `maxImportChunkBase64` | 700000 |
| `maxStringParam` | 4 MiB | `maxPathEntry` | 4096 |
| `maxPaths` | 200 | `maxListLimit` | 2000 |
| `maxOffset` | 100000 | `maxSearchResults` | 100000 |
| `maxSearchDurationMs` | 4000 | `maxSearchDepth` | 8 |
| `maxPreviewBytes` | 512 KiB | `maxDiskUsageEntries` | 100000 |
| `maxConcurrentTasks` | 8 | `maxConcurrentImports` | 4 |
| `maxWatchEvents` | 1024 | `watchDebounceMs` | 250 |
| `defaultListLimit` | 500 | `defaultPageWindow` | 100001 |
| `commandTimeoutMs` | 30000 | `maxWatchers` | 64 |

`describeConfig(config)` 返回脱敏后的可序列化配置视图。
`maxConcurrentImports` 限制同时存在的分块导入会话数，超限返回 `TOO_MANY_TASKS`；
`maxConcurrentTasks` 与原宿主一致，**只**对 `search`、`locate`、`read_file`、`archive_list`、
`create_zip`、`extract_archive` 和四个 `*_batch` 生效（原 `main.rs:328-340` 亦如此），
`write_file`、`list_dir`、`stat` 等轻量命令不受该预算限制，智能体可安全并发调用；
任务登记表仍覆盖全部命令，取消与进度回调因此照常可用。
`locateHandler`（即 `mdfind` 加速）失败时回退到有界目录遍历；全文检索不使用仅名称的加速结果。
PDF 内容提取失败标记 `contentUnavailable:true`，不伪装成无匹配。限制配置必须为正安全整数，安全开关必须为布尔值。

---

## 6. 生命周期与事件

```
createFilePlugin() -> backend.init() -> attach()/start() -> 调用 -> dispose()
```

- `dispose()`：逆序停止适配器 → abort 并等待在途任务结束 → 关闭 `fs.watch` → 清理未提交的导入临时文件。
- 取消：`*_cancel` 按 `requestId` abort 信号；搜索、批量和归档子进程协作取消。小型原子操作开始后可能完成；导入会话用 `import_cancel` 清理。
- 并发：`maxConcurrentTasks` 上限由 `FileService` 统一强制。
- 事件（通过 `service.on(type, fn)` 或 `config.events`）：
  `changed`（写命令成功后）、`fs_changed`（监听去噪后）、`progress`（批量 / 导入进度）、
  `error`（内部错误）、`*`（全部，供适配器转发为宿主通知）。
- 文件事件新增 `changes` 数组和 `overflow` 标记，保留同一防抖窗口的所有文件名；超限后宿主刷新目录。
- 停止监听会取消其定时器及尚未发出的事件；监听器异常不改变文件操作结果。

---

## 7. 安全模型

1. **授权句柄**：所有路径先经 `AccessPolicy.authorize()` → 规范化（含不存在目标的最近存在祖先）
   → 拒绝 `..` / NUL / 悬空符号链接 → 黑名单 → 白名单 → 返回 `AuthorizedPath`。
   搜索内容、递归复制和归档子项也分别授权。此实现基于路径 API，不能消除外部进程并发替换路径的所有 TOCTOU 竞态，不能作为恶意本地进程的隔离沙箱。
2. **只读模式**：`allowWrite: false` 在 `FileService` 层统一拒绝全部 `mutates` 命令，后端不接触。
3. **OS 能力显式化**：默认可用但可整体关闭；关闭后不执行任何外部命令，返回明确错误。
4. **归档安全**：拒绝绝对路径 / `..` 成员、链接与设备成员、目标路径中的符号链接；逐成员 WRITE 授权。命令输出超限失败，不使用截断清单。解包不覆盖已有文件（`-n` / `-xk`），不提供磁盘配额或解压体积沙箱。
5. **有界性**：读取、预览、搜索、磁盘统计、批量、导入、监听事件全部有硬上限，
   避免单个智能体请求拖垮宿主。文件页面的 `/agent/files/raw` 不是工具输出：它由浏览器按 `Range`
   自行拉取，走同一 `PREVIEW` 授权且限定媒体类型、同源、`nosniff`；工具侧 `*_preview` 的
   `maxPreviewBytes` 上限保持不变。
6. **错误脱敏**：内部错误不泄漏路径；wire `error` 恒为字符串。
7. **不主动外发**：插件不发起任何对外网络请求；唯一网络行为是可选兼容后端对宿主指定 endpoint 的调用。

---

## 8. 兼容性承诺与已知差异

- **协议兼容**：方法名、参数白名单、请求/响应 envelope、wire 类型、错误文案与原
  `native-file-host` 保持一致；原前端的 `call(method, params)` 可平移到 `plugin.handle()`。
- **命令覆盖**：42 个原 file 命令全部保留，另补 `locate_cancel`（原 main 循环已处理但
  `validate_request` 白名单漏掉）；非 file 命令（`workspace_*`、`settings_*`、`apps:*` 等）不纳入。
- **明确差异**（逐条见 [CAPABILITY_MATRIX.md](CAPABILITY_MATRIX.md)）：
  - `version` 不再写 AiNative 握手标记文件，返回插件自身版本与 backend 标识；
  - `roots` 基于 `config.homeDir` 而非 `dirs::home_dir()`；
  - `list_dir` 的 `probeProjects` 真正生效（原 `list_dir_page_with_options` 未使用该参数）；
  - OS 相关命令改为注入式，未注入且关闭时返回 `CAPABILITY_UNAVAILABLE`；
  - 监听使用 Node `fs.watch`（非递归）而非 `notify` crate；去噪与事件上限策略一致，
    但事件类型改由「目录名单播种 + 窗口末 stat」推断；启动后核对一次有界名单，补回漏发的创建和删除；改名呈现为 `changes` 中的删除和创建，
    窗口内创建后删除可能不产生逐文件记录，超限按目录失效处理。见 CAPABILITY_MATRIX 的 `watch_start` 行。

## 9. 验收

```bash
npm test             # 协议 / 授权 / 文件操作 / 服务 / 后端 / 5 类适配器 / 端到端 / 原项目桥接
npm run check        # 测试 + 命令表 / 工具目录 / 文档 / 版本一致性门禁
npm run check:dsh-runtime -- /absolute/path/to/dsh/node_modules
node bin/cli.mjs describe
```

## 文件管理页面展示契约

页面提供图标／列表、三档尺寸、四种排序和可收起预览。`web/view-state.js` 统一展示偏好、Windows 盘符／UNC 与 POSIX 导航、系统快捷键与选择规则；只持久化视图、尺寸、排序、预览开关和主题。动态名称与路径用 DOM 文本显示。未保存文本切换选择或关闭预览必须确认；取消保持草稿，条件保存继续使用 `expectedMtime`。预览区关闭是纯界面操作，不受进行中的文件操作阻塞；右键菜单按文件类型生成，直接调用与工具栏共享的动作表，并兼容只派发 `pointerup` 的宿主。

列表按 `path → DOM 节点` 键控增量渲染：选择变化与监听刷新复用未变化条目的节点（含已解码的缩略图 `<img>`），行为指纹覆盖名称、类型、时间、大小、项目徽章与查询上下文。图片条目用同源 raw 路由懒加载缩略图，解码失败回退矢量图标；文件夹条目在 `list_dir` 传入 `probeProjects` 时携带 node／web／python／rust／go／git 项目徽章（后端浅探至多 80 个子目录）。

预览按类型分流：Markdown 由 `web/markdown.js` 用受控 DOM 渲染（不解析 HTML 字符串；链接仅允许 http(s)／mailto，本地图片相对路径解析后走 raw 路由，外链 https 图片交由 CSP 放行）；代码文件由 `web/highlight.js` 输出纯文本 span（未知语言退回纯文本）；CSV／TSV 渲染为有界表格（前 500 行）；HTML／HTM 渲染进 `sandbox` iframe；图片预览铺透明棋盘格并可进入灯箱（滚轮缩放、点击空白关闭）。列表键盘与 `⌘K` 全局搜索浮层、`⌘B` 侧栏、`/` 聚焦搜索、Backspace 上一级、`⌘↵` 编辑器打开共用 `view-state` 快捷键表。

“磁盘占用透视”面板调用既有 `disk_usage` 命令，按条形榜展示前 60 项并支持下钻、上一级与打开目录；面板只读，不写文件系统。

列表支持内部拖拽组织：把条目拖到文件夹上调用 `move_batch`（按住 Alt／⌥ 为 `copy_batch`），拖到空白处目标为当前目录；目标文件夹拖入时高亮，候选路径由 `view-state.pathsForDrop` 过滤掉目标自身与其祖先（拖入自身子树一律拒绝），后代拖回父目录交由批量层跳过 no-op。外部文件拖入（`Files` 类型）仍走上传，两类拖拽按 `dataTransfer` 类型区分。只读模式下条目不可拖。移动完成后应用剪贴板同步移除已移走的路径。新建文件夹／文件与上传完成后，页面滚动并选中新条目（`revealEntry`）；长列表滚动接近底部时自动加载下一页，“加载更多”按钮保留兜底。状态栏选中汇总由 `view-state.selectionSummary` 计算：文件夹不计入字节合计。预览元数据展示 `entry.btime` 的创建时间（平台不提供时显示占位符）；“打开废纸篓”走 `open_trash`（os 能力门控），不经页面暴露回收站内容。

### 全局搜索浮层（⌘K）

`web/quick-search.js` 的浮层使用两条既有命令：范围「全部位置」调用 `locate`（文件名模糊，`content: true` 时全文），范围「当前目录」调用 `search`；`内容:`／`content:` 前缀（含全角冒号）切换全文模式。每次输入取消上一个请求（复用 wire 级 cancel 命令），仅展示第一页（60 条），截断时提示；结果高亮为贪心子序列 `<mark>`，全文模式附带后端返回的命中行。Enter 交回页面导航并选中预览，`⌘↵` 交给 `editor` 命令（无系统命令时回退为打开预览）。浮层不持久化任何输入。

### HTML 预览边界

`/agent/files/raw` 对 `text` 类中的 `.html`／`.htm` 返回 `text/html`，并附 `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups` 响应头：文档无论经 iframe 还是顶层直接导航，都运行在不透明源上，拿不到 cookie、凭据与同源文件 API。响应体有界（4 MiB，超出明确报错），并在 `<head>` 注入一段带 `data-dsh-preview` 标记的引导脚本，仅把相对／`file:` 的媒体 `src` 改写到 raw 路由；其余 HTML 字节不变，不支持 Range。页面侧 iframe 再叠加 `sandbox` 属性与 `frame-src 'self'` CSP；页面 CSP 同时放行 `https:` 图片供 Markdown 外链图渲染。

本地后端的 `backendCapabilities.platform` 返回宿主平台，页面据此采用 Cmd／Ctrl、重命名和回收站文案。`search`／`locate` 可选 `sortBy`、`sortDir`；提供排序键时在有界候选集合中先排序再分页，不提供时保持相关度排序。`locate` 的宿主加速钩子（如 macOS `mdfind`）返回的候选全部未通过授权时，回退到内置有界遍历而不是返回空结果。Windows 创建名称拒绝保留设备名、流分隔符和尾点／尾空格；回收站失败返回错误，不降级为永久删除。Windows 跨盘路径压缩明确拒绝。

### 侧栏收藏位置

`web/sidebar.js` 管理收藏交互，`web/places-state.js` 管理独立的收藏存储。首用以宿主 roots 为初始收藏，后续完全按用户保存的列表展示，不按访问频率推断、不重新追加已移除的默认项。最多 64 项，别名不超过 80 个字符；新增或编辑先调用既有 `list_dir` 验证目录类型、可读性和授权，并使用返回的规范路径去重。打开收藏仍由文件 API 重新授权。

本地存储键按平台和配置的个人目录隔离；只记录用户主动收藏的路径、默认根引用、别名与顺序，不保存文件内容或访问历史。损坏／不可用存储使用初始列表，写入失败明确提示只在当前页面生效；空列表是有效设置。Windows 路径去重忽略大小写和分隔符差异。拖拽只在释放于侧栏时提交，取消、失焦、指针取消或页面退出清理捕获、计时器和滚动帧，不改变列表。收藏管理在只读模式下可用，不改动文件系统。
