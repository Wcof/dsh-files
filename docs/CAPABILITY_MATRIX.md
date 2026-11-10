# 能力矩阵 · 原 AiNative file 模块 → 独立插件

对照基线：`AiNative/Natives` @ `deploy / 08ec6dfc`（改动前）。
原实现位置：`crates/file-manager-core/src/file_manager/*.rs`、
`crates/native-file-host/src/{protocol,dispatch,search,preview,watch,import,batch}.rs`、
`crates/native-file-host/src/service/files.rs`。

**结论**：42 个原 file 命令全部保留，另补 1 个被原协议白名单漏掉的 `locate_cancel`；
非 file 域命令（工作区 / 设置 / 偏好 / 应用 / 诊断）不属于文件能力，未纳入插件边界。

图例：**一致** = 方法名、参数、返回形状、错误语义对齐；**增强** = 保留兼容前提下的明确改进；
**注入** = 原为进程内硬编码 OS 调用，现改为可注入 / 可关闭能力；**差异** = 已在契约中声明的行为差别。

## 元信息与浏览

`0.2.0` 的 DSH 文件页面复用下表命令，不新增 wire 命令。覆盖目录与名称/内容搜索、文本预览编辑、分块上传、复制移动、重命名、废纸篓和归档。图片与音视频受预览大小上限约束；PDF 还依赖浏览器原生查看器，不可用时显示说明与系统打开入口。
每个带路径的 SSE 连接独立持有监听订阅；多个页面与工具共享同目录的底层 watcher，只有最后一个订阅释放才关闭。

| 命令 | 输入 | 输出 | 状态 | 说明 |
|---|---|---|---|---|
| `version` | `extensionVersion?` | `{protocolVersion, hostVersion, pluginVersion, backend}` | 差异 | 不再写 AiNative 握手标记文件；返回插件自身版本与后端标识；`extensionVersion` 仅为协议兼容而接受，不产生副作用 |
| `roots` | — | `Array<{id,name,path}>` | 差异 | 基于 `config.homeDir` 而非 `dirs::home_dir()`；仍乐观展示受 TCC 保护的家目录项 |
| `list_dir` | `path, offset, limit, sortBy, sortDir, showHidden, probeProjects` | `ListDirResult & {hasMore}` | 增强 | 目录优先 + 自然排序 + 分页窗口一致；`probeProjects` 真正生效（原 `list_dir_page_with_options` 忽略该参数）；同时返回 `project` 徽标 |
| `stat` | `path` | `StatResult` | 一致 | 不存在返回 `{found:false,path}`；含 `dirHint`、符号链接目标 |
| `disk_usage` | `path` | `DiskUsageResult` | 一致 | 有界递归、符号链接计数但不跟随、`items` 按大小降序 |

## 读取与预览

| 命令 | 输入 | 输出 | 状态 | 说明 |
|---|---|---|---|---|
| `read_file` | `path` | `ReadFileResult` | 一致 | 仅 text kind；> 2 MiB 截断到 256 KiB 并对齐 UTF-8 字符边界；`encoding: 'utf-8'` |
| `image_preview` | `path` | `PreviewResult` | 一致 | 有界 base64 + PNG/JPEG/GIF 魔数校验 + mime 判定 |
| `pdf_preview` | `path` | `PreviewResult` | 一致 | 有界 base64 + `%PDF` 魔数校验 |
| `media_preview` | `path` | `PreviewResult` | 一致 | 有界 base64；接受 audio/video 两类，按实际 kind 返回 mime |

## 搜索

