# DSH 接入验证与功能参考

## 验证入口

```bash
npm run check
npm run check:dsh-runtime -- /absolute/path/to/dsh/node_modules
# 可选第二个参数：已解包的插件目录，用于验证实际分发产物
npm run check:dsh-runtime -- /absolute/path/to/dsh/node_modules /absolute/path/to/unpacked/package
```

运行时脚本使用指定 DSH 自带的 Cordis、ToolsService、原生工具执行器、WebServer 和组合包解析器。
它创建独立上下文、临时测试目录与随机回环端口，不使用模型，不修改用户 profile，不操作用户文件。
验证组合包 patch 与包导出解析、25 个工具注册、真实读写与结果渲染、非法输入、路径拒绝、提前取消、只读模式、HTTP 同源限制、SSE 与卸载重载。

当前验证对象是 macOS 上的 DeepSeek Harness `0.2.2-rc.1`，从已安装应用中提取运行包执行。
静态分析仅用于确定实际包身份和接口，不当作运行成功的证据。
原始应用 ASAR SHA-256：`f21d83abfb33d463822a52c439cc9b15c8245dbce4ae4cf9424c90eae8eba94f`。
REA 静态记录：`ev_e01511af82e6d4919feb354389514e40fb2df8c0fa94e8e6e18b85b709a0e8f9`。

## GitHub 与 PlugBox 分发

`0.1.1` 的运行代码提交为 `9dc5e08caf579486b468ce3265b14fe4ba4c05ee`。
已通过 pnpm 从公开 GitHub 地址安装到隔离目录，并对实际下载的包运行上述 DSH 检查。
[PlugBox 收录申请](https://github.com/Wcof/PlugBox/issues/4) 对应的精选索引固定到此提交；使用真实 DSH 市场服务读取已发布索引，按 `@dsh/files`、`DSH Files`、文件工具均能检索到，兼容判定与安装参数正确。

## 一手参考

- [DSH 组合包安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md)：`dsh.bundle.patch`、安装后 profile 组合、本地目录与 GitHub 安装。
- [DSH 工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/tools.zh.md)：原生注册需要 `parameters`、`output` 和 `execute`，并传递取消信号。
- [Fanbox 功能说明](https://github.com/alchaincyf/fanbox/blob/2ec28c6d3336638e90b11c347162c20d1cb2d4ff/README.md)：文件检索、预览、安全编辑与实时文件变化。
- [Fanbox 事件合并](https://github.com/alchaincyf/fanbox/blob/2ec28c6d3336638e90b11c347162c20d1cb2d4ff/lib/watch-batcher.js)：借鉴“按文件合并、有界批次、溢出刷新目录”的行为，独立实现现有事件契约。
- [Fanbox 安全编辑](https://github.com/alchaincyf/fanbox/blob/2ec28c6d3336638e90b11c347162c20d1cb2d4ff/server.js#L421)：借鉴外部删除应视为编辑冲突的处理。

本次未复制 Fanbox 的 UI、CSS、图标或前端组件，没有增加运行时依赖。

## 适用边界

- “可安装的能力插件”表示 DSH 原生工具和 API；不新增侧栏或独立文件管理页面。
- 自动化使用真实宿主模块与执行器，未在用户正在使用的桌面 profile 内安装，也未发起付费模型对话。
- 其他 DSH 版本和其他操作系统需要运行同一检查后再确认兼容；不能从本次结果推断所有版本无缺陷。
- OS 功能依赖本机命令或注入钩子；验证包含真实 ZIP/TAR，但没有操作用户剪贴板、回收站或打开应用。
- `fs.watch` 提供非递归最终变化通知；启动后会核对一次有界目录名单，补回漏发的创建与删除，但不能补回已有文件的无信号内容修改；不是完整审计日志。溢出或重连后刷新目录。
- 同一插件实例的条件写入串行化；外部进程仍可能在最后一次检查后修改路径，Node 路径 API 无法提供跨进程 CAS 或恶意本地进程隔离。
- 归档成员路径和链接检查不等于解压体积配额；跨盘、系统拒绝访问与磁盘耗尽会返回错误。
