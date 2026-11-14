# @dsh/files -- 文件管理页面与通用文件工具

把原 `AiNative/Natives` 的 file 文件模块解耦成**一个宿主无关、可独立安装运行的文件能力插件**。
同一份能力内核、同一份工具目录、同一套校验规则，以统一方式适配 **DeepSeek Harness（DSH）**、
**zcode** 及同类智能体（MCP / HTTP / 进程内）。

> 与旧 `@natives/dsh-files` 的区别：旧插件只是一层 iframe 薄壳，必须 attach 整个 Natives Core
> （8770 端口、`~/.natives` 数据、产品前端资产、主题参数）。本插件不依赖任何 Natives 模块、
> 进程或数据目录，默认自带完整的本地文件实现。

## 安装与快速开始

零运行时依赖，Node.js >= 20.11，无需 npm install：

```bash
npm test          # 全量单测 + 集成测试（含原项目桥接验证）
npm run check     # 测试 + 契约一致性门禁
```

### 安装到 DeepSeek Harness

包内自带 `dsh.bundle`、`cordis.patch.yml`、包根 Cordis 入口和浏览器页面。
声明 DSH 范围为 `>=0.2.2-rc.1 <0.3.0`。安装并启用后，左侧出现「文件」，点击即可管理文件；同时提供 25 个 `file_*` 工具。
在 DSH 侧栏打开「插件 → 添加插件」，粘贴以下 GitHub 地址，查看并安装：

```text
https://github.com/Wcof/dsh-files.git
```

