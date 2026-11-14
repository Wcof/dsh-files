# 统一智能体适配协议

## 为什么是「统一」

原 `@natives/dsh-files` 是**为一个宿主定制的**：它假设 DSH 侧栏 + 主面板 + 一个 iframe 指向
Natives Core 的 `files.html`，因此 DSH 的 API、Natives 的端口 / 数据 / 主题 / 签名嵌入全部缠绕在一起。
换一个智能体就得重写一遍。

本插件把差异压缩到**一个薄适配器**，其余全部共享：

| 共享部分 | 位置 |
|---|---|
| 命令表（43 命令、参数白名单） | `src/protocol/commands.js` |
| 请求校验与错误模型 | `src/protocol/validate.js` / `errors.js` |
| 工具目录（名称、描述、inputSchema） | `src/tool-definitions.js` |
| 能力实现 / 路径授权 / 取消 / 事件 | `src/core/*`, `src/core/service.js` |
| 调用入口 | `service.handle({id, method, params})` 与 `callTool(service, name, args)` |

**新增智能体 = 新增一个 `defineAdapter()` 文件（约 30-60 行），零改动能力代码。**

---

## 1. 适配器契约

```ts
interface HostAdapter {
  name: string;
  start(ctx: { service: FileService; config: object; log: Function }): Promise<any>;
  stop(): Promise<void>;
  describe(): object;
}
```

| 规则 | 说明 |
|---|---|
| R1 | 只能调用 `service.handle()` / `service.call()` / `service.tools()` / `service.describe()` / `service.on()` |
| R2 | 不得自行读取文件、不得复制命令表、不得重写参数校验 |
| R3 | 工具名统一为 `file_<命令>`，工具目录直接来自 `service.tools()` |
| R4 | `stop()` 必须释放监听、定时器与路由；不得关闭宿主拥有的 `process.stdin` |
| R5 | 错误用 `safeMessage()` 脱敏后再交给宿主 |
| R6 | 适配器之间无共享可变状态；多个适配器同时 attach 共享同一个 `FileService` |

注册与创建：

```js
import { defineAdapter, createAdapter, listAdapters } from '@dsh/files';

defineAdapter('my-agent', (options) => ({ name: 'my-agent', start, stop, describe }));
const adapter = createAdapter('my-agent', { /* options */ });
await plugin.attach(adapter);
```

宿主也可以不预注册，直接把符合契约的对象传给 `plugin.attach(adapterObject)`。

---

## 2. 内置适配器

### 2.1 DeepSeek Harness · `dsh`

**不再 iframe 任何 Natives 页面**，不依赖 8770 / `~/.natives` / 产品主题 / 签名嵌入。
安装组合包时，包根 `@dsh/files` 的 `apply(ctx, config)` 向 `ctx.tools` 注册 25 个原生工具。
每个定义包含 `parameters`、`output.schema/render` 和 `execute`，调用复用共享服务并传递取消信号。
`tools` 是必需注入；`webServer` 可选，存在时注册 6 条同源 API 路由和 `/dsh-files/` 静态页面。卸载时释放工具、路由、事件流及内核资源。
包声明 `dsh.client`，`client.js` 用宿主 React 和插槽服务注册左侧「文件」及对应主面板，主面板嵌入本包页面。patch 插件行必须使用包根，DSH 浏览器发现会忽略子路径。页面无独立服务和运行时依赖。

```js
const handle = await plugin.attach({
  name: 'dsh',
  options: {
    hostContext: ctx,          // { webServer, effect }
    panelId: 'universal-files',
    routePrefix: '/agent/files',
    order: 20,
  },
});
// 或在已有 ctx 上手工挂载：handle.apply(ctx)
```

| 路由 | 方法 | 输入 | 输出 |
|---|---|---|---|
| `/agent/files/tools` | GET | — | `{routePrefix, tools:[{name,description,inputSchema,readOnly}]}` |
| `/agent/files/describe` | GET | — | 边界 / 策略 / 能力 / 限制 |
| `/agent/files/rpc` | POST | `{id, method, params}` | 原 wire 响应 |
| `/agent/files/tools/call` | POST | `{name:'file_list_dir', arguments:{...}}` | `{ok, result}` |
| `/agent/files/events` | GET | 同源 EventSource 请求；可选 `path` 指定监听目录 | SSE：`changed`、`fs_changed`、`progress`、`error` |
| `/agent/files/raw` | GET / HEAD | `path` 查询参数；可选 `Range` | 页面内置预览的整文件字节流（200 / 206），不是 wire 命令 |
| `/dsh-files/` | GET / HEAD | 无 | 本包文件管理页面；仅组合包入口注册 |

