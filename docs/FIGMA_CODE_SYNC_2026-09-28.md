# 代码现状回写 Figma · 2026-09-28

本轮以代码为准，把 09-12 之后代码侧的界面变化和 token 结构回写到 [Figma 设计文件](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv)，同时清理 Figma 内的遗留配色与未套样式文字。自此 Figma 重新作为设计权威，`apps/web/src/design/tokens.data.ts` 的 `FIGMA_BINDINGS` 与 Figma 变量名一一对应。

## Token

- 删除 `Shell Light` 模式与 `color/chrome/*`（暖灰加 `#5980a6` 的旧外壳色板），约 1,000 处引用改绑到语义变量；`Workbench Light` 更名为 `Light`。
- 约 2,400 处直接绑定原始色值或未绑定的颜色改为语义变量，修复暗色模式下这些画板不切换的问题。
- 删除仅存在于 Figma 的 `ink`、`bg/navy`、`icon/muted`、`control/accent`、`waveform/*`、`map/*`、`bg/selection-soft`，改用代码实际使用的语义角色。
- 合并重复：`state/ghost-*` 并入 `state/action-hover|pressed`；`status/stale` 更名为 `text/fail`。
- 补齐代码已有的 `text/ok`、`border/ok`、`border/fail`、`team/a`（accent）、`team/b`（`--color-team-b`）。
- 暗色别名统一指向 `dark/<同名语义>`，不再跨角色借用 `media-badge`、`selection-marker` 等。
- Color 集合 70 → 45 个变量，Primitives 156 → 110。

## 文字样式

- 新增与代码组合对应的 `Label/Compact`、`Label/Strong`、`Label/Strong Compact`、`Body/Strong`、`Heading/Subsection`、`Mono/Strong`；`Label/Emphasis` 行高改为 26。
- 合并重复样式 `Metadata/Compact` → `Metadata/Default`、`Label/MediaName` → `Label/Control`。
- 界面页 3,131 个无样式文字套用样式，11 px / 10 px 统一为 12 px。`Heading/Section` 保持 Medium，与代码分区标题 `text-lg font-medium` 一致。

## 画板与组件

- `AppChrome/WindowTitleBar`：蓝灰工具面、分隔线边框、带框通知按钮、直角窗口按钮。
- `Module/ProjectTimeline` 四个视图：默认工具条为播放、分割、撤销、吸附、高级操作；工具栏只露出选择、手形、缩放与更多工具。
- 剪辑工作区 7 张画板：页头为版本、素材状态、剪辑布局菜单、Agent、更多、录制缺失片段、导出成片；成片预览标签、Demo 选材、素材列表/网格浅蓝选中态。
- Demo 资料库：Seg 浅蓝选中态、StatusDot 状态、统一“打开”行操作、筛选按钮带边框；Inspector 持有唯一 primary。
- 比赛概览及分析页头：新建作品降为 secondary；标签按内容排布；指标与代码一致；tick 区间下沉到“精确信息”。
- 工作台：失败任务卡（中性边框、失败色进度、失败提示）、继续、开始选材。
- 组件描述写入对应代码路径。Code Connect 需要组织版或企业版席位，当前不可用。

## 边界

- 未修改的画板保留原有状态示例数据；比赛概览 Inspector 的高光预览为设计领先代码的部分，保留在 Figma。
- 截取网页到 Figma 需要向页面注入外部脚本，本轮未使用；画板同步通过 Plugin API 按代码截图逐项修改完成。