| 命令 | 输入 | 输出 | 状态 | 说明 |
|---|---|---|---|---|
| `search` | `path, query, offset, limit, recursive, content, showHidden` | `SearchResult` | 一致 | 模糊名称评分 + 有界内容搜索（text ≤ 2 MiB / PDF ≤ 20 MiB）；深度 8、4 秒预算、10 万结果上限；`hasMore/truncated/contentUnavailable` |
| `locate` | `path?, query, offset, limit, recursive, content, showHidden` | `SearchResult` | 增强 | 默认从配置的 roots 遍历；注入 `locateHandler` 时优先消费其候选路径（每条仍经过访问策略与 stat 校验），钩子缺失 / 被禁用 / 抛错时静默回退内置遍历，不依赖 macOS 专有索引 |
| `search_cancel` | `requestId` | `{cancelled}` | 一致 | 由 `FileService` 持 AbortSignal（原由 main 循环持 token） |
| `locate_cancel` | `requestId` | `{cancelled}` | 增强 | 原 `main.rs` 已处理但 `validate_request` 白名单漏掉；插件补齐白名单 |
| `preview_cancel` | `requestId` | `{cancelled}` | 一致 | 同上 |
| `batch_cancel` | `requestId` | `{cancelled}` | 一致 | 同上 |

## 归档

| 命令 | 输入 | 输出 | 状态 | 说明 |
|---|---|---|---|---|
| `archive_list` | `path` | `{entries, rejected}` | 注入 | `unzip -Z1` / `tar -tf`；拒绝绝对路径与 `..` 成员并计数；可注入 `archiveHandler` |
| `create_zip` | `paths, dest, name` | `{path, count}` | 注入 | 1..200 路径、目标已存在则拒绝；名称经 `validName` 校验 |
| `extract_archive` | `path, dest` | `{path, count}` | 注入 | 检查路径、链接/设备成员和目标现有符号链接；逐成员授权，再用 `-n` / `-xk` 解包，不覆盖已有文件；不提供解压体积配额 |

## 写入

| 命令 | 输入 | 输出 | 状态 | 说明 |
|---|---|---|---|---|
| `create_folder` | `parent, name` | `{ok:true}` | 一致 | `validName` + 目标 WRITE 授权 |
| `create_file` | `parent, name` | `{ok:true}` | 一致 | 独占创建（不覆盖） |
| `write_file` | `parent, name, data, expectedMtime?` | `{path, mtime, conflict}` | 一致 | **严格** base64（非规范编码一律 `INVALID_PARAMETER`，对齐 Rust `STANDARD.decode`；Node 的 `Buffer.from(...,'base64')` 会静默吞掉非法字符，故解码后回编码比对）→ 同目录 tmp → fsync → rename 原子写；`expectedMtime` 不符返回 `conflict:true` 且不写入 |
| `rename` | `path, name` | `{path}` | 差异 | 同目录改名；已存在目标返回 `CONFLICT`，保留双方文件 |
| `trash` | `path` | `{ok:true}` | 注入 | 移动到回收站（macOS `~/.Trash` / XDG trash），**从不 unlink**；可注入 `trashHandler` |
| `copy` | `from,to` 或 `source,target` | `{path}` | 一致 | 自动去重、防目录自复制、跨设备兼容；`to` 为绝对路径或 `~/...`，相对值按源所在目录解析（宽松兼容，原实现要求完整目标路径） |
| `move` | `from,to` 或 `source,target` | `{path}` | 一致 | rename，`EXDEV` 时复制后删除；拒绝移入自身 |
| `duplicate` | `path` | `{path}` | 一致 | 同目录生成 `name (2).ext` 形式副本 |
| `duplicate_batch` | `paths` | `BatchResult` | 一致 | 逐项报告失败，可取消 |
| `copy_batch` | `paths, dest` | `BatchResult` | 一致 | 目标目录自动创建；`ok/copied/errors/count/cancelled` |
| `move_batch` | `paths, dest` | `BatchResult` | 一致 | 同目录 no-op 计入 `skipped`；拒绝目录移入自身后代 |
| `trash_batch` | `paths` | `BatchResult` | 注入 | 逐项调用注入的回收站处理器 |

## OS 集成（可注入 / 可整体关闭）

