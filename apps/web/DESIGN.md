---
name: Vibe CS
description: 统一、清晰的浅色蓝灰桌面工具，连接创作者剪辑与比赛数据分析。
colors:
  accent: "#3268d6"
  accent-600: "#285abd"
  accent-700: "#214b98"
  accent-800: "#214b98"
  accent-100: "#eef4ff"
  bg: "#ffffff"
  surface: "#f1f3f6"
  surface-chrome: "#f6f7f9"
  text: "#1d1f20"
  neutral-600: "#606c7e"
  neutral-700: "#465265"
  divider: "#dfe3e9"
  action-hover: "#1d1f2012"
  action-pressed: "#1d1f2024"
  on-accent: "#ffffff"
  ok: "#4d7a5a"
  warn: "#a8792f"
  fail: "#a3453c"
  media: "#111827"
  on-media: "#f8fafc"
typography:
  headline:
    fontFamily: "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: "36px"
  title:
    fontFamily: "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: "26px"
  body:
    fontFamily: "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
  reading:
    fontFamily: "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "26px"
  label:
    fontFamily: "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
  metadata:
    fontFamily: "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif"
    fontSize: "12px"
    lineHeight: "18px"
  mono:
    fontFamily: "'Roboto Mono Variable', 'Roboto Mono', monospace"
    fontSize: "12px"
    lineHeight: "18px"
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "999px"
spacing:
  base: "4px"
  panel-gap: "8px"
  panel-inset: "12px"
  content: "16px"
  section: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-600}"
  button-primary-active:
    backgroundColor: "{colors.accent-700}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.neutral-700}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  button-danger:
    backgroundColor: "{colors.fail}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 12px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 12px"
  navigation-current:
    backgroundColor: "{colors.accent-100}"
    textColor: "{colors.accent-800}"
    height: "40px"
    padding: "0 12px"
  badge-accent:
    backgroundColor: "{colors.accent-100}"
    textColor: "{colors.accent-800}"
    padding: "3.6px 12px"
  review-panel:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.sm}"
---

# Design System: Vibe CS

## Overview

**Creative North Star: "统一清晰的浅色蓝灰桌面工具"**

Vibe CS 的两个工作模式共用色彩、字体、导航和反馈语言。剪辑以成片预览与 Timeline 为视觉中心，分析以比赛身份、数据和证据为中心；支持面板应帮助当前任务，避免与主内容争夺注意力。

界面采用浅色蓝灰工作面、清晰的细分隔和紧凑控件。暗色沿用同一语义角色与布局；Program 与视频媒体面保留深色，分析地图沿用 MapCanvas 的语义主题背景和原始雷达图像。面板可调整、可停靠，用户保存的个人布局是实际工作状态。

**Key Characteristics:**

- 同一视觉语言，两种任务层级。
- 蓝色突出主动作、选择与键盘焦点。
- 中文阅读与紧凑数据并存，时间码采用等宽字体。
- 以色阶和边界组织面板，保留桌面工作空间的可调整性。

本规范从已实施的 `src/design/theme.css`、`base.css`、共享 primitives、`design/review` 和 Shell 提取。前置 YAML 记录浅色基准的复用 token；运行时以 CSS 同名语义变量及其暗色覆盖为准。完整色阶和尺寸仍由主题管理，新页面直接引用现有变量，不复制本文件的字面值。

## Colors

低彩度蓝灰承托信息，明确的蓝色承担交互强调。

### Primary

- **工作蓝（accent）**：主要提交动作、当前选择和全局键盘焦点；较深的两个状态承担悬停、按下与链接文字。
- **浅蓝选择面（accent-100）**：导航选中、状态标签和局部选择背景；与深蓝文字成对使用。

### Neutral

