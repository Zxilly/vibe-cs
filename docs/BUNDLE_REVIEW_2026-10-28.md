# 前端分包检查 · 2026-10-28

页面优化完成后，生产构建仍有两个超过默认 500 kB 的 JavaScript chunk：编辑器工作区约 652 kB、3D renderer 约 577 kB。本轮保留告警阈值，修正提前加载的依赖，并按实际模块边界拆分大型库。

## 原因与处理

依据 source map 估算，`flexlayout-react` 约占编辑器 chunk 生成代码的 31%。将布局库独立分包后，它仍随编辑器加载，但业务代码改动可以保留布局库缓存。这项拆分本身不减少首次打开编辑器所需的总字节数。

原 React vendor 规则使用 `includes('/node_modules/react')`，同时匹配了 `react-markdown`，使 Markdown 解析依赖进入全局加载。现改为精确匹配 React 包目录。Agent 面板使用模块级 `React.lazy` 和面板内 `Suspense`，复用 Dock 已有的按需挂载机制；打开面板时才加载 Agent 和 Markdown。页面需要的 `pendingDeliveryGroup` 移至纯逻辑模块，由页面和面板直接共享。时间线、Program Monitor 和媒体池的挂载路径不变。

3D renderer 已经使用动态导入。其生成代码约 61% 来自 Three.js WebGL 模块、33% 来自 core，业务代码只占很小部分。现按上游 `three.core.js` → `three.module.js` 的依赖方向分包，业务 renderer 保留独立动态入口。三个文件仍在首次显示 3D 时一起加载，首次启用 3D 的总量基本不变；收益是单文件大小和缓存复用。

Vite 配置采用当前的 `build.rolldownOptions.output.codeSplitting.groups`。core 的分组优先级高于 WebGL，以保留实际依赖方向。没有启用按任意大小切片或提高告警阈值。[Vite 构建配置](https://vite.dev/config/build-options)和 [Rolldown 分包说明](https://rolldown.rs/in-depth/manual-code-splitting)解释了对应选项及手动分包对执行顺序的影响。

## 构建结果

以下为同一锁文件下的生产构建大小，单位为十进制 kB，均为未 gzip 的 JavaScript。静态依赖合计由 manifest 的 `imports` 递归计算，每个文件只计算一次，不包含动态导入的语言包、页面和可选功能；它不是浏览器整页传输量。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 编辑器工作区 chunk | 651.98 | 391.85 |
| React vendor chunk | 431.12 | 310.80 |
| 编辑器布局库 | 包含在工作区中 | 203.24 |
| Agent 与 Markdown 面板 | 分散在常驻 vendor 和工作区中 | 按需加载 171.72 |
| 3D renderer | 577.37 | 35.62 |
| Three core | 包含在 renderer 中 | 191.29 |
| Three WebGL | 包含在 renderer 中 | 352.31 |
| 应用入口静态依赖合计 | 859.41 | 742.63 |
| 编辑器静态依赖合计 | 1,486.05 | 1,315.61 |

修改后 68 个 JavaScript chunk 均低于 500,000 bytes，最大为编辑器工作区。入口静态依赖减少约 13.6%，编辑器静态依赖减少约 11.5%。这些是体积结果；没有据此推算启动或交互耗时。

## 自动检查与验证

`pnpm build` 现在在 Vite 构建后执行 `scripts/check-web-bundle.mjs`。它读取真实 manifest 和 source maps，检查单个 JS chunk 不超过 500,000 bytes、静态 chunk 图无循环，并禁止应用入口提前引入 Markdown、Three 和编辑器布局库；编辑器静态依赖也不得包含 Agent 面板、Markdown 或 Three。脚本输出入口和编辑器的合计大小，目前没有对这两个合计数设置数值上限。

- 旧代码的重建产物触发了两个超限和 Markdown/Agent 提前加载检查；修复产物通过。
- 检查脚本的独立样例覆盖共享依赖、动态依赖、超限、静态循环和禁止提前加载的模块，正反向结果符合预期。
- `pnpm lint`、类型检查和生产构建通过；Agent/工作区与 3D 相关测试共 6 个文件、247 项通过。
- 生产 preview 注入现有 IPC fixture：工作台和纯 2D 回放未请求 Three；切换 3D 才请求 renderer、core 和 WebGL；编辑器打开 Agent 面板时才请求 Agent chunk。
- 浏览器确认 3D 首帧、方向键移动视角、播放暂停和返回 2D 正常，没有页面异常。样例作品本身有 3D 机位预演，因此打开该作品时加载 Three 属于实际功能需求。
- 产物图中 `three-webgl` 仅依赖 `three-core`，core 无静态依赖；core、WebGL 和 OrbitControls 源码各只出现一次。

本地日志、资源请求记录和截图位于忽略的 `artifacts/chunk-review-2026-10-28/`。浏览器验证覆盖生产 JavaScript 与 WebGL 渲染，数据仍来自 fixture，不能证明真实录制或导出成功。