在 [PlugBox](https://github.com/Wcof/PlugBox) 的「安装插件」对话框中也可使用同一地址。
已订阅 [PlugBox 精选索引](https://raw.githubusercontent.com/Wcof/PlugBox/main/index.json) 时，刷新插件市场并搜索 `@dsh/files`、`DSH Files` 或「文件工具」即可安装。市场版本固定到经过验证的提交。

也可以先完全退出桌面版，再使用已安装的 DSH CLI：

```bash
dsh plugin --profile desktop add git+https://github.com/Wcof/dsh-files.git
```

重新打开桌面版后，点击左侧「文件」进入页面；也可在对话中要求列目录、读取或搜索文件，例如“使用 file_list_dir 列出我的 Downloads”。
Web / headless 使用各自的 profile 名称。这里的安装命令会修改所选 profile；项目检查本身不修改 profile。
开发时可将安装地址换成本地仓库的绝对路径。插件直接运行包内 JavaScript，无需安装时构建。
根导出仍为通用 JS API，DSH 入口不会改变其他宿主接入方式。

### 从旧版升级与页面操作

`0.2.0` 增加文件管理页面，`0.2.1` 修复内置预览、预览区关闭与文件右键菜单交互，`0.2.2` 补齐全局搜索、Markdown／HTML／代码／CSV 预览、列表拖拽移动复制、项目徽章、缩略图、磁盘占用透视与废纸篓入口。已经安装旧版本的用户，在 PlugBox 或 DSH 插件管理中检查更新并安装新版本，然后重启 DSH 窗口。旧配置中的插件行名称应为 `@dsh/files`，旧的 `@dsh/files/dsh` 子路径不能被 DSH 浏览器模块发现；如更新后仍无入口，移除旧插件登记，再使用上面的 GitHub 地址重新添加。

- Finder 风格侧栏、工具栏与路径导航；单击选择，双击文件夹进入，双击文件用系统应用打开。空格或预览按钮打开／关闭预览区。
- `⌘K`／`Ctrl + K` 全局搜索浮层：文件名模糊搜索覆盖全部收藏根，`内容:关键词` 或按钮切换全文搜索，`Tab` 切换「全部位置／当前目录」，↑↓ 选择、Enter 打开、`⌘↵` 用编辑器打开、Esc 关闭；工具栏搜索框（`⌘F` 或 `/`）只搜当前目录及子目录。
- 左侧“收藏位置”由你手动管理：点标题旁的 `+` 输入目录路径，或用左下角“收藏当前文件夹”；文件夹右键菜单也可添加。每项的 `…`／右键菜单支持修改显示名称、目标路径、移除和上移／下移。
- 按住收藏项拖拽可调整顺序，也可用 `Alt + ↑／↓`；拖拽时有插入提示线，`Esc` 或拖出侧栏可取消。名称、目录和顺序保存在当前来源的浏览器中，按宿主平台和个人目录隔离；清空后不重新填入默认目录。移除收藏不影响真实文件，修改收藏也不扩大文件访问权限，只读模式仍可管理收藏。
- 图标／列表两种视图均支持小、中、大三档显示；按名称、修改时间、大小、类型升降序排列，文件夹始终置前。展示偏好保存在当前浏览器，不保存文件路径或内容。
- macOS 使用 Cmd 多选、Enter 重命名、Cmd + Backspace 移到废纸篓；Windows 使用 Ctrl 多选、F2 重命名、Delete 移到回收站。两者均支持 Shift 范围选择、方向键移动、右键菜单、Cmd／Ctrl + C、X、V、A、L、F、S、B（侧栏）、Backspace（上一级）与 1／2 切换视图。全选只选择已加载项目，并遵守批量上限。
- 新建、上传（按钮或把文件拖进列表）、重命名、复制、剪切粘贴、制作副本、废纸篓、ZIP 与解压都连接同一文件内核。列表内直接把条目拖到文件夹上即移动（按住 Alt／⌥ 拖为复制），拖到空白处移入当前目录；目标高亮，拖入自身子树会被拒绝，移动后自动清掉已随剪贴板移动的条目。
- 支持名称和内容搜索、隐藏文件、排序、分批加载与目录变化自动刷新；长列表滚动到底自动加载下一页；文件夹卡片显示 node／web／py／rs／go／git 项目徽章（浅探至多 80 个子目录）。
- 状态栏实时显示已选数量与文件总大小（文件夹不计入）；“更多”菜单与空白右键可直接打开系统废纸篓（`open_trash`）。
- 列表中的图片直接显示懒加载缩略图，解码失败自动回退矢量图标；预览图片铺透明棋盘格，点击进入灯箱，滚轮缩放、点击空白关闭。
- 预览按类型呈现：Markdown 渲染（本地图片走同源路由，代码块语法高亮）、HTML 在隔离沙箱 iframe 中实时渲染（脚本无法访问页面与文件 API）、代码文件语法高亮、CSV／TSV 渲染为表格（前 500 行）、文本可编辑保存；元数据含类型、大小、修改与创建时间、完整路径。外部修改冲突时保留草稿并拒绝覆盖，离开未保存内容时需确认。
- 图片、音视频和 PDF 通过同源整文件流直接内置预览，不再被 `maxPreviewBytes` 误拦截；没有该路由的旧宿主自动回退到有界预览命令。PDF 还需浏览器提供原生查看器。确实无法加载时显示真实原因，可用系统应用打开。
- 文件右键菜单按类型提供预览、编辑文本、打开、用编辑器打开、复制路径、重命名、复制／剪切／粘贴、制作副本、压缩／解压、磁盘占用与废纸篓；空白区域菜单提供新建、上传、粘贴、全选、磁盘占用与刷新。菜单动作与工具栏共用同一套处理函数，键盘与触控手势均可触发。
- “磁盘占用透视”（`更多` 菜单、空白或文件夹右键）按 `disk_usage` 命令渲染条形榜，可点击文件夹下钻、上一级返回，或一键打开该目录；大目录显示截断提示。
- 支持中文、英文、跟随系统／浅色／深色和窄窗口。只读模式禁用写操作；关闭系统命令时，双击文件改用内置预览，废纸篓和归档操作禁用。
- Windows 使用系统 PowerShell 打开／定位文件及送入回收站，路径通过标准输入传入；ZIP 使用 Windows 自带的 `tar`（Windows 10 1803 及以上）。macOS 使用 `open`、`zip`／`unzip` 和 `tar`；其他系统能力可由宿主注入。

需要只读模式时，在该 profile 的 patch 中为 `@dsh/files:tools` 配置
`security: { allowWrite: false }`；支持的完整配置见 `docs/PLUGIN_CONTRACT.md`。

```js
import { createFilePlugin } from '@dsh/files';

const plugin = createFilePlugin({
  homeDir: '/Users/me',
  security: { allowSystemCommands: false }, // 默认开，可关
});
await plugin.backend.init?.();

const roots = await plugin.call('roots');
const listing = await plugin.call('list_dir', { path: '~', limit: 50 });
const written = await plugin.call('write_file', {
  parent: '~/Documents', name: 'note.txt', data: Buffer.from('hello').toString('base64'),
});
await plugin.dispose();
```

三种对外形态，任选其一（见 `docs/PLUGIN_CONTRACT.md`）：

| 形态 | 用法 | 适用 |
|---|---|---|
| JS API | `plugin.call(method, params)` / `plugin.handle(request)` | 同进程宿主、脚本、测试 |
| Agent 工具 | `plugin.tools()` → `file_list_dir` 等 | DSH / zcode / MCP 智能体 |
| 适配器 | `plugin.attach('dsh' \| 'zcode' \| 'mcp' \| 'http' \| 'in-process')` | 实际接入 |

## 架构

```
config ──> AccessPolicy + SystemTools(注入) ──> Backend ──> FileService ──> HostAdapter
                                                  │              │
                                          local(默认) /       统一工具目录
                                          natives-core(可选)   + 事件 + 取消
                                                                │
                                     ┌──────────┬──────────┬────┴────┬─────────┐
                                    DSH       zcode       MCP      HTTP    in-process
```

- **协议层**（`src/protocol/`）：43 个命令、参数白名单、请求校验、错误模型、wire 类型。移植自
  `native-file-host/src/protocol.rs`，是唯一的契约源。
- **能力层**（`src/core/`）：路径授权、目录/文件读写、搜索、预览、归档、批量、分块导入、监听。
  零 Natives 依赖；`backend` 可整体替换。
- **适配层**（`src/adapters/`）：只做「宿主传输 ↔ `service.handle()`」翻译，不含任何文件逻辑。
- **组合根**（`src/host.js`）：把四层拼起来，是唯一知道全局的地方。

新增一个智能体 = 新增一个 `defineAdapter()` 文件，不改能力代码、不改命令表、不改校验。

## 命令行

```bash
dsh-files list-tools                         # 统一工具目录
dsh-files describe                           # 边界 / 配置 / 策略 / 能力
dsh-files call roots
dsh-files call list_dir '{"path":"~"}'
dsh-files stdio                              # zcode NDJSON
dsh-files mcp                                # MCP JSON-RPC 2.0
dsh-files http                               # loopback HTTP
```

## 各智能体接入（同一份插件）

```js
// 已有 DSH 宿主只需同源 API 时：注册 5 条路由（含 SSE），UI 由宿主提供。
// 安装组合包时，包根 @dsh/files 另外注册原生工具和文件页面。
const dsh = await plugin.attach({ name: 'dsh', options: { hostContext: ctx } });

// zcode：CLI agent 拉起子进程，NDJSON 交互
const zcode = await plugin.attach('zcode');   // 或注入 input/output 流

// 同类智能体：标准 MCP
const mcp = await plugin.attach('mcp');

// 一次声明多个，共享同一个 FileService
await plugin.attach(['dsh', 'zcode', 'mcp', 'http']);
```

详细协议见 `docs/AGENT_ADAPTERS.md`。

## 文档

| 文档 | 内容 |
|---|---|
| [PLUGIN_CONTRACT.md](docs/PLUGIN_CONTRACT.md) | **插件边界、对外接口、输入输出、依赖项、配置项**（正式契约） |
| [CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md) | 43 个原命令逐条行为对照与差异清单 |
| [AGENT_ADAPTERS.md](docs/AGENT_ADAPTERS.md) | 统一适配协议、内置适配器、如何接入新智能体 |
| [NATIVES_INTEGRATION.md](docs/NATIVES_INTEGRATION.md) | 原项目最小接入调整与回归结论 |
| [DSH_VERIFICATION.md](docs/DSH_VERIFICATION.md) | DSH 运行时验证方法、功能参考与适用边界 |

## 与 AiNative 的关系

- 本仓库**不 import、不 require、不 spawn** 任何 AiNative 模块；默认配置下不读取 `~/.natives`、
  不连接 8770、不加载产品前端资源。
- 可选 `backend: 'natives-core'` 通过宿主注入的 `rpc()` 转发原命令，用于「已装 Natives Core 时
  100% 复用原 Rust 行为」的场景。这是**协议级对接**，仍是可选、可替换的注入项。
- 原项目的接入是纯增量、可选、默认不影响既有行为，见 `docs/NATIVES_INTEGRATION.md`。
