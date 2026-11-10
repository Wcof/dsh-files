# @dsh/files — 通用文件能力插件

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

包内自带 `dsh.bundle`、`cordis.patch.yml` 和 `@dsh/files/dsh` Cordis 入口。
声明 DSH 范围为 `>=0.2.2-rc.1 <0.3.0`。安装并启用后可直接调用 25 个 `file_*` 工具，使用宿主原生工具结果展示。
在 DSH 侧栏打开「插件 → 添加插件」，粘贴以下 GitHub 地址，查看并安装：

```text
https://github.com/Wcof/dsh-files.git
```

在 [PlugBox](https://github.com/Wcof/PlugBox) 的「安装插件」对话框中也可使用同一地址。

也可以先完全退出桌面版，再使用已安装的 DSH CLI：

```bash
dsh plugin --profile desktop add git+https://github.com/Wcof/dsh-files.git
```

重新打开桌面版后，在对话中要求列目录、读取或搜索文件即可；例如“使用 file_list_dir 列出我的 Downloads”。
Web / headless 使用各自的 profile 名称。这里的安装命令会修改所选 profile；项目检查本身不修改 profile。
开发时可将安装地址换成本地仓库的绝对路径。插件直接运行包内 JavaScript，无需安装时构建。
根导出仍为通用 JS API，DSH 入口不会改变其他宿主接入方式。

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
// 安装组合包时，@dsh/files/dsh 另外向 ctx.tools 注册原生工具。
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
