# DSH 接入验证与功能参考

## 验证入口

```bash
npm run check
npm run check:dsh-runtime -- /absolute/path/to/dsh/node_modules
# 可选第二个参数：已解包的插件目录，用于验证实际分发产物
npm run check:dsh-runtime -- /absolute/path/to/dsh/node_modules /absolute/path/to/unpacked/package
```

运行时脚本使用指定 DSH 自带的 Cordis、ToolsService、原生工具执行器、WebServer、ClientModuleRegistry 和组合包解析器。
它创建独立上下文、临时测试目录与随机回环端口，不使用模型，不修改用户 profile，不操作用户文件。
验证组合包 patch 与包导出解析、浏览器模块发现、文件页面与静态资产、25 个工具注册、真实读写与结果渲染、非法输入、路径拒绝、提前取消、只读模式、HTTP 同源限制、SSE 与卸载重载。

当前验证对象是 macOS 上的 DeepSeek Harness `0.2.2-rc.1`，从已安装应用中提取运行包执行。
静态分析仅用于确定实际包身份和接口，不当作运行成功的证据。
原始应用 ASAR SHA-256：`f21d83abfb33d463822a52c439cc9b15c8245dbce4ae4cf9424c90eae8eba94f`。
REA 静态记录：`ev_e01511af82e6d4919feb354389514e40fb2df8c0fa94e8e6e18b85b709a0e8f9`。

## GitHub 与 PlugBox 分发

发布使用 [GitHub 仓库](https://github.com/Wcof/dsh-files)，[PlugBox 收录申请](https://github.com/Wcof/PlugBox/issues/4) 对应的精选索引固定到版本提交。版本发布与安装验证记录集中在 `ROADMAP.md`。
发布验证包括 npm 实际打包、pnpm 从 GitHub 固定提交隔离安装，以及对实际下载的包运行上述 DSH 检查；市场索引用真实 DSH 服务验证包名与双语搜索、兼容判定和固定提交安装参数。

## 页面验证方法

使用真实 DSH WebServer 与文件插件，绑定回环端口并将 `homeDir`、`stateDir` 指向隔离测试目录。浏览器覆盖目录导航、文本保存、外部修改冲突、离开草稿确认、新建、重命名、复制粘贴、Unicode 上传与取消、内容搜索、隐藏文件和图片预览。保存、冲突、上传和废纸篓结果再与磁盘内容对比。
废纸篓与系统打开使用测试处理器；只读配置用独立实例确认按钮禁用与文本仍可预览。桌面和窄窗口分别检查布局，中英文和控制台错误一起核对。侧栏收藏验证覆盖添加、别名／路径编辑、默认项移除、刷新持久化、拖拽／键盘排序、无效／重复／受限目录、取消及只读模式。Finder 页面另覆盖列表／图标、三档尺寸、排序、多选、方向键、右键菜单、预览开关与展示偏好；Windows 路径、快捷键映射与系统命令通过隔离测试检查，不能替代 Windows APP 实机验证。PDF 需要浏览器原生查看器；当前验证浏览器不支持内嵌显示，已验证明确失败提示与系统打开入口，不将其记录为 PDF 渲染成功。

## 一手参考

- [DSH 组合包安装文档](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md)：`dsh.bundle.patch`、安装后 profile 组合、本地目录与 GitHub 安装。
- [DSH 工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/subsystems/tools.zh.md)：原生注册需要 `parameters`、`output` 和 `execute`，并传递取消信号。
- [Fanbox 展示偏好与文件列表](https://github.com/alchaincyf/fanbox/blob/2ec28c6d3336638e90b11c347162c20d1cb2d4ff/public/app.js)：参考视图、尺寸、排序偏好及有界文件列表，不复制视觉代码。
- 本地 Natives 的 `extension/files-entries-renderer.js`、`files-preferences.js`、`files-shortcuts.js`：参考选择、导航与偏好行为，不增加模块或数据依赖。
- [Fanbox 功能说明](https://github.com/alchaincyf/fanbox/blob/2ec28c6d3336638e90b11c347162c20d1cb2d4ff/README.md)：文件检索、预览、安全编辑与实时文件变化。
- [Fanbox 事件合并](https://github.com/alchaincyf/fanbox/blob/2ec28c6d3336638e90b11c347162c20d1cb2d4ff/lib/watch-batcher.js)：借鉴“按文件合并、有界批次、溢出刷新目录”的行为，独立实现现有事件契约。
- [Fanbox 安全编辑](https://github.com/alchaincyf/fanbox/blob/2ec28c6d3336638e90b11c347162c20d1cb2d4ff/server.js#L421)：借鉴外部删除应视为编辑冲突的处理。

本次未复制 Fanbox 的 UI、CSS、图标或前端组件，没有增加运行时依赖。

## 适用边界

- DSH 组合包提供左侧「文件」、随包页面和原生工具；直接 attach API 的其他宿主继续自行提供 UI。
- 自动化使用真实宿主模块与执行器，未在用户正在使用的桌面 profile 内安装，也未发起付费模型对话。
- 其他 DSH 版本和其他操作系统需要运行同一检查后再确认兼容；不能从本次结果推断所有版本无缺陷。
- OS 功能依赖本机命令或注入钩子；验证包含真实 ZIP/TAR，但没有操作用户剪贴板、回收站或打开应用。
- `fs.watch` 提供非递归最终变化通知；启动后会核对一次有界目录名单，补回漏发的创建与删除，但不能补回已有文件的无信号内容修改；不是完整审计日志。溢出或重连后刷新目录。
- 同一插件实例的条件写入串行化；外部进程仍可能在最后一次检查后修改路径，Node 路径 API 无法提供跨进程 CAS 或恶意本地进程隔离。
- 归档成员路径和链接检查不等于解压体积配额；跨盘、系统拒绝访问与磁盘耗尽会返回错误。