- **白色工作面（bg）**：内容面板、表单承载面；**蓝灰底（surface）**与**浅灰工具面（surface-chrome）**区分工作区域和工具栏。
- **深色正文（text）**：主要信息；**辅助灰（neutral-600 / neutral-700）**：元数据、次级说明与普通操作。不要用降低整个容器透明度替代文字角色。
- **细分隔（divider）**：面板、表格和控件边界；action-hover / action-pressed 为普通动作提供中性状态反馈。
- **媒体底与媒体文字（media / on-media）**：Program 与视频媒体面的稳定深色语境。分析地图使用 MapCanvas 既有的 bg 语义背景与原始雷达图像，不统一强制为深色。

成功、警告与失败使用主题已有的 ok / warn / fail 及相应 surface、text、border 配对，呈现为 Notice 或 StatusDot 等反馈；这些语义色不扩展成第二套品牌配色。

**The Action Hierarchy Rule.** 蓝色优先表达主动作、当前选择与焦点；普通 ghost 动作默认使用中性色。

## Typography

**Body / Heading Font:** 随包分发的 Noto Sans SC Variable，回退 Noto Sans SC、sans-serif。
**Label / Mono Font:** 标签沿用正文字体；时间码、tick、路径与精确数值使用 Roboto Mono Variable，回退 Roboto Mono、monospace。

字级根据阅读任务分层：metadata 承担紧凑元数据，label 承担控件，body 承担普通内容，reading 承担 Agent 等连续阅读内容，title 与 headline 建立面板之外的标题层级。更大的标题沿用主题现有阶梯，不能把展示性大字塞进密集工具栏。

YAML 字体角色描述应用组合；HTML heading 的默认样式仍由 base.css 管理，组件按上下文选择主题字号与行高。标题默认较重，控件采用中等字重，表格和媒体标记应保持数字可比较。

**The Reading Role Rule.** 连续阅读内容使用正文或阅读角色；元数据字级不能成为长篇 Agent 内容的默认字级。

## Layout

窗口就是页面边界，页面整体不滚动，内容面板各自滚动。布局基于 spacing.base；面板边界使用 panel-gap，标题、搜索、列表与页脚共享 panel-inset 的内容轴线和滚动条占位。

窗口栏、页面工具栏、面板标题分别使用 `--h-titlebar`、`--h-topbar`、`--h-panel-head`。控件小、中、大、强调四档为 32 / 36 / 40 / 44 px；普通、紧凑、证据与任务行使用主题对应行高，不按页面另建尺度。

剪辑默认 Program 大于 Tactical，素材与 Agent 支持主预览和 Timeline。Dock 负责个人面板几何，允许移动、调整和最大化；新默认比例只作用于新布局或用户显式重置。分析保留比赛身份和跨视图上下文，数据、事件、地图为主，Inspector 为辅助。

Shell 在窗口宽度不超过 1100 px 时折叠为图标栏，提供悬停与键盘焦点标签；次导航转换为横向视图入口，溢出项进入“更多”，当前视图保持可见。比赛上下文栏另有 1600 px 内容折叠点；它不改变 Shell 断点。窄桌面窗口通过折叠和面板滚动保留能力，不视为独立移动产品。

作品工作区在窄窗口复用同一个 FlexLayout 和面板工厂：Program / Tactical 合为标签，Agent / 音轨混音器放入右侧 overlay border。这是原生 Dock 对 Figma 抽屉的适配，不再创建另一套编辑器或 Timeline。窄布局不会替换宽屏的个人布局。素材列表优先，源预览在底部显式展开；重新定位文件只重建源媒体池，不清空面板选择或展开状态。

## Elevation & Depth

静态面板主要以工作面色阶和细边界分层。浮层、菜单和对话框使用主题的 shadow-sm / shadow-md / shadow-lg；暗色阴影同步切换，不能复制浅色阴影到私有样式。焦点 ReviewPanel 使用现有细描边加强关注，不将所有面板抬升为卡片。

**The Surface First Rule.** 固定工作区依靠色阶与分隔组织深度，阴影用于浮层和明确的关注状态。

