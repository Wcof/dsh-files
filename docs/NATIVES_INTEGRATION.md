# 原项目（AiNative/Natives）最小接入调整

目标：把 file 能力拆成独立插件后，原项目**只做可选的增量接入**，其余功能零回归。

## 1. 改动清单（4 个文件，全部在 `integrations/dsh/files/`）

| 文件 | 改动 | 性质 |
|---|---|---|
| `agent-tools.js` | **新增**，约 130 行可选桥接 | 纯增量 |
| `index.js` | +1 行 import、+4 行调用与注释 | 纯增量，原 `registerUrlRoute` 调用一行未动 |
| `package.json` | `files` 白名单 +1 项 `agent-tools.js` | 保证 tarball 中静态 import 可解析 |
| `README.md` | 追加「可选：接入独立文件能力插件」一节 | 文档 |

**未改动**：`runtime.js`（生成的 runtime 副本）、`client.js`（侧栏入口 + 主面板 iframe）、
`cordis.patch.yml`、`locale/*`、`icon.svg`、`integrations/dsh/runtime/index.js`、
Core 的 Rust 代码、扩展前端、`extension/*`、任何端口 / 数据 owner / 启动链。

## 2. 接入方式

```js
// index.js（现有逻辑原样保留）
export function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    registerUrlRoute(scoped, { route: '/natives/files/url', target: 'files' });
    attachAgentTools(scoped);   // 新增：可选、懒加载、失败不影响
  });
}
```

桥接只注册 4 条新路径，**不注册也不替换** `/natives/files/url`：

```text
GET  /natives/files/agent/tools
GET  /natives/files/agent/describe
POST /natives/files/agent/rpc
POST /natives/files/agent/tools/call
```

- 插件模块按**首次请求懒加载**：`DSH_FILES_PLUGIN_ROOT` 指向插件 checkout，或 `@dsh/files` 可被宿主解析。
- 插件实例通过统一适配层接入：`plugin.attach({name:'dsh', options:{routePrefix}})`，
  路由 handler 只调用 `dsh.dispatch()`，不复制任何能力或校验逻辑。
- 配置只来自环境变量；桥接默认 `security.allowSystemCommands: false`，
  不引用任何 Natives 内部路径、不读取 `~/.natives`、不连接 8770、不新增监听端口。
- 插件缺失或加载失败 → 新路由返回 503 `plugin-missing`，原有入口、面板与 Core 交互完全不变。
- 关闭方式：不设置 `DSH_FILES_PLUGIN_ROOT` 且不安装 `@dsh/files` 即可（或删除 `attachAgentTools` 一行）。

## 3. 为什么不影响其余功能

1. **不改现有代码路径**：`registerUrlRoute` 的参数、顺序、`ctx.inject` 结构、Client 面板、
   `?theme=`、签名嵌入、runtime 副本一致性全部原样。
2. **不改启动链与生命周期**：桥接是同步注册空 handler，插件对象在首次请求时才创建；
   不启动第二个 Core、不 spawn 进程、不写产品数据。
3. **不改数据 owner**：插件只读写自己 `stateDir` 下的导入临时文件，默认 `~/.dsh/files`；
   与 `~/.natives` / `~/.natives-local` 完全分离。
4. **安全失败**：桥接内部全量 try/catch，注册失败只写 stderr，不抛给宿主。
5. **可回滚**：删除 `agent-tools.js`、还原 `index.js` 的 5 行、`package.json` 的 1 行与 README 一节即可，
   没有任何迁移、schema 或数据变更需要回滚。

## 4. 回归验证

基线（改动前，`deploy / 08ec6dfc`）与改动后逐项对比：

| 门禁 | 基线 | 改动后 |
|---|---|---|
| `npm run dsh:check`（runtime 副本 + 运行时测试） | 7 pass | **7 pass** |
| `npm run standards:check` | 通过 | **通过** |
| `node extension/check-syntax.mjs` | 213 文件 + locale 通过 | **213 文件 + locale 通过** |
| `node extension/files-paths/session/search/transfer/pdf.test.mjs` | 全 OK | **全 OK** |
| `cargo test -p file-manager-core` | 45 passed | **45 passed** |
| `git diff --check` | 干净 | **干净** |
| `node --check` 新增/修改的 JS | — | **通过** |
| `npm pack --dry-run`（files 插件） | 9 文件 | **10 文件**（+`agent-tools.js`），其余条目不变 |
| 插件侧 `npm test` | — | **54 pass / 0 fail** |
| 插件侧 `npm run check`（契约门禁） | — | **43 命令、25 工具、版本一致** |

桥接的两种路径都由 `test/natives-bridge.test.mjs` 覆盖：

- 插件可用：4 条 agent 路由注册、`/tools` 返回统一工具目录、`/rpc` 与 `/tools/call` 返回真实结果，
  且 `/natives/files/url` **未被注册或替换**。
- 插件缺失：返回 503 `plugin-missing`，仍只注册 4 条新路由。

`git status --short` 改动后仅显示 4 个文件，无其它工作区变更。

## 5. 与 ADR-0048 的关系

- 不新增业务 Surface：4 条路由是既有 `files` 插件内的工具端点，不是新入口、新面板、新模块。
- 不违反单实例单数据：桥接不启动 Core，不复制 payload，不产生第二个数据 writer。
- 不放宽鉴权：沿用同源校验；不碰 Cookie / CSRF / Origin / X-Frame-Options / CSP。
- 不把业务数据送进模型上下文：工具化访问需宿主显式调用，桥接不主动推送。
- 四个插件仍可独立安装 / 启用 / 卸载；`runtime.js` 副本逐字节一致性未被改动。

## 6. 启用示例

```bash
# 源码 checkout 中启用（指向独立插件仓库）
export DSH_FILES_PLUGIN_ROOT=/path/to/dsh-files
# 可选：把插件状态目录指到隔离位置，避免写 ~/.dsh
export DSH_FILES_STATE_DIR=/tmp/dsh-files-state
export DSH_FILES_ALLOW_SYSTEM_COMMANDS=0   # 默认即关闭

# 验证
curl -s http://<dsh-host>/natives/files/agent/tools
curl -s -X POST http://<dsh-host>/natives/files/agent/rpc \
  -H 'Content-Type: application/json' \
  -d '{"id":"1","method":"roots","params":{}}'
```