`/agent/files/raw` 只供随包页面加载图片、PDF、音视频，避免把有界 base64 工具结果当成页面预览上限。它复用 `core/preview.js` 的 `Operation.PREVIEW` 授权，仅接受 image / pdf / audio / video 且排除 SVG，固定 `Content-Type`、`nosniff` 与 `inline`，不新增 wire 命令，也不向智能体工具目录暴露。DSH 适配器只做 `Range` 解析和响应头映射，文件访问仍由 `src/core/` 完成；没有该路由的旧宿主由页面自动回退到 `*_preview` 有界命令。

事件流最多 32 个连接，15 秒发送心跳；慢消费者超过写缓冲后关闭连接，由宿主重连并刷新目录。
带 `path` 的事件流拥有独立监听订阅，断开时释放；同目录其他页面或工具持有的监听不会被停止。静态页只允许固定资产白名单，不将用户文件路径映射为静态 URL。公开 HTML 允许从外部链接顶层导航进入；文件 API 与静态脚本仍拒绝跨站请求。
`fs_changed` 保留 `kind/path/count`，新增 `directory/changes/overflow`；界面应遍历 `changes`，
`overflow:true` 时重新读取目录。事件不持久化，也不代表完整的文件修改历史。

- 复用 DSH 原生 `webServer.register({kind:'exact', path, handler})` 与 `ctx.effect(fn, key)` 形状
  （与 `integrations/dsh/runtime/index.js` 一致），无新依赖。
- 同源校验：拒绝 `sec-fetch-site: cross-site/cross-origin` 与不匹配 `host` 的 `origin`。
- `clientSpec = { panelId, sidebar, main, routePrefix, rendering:'host-owned', note }` 仍供直接 attach API 的宿主参考；组合包的 `client.js` 负责实际页面入口，不打包第二份 React。
- 纯函数 `handle.dispatch({method, path, body, headers, query})` 可脱离 DSH 直接测试。

### 2.2 zcode 及同类 CLI 智能体 · `zcode`

NDJSON over stdio（一行一个 JSON），响应沿用原 wire envelope `{id, ok, result?, error?}`。
帧按请求顺序串行处理，便于按位置关联的 CLI 客户端。

```jsonc
{"id":"1","method":"initialize","params":{"client":"zcode"}}
{"id":"1","ok":true,"result":{"protocolVersion":1,"pluginVersion":"0.2.2","backend":"local","tools":25}}

{"id":"2","method":"tools/list"}
{"id":"2","ok":true,"result":{"tools":[...]}}

{"id":"3","method":"tools/call","params":{"name":"file_list_dir","arguments":{"path":"~"}}}
{"id":"3","ok":true,"result":{"path":"...","entries":[...]}}

{"id":"4","method":"list_dir","params":{"path":"~"}}                 // 原始命令
{"id":"5","method":"file_stat","params":{"path":"~"}}                // 前缀工具名
{"id":"6","method":"describe"}                                      // 自描述
{"id":"7","method":"cancel","params":{"requestId":"..."}}
```

支持 `tools/list` 与 `tools.list`、`tools/call` 与 `tools.call` 两种拼写。
`options: { input, output }` 可注入任意流（默认 `process.stdin/stdout`）。
工具目录前缀统一由 `createFilePlugin({ toolOptions: { prefix } })` 定义，所有 `tools/call` 均按实际目录解析。
示例里的 `tools: 25` 是当前目录的示意值，实际以 `tools/list` 返回为准。

**请求 id**：字符串与数字都接受，响应按宿主原始类型回显（`{"id":2,...}` 回 `"id":2`，
`{"id":"2",...}` 回 `"id":"2"`）。适配器内部把数字 id 转成字符串再交给 wire 层，
因此原始命令（如上面的 `list_dir`）与 `cancel` 都能正常关联；完全不带 id 的帧返回
`{"id":"","ok":false,"error":"invalid request id"}`。
DSH / HTTP 的 `POST /rpc` 直接暴露原 wire 契约，仍要求字符串 id。

### 2.3 通用 MCP 智能体 · `mcp`

标准 JSON-RPC 2.0 over NDJSON stdio，`protocolVersion: 2024-11-05`：

- `initialize` → `{protocolVersion, capabilities:{tools:{listChanged:true}}, serverInfo}`
- `ping` → `{}`
- `tools/list` → 与 DSH / zcode **完全相同**的工具目录
- `tools/call` → `{content:[{type:'text', text: JSON.stringify(result)}], isError:false}`；
  失败时 `isError:true` 且文本为脱敏错误