| 命令 | 输入 | 输出 | 状态 | 说明 |
|---|---|---|---|---|
| `copy_paths` | `paths` | `{ok:true}` | 注入 | 剪贴板；`clipboardHandler` |
| `copy_image` | `path` | `{ok:true}` | 注入 | 图片剪贴板；`clipboardHandler` |
| `open` | `path` | `{ok:true}` | 注入 | `open` / `xdg-open` / `cmd`；`openHandler` |
| `editor` | `path` | `{ok:true}` | 注入 | 同上，mode=`editor` |
| `reveal` | `path` | `{ok:true}` | 注入 | 同上，mode=`reveal` |
| `open_trash` | — | `{ok:true}` | 注入 | `openTrashHandler`；不向调用方暴露回收站内容 |

> `security.allowSystemCommands = false` 且未注入对应钩子时，以上命令返回
> `CAPABILITY_UNAVAILABLE`（HTTP 501），不静默降级、不执行外部命令。

## 监听与分块导入

| 命令 | 输入 | 输出 | 状态 | 说明 |
|---|---|---|---|---|
| `watch_start` | `path` | `{ok:true}` | 差异 | Node `fs.watch` 非递归，250 ms 合并，最多 64 个目录。单批最多保留 1024 个文件名，事件保留 `kind/path/count` 并增加 `directory/changes/overflow`。启动后核对一次有界目录名单，补回订阅启动期间漏发的创建与删除；count 包含原生信号与核对补回的变化。播种名单与窗口末 lstat 推断创建、修改、删除；重命名表现为两项变化，窗口内创建后又删除可能无记录。超限或无法判断时发目录失效通知，宿主刷新列表 |
| `watch_stop` | `path` | `{ok:true}` | 一致 | 关闭监听、清理定时器并禁止尚未完成的批次继续发事件 |
| `import_probe` | `parent, name` | `{exists}` | 一致 | 仅探测，不创建 |
| `import_begin` | `uploadId, parent, name, size, conflict` | `{uploadId, path, name, size, renamed, skipped?}` | 差异 | 写操作，受只读策略限制。`conflict=rename` 去重；`skip` 命中已存在目标时返回 `skipped:true` 且不创建会话。预留会话名和并发名额；临时文件为目标同目录随机私有文件，跨卷导入不依赖 stateDir 所在卷 |
| `import_chunk` | `uploadId, offset, data` | `{uploadId, received, size}` | 一致 | 同一会话串行处理；连续 offset、严格 base64、实际写入字节数和声明大小均验证 |
| `import_end` | `uploadId` | `{path, size, mtime}` | 一致 | 大小校验后 `hard_link` 原子提交（对齐 `ImportWriter::finish`） |
| `import_cancel` | `uploadId` | `{uploadId, cancelled}` | 一致 | 删除临时文件、释放会话 |

## 未纳入（原项目仍保留，插件不管）

`workspace_*`、`settings_get/set`、`preferences_*`、`space_background_bing`、
`diagnostics_*`、`apps:*`、`app:*`、`model_*` 等属于工作区 / 设置 / 应用运行时域，
不是文件能力。原项目这些功能**未做任何改动**，由宿主自行提供。

## 行为核验方式

| 核验点 | 命令 / 测试 |
|---|---|
| 原协议白名单逐项对齐 | `test/protocol.test.mjs` |
| 路径授权（含 `..`、黑名单、悬空链接、外部卷） | `test/access-policy.test.mjs` |
| 43 命令行为往返 | `test/local-backend.test.mjs` |
| 取消 / 并发 / 事件 / 只读模式 | `test/service.test.mjs` |
| 多智能体共享同一能力实例 | `test/integration.test.mjs` |
| 契约与文档不漂移 | `npm run check` |
| DSH 原生执行器、HTTP/SSE、卸载与重载 | `npm run check:dsh-runtime -- <runtime-node_modules>` |
| 文件保护边界与真实归档工具 | `test/hardening.test.mjs`、`test/system-tools.test.mjs` |