## Shapes

控件使用 rounded.md，ReviewPanel 使用 rounded.sm，较大容器可以使用主题已有 rounded.lg；圆形滑块和滚动条使用 rounded.full。Dock 内容保持直角并贴合面板边界，选中页签用底边线表示状态。Badge 当前为紧凑矩形，不将胶囊形扩展为全局默认。

## Components

- **Buttons：** primary、secondary、ghost、danger 是同一个 Button 的四个变体。普通按钮水平内边距采用 panel-inset；hero 使用更宽的一档。悬停和按下只改变颜色，不改变盒子尺寸。禁用控件保留原因提示，危险动作与普通操作区分。
- **Inputs：** 默认透明底、细边框，必要时用 ground="bg" 与父面板分离；悬停增强边框，焦点采用 accent。错误通过 invalid 与失败边框表达，禁用使用现有透明度。附加按钮或单位通过 InputGroup 组合。
- **Badges：** 用于状态、计数和上下文；accent、neutral、outline、count 等沿用现有变体。可操作标签使用真实 button / link，不把静态 span 当作按钮。
- **Panels / Cards：** ReviewPanel 提供中性和 focus 边界，容器没有强制固定内边距；内部标题、正文与操作沿共享内容轴线对齐。Dock 中的容器由 Dock 统一边界。
- **Navigation：** 主导航选中使用浅蓝面和左侧细线；折叠后保留图标的可访问名称与焦点标签。次导航横向形态用底边线表达当前视图，不让当前入口藏入溢出菜单。
- **Project Timeline：** 保留唯一 `domain/editing/ProjectTimeline`，所有时间几何使用 `design/timeline`，视觉沿用 `design/review` 与主题。紧凑工具栏选中状态采用浅蓝面；Program Monitor 继续由 Timeline Transport 驱动。
- **选材确认：** 列表、Inspector 和批量动作共享高光来源映射。高光身份独立于回放播放头保存在工作区 URL；确认显示事件、含缓冲录制范围、目标作品、Story 落点和加入后时长。不能从时间定位点猜测最终录制长度。
- **任务反馈：** 顶部作品任务与 Agent 对话共用 `ProjectExecutionCard`，状态来自持久任务接口。恢复已有任务不自动重启 Agent 或执行录制。取消、失败、成功分别表达；成功文件仍需人工观看验收。
- **成品：** 使用 144 px 预览和可比较的文件行，列表不堆叠原生播放器控件。作品名、源版本、完成时间为首要信息；完整文件名、路径和单文件播放放入详情。版本来自 DTO，不能由文件名推断。
- **长内容：** 对话框正文独立滚动，标题和确认操作保持可见；长 Agent 回复提供完整内容入口，不删除原始对话内容。

所有可交互元素保留全局键盘焦点：accent 的 2 px 外轮廓与 2 px 偏移。普通控件只做颜色状态过渡；遵循系统与应用的减少动态效果设置。侧车示例把实际组件的工具类展开为独立 CSS，继续通过 CSS 变量绑定主题。

## Do's and Don'ts

### Do:

- **Do** 在两个模式复用同一主题、控件和反馈语言，并按创作或分析任务安排信息层级。
- **Do** 使用现有语义 CSS 变量，验证浅色与暗色的文字、选择和焦点状态。
- **Do** 保留可调整面板、个人布局、键盘等价操作和明确的禁用原因。
- **Do** 让标题、滚动列表和页脚沿共享内容轴线对齐。

### Don't:

- **Don't** 为页面创建私有调色板、时间轴几何或第二个编辑与 Agent 运行路径。
- **Don't** 通过静默重置用户布局或删减功能来获得整齐截图。
- **Don't** 将普通 ghost 操作全部染蓝，或把元数据字级用于连续长文。
- **Don't** 将旧注释里的 3.4 px 间距、全直角描述或装饰性眉题继承为新页面规范；以当前主题和实际组件为准。