- `service` 事件转发为 `notifications/file/event`

任何 MCP 兼容智能体（Claude Desktop、Cursor、Cline 等）可直接：

```json
{ "mcpServers": { "files": { "command": "npx", "args": ["@dsh/files", "mcp"] } } }
```

### 2.4 通用 HTTP · `http`

回环 HTTP，默认 `host: 127.0.0.1`、`port: 0`（OS 分配，无端口冲突）。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/healthz` | GET | 存活与 backend 名 |
| `/tools` | GET | 共享工具目录 |
| `/describe` | GET | 边界与配置 |
| `/rpc` | POST | 原 wire 请求 |
| `/tools/call` | POST | `{name, arguments}` |

可选 `Bearer` token（`DSH_FILES_HTTP_TOKEN` 或 `options.token`）、同源校验。

**嵌入模式**：宿主已有 HTTP server 时不必另起监听，用 `listen: false` 只取 handler：

```js
const handle = await plugin.attach({ name: 'http', options: { listen: false } });
hostServer.on('request', (req, res) => {
  if (req.url?.startsWith('/files/')) return handle.handler(req, res);
  // ... 宿主原有路由
});
```

此时不开 socket、不分配端口，`start()` 返回 `{handler, listen:false, prefix}`，
`describe().mode` 为 `injected-handler`。

### 2.5 进程内 · `in-process`

返回 `{call, handle, tools, describe, service}`，供同进程宿主 / 脚本 / 测试直接使用，无传输开销。

---

## 3. 新增一个智能体（完整示例）

假设新宿主用「每行一个 JSON」的私有协议，只需翻译帧格式：

```js
// src/adapters/my-agent.js
import { defineAdapter, readLineStream } from './adapter.js';
import { safeMessage, asFilePluginError } from '../protocol/errors.js';
import { callTool } from '../tool-definitions.js';

defineAdapter('my-agent', (options = {}) => {
  let service;
  let config;
  let detach;

  function write(frame) {
    (options.output ?? process.stdout).write(`${JSON.stringify(frame)}\n`);
  }

  return {
    name: 'my-agent',
    async start({ service: s, config: c, log }) {
      service = s;
      config = c;
      detach = readLineStream(options.input ?? process.stdin, async (frame) => {
        try {
          // 宿主私有帧 -> 统一工具调用
          const result = await callTool(service, frame.tool, frame.args);
          write({ id: frame.id, data: result });
        } catch (error) {
          write({ id: frame.id, message: safeMessage(asFilePluginError(error), config.security) });
        }
      }, log);
      return { write };
    },
    async stop() { detach?.(); },
    describe() { return { transport: 'stdio', framing: 'NDJSON' }; },
  };
});
```

在 `src/adapters/index.js` 加一行 `import './my-agent.js';` 即可。
无需改命令表、校验、能力实现、工具目录或其它适配器 —— 这就是「统一方式」。

---

## 4. 部署形态对照

| 形态 | 命令 | 谁拥有进程 | 是否需要 AiNative |
|---|---|---|---|
| DSH 插件 | `plugin.attach('dsh')` | DSH 宿主 | ❌ |
| zcode 工具进程 | `dsh-files stdio` | 智能体 spawn | ❌ |
| MCP server | `dsh-files mcp` | MCP 客户端 spawn | ❌ |
| 本地服务 | `dsh-files http` | 插件（回环） | ❌ |
| 同进程库 | `import { createFilePlugin }` | 宿主 | ❌ |
| 兼容模式 | `backend:'natives-core'` + 注入 `rpc` | 宿主已有 Core | 可选（协议级） |

## 5. 与旧方案的差异小结

| 维度 | 旧 `@natives/dsh-files` | 本插件 |
|---|---|---|
| 支持宿主 | 仅 DSH | DSH / zcode / MCP / HTTP / 进程内 / 任意自定义 |
| 依赖 | 整个 Natives Core + 8770 + `~/.natives` + 产品前端 | 零 npm 依赖，Node 内置模块 |
| 交付内容 | iframe URL 与面板壳 | 完整文件能力 + 统一工具目录 + 契约 |
| 新增宿主 | 重写插件 | 一个 `defineAdapter()` 文件 |
| 独立运行 | 不行（无 Core 即不可用） | 可以（默认 local backend） |
| 数据 | 共享产品数据库 | 独立插件状态目录；导入暂存与目标同目录，支持跨卷导入 |
