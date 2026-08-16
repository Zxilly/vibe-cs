# 前端全量重构 · 技术选型与代码架构设计

日期：2026-08-15
设计来源：Claude Design 项目 `Vibe CS 重设计`（`f5cf6827-461a-4508-837f-4d18ba7d192f`），16 个画板
能力基线：`docs/PRODUCT_CAPABILITIES_AND_VISUAL_REDESIGN_BRIEF.md`
缺口记录：`docs/DESIGN_COVERAGE_GAPS.md`

## 0. 已锁定的决策

| # | 决策 | 选择 |
| --- | --- | --- |
| 1 | 迁移策略 | 一次性全量重写 `apps/web/src` |
| 2 | 主题 | 浅色 + 按设计稿映射表派生暗色 token |
| 3 | 样式 | Tailwind 4 `@theme` 映射 Industry token |
| 4 | 数据契约 | ~~不动~~ **需要扩展**。设计稿第五、六轮引入的会话模型与修订号在后端不存在，见 §4.6 |
| 5 | 控件高度 | 抬到 32px 底线，归并为 32 / 34 / 38 / 42 四级，无例外 |
| 6 | 服务端数据层 | 引入 TanStack Query |
| 7 | 交互测试 | 新增 jsdom 测试项目（vitest 三项目） |
| 8 | i18n | 引入 Lingui，废弃自研 `msg("mXXXX")` catalog |

---

## 1. 技术选型

### 1.1 保留

| 依赖 | 理由 |
| --- | --- |
| React 19 / Vite 8 / TypeScript 7 | 无更换理由 |
| react-router-dom 7（hash 模式） | Tauri `frontendDist` 走文件协议，必须 hash |
| zustand 5 | 壳层与偏好状态；服务端数据交给 Query，职责收窄 |
| xstate 5 | 从「只有 analysis 用」升格为统一任务生命周期模型，见 §4.3 |
| lucide-react | Industry 明确规定 Lucide、stroke-width 1.5，完全契合 |
| tailwindcss 4 | 已锁定 |
| vitest | 保留，测试分层调整见 §6 |
| `@vitejs/plugin-react` | **不可换成 SWC 版**：Lingui 宏依赖 Babel 变换，见 §5.2 |

### 1.2 移除

> **移除时机**：三个 npm 依赖留到阶段 4，跟 `features/` 一起删。阶段 0 曾按本节把它们从 `package.json` 摘掉，结果 `features/agent/AgentPage.tsx`、`features/editor/EditorTimeline.tsx`、`EditorWaveform.tsx` 立刻解析不到自己的 import，`typecheck` 与 4 个旧 suite 全红——而 §9 风险 2 要求每个阶段收尾时主干是绿的。依赖删除必须与使用点删除同一次提交，本节的其余判断不变。

| 依赖 / 机制 | 当前唯一使用点 | 移除理由 |
| --- | --- | --- |
| `@assistant-ui/react` 0.15.13 | `features/agent/AgentPage.tsx` | 设计稿第六轮确实画了气泡对话流，所以「没有对话」不是理由。真正的理由有二：① 流式传输走 **Tauri `Channel`**，不是 SSE/fetch，该库预置的 runtime 适配器（Vercel AI SDK / LangGraph 等）一个都用不上，必须自写 runtime adapter；② 消息流里约三分之一的条目**不是消息**——`workspace_edit` 通知渲染成一行带分隔线的系统灰字、可展开成 JSON 原文，不进气泡；assistant 消息还内嵌「不用 / 加上」按钮。绕过它的 message model 的成本大于收益 |
| `@xzdarcy/react-timeline-editor` 1.0.0 | `features/editor/EditorTimeline.tsx` | 设计稿 10 号的时间轴是 132px 轨道头 + 绝对定位片段 + 「1 秒 = 12 px」的线框结构，并要求剃刀 / 滑移 / 波纹删除 / 吸附 / 标记。该库自带圆角与主题，视觉语言冲突；版本停在 1.0.0。**最大单点风险，见 §10.1** |
| `wavesurfer.js` 7.12.11 | `features/editor/EditorWaveform.tsx` | 波形与节拍已由 Rust 侧 `media` crate（RustFFT）算好，`analyzeAudioAsset` 直接返回数据。前端只需把数组画成一条 SVG path（设计稿 09 就是这么画的），不需要它的解码与播放能力 |
| 自研 i18n（`shared/i18n/index.ts` 2796 行 + `literals.ts` 2621 行 + `scripts/check-web-i18n.mjs`） | 全站 | 由 Lingui 取代，见 §5 |
| `useAsyncAction` | 全站 | 由 TanStack Query 取代，见 §4.1 |

### 1.3 新增

**生产依赖（2 个）**

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@tanstack/react-query` | 5.101.4（peer React `^18 \|\| ^19` ✓） | 服务端数据层 |
| `@lingui/react` | 6.6.0（传递引入 `@lingui/core`） | i18n 运行时 |

**开发依赖（5 个）**

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@lingui/cli` | 6.6.0 | `extract` / `compile` |
| `@lingui/vite-plugin` | 6.6.0（peer Vite `^6.3.0 \|\| ^7 \|\| ^8` ✓，项目 `^8.2.1`） | 构建期加载编译后的 catalog |
| `@lingui/babel-plugin-lingui-macro` | 6.6.0 | 宏变换 |
| `jsdom` | 最新 | 交互测试环境 |
| `@testing-library/react` | 最新 | 交互测试 |

依赖净变化：生产 **−3 +2 = −1**。

**自托管字体资产**：`Barlow` 与 `Barlow Condensed`（SIL OFL 1.1）的 woff2 子集，落到 `apps/web/public/fonts/`。

> **硬约束**：`apps/desktop/src-tauri/tauri.conf.json` 的 CSP 是
> `default-src 'self' …; font-src 'self' vibe-cs-media: … data:`。
> Industry `styles.css` 顶部的 `@import url('https://fonts.googleapis.com/…')` 在桌面端会被直接拦截，**必须**改成本地 `@font-face`。按仓库惯例在 `THIRD_PARTY.md` 与 `docs/DEPENDENCY_PROVENANCE.md` 登记来源与许可证。

---

## 2. 目录架构

设计稿的界面语言高度收敛——表格＋Inspector、顶栏、分段控件、底部选择条、任务阶段条、证据条目，在 16 个画板里反复出现。所以架构按**三层**组织，而不是按页面各写各的。这直接对治简报 §8.12 指出的三个债务（token 与组件耦合、页面规则与组件规则混排、旧密度与修正层并存）。

```
apps/web/
├─ lingui.config.ts
├─ vite.config.ts             react({babel:{plugins:[lingui-macro]}}) → lingui()
├─ vitest.config.ts           三项目：unit / markup / interaction
├─ public/fonts/              自托管 Barlow woff2
└─ src/
   ├─ main.tsx                QueryClientProvider + I18nProvider + RouterProvider
   │
   ├─ locales/                ← Lingui catalog（.po 源 + 编译产物）
   │   ├─ zh-CN/messages.po
   │   └─ en-US/messages.po
   │
   ├─ design/                 ← 第 1 层：设计系统。页面不得绕过
   │   ├─ theme.css           @theme + 暗色覆盖（唯一 token 源）
   │   ├─ fonts.css           自托管 @font-face
   │   ├─ base.css            元素级、focus-visible、::selection、reduced-motion
   │   ├─ primitives/         Button Tag Seg Field TextInput Toggle Slider Checkbox Link
   │   ├─ layout/             Page Toolbar SubNav Inspector SelectionBar SplitPane Blueprint
   │   ├─ data/               DataTable TableCell Pagination EmptyState Skeleton
   │   └─ feedback/           Notice Dialog Drawer StatusDot StageBar ProgressBar
   │
   ├─ domain/                 ← 第 2 层：跨页面复用的领域组件
   │   ├─ match/              MatchContextBar RoundTimeline Scoreboard EvidenceRow HighlightRow
   │   ├─ map/                MapCanvas HeatLayer PathLayer EngagementLayer CameraPathLayer
   │   ├─ media/              Transport Waveform ClipStrip FilmStrip Timeline(自研)
   │   ├─ task/               TaskCard StageTimeline TaskDetail RetryNotice
   │   └─ agent/              ProposalDiff ShotCard(可编辑) TakeCard ContextChips ImpactPanel
   │                          SessionDrawer SessionCard ConversationStream
   │                          WorkspaceEditNotice StaleChangeCard RevisionBadge
   │                          OriginTrail ObjectRefChip ReferencePicker
   │
   ├─ app/                    ← 第 3 层上半：壳层
   │   ├─ AppShell.tsx        TitleBar + SideNav + Outlet + AgentRail
   │   ├─ TitleBar.tsx        44px 自绘标题栏
   │   ├─ SideNav.tsx         216px / 56px 两态
   │   ├─ AgentRail.tsx       46px / 380px 两态
   │   ├─ CommandPalette.tsx  Ctrl K
   │   ├─ ServiceGate.tsx     本地服务离线全局降级
   │   ├─ RouteBoundary.tsx   错误 / 加载 / 未找到
   │   └─ routes.tsx
   │
   ├─ pages/                  ← 第 3 层下半：12 个页面
   │   ├─ home/  library/  history/  players/  evidence/
   │   ├─ match/              9 个子视图
   │   ├─ agent/              2a / 2b / 2c
   │   ├─ recording/  montage/  editor/
   │   ├─ delivery/           输出 + 任务记录 + 任务详情
   │   ├─ settings/           5 节
   │   └─ recovery/
   │
   ├─ data/                   ← Query 层：queryKeys + 每个领域一个 hooks 文件
   │   ├─ queryClient.ts      默认项（见 §4.1）
   │   ├─ keys.ts             集中的 queryKey 工厂
   │   ├─ demos.ts players.ts evidence.ts tasks.ts outputs.ts config.ts
   │   ├─ sessions.ts         会话列表 / 引用 / 重命名 / 删除
   │   ├─ plans.ts            方案读写 + 修订号 + 手动编辑 mutation
   │   └─ editNotifier.ts     5 秒合并窗口 → workspace_edit 通知（§4.5）
   │
   └─ shared/                 ← 原样保留，不重写
       ├─ desktop/            141 个 client 方法 + dto + 契约测试（IPC 面见 §4.7）
       └─ stores/             zustand（hooks/ 随 useAsyncAction 一起删除，
                              它是目录里唯一的文件）
```

### 2.1 分层约束（由 lint 强制）

新增 `scripts/check-web-layers.mjs`，照已被删除的 `check-web-i18n.mjs` 的先例接进 `pnpm lint`：

1. `design/**` 不得 import `domain/**`、`pages/**`、`app/**`、`data/**`、`shared/desktop/**`
2. `domain/**` 不得 import `pages/**`、`app/**`
3. `pages/**` 与 `app/**` 之间不得互相 import
4. `pages/**`、`app/**`、`domain/**` 源码中不得出现裸 hex（`#rgb` / `#rrggbb`）
5. `pages/**`、`app/**` 中不得出现 Tailwind 任意值语法里的字号与颜色（`text-[13px]`、`bg-[#5980a6]`）；尺寸类任意值（`w-[380px]`）允许，但需在 §3.5 的宽度 token 里有对应项
6. `pages/**`、`domain/**` 不得直接 import `shared/desktop/client`；服务端读写一律经 `data/**`

第 4、5 条是关键——今天的债务正是「页面私有覆盖比组件 API 更容易生效」。第 6 条保证缓存失效不会被绕过。

---

## 3. Token 归纳

**这一节是最需要逐条看的部分。** 设计稿是手写内联样式，充满 `height:34px`、`font-size:13px`、`#4d7a5a`。逐字照搬会把裸值全量带进代码，退回今天的状态；归并过狠又会失真。下面是归并提案。

### 3.1 颜色

Industry 的 `--color-*` 全量进 `@theme`，另把设计稿反复出现的**状态裸色收编成 token**：

| Token | 浅色 | 暗色 | 出处 |
| --- | --- | --- | --- |
| `--color-ok` | `#4d7a5a` | `#6ea87f` | 宿主已验证完成、校验通过 |
| `--color-warn` | `#a8792f` | `#d3a85f` | 等待确认、穿墙风险、生命周期不完整 |
| `--color-fail` | `#a3453c` | `#cf7a72` | 失败、文件缺失、服务离线 |
| `--color-ok-surface` | `#eef4ee` | 派生 | 成功 Notice 底 |
| `--color-warn-surface` | `#f7efdd` | 派生 | 警告 Notice 底 |
| `--color-fail-surface` | `#f7ecea` | 派生 | 失败 Notice 底 |
| `--color-warn-border` | `#d8bb86` | 派生 | 警告镜头卡边框 |
| `--color-fail-border` | `#c9a8a3` | 派生 | 失败卡边框 |
| `--color-team-b` | `#c9a55a` | 派生 | 对方阵营（回合时间线、雷达标记） |

暗色三个语义色直接取设计稿映射表；surface / border 由对应语义色按同一算法派生，不逐个手挑。

### 3.2 字号

设计稿出现 21 种字号（9–56）。归并为 10 级：

| Token | px | 用途 |
| --- | --- | --- |
| `--text-2xs` | 11 | 分组标题（letter-spacing .16em）、徽标、图例 |
| `--text-xs` | 12 | 元数据、说明、次级说明 |
| `--text-sm` | 13 | 表格内容、小按钮、链接 |
| `--text-base` | 14 | 正文、控件、表格主列 |
| `--text-md` | 15 | 段落 |
| `--text-lg` | 17 | 卡片标题、片段标题 |
| `--text-xl` | 19 | 面板标题、子视图标题 |
| `--text-2xl` | 22 | 页面标题 |
| `--text-3xl` | 26 | 画板标题 |
| `--text-4xl` | 40 | 章节大标题 |

被吸收：9/10→11，16→15，18→17 或 19，20/21→19 或 22，24/25→22 或 26，32→26；42/56 仅出现在设计稿的说明层，不进产品。等宽字复用同一级。

### 3.3 控件高度（决策 5）

设计稿出现 28/30/32/34/36/38/40/42 八种，其中 28 / 30 与简报 §15.3「交互控件不低于 32px」冲突。**已决定抬到 32px 底线**，归并为 4 级、无例外：

| Token | px | 用途 |
| --- | --- | --- |
| `--h-ctl-sm` | 32 | 卡内次级动作、工具栏（吸收原 28 / 30） |
| `--h-ctl-md` | 34 | 顶栏动作、筛选器、表单控件（吸收原 36） |
| `--h-ctl-lg` | 38 | Inspector 主按钮（吸收原 40） |
| `--h-ctl-hero` | 42 | 「确认并生成视频」等终局动作 |

受影响处：Agent 2a 变更卡的「预览这条 / 拒绝 / 接受」、多轨编辑器工具栏、节拍建议卡的「预览 / 应用」。这些位置会比设计稿略松，需在 1100×700 下复核不溢出。

### 3.4 行高与栏高

| Token | px | 用途 |
| --- | --- | --- |
| `--h-titlebar` | 44 | 自绘标题栏 |
| `--h-topbar` | 56 | 页面顶栏 / 比赛上下文栏 |
| `--h-bar` | 46 | 次级栏（筛选条、上下文条、任务记录头） |
| `--h-panel-head` | 40 | 面板头、Inspector 头（吸收原 38 / 44） |
| `--h-thead` | 34 | 表头（吸收原 32） |
| `--h-row` | 42 | 表格行（设计稿明写的密度契约） |
| `--h-row-compact` | 38 | 密集列表（吸收原 34 / 36 / 40） |
| `--h-row-evidence` | 52 | 双行证据条目 |
| `--h-row-task` | 64 | 工作台首页的双行任务行（阶段 0 补） |
| `--h-composer` | 80 | Agent 输入区（吸收探索稿的 66，阶段 0 补） |
| `--h-actionbar` | 92 | 页面底部终局动作条（吸收双行版的 96，阶段 0 补） |

最后三行是阶段 0 落地时补的：它们在归纳阶段被列为「无处可归」，因为离最近的 token 有 10–40px，远超本表任何一次归并的幅度（最大 4px）。定值依据逐条记在 `design/tokens.data.ts` 的 `BAR_HEIGHT_MERGE` 里。

### 3.5 面板宽度

设计稿出现 17 种（132–520）。归并为 7 级：

| Token | px | 用途 |
| --- | --- | --- |
| `--w-nav` | 216 | 主侧栏展开（收起 `--w-nav-collapsed: 56`） |
| `--w-agent-rail` | 46 | Agent 竖条收起（展开复用 `--w-inspector`，380） |
| `--w-subnav` | 190 | 比赛工作区视图导航、玩家名单（吸收 180/200/220/270） |
| `--w-panel` | 340 | 片段列表、属性面板（吸收 310/330/360） |
| `--w-inspector` | 380 | 标准 Inspector（吸收 400） |
| `--w-inspector-wide` | 440 | 宽 Inspector（吸收 420/460） |
| `--w-split` | 520 | 交付页任务记录栏（对半分栏） |
| `--w-track-head` | 132 | 多轨时间轴轨道头（阶段 0 补，同时供 132×74 素材缩略图使用） |

暗色画板把轨道头画成 110。宽度 token 不随主题变——两个主题里装的是同一串轨道名——按正稿的 132 统一。

### 3.6 间距与圆角

`--spacing: 3.4px`（Industry 0.85× 密度基数）。Tailwind 4 的 `p-2` = 6.8px、`p-4` = 13.6px，与 Industry `--space-2` / `--space-4` 精确对齐。
`--radius-*: 0`。Industry 组件层已把 `.card/.btn/.input/.tag/.seg/.dialog` 全部压成方角，圆角在这个系统里只属于 `.radio .dot`。

---

## 4. 状态与数据

### 4.1 服务端数据：TanStack Query（决策 6）

`data/` 目录承载全部服务端读写，`pages/**` 与 `domain/**` 不得直接 import `shared/desktop/client`（§2.1 第 6 条）。

**QueryClient 默认项**——桌面 Tauri 环境与浏览器不同，默认值必须显式覆写：

| 选项 | 值 | 理由 |
| --- | --- | --- |
| `refetchOnWindowFocus` | `false` | 桌面应用频繁切窗口，默认 `true` 会造成用户感知不到的重复 IPC |
| `retry` | `false` | Tauri IPC 失败基本是确定性错误（服务未启动、路径不存在），重试只会延迟错误呈现。个别命令按需单独开 |
| `staleTime` | 30_000 | 本地数据变更由显式动作驱动，不需要激进新鲜度 |
| `throwOnError` | `false` | 错误就地渲染成 Notice（设计稿规定「不用 Toast 承载错误」），不抛给 ErrorBoundary |

`keys.ts` 集中 queryKey 工厂，避免字符串散落：

```ts
export const qk = {
  demos: { all: ['demos'] as const, one: (id: string) => ['demos', id] as const },
  match: { workspace: (demoId: string) => ['match', demoId] as const },
  tasks: { all: ['tasks'] as const, one: (id: string) => ['tasks', id] as const },
  // …
}
```

**离线降级**与 Query 的关系：`ServiceGate` 订阅 `health` query，服务离线时把状态下发给 `Toolbar` / `Button`，禁用需要服务的动作并写明原因（设计稿规定「不隐藏、不静默失败」）。重连成功后 `invalidateQueries` 全量刷新，无需刷新页面。

### 4.2 全局 UI 状态（zustand，持久化）

`sidebarCollapsed` / `agentRailExpanded` / `theme` / `language` / `restoreLastRoute` / `reduceMotion` / 各表的列配置与保存的视图。**不再承载服务端数据。**

### 4.3 任务生命周期（xstate）

设计稿把任务阶段画成了产品的一等公民：录制 6 阶段（启动·跳转·采集·稳定·编码·发布）、分析 5 阶段、导出、下载，且都要求「失败可安全回退到某阶段后重试」「影响范围写清楚」。现有 `analysisLifecycleMachine` 只覆盖分析一种。

方案：统一成 `domain/task/taskMachine.ts` 一台机器，阶段序列由任务类型参数化。工作台首页、交付页、任务详情、资料库行内进度共享同一台机器的快照，不各自维护进度状态。机器的输入来自 `data/tasks.ts` 的 query，输出只是呈现状态——**推进由后端事件驱动，前端不模拟进度**（设计稿明写「有真实分母时才用进度条，否则只给阶段名」）。

### 4.4 比赛工作区上下文

沿用现有 `analysisNavigation.ts` 的设计——**URL 是唯一真值**（`view / round / player / tick / evidence` 全在 query）。这是现有代码里最值得保留的一个决定：证据可深链、后退可用、Agent 的「定位」跳转天然可实现。

### 4.5 会话 / 方案 / 修订模型（新增，核心）

设计稿第五轮把**会话与任务解耦成多对多**，第六轮加了**手动编辑与修订号**。这两条把 Agent 从「一个页面」变成了贯穿全应用的一层，是整个重构里数据模型最重的部分。

#### 4.5.1 三个独立生命周期

```
Session   一条对话线程。随时新建，不继承也不锁定任何任务。
          删除只删对话，它改过的方案、任务、视频全部留下。
Object    方案 / 录制任务 / 剪辑工程 / 输出。有自己的生命周期，
          存在于会话之外。不用 Agent 也能完整操作。
Reference 一次操作的双向记录。会话看得到它改过什么，
          方案也看得到它被哪几条会话改过、分别改了什么。
```

一条会话可引用多个对象；一个方案也可能被前后几条会话改过。界面表达的是**触及关系**，不是从属关系。

#### 4.5.2 类型

```ts
Session { id, title, createdAt, updatedAt, messages: Entry[], refs: ObjectRef[] }
ObjectRef { kind: 'plan'|'recordingTask'|'editProject'|'output', id, label,
            touchedAt, summary /* 「改过 2 次」 */, status }

// 会话流里的条目有三种，只有前两种是气泡
Entry =
  | { kind: 'user',      content, at }
  | { kind: 'assistant', content, at, toolCalls[], proposals[], actions?[] }
  | { kind: 'workspaceEdit', notice: WorkspaceEditNotice }   // 一行系统灰字，可展开

WorkspaceEditNotice {
  type: 'workspace_edit', object: `plan#${string}`, revision: number,
  by: 'user', at: string,
  changes: Array<{ shot: number; field?: string; from?: string; to?: string; op?: 'removed' }>,
  note?: string
}

Plan { id, revision, shots: Shot[], status, origin: PlanOrigin[] }
Shot { id, kind: Static|Tracking|POV|Crane|Flyby, view, startTick, endTick,
       durationSeconds, rationale, evidenceRefs[], risks[],
       source: 'agent'|'user',           // 来源徽标：Agent / 你改过
       removedBy?: 'user',               // 「你删除的」，可撤销
       params{} }
PlanOrigin { at, sessionId, sessionTitle, summary }   // 「改动来源」按时间倒序

ChangeSet { basedOnRevision: number, changes: Change[] }
Change { id, op: shorten|delete|replace|insert, target: ShotId,
         before, after, deltaSeconds, rationale, warning?,
         state: 'pending'|'accepted'|'rejected'|'stale' }

Take { id, label, plan: Plan, metrics }
Composition { shotSlot → { takeId, shotId } }
```

#### 4.5.3 三条硬规则

**① 录制只由一次显式确认启动。** 接受变更不触发录制，手动编辑不触发录制，切换会话不触发录制。设计稿在设置「行为边界」里把这条做成了**不可关闭**的开关（开关本身画成禁用态）。这必须落进 `taskMachine`，不能只靠 UI 摆放。

**② 用户手动编辑永不需要 Agent 批准，Agent 也不得自动回滚用户的编辑。**

**③ 修订号决定提议是否还成立。** Agent 每次提议带 `basedOnRevision`；用户手动编辑使 `plan.revision++`；`basedOnRevision < plan.revision` 的未处理变更立即变 `stale`——卡片降到 55% 不透明度、「接受」按钮禁用、标签写「已过期」，但**内容仍可读**（过期不等于错误，用户要据此判断是否值得重算）。已接受过的变更不受影响。

这是一个简化的并发一致性问题：Agent 流式生成期间用户改了方案，生成完成时 revision 已变。判定逻辑写成纯函数 `markStale(changeSet, currentRevision)`，放 `unit` 测试项目。

#### 4.5.4 编辑通知的合并窗口

设计稿要求「5 秒内的连续编辑合并成一条，避免刷屏」。放在**前端** `data/editNotifier.ts`：用户连续拖拽 / 改数值是前端事件，后端看不到中间态。

强制 flush 的时机（漏掉任何一个都会丢通知）：
- 5 秒窗口到期
- 用户发送消息前
- 切换会话 / 离开页面 / 组件卸载
- 点「确认并生成视频」前
- 窗口关闭前（`beforeunload`）

合并后一次性调后端写入会话上下文。窗口内的多次编辑按 `shot + field` 去重，只保留最初的 `from` 和最终的 `to`。

### 4.6 后端契约缺口 ⚠️

**§0 决策 4 原本写的是「数据契约不动」。第五、六轮之后这条不再成立。** 下面全部是设计稿要求、后端目前没有的，前端补不出来：

现有后端只有：

```ts
AgentThread  { id, messages: AgentMessage[], updatedAt }
AgentMessage { id, role: 'user'|'assistant', content, createdAt, toolCalls[], proposals[] }
AgentProposal{ kind, title, payload }
命令：agent_status / agent_thread(threadId) / agent_chat(stream) / agent_cancel
```

| # | 设计稿要求 | 后端现状 | 需要 |
| --- | --- | --- | --- |
| 1 | 会话抽屉「共 14 条」+ 搜索会话/Demo/选手 | 只能按 id 取单条 | `agent_threads(query, limit)` 列表查询 |
| 2 | 会话标题「Kael 的 1v3」、重命名 | `AgentThread` 无 `title` | 字段 + `agent_thread_rename` |
| 3 | 删除会话（只删对话，不动方案与视频） | 无 | `agent_thread_delete`，且必须保证不级联 |
| 4 | 每条会话下方列出触及的对象（方案 #P-118 · 改过 2 次 / 录制任务 #A-2481 / 输出 xxx.mp4） | 无引用关系 | `AgentThread.refs[]` + 双向索引表 |
| 5 | `workspace_edit` 通知进入会话上下文 | `role` 只有 `user`/`assistant` | 第三种条目类型 + `agent_notify_workspace_edit` |
| 6 | 方案修订号、旧提议过期 | `AgentProposal` 无 `basedOnRevision`；方案无 `revision` | 两处加字段 |
| 7 | 方案「改动来源」：被哪几条会话改过 | 无 | `Plan.origin[]` |
| 8 | 新建会话时列出「工作区里正在进行的」可引用对象 | 无 | 一个跨源查询（待确认方案 + 运行中任务 + 剪辑工程 + 失败导出） |
| 9 | 会话保留策略（全部 / 最近 50 / 30 天 / 不保留）、take 上限、占用统计、导出、清空 | 无 | 配置项 + 存储命令 + 清理任务 |
| 10 | 「还原为 Agent 版本」 | 无 | 方案需要保留 Agent 原始版本快照 |

第 3、4、7 项涉及 `storage` crate 的 schema 变更（会话表加字段、新增会话↔对象引用表），第 9 项涉及一个保留策略清理任务。**这部分不在前端重构范围内，需要单独排期，且是 Agent 页面（阶段 3e）的前置条件。**

短期解法：前端先按 §4.5 的类型写死一层 `data/sessions.ts` 适配器，用现有 `agent_thread` 能拿到的部分 + 前端本地存储兜住 title / refs，等后端补齐后把适配器换掉。但第 6 项（修订号）没法在前端兜——它必须是服务端权威，否则两条会话同时改一个方案会静默覆盖。

---

### 4.7 IPC 面的真实形状（核对记录）

前面几稿我写过「145 个 Tauri 命令」，三处都不准，在此更正并留档，因为它直接决定 §4.6 的东西该加在哪：

| 层 | 数量 | 位置 |
| --- | --- | --- |
| 真正注册的 Tauri 命令 | **10** | `apps/desktop/src-tauri/src/lib.rs:57` 的 `generate_handler!` |
| 前端 `commands` 对象方法 | **141** | `apps/web/src/shared/desktop/client.ts:461-1208` |
| 其中经 `request<T>(path, {method})` 的 | **127** | 全部走同一个 `desktop_call` |
| `desktop_call` 下的唯一路由 | **106** | `crates/application/src/routes/*.rs` 的 axum Router，路径形如 `/api/…` |

那 10 个 Tauri 命令是：`desktop_call` / `desktop_binary` / `desktop_upload`（bridge）、
`agent_status` / `agent_thread` / `agent_chat` / `agent_cancel`（agent）、
`list_hlae_bundles` / `reveal_hlae_bundle`（hlae）、`toggle_ace_overlay_prototype`（原型，随 §7 一并下线）。

**对 §4.6 的直接影响**：那 10 项契约缺口应当实现为 `crates/application/src/routes/` 下的**新增 axum 路由**，
与现有 106 条保持一致的注册、提取器与错误处理，而不是新增 `generate_handler!` 条目。
独立 Tauri 命令只留给需要流式 `Channel` 的场景——`agent_chat` 是仓库里唯一先例，
而 §4.6 没有一项需要流式，因此预期新增 0 个 Tauri 命令。

## 5. i18n：Lingui（决策 8）

### 5.1 政策反转

| | 今天 | Lingui 之后 |
| --- | --- | --- |
| 消息来源 | 手工编号 `m0001`–`m2621`，中文在 `literals.ts` | 中文**直接写在 JSX/TS 里**，即源消息 |
| lint 规则 | `check-web-i18n.mjs` **禁止**生产代码出现汉字 | 规则删除。汉字就是源文案 |
| ID | 人工分配 | 由源文案 + context 哈希生成，不需要人管 |
| 复数 | 不支持（`msgf` 只有位置插值） | ICU `plural` / `select` / `selectOrdinal` |
| 双语校验 | 自研 parity 检查 | `lingui compile --strict` |

代码可读性是主要收益：`<Trans>确认并生成视频</Trans>` 对比今天的 `msg("m0743")`，设计稿文案能 1:1 落进代码，评审时不用来回查表。

复数是真实缺口。设计稿里大量计数文案——「已选 3 场 · 上限 12 场」「3 项变更待处理」「命中 47 条」「4 个镜头」——中文无所谓，英文必须区分 `1 match` / `3 matches`。现有 `msgf` 做不到，只能靠英文文案回避复数，会写得很别扭。

### 5.2 集成

```ts
// vite.config.ts —— 顺序不可颠倒：react 先，lingui 后
plugins: [
  react({ babel: { plugins: ['@lingui/babel-plugin-lingui-macro'] } }),
  lingui(),
  tailwindcss(),
]
```

> `@vitejs/plugin-react` 默认**不读**项目的 babel 配置，宏插件必须显式写在 `babel.plugins` 里。
> 因此 `@vitejs/plugin-react` 不能换成 SWC 版（换了要改用 `@lingui/swc-plugin`，无必要）。

```ts
// lingui.config.ts
export default defineConfig({
  sourceLocale: 'zh-CN',
  locales: ['zh-CN', 'en-US'],
  catalogs: [{ path: '<rootDir>/src/locales/{locale}/messages', include: ['src'] }],
})
```

宏导入路径（v6）：

```ts
import { t, msg, plural, select } from '@lingui/core/macro'   // 非 JSX
import { Trans, Plural, useLingui } from '@lingui/react/macro' // JSX
```

catalog 格式用 `.po`（Poedit / Crowdin 生态最好）。运行时 `lingui compile --typescript` 产出 TS，按 locale 动态 import 后 `i18n.activate()`。

语言切换因此是**异步**的——正好对上设计稿「设置·应用」写的「保存成功后才切换，不会切到一半」。

### 5.3 CI

```json
"i18n:extract": "lingui extract --clean",
"i18n:compile": "lingui compile --typescript --strict",
"lint": "pnpm i18n:compile && node ../../scripts/check-web-layers.mjs && tsc -b --pretty false"
```

`--strict` 在任一 catalog 有缺译时失败，等价替换掉旧 lint 的双语 parity 检查。
另加一道 CI 守卫：跑完 `lingui extract --clean` 后 `git diff --exit-code src/locales`，防止源码改了文案却没提交 catalog。

### 5.4 迁移

旧 catalog 2621 条整体废弃，不做映射——绑的是旧文案，新设计几乎全新。
文案随页面走：每完成一页立刻 `extract` 并补齐该页英文，不留到最后（§10.3）。

---

## 6. 测试策略（决策 7）

### 6.1 现状

vitest `environment: 'node'`，167 个测试文件：123 个纯逻辑（`.test.ts`）、41 个用 `renderToStaticMarkup` 断言静态标记、1 个 react-test-renderer、0 个 testing-library。

优点是快、无 DOM 依赖；缺点是**测不了交互**。而新设计有大量交互契约：对话框焦点陷阱与关闭后焦点归位、命令面板 ↑↓/TAB/↵、时间轴剃刀与吸附、1100×700 折叠后主动作不得进溢出菜单、离线时禁用动作必须写明原因而非隐藏。简报 §15.3 也明确要求「全流程可用键盘完成主要选择和确认」。

### 6.2 vitest 三项目

| 项目 | 环境 | 覆盖 | 数量预估 |
| --- | --- | --- | --- |
| `unit` | node | 纯逻辑：presentation / query 选择器 / selection / taskMachine / proposal 折叠 / token 归纳表 | ~140，现有 123 个大部分可平移 |
| `markup` | node | `renderToStaticMarkup` 结构与 aria 断言 | ~50，现有 41 个可平移 |
| `interaction` | jsdom | 焦点、键盘、浮层、折叠、禁用态 | ~30，全新 |

### 6.3 Lingui + Query 的测试接线

两个 provider 都要进测试渲染路径，逐文件重复会很脏。写一个 `src/test/render.tsx`：

```tsx
// 统一包 I18nProvider(zh-CN, 源 catalog) + QueryClientProvider(retry:false, gcTime:0)
export function renderMarkup(ui: ReactElement): string
export function renderInteractive(ui: ReactElement): RenderResult
```

`markup` 项目激活 `sourceLocale`（zh-CN），渲染出的就是源文案本身，不依赖编译产物；`interaction` 项目同理。这样 catalog 未编译也能跑测试。

宏变换在测试里同样需要——vitest 复用 vite 配置，`@vitejs/plugin-react` 上挂的宏插件会生效，不需要额外配置。

### 6.4 把架构约束本身变成测试

- §2.1 的分层 / 裸值 lint 作为 `pnpm lint` 的一部分
- §3 的 token 归纳表做成数据 + `unit` 断言：设计稿里出现的每个尺寸都必须能映射到某个 token

---

## 7. 路由

```
/                          工作台首页
/library                   Demo 资料库          ?view=table|card
/history                   比赛历史与 Steam 下载
/players                   玩家目录
/players/:playerId         玩家档案与趋势
/evidence                  证据检索             ?view=evidence|annotations
/match/:demoId             比赛工作区           ?view=…&round=&player=&tick=&evidence=
/agent                     Agent 创作           ?plan=&session=&mode=changes|inline|takes
                           顶栏主体是「方案」，会话切换器在左列顶部（设计稿第五轮连带修订）
                           会话抽屉是浮层，不是路由
/recording/:taskId?        录制计划与镜头预览
/montage/:projectId?       快速合辑
/editor/:projectId?        多轨编辑器
/delivery                  交付                 ?view=outputs|tasks
/delivery/task/:taskId     任务详情与阶段日志
/settings                  设置                 ?section=app|files|game|ai|advanced
                           第四节标题为「AI 与 Agent」（第五轮改名），分模型 / 会话 / 行为边界三块
/recovery                  恢复中心
```

比赛工作区 `view` 取值（9 个，按设计稿的归并表）：
`overview | rounds | players | duels | utility | replay | highlights | review | teams`

相对现有 17 条路由的变化：

- `demoId` 从 query 提升为路径参数（面包屑「资料库 › Aurora vs Meridian › 概览」需要它是一等身份）
- `/analysis` → `/match/:demoId`；`/outputs` + `/activity` 合并为 `/delivery`
- `/production`、`/studio`、`/lineups`、`/prototype/ace-overlay` 下线（设计稿明确建议）
- 分析页 18 个 tab → 9 个 view：`advantage`/`objective` 并入 `rounds`，`clutches` 并入 `highlights`，`insights` 并入 `review`，`teams` 新增并接管原 `/lineups`，`cosmetics` 移到资料库 Inspector

---

## 8. 响应式

窗口即视口，所以壳层折叠用**媒体查询**（`1100px` 断点），面板内部折叠用**容器查询**。

设计稿给的三条折叠规则原样落地：

1. 侧栏 216 → 56 图标条，分组标题仅在悬停展开时出现
2. 右侧 Inspector 不再常驻，收成底部 44px 选中摘要 + 可召出的右侧抽屉
3. 比赛工作区左侧视图导航 → 顶部标签，放不下的进「更多」

不可协商的一条：**主动作（加入视频 / 用 Agent 制作视频 / 确认并生成视频）在任何宽度下保持可见，不进溢出菜单。** 做成 `design/layout/Toolbar` 的 API 契约（`primary` 槽永不折叠），并写成 `interaction` 测试。

200% 缩放复用同一断点——缩放会等比缩小 CSS 像素视口，1920 @200% ≈ 960px 逻辑宽，落进折叠态。

---

## 9. 风险

1. **自研多轨时间轴是最大单点**（替代 `@xzdarcy`）——剃刀、滑移、波纹删除、吸附、标记、缩放、多轨拖拽、链接音视频。缓解：阶段 0 结束后**立刻**做时间轴技术原型，不排到最后，避免走到阶段 3 末尾才发现做不动。
2. **一次性重写期间产品不可用**——已定的决策。缓解：每个阶段结束保证 `pnpm lint && pnpm typecheck && pnpm test` 为绿，只是路由未接完；不允许以「等最后一起修」为由让主干红着。
3. **i18n 双语约 2000 条**是纯体力但量大，容易成为收尾阶段的隐藏尾巴。缓解：文案随页面走，每完成一页立刻 extract + 补英文；CI 的 `git diff --exit-code src/locales` 守住。
4. **Lingui 引入 Babel 到构建链**——`@vitejs/plugin-react` 本就是 Babel 版，但宏变换会增加冷启动与构建时间。缓解：阶段 0 就接好并测量，若构建时间不可接受，退路是改用 `@lingui/swc-plugin` + `@vitejs/plugin-react-swc`。
5. **暗色只有 2 页参考画面**，其余按映射表推导。缓解：暗色 token 一次定死在 `theme.css`，页面不得写死颜色（§2.1 第 4 条 lint 兜底），推导错了只需改 token 不需改页面。
6. **抬到 32px 后密集面板可能溢出**（§3.3）——Agent 变更列表、片段属性面板在 1100×700 下最紧。缓解：阶段 2 做完 `design/layout` 后立刻用真实数据量在 1100×700 复核。
7. **后端契约缺口阻塞 Agent 页面**（§4.6）——10 项缺口里有 3 项要改 `storage` schema。缓解：把它拆成独立的后端任务与前端重构并行排期；前端先写适配器层，把「适配器换成真命令」做成阶段 3e 的显式出口条件，不允许悄悄用本地存储长期兜着。
8. **修订号必须是服务端权威**——若在前端维护，两条会话同时改一个方案会静默覆盖，而设计稿明确允许「一个方案被前后几条会话改过」。这一项没有前端兜底方案，是 §4.6 里唯一的硬阻塞。
9. **编辑通知的 flush 时机遗漏会丢通知**（§4.5.4）——Agent 会基于过期版本继续提议，正是设计稿要防的事。缓解：五个 flush 时机逐个写成 `interaction` 测试。

---

## 10. 实施顺序

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| 0 | Token 归纳表 → `theme.css` + 暗色；自托管字体；Lingui + Query + vitest 三项目接线；`design/` 全部原语与布局组件；分层与裸值 lint | `pnpm lint` 绿，design 层测试齐，构建时间已测量 |
| 0.5 | **多轨时间轴技术原型**（只验证交互可行性，不接数据） | 剃刀 / 吸附 / 拖拽 / 缩放跑通 |
| 1 | 壳层：TitleBar / SideNav 两态 / AgentRail 两态 / CommandPalette / ServiceGate / RouteBoundary / 1100×700 折叠 | 空壳可跑，interaction 测试绿 |
| 2 | 领域组件：MatchContextBar / DataTable+Inspector / TaskCard+StageTimeline / MapCanvas / Transport / Waveform | 各自有 markup + interaction 测试；1100×700 密度复核通过 |
| 3a | 交付（输出 + 任务记录 + 任务详情） | 验证 TaskCard / StageTimeline / taskMachine |
| 3b | 资料库（表格 + 卡片 + Inspector + 饰品改写）+ 5 个对话框 | 验证 DataTable / Dialog / Query 失效链路 |
| 3c | 比赛工作区 9 个子视图 | 最大一块 |
| 3d | 证据检索 / 玩家目录 / 玩家档案 / 比赛历史 | |
| 3e | Agent：2a + 2b + 2c、会话抽屉、新建会话与引用、手动编辑与修订号、编辑通知、过期变更、设置「AI 与 Agent」 | 验证提案折叠 + `markStale` + flush 时机；**出口条件包含「适配器已换成真实后端命令」**（§4.6） |
| 3e-be | **后端并行任务**：§4.6 的 10 项契约缺口，含 `storage` schema 变更（会话表加 title/refs、会话↔对象引用表、方案 revision 与 origin、保留策略清理） | 前端适配器可整体拆除 |
| 3f-be | **后端并行任务**：每镜头拍摄参数 / 录制前校验 / 镜头预设 / 方案↔录制绑定（§10.6 缺口 1），外加把 CI 的 `cargo clippy -D warnings` 门清零 | 画板 08 的四块不再靠「禁用 + 写明原因」 |
| 3f-1 | 录制计划（08）/ 快速合辑（09） | ✓ 完成（§10.8）。两页接真数据；导播预览画真实相机路径；Agent 页的「确认并生成视频」不再是死按钮 |
| 3f-cg | **强类型收口**：`ts-rs` 在 Rust 类型上 derive，`cargo test` 写出 `shared/desktop/generated/`，`dto.ts` 退化成再导出。CI 的 rust job 加一道漂移门 | ✓ 完成（§10.9）。dto.ts 2421 → 864 行，抓出并修掉 21 处真实漂移。**原计划的 utoipa 方案在清点出 155 条路由后换成了 ts-rs**，理由见 §10.9 开头 |
| 3f-2 | 多轨编辑器（10） | ✓ 完成（§10.10）。两步：先补齐时间轴内核（修剪 / 自动滚动 / 帧网格 / 变速 / 虚拟化 / 指针捕获，`TrackKind` 对齐线上），再接真素材（适配层 + `data/editor.ts` + 六个面板） |
| 3g-be | **后端并行任务**：Agent 设置五个开关 / 引用删除路由 / 保留策略调度 / `OutputItem` 媒体元数据与输出流 / 活动错误码 / **`GET /api/recording/plans/{id}`（§10.8 缺口 1 与 2 同因，一条路由修两个）** | ✓ 完成（§10.11）。六项全部落地，`cargo test --workspace` 全绿 |
| 3g | 设置 5 节 / 恢复中心 / 工作台首页余下五块 / **`/guide` 与首次使用三步提示条** / 原生外壳能力回填 | |
| 4 | i18n 英文收口；测试回归；删除 `styles/index.css`、旧 `features/`、旧 `shared/ui`、旧 `shared/i18n`、`check-web-i18n.mjs`、三个被移除的依赖 | `pnpm lint && pnpm typecheck && pnpm test` 全绿，旧目录清零 |
| 5 | `design/` 组件库回流到一个**新建的** Claude Design 设计系统项目（`Industry` 是共用基底，不动） | 下一轮画板的起点是真正被建出来的那套 token 与控件 |

---

## 10.1 阶段 0 落地记录（2026-08-15）

出口条件全部达成：`lint` / `typecheck` / `cargo check --workspace --all-targets` 退出码 0；`vitest` 三项目 214 文件 1210 用例通过（3 个 skip 是 `features/analysis` 里靠外部数据库开关的既有审计）；`main` 上的 167 个测试文件逐一核对仍在跑，没有被新的 include/exclude 漏掉；`design/` 四组 35 个组件各自带测试；`check-web-layers.mjs` 有自测且能对违规样例报错退 1。

### 与规格的偏离

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | 三个待删依赖不能在阶段 0 摘 | 已改 §1.2，推到阶段 4 |
| 2 | §3.4 / §3.5 各缺 3 个和 1 个 token | 已补，见两表 |
| 3 | §3 没有字距、行高、chrome 底色、语义色文字档 | `theme.css` 补了 `--tracking-caps/-wide`、`--leading-tight/-normal/-relaxed`、`--color-surface-chrome`、`--color-{ok,warn,fail}-text`、`--color-ok-border`。前两族尤其必要——§2.1 的裸值 lint 拦 hex 与字号，拦不住 `tracking-[.16em]` |
| 4 | `base.css` 的 `h1`–`h6` 是无 layer 的裸标签选择器，会静默压过 `@layer utilities` 里的 `text-*` | 全部包进 `:where()` 降到 0 特异性。标题层级回归语义选择，字号回归工具类 |
| 5 | §4.6 第 5 项没做成独立路由 | 并入 `PATCH /api/agent/plans/{id}`。理由正确并已采纳：单独的 notify 路由要接受客户端传来的 revision，等于把 §9 风险 8（修订号必须服务端权威）重新打开。§4.5.4 的 5 秒 flush 应当调 `applyAgentPlanEdit`，落库 + revision++ + 会话上下文注入在同一事务里完成 |

### 留给后续阶段的已知缺口

1. **只有 plan 能产生 `workspace_edit` 通知。** `WorkspaceEditNotice.object` 声明支持四种 kind，但 recording_task / output 没有服务端修订号，edit_project 的 revision 埋在 `editor_projects.document_json` 里没接出来。若设计稿要求「改剪辑时间轴也通知会话」，需在阶段 3f 把它提升为可查询列并加一条路由。目前没有用假 revision 兜住，这是好事。
2. **保留策略清理没有调度器。** `POST /api/agent/workspace/storage/retention` 可调用，但没有任何东西定期触发它。阶段 3e 需决定是前端启动时调一次，还是在 runtime 挂定时器。
3. **`design/layout/Inspector` 的抽屉态自带焦点陷阱，与 `design/feedback/Drawer` 重复。** 两个 agent 并行写的，职责重叠。阶段 1 收口时让 Inspector 复用 Drawer 的浮层实现，不要留两套焦点管理。
4. **`Drawer` 的焦点陷阱与画板的「不阻断」承诺相抵。** 现状是保留 Tab 陷阱、去掉 `aria-modal` 与遮罩，所以指针仍能操作背后的页面，但键盘用户只能 Esc 退出。已记在 `Drawer.tsx`，阶段 1 复核。
5. **`lingui extract` 尚未跑过。** 四个并行 agent 共享 `.po`，并行跑会冲突，所以组件里的宏文案还没进目录。阶段 1 开始前统一跑一次。
6. **`Toolbar` 折叠时默认把全部 actions 收进「更多」**（`inlineActionsWhenCollapsed` 默认 0），依据是 1100×700 画板上顶栏只剩一个按钮。阶段 2 用真实数据量复核时（§9 风险 6），部分页面可能要显式传 1 或 2。
7. **`Tag` 没有 ok/warn/fail 三色。** 设计稿零个状态标签——所有成败态都是 `Notice` 或 `StatusDot`。若领域组件确实需要状态胶囊，按 `--color-*-surface` / `--color-*-text` 补三档，不要另起配色。
8. **组件内部几何写成 Tailwind 任意值**（Toggle 34×18 轨道 + 16×16 滑块、Slider 4px 轨 + 14×14 拇指、Checkbox 13/15px 盒）。§3 没有对应 token 族，硬造会暗示一套不存在的刻度。每处都注了出处，保持现状。

---

## 10.2 阶段 0.5 + 1 落地记录（2026-08-15）

出口条件全部达成：`lint`（= `i18n:compile --strict` + 分层 lint + `tsc -b`）/ `typecheck` / `build`（`vite build`，本轮首次真跑）/ `cargo check --workspace --all-targets` 退出码 0；`vitest` 三项目 **255 文件 1871 用例**通过（3 skip 同上，与本轮无关）；`lingui extract` 报 en-US Missing = 0；阶段 0 基线的 217 个测试文件仅 `app/WindowTitleBar.test.tsx` 一条位移到 `app/shell/`，5 条用例逐一有承接且多出 4 条。

交付：`design/timeline/`（35 文件，算法层零 React）、`app/shell/`、`app/command/`、`app/boundary/`、重写的 `app/AppShell.tsx` + `app/router.tsx` + `src/routes.tsx`、`pages/` 15 个占位页。

### 与规格的偏离

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | §2 把 `routes.tsx` 画在 `app/`，但 §2.1 第 3 条禁止 `app/` ↔ `pages/` 互相 import，路由表点名页面必然违规 | **采纳依赖倒置**：`app/router.tsx` 持有全部路径 / id / 重定向 / 壳层元素，导出穷举接口 `RoutePages` 与 `createAppRoutes(pages)`；`src/routes.tsx`（src 根，与 `main.tsx` 同级，在两层之上）做唯一知道两边名字的接缝。加一条路由却不给页面会编译失败。lint 规则不动 |
| 2 | 命令面板画板宽 600px，§3.5 无对应 token | **新增 `--w-overlay: 600`**。它是绝对定位的浮层卡片，`EXTRACTION_RULES.panelWidth`（要求 `flex:none` / `border-left` / `border-right`）按构造就看不见它，所以既不在 `OBSERVED_PANEL_WIDTHS` 也没有 MERGE 条目。这是新角色而非漏掉的值——折到 `--w-split`(520) 会成为全表最宽的一次归并，且让居中浮层与分栏面板从此一起变 |
| 3 | 1100×700 画板不画右侧 Agent 竖条 | **照画板执行：折叠时整列不渲染。** 入口没丢——`SideNav` 的 sparkle 项（`agent` → `/agent`）就在 56px 图标条上、带同一颗徽标点，正是画板画的那颗。留一条只剩「跳 /agent」的 46px 列等于把同一个控件放两遍，还花掉折叠本要收回的 46px |
| 4 | `main.tsx` 只 import `design/theme.css`，而非任务书要求的三个 css | `theme.css` 首行即 `@import 'tailwindcss'; @import './fonts.css'; @import './base.css';`。三个都引会重复引入 fonts 与 base，并可能把 base 的无 layer 元素规则排到 utilities 之后。顺序由 CSS 的 `@import` 保证 |
| 5 | 「标记」没做成时间轴上的一条轨道 | 画板画的是 `top:0;bottom:0` 贯穿全部轨道的竖线，那是序列属性不是某一行的属性。`markers` 是文档上的独立数组，标尺是它们的车道。要改回真轨道只动渲染层 |
| 6 | `/analysis` 重定向丢 `tab` / `run` 查询参数 | 有意。§7 的 18 tab → 9 view 是归并不是改名（advantage/objective→rounds、clutches→highlights、insights→review），把工作区看不懂的 `tab` 带过去比落在默认「概览」更糟。要做映射表，扩展点是 `app/router.tsx` 的 `LegacyAnalysisRedirect` |
| 7 | `lingui.config.ts` 的 `include: ['src']` 无 exclude，把 54 条测试夹具中文串当成品文案打进目录 | **已加 exclude**（`**/*.test.ts(x)`、`**/*.interaction.test.tsx`、`**/test/**`）。目录从 246 条降到 192 条 |

### 本轮收口掉的重复与孤儿

- `app/RouteError.tsx` 已删（新 router 用 `boundary/RouteErrorElement`）。
- `ServiceStatusIndicator` 已删；`WindowTitleBar` 改渲染 `ServiceStatusMarker`，`ShellServiceStatus` 变成 `ServiceStatus` 的别名。全应用只剩一处「● 本地服务在线」的实现。
- 172px 状态盒回到设计层：`EmptyState` 自己带上 `EMPTY_STATE_MIN_HEIGHT_CLASS` 并导出，`RouteLoading` 的骨架复用同一个类。
- 「跳转」一个 msgid 两个词义（面板的 Go to、录制流水线的 Seek）已用 `context` 拆开。

### 留给后续阶段的已知缺口

1. **时间轴没有帧网格。** 时间是浮点秒，比较靠 `TIME_EPSILON=1e-6`。导出到真实素材前必须补 fps 与量化，否则会出现半帧入出点。建议 fps 放 `Timeline` 上、只在提交处量化（预览量化会让吸附发涩）。阶段 3f 拍板。
2. **拖拽没用 `setPointerCapture`**，改在 window 上监听 pointermove/pointerup——因为 jsdom 没实现它，用了那 21 个真指针拖拽测试就跑不了。代价真实：拖到窗口外松手收不到 pointerup，手势会卡住。阶段 3f 决定是否接受为此把部分拖拽测试改成手动验证。
3. **§0.5 点名的六项能力只是多轨编辑器的一半。** 修剪（拖片段左右边缘改入出点）、拖到边缘自动滚动、行虚拟化都不在那六项里，却是 3f 必须有的，工作量各自与「拖拽」一档。按 `design/timeline/README.md` 第 2 节估工时，不要按「§0.5 已跑通」估。
4. **@xzdarcy 的取舍结论是「保留自研」，但理由不是已经写完了。** 它的 `TimelineAction` 只有 `{id,start,end,effectId}`，没有素材入点、素材时长、链接关系，所以滑移在它的模型里表达不出来、剃刀右半算不出正确 `sourceIn`——这是模型差距。反过来它在修剪 / 自动滚动 / 虚拟化 / 播放引擎 / 吸附辅助线 / 轨道重排上明确更成熟。3f 定。
5. **`shell/navigation.tsx` 与 `command/commandRegistry.ts` 是两张表。** 没有合并（一张要 Frame 顺序与图标，一张要搜索词），改成**绑定**：`router.test.tsx` 把每条侧栏 `to` 和每条 `PAGE_COMMANDS`（通过真的 `run({navigate})` 捕获目标）都过一遍 `matchRoutes`。漂移会变成红测试而不是死链。
6. **命令面板的三个分组（比赛 / 选手 / 证据）本轮是空的**，动作类命令（导入 Demo · CTRL I、用 Agent 制作视频 · CTRL G）也没注册——前者要 `data/**` 的 hooks，后者要文件对话框（3b）与 Agent 会话状态（3e）。扩展点是 `buildCommandList(extensions)`。
7. **§8 折叠三条规则本轮只落地第 1 条**（侧栏 216→56）。第 2 条（Inspector → 底部 44px 摘要 + 抽屉）与第 3 条（工作区视图导航 → 顶部标签）住在 `design/layout/Inspector` 与 `SubNav`，阶段 0 已实现并自带断点，由页面在 3c 接。
8. **`/recovery` 没有侧栏入口**（Frame 没画），命令面板是键盘唯一到得了它的路。若产品要求独立入口，需设计稿补画。
9. **§10.1 缺口 3（Inspector 与 Drawer 两套焦点管理）仍未收口**——它在 `design/layout/`，本轮四个 agent 的目录范围都不含它。顺延到阶段 2。

---

## 10.3 阶段 2 落地记录（2026-08-15）

出口条件全部达成：`lint` / `typecheck` / `build` / `cargo check --workspace --all-targets` 退出码 0；`vitest` 三项目 **319 文件 2629 用例**通过（unit 165 / markup 114 / interaction 43，合计 322 文件正好等于全量文件数）；`lingui extract` 报 en-US Missing = 0（336 条）；阶段 1 的 258 个测试文件逐一核对仍在跑，`comm` 差集为 0。

交付：`domain/{match,map,media,task}/` 共 24 个组件、94 个文件；`data/` 的 keys 工厂 + health + 六个领域 hooks；`domain/densityFixtures.ts` + 6 个密度测试文件。

### 1100×700 密度复核（§9 风险 6，本阶段的出口条件）

16 项测量，查出 **7 项真实违规**，全部当场修掉：

| 组件 | 数据量 | 问题 | 修法 |
| --- | --- | --- | --- |
| `media/ClipStrip` | 24 个片段 = 5538px | `<ul>` 上没有任何 overflow 容器，横向滚动会落到 body 上（阶段 1 AppShell 明令禁止） | `overflow-x-auto overscroll-x-contain`，ready 与 loading 两条路径都加 |
| `media/FilmStrip` | 62 帧 = 8428px | 同一形状；8 格 placeholder 的 loading 行 1064px 也已超过 996px | 同上 |
| `task/TaskDetail` | 120 行阶段日志 ≈ 3360px | `<ol>` 无 overflow-y，所在左列缺 `min-h-0` → 详情页长出第二条滚动条，阶段条被顶出视野 | `min-h-0 flex-1 overflow-y-auto` + 左列补 `min-h-0` |
| `match/MatchContextBar` | 10 人首发 ≈ 600px | 聚焦选手无上限，`flex-none` 的 Tag 既不能缩也不能换行，把 §8 明令不得折叠的主动作推出窗口 | `FOCUS_INLINE_MAX=4`，其余进折叠盘，徽标用 Plural 数**被折进去的那部分** |
| `match/MatchContextBar` | — | metadata / focus 写了 `flex-wrap` 却住在固定 56px 栏里——在固定高度里换行等于溢出 | wrap 从常量改成构造器参数：栏内 `flex-nowrap overflow-hidden`（宁可裁剪），面板内 `flex-wrap` |
| `match/MatchContextBar` | 4 个半场（含两个加时） | `periods` 传进栏内 Scoreboard，外层 `flex-none` 按 max-content 定宽，把记分板撑到 ~450px，溢出约 40px | 周期明细只进折叠面板；栏里只剩「13 : 11」，正是画板画的 |
| `match/RoundTimeline` | 30 回合 @ 380px Inspector | 面板头是 `flex-wrap` 配固定 `h-[var(--h-panel-head)]`，一换行就溢出盒子 | 改成 `min-h-`，画板的 40px 从上限变成下限 |

不需要改的九项也留了算术：248 行资料库分页后表里 20 行且页脚印「共 248 条」；12 000 个热力采样归到 864 个格子（比原始点少 13.9 倍）；6200 个峰值只产出 2 个 `<path>`，节点数与音频长度无关；50 条任务记录里 `role="progressbar"` 恰好 5 个——**只有真有分母的在跑任务画进度条**。

### 与规格的偏离

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | §8 只有 1100 一个断点，但**跨过 1100 向上会让内容列变窄**：侧栏 56→216、Agent 竖条出现，1101px 窗口给页面 ~791px，而 1100px 折叠态给的是 ~996px。比赛上下文栏展开需要 ~1300px，所以 1101–1600 区间结构性超载 | **新增组件级断点** `CONTEXT_BAR_BREAKPOINT_PX = 1600`（≈1300+216+46+48）与通用的 `useBelowWidth(px)`，`useCollapsed(forced, breakpointPx?)` 收第二个参数。壳层仍然只有一个折叠断点，这一个不重排任何壳层节点。测试用改造过的 `stubMatchMedia(width)` 真的在 1101 / 1599 / 1601 三个宽度上走了一遍 |
| 2 | `de_inferno` 的雷达标定拿不到权威值 | 落成 `confidence:'provisional'` + `provenance:'PLACEHOLDER …'`，MapCanvas 用占位标定时渲染 warn 色提示，并有一条测试专门钉住它。`de_mirage` 的 pos_x -3230 / pos_y 1713 / scale 5 是 `crates/source-assets/src/overview.rs:448` 的仓库内 fixture，可核对 |
| 3 | §3.4 把 `--h-row-evidence`(52) 命名为「双行证据条目」，但 EvidenceRow 的 comfortable / inline 两档用了 42 / 38 | 画稿的证据检索行确实是 42、Agent 引用行是单行，属于按 §3.4 归并而非新造尺寸。若复核认为「证据行一律 52」，要改的是组件的 HEIGHT_CLASS 表而不是 token |
| 4 | `--w-track-head`(132) 有 token，配套的 74px 缩略图高度没有 | FilmStrip 用 `w-[var(--w-track-head)] aspect-video` 得 74.25px（74/132=0.5606 vs 9/16=0.5625，差 0.3%）。要精确 74 需要在 theme.css 补 `--h-thumb`，本轮未补 |
| 5 | 画板 08 的时码是 `00:13.1`（mm:ss.十分之一），`timeScale.ts` 只有 mm:ss 与 hh:mm:ss:ff | Transport 只提供 `frames`（默认，对应画板 10）与 `clock`（退到 mm:ss）两档，没有偷偷写第三份格式化。要还原画板 08 需在 `timeScale.ts` 补 `formatDecimalTimecode` |
| 6 | §4.1 的 Query 默认项里没有 `refetchInterval`，而任务面天然要轮询（§4.7 确认后端只有 `agent_chat` 一个流式命令，没有任务事件通道） | 每个 hook 加 `pollMs` 选项、**默认不轮询**，节奏留给页面——首页两行任务、交付页任务记录、任务详情三处密度不同，不该由 data 层统一决定。阶段 3a 必须拍数 |
| 7 | `TaskKind` 五类，dto 的 `ActivityKind` 只有四类（无 montage） | 已在文件头写明。页面层要么从 subtype 推，要么后端补，属 §4.6 的契约缺口 |
| 8 | `data/test/renderDataHook.tsx` 是第二个测试渲染入口 | `src/test/render.tsx` 固定包 I18nProvider 且不把 QueryClient 还给调用方，而 hook 测试需要拿到 client 去 invalidate。若要统一，需给 `src/test/render.tsx` 加一个返回 queryClient 的变体 |

### 本轮收口掉的

- `app/boundary/serviceHealth.ts` 的 `SERVICE_HEALTH_KEY` 改成 `qk.service.health()`。原先它自己声明一份、`keys.test.ts` 反向 import `app/**` 来盯住两者不漂移——**键工厂存在的意义就是不要有第二份声明**，现在 data 不再反向依赖 app。
- 「回合」一个 msgid 两个词义（工作区子视图标签的复数 Rounds、证据种类的单数 Round）用 `context` 拆开，与上一轮的「跳转」同一处方。
- `ServiceGate.tsx` 文件头里对已删除的 `…Indicator` 的描述改正。

### 留给后续阶段的已知缺口

1. **`PathLayer` 在 240 条轨迹 × 600 采样下产出 2.65 MB markup。** 节点数只有 720，没问题，问题是字节。组件收到什么画什么，改不了——需要页面层（3c/3d）定策略：按回合分批，或在 `data/` 层下采样后再交给图层。`map/density.test.tsx` 已经立了 1MB–8MB 的边界，越界会红。
2. **`Toolbar` 的 `inlineActionsWhenCollapsed` 复核结论**：组件默认 0 保留（组件量不到自己的标题宽度），但短标题页（library / delivery）应显式传 2——折叠下 940px 减去标题 132 + meta 170 + 更多 62 + 主动作 104 + gap 58 = 剩 414px，一个三字 ghost 按钮约 76px。现在 15 个页面全是占位页、没有一处传 actions，所以这条要由阶段 3 接页面时落实。算术写在 `domain/density.test.tsx` 的注释里。
3. **§10.1 缺口 3 / §10.2 缺口 9 仍未收口**（`design/layout/Inspector` 与 `design/feedback/Drawer` 两套焦点陷阱）。本轮只验证了 Inspector 折叠态的结构契约（46px 摘要条 + 主动作留在条上 + 抽屉入口在），没有碰焦点管理。
4. **分析流水线的 5 个阶段没有中文标签。** §4.3 只写了「阶段 3/5」这个位置，没有四个阶段的用户可读名。`ANALYSIS_STAGE_IDS` 取 dto 的 `AnalysisRunStage` 去掉四个终态，剩下的裸 id 由页面层传 label——要么产品补名，要么确认后端 `ActivityItem.stage` 可直接给用户看。
5. **`MAX_TASK_ATTEMPTS = 3`、`cancelled.RESTART`、「只有录制需要显式确认」三条都是推断**，§4.3 / §4.5.3 没写。每条都在 `taskMachine.ts` 注释里写了依据，但需要产品确认。
6. **楼层（多层地图）只有 `heatBinning` 做了过滤。** `PathLayer` / `EngagementLayer` / `CameraPathLayer` 的记录带 floor 字段但没有筛选，也没有楼层切换控件——3c 要判断楼层是图层自己的事还是页面的事。
7. **热力图需要服务端聚合。** 上万个点不能从前端顶起来，需要一份按 demo 的采样查询，落在 `data/**`；`HeatLayer` 只吃已经分好箱的 `HeatDistribution`。
8. **底图图片没有交付路径。** Tauri CSP 是 `default-src 'self'`，雷达底图只能走 `vibe-cs-media:` 或本地打包资源。`MapCanvas` 只留了 `basemap: ReactNode` 的口子，3c 接页面时要定。
9. **`ClipStrip` 的指针拖拽同样没用 `setPointerCapture`**（jsdom 不实现它），与 `design/timeline` 是同一处已知缺口，一并在 3f 处理。落点计算是纯函数并单测，interaction 只覆盖键盘路径。
10. **组件内部几何常量仍未 token 化**：`ClipStrip` 的 210px 片段宽、112px 缩略图、`Waveform` 的 168px 最小高。它们是内容盒的纵横比参数，不在 §3.4 栏高表也不在 §3.5 宽度表，按阶段 0 的先例保持现状并注了出处。
11. **`domain/agent/` 与 `data/{sessions,plans,editNotifier}.ts` 尚未存在**（属 3e，模型 §4.5 要跟后端一起定）。`keys.ts` 已经预留 sessions / plans 两个命名空间的键形状（含 §4.5.1 的反向索引 `sessions.ofObject(kind,id)`），3e 不需要给缓存重新编号。那批落地后必须重跑一次 `i18n:extract` —— **i18n 这一步不是永久关闭的**。

---

## 10.4 阶段 3a + 3b + 3d 落地记录（2026-08-16）

出口条件全部达成：`lint` / `typecheck` / `build` / `cargo check --workspace --all-targets` 退出码 0；`vitest` 三项目 **361 文件 3064 用例**通过（unit 178 / markup 131 / interaction 55）；`lingui extract` 报 en-US Missing = 0（687 条）；阶段 2 的 322 个测试文件 `comm` 差集为 0；`src/routes.tsx` 与 `app/router.tsx` 一字未动，15 条路由仍全部可达。

八个页面不再是占位：交付（输出 / 任务记录）、任务详情、工作台首页、Demo 资料库 + 5 个对话框、证据检索、玩家目录、玩家档案、比赛历史。`data/` 从只读扩到读写：`tasks` / `outputs` / `demos` / `config` / `history` 都有了 mutation。

### 页面层拍下的三个板

| 决定 | 值 | 依据 |
| --- | --- | --- |
| 轮询节奏（§10.3 缺口 1） | 任务详情 2s / 任务记录 5s / 首页 digest 10s | 录制阶段以秒计（画板：片段 1 采集完成 · 3.0 秒），慢于 2s 会整段跳过阶段；50 行列表读的是完成/失败这种整体事件，5s 还与断线重连探测同频不打拍；首页是一瞥不是盯 |
| 停轮 | 真的实现了 | 不是页面算出 `pollMs` 回传（那会与屏幕上的数据错位），而是 `refetchInterval` 做成读 query 自身缓存答案的函数（`feedHasActiveTask` / `activityIsActive` / `analysisRunIsActive`），第一次拿到「全部终态」后 interval 变 false。两条 interaction 测试分别证明「有在跑就继续问」「全空闲就彻底停」。不丢事件的理由：任务只可能由本 app 的 mutation 启动，而每个 mutation 都失效 `qk.tasks.all` |
| `Toolbar.inlineActionsWhenCollapsed`（§10.3 缺口 2） | 交付页显式传 2 | 折叠下 940px 减去标题/meta/更多/主动作/间距后剩 414px，够放两个三字 ghost 按钮。`deliveryCollapse.interaction.test.tsx` 在 1100px 上验证 Seg 与「清理无效记录」都没进「更多」 |

失效链路每条都写了理由，其中一条是**故意不失效**：`planRecordingRetry` 只生成方案、没有任务发生变化，多打一次请求不会返回任何不同的东西——测试直接断言调用次数没变。

### 与规格的偏离

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | **本轮任务书自相矛盾**：要求页面用 `app/boundary` 的 `useServiceAction()`，而 §2.1 规则 3 禁止 `pages/**` import `app/**` | 三个 agent 各自按 lint 执行——两个写了自己的替身（`pages/{delivery,library}/serviceAction.tsx`），第三个干脆没有离线降级。**这是任务书的错，不是 agent 的错。** 已收口：`serviceHealth.ts` 从 `app/boundary/` 移到 `data/`（它全是对健康查询的纯派生，本来就是数据层的东西），新增 `data/serviceAction.tsx` 作为唯一实现，`app/boundary` 保留同名再导出。两个替身删除，调用点改一行 import |
| 2 | `data/desktopClient.tsx` 的 `DesktopClient` 只列了阶段 2 的读，三个 agent 各自声明了局部 `Pick` 切片绕开它 | 已把三份写方法并进中心 `Pick`，删掉两个 `requireCommand` 运行时守卫和 `demos.ts` 的 `as unknown as`，`DesktopClientStub = Partial<DesktopClient>` 声明一次。**这次收口抓到一个真 bug**：`LibraryPage.interaction.test.tsx` 给 `startAnalysisRun` 的桩返回 `{id:'run-1'}` 而不是一个完整的 `AnalysisRun`，被那个强转掩盖着 |
| 3 | 五组 msgid 一词两义 | 全部用 `context` 拆开：`应用`（设置分节 App / 对话框确认 Apply——确认按钮当时写着 "App"）、`分析`（任务种类名词 Analysis / 行内动作动词 Analyze）、`击杀`·`死亡`（证据种类单数 Kill·Death / 计数列头 Kills·Deaths）、`比赛`·`选手`（命令面板分组复数 / 表格列头单数）。**整套词表一起打标签**而不是只标撞上的那个词，否则下一个新增成员会静默继承别的屏幕的译法。注意 `msg` 是编译期宏，不能包进 helper 函数——包了 extract 什么都读不到 |
| 4 | 「饰品与 Demo 改写」（§10 排在 3b）一行未做 | 设计稿只在两处写了「已建议移入资料库 Inspector，需要独立编辑器再画」，**全稿没有任何一块画了它长什么样**。后端能力是齐的（8 个 cosmetic 命令）。需要一块正稿才能接 |
| 5 | 「保存为视图」与「列配置」只活在页面 state，刷新即失 | §4.2 说它们该进持久化的 zustand store，但 `shared/stores/uiStore.ts` 只有三个键且 `shared/**` 要到阶段 4 才动。没有偷偷写 localStorage（那会变成 §4.2 之外的第二套持久化），保存对话框里明写「本轮的视图只保留到应用关闭为止」 |
| 6 | 证据种类分段控件与画板不一致 | 画板画的是 击杀·死亡·回合·目标事件·道具（那是「行」的词表），而索引的过滤字段 `EvidenceSearchEventFamily` 只有 kill/multi_kill/objective/round_start。按索引**能真正回答的**四项落地，否则其中两个筛选会静默返回 0 条并让用户以为是自己搜错了 |
| 7 | 「已过期 · Valve 不再保留」不是后端字段 | `MatchHistoryItem.demo_status` 只有 available/downloading/downloaded/failed。用 `played_at` + `DEMO_RETENTION_DAYS = 14` 推导，依据写在 `matchHistoryRows.ts`：宁可少判过期，多判会让用户看不到本来还能下的回放 |

### 后端契约缺口（本轮撞到的，按影响排序）

这一轮页面接真数据，撞出的缺口比前三轮加起来还多。每一条都**没有**用假数据兜住：

1. **`ActivityItem.error` 是自由文本，旁边没有错误码。** 所以 `TaskFailureReason` 的五个具名值（磁盘空间不足 / 游戏不可用 / 源文件缺失 / 服务离线 / 超时）无法从线上数据还原，一律映射成 unknown 并把服务端原句放进 `Notice`。代价是状态行会出现「失败 · 未知原因」。要还原画板需要 `ActivityItem` 补一个 `code`。
2. **只有 analysis 有真正的阶段日志**（`AnalysisRunDetail.events`，9 个闭集 code）。recording 只有一个「当前阶段」字段、无历史，export / download 什么都没有。所以四分之三的任务类型的「阶段日志」是空态——没有用状态变化伪造日志行。
3. **没有 `retry_export`。** `ActivityAction` 只有 retry_analysis / retry_download / retry_recording；重跑一次导出需要原始 `EditorExportOptions`，活动记录不保存。失败的导出因此以「打开工程」作为恢复动作——这正是画板 11 画的。没有为此发明命令。
4. **recording 输出回链不到来源任务**：export 输出的 id 就是 job id（可拼成 `export:<id>`），recording 输出的 id 是 clip id，没有 job 可指。所以「来源任务」只对导出/合辑出现。
5. **`OutputItem` 没有时长 / 帧率 / 编码 / 分辨率 / 缩略图**，画板 11 的「42 秒 · 60 fps · 186 MB · H.264 / AAC」只印得出体积。「播放」也没实现——CSP 是 `default-src 'self'` 且没有命令返回可播放 URL（与 §10.3 缺口 8 同源）。
6. **`DemoSummary` 没有 tags**，标签只能逐 demo `getDemoMetadata`（一页 20 次往返）。**删掉了这一列而不是留一列永远空白**——永远空的列和静默截断是同一个谎。
7. **`normalizeDemo` 丢掉了 `file_size` 与 `content_sha256`**，Inspector 的「大小」「校验」两行渲染不出来，没有渲染成空行。
8. **没有「某个 demo 的历次 analysis run」查询**，只有 `getActiveAnalysisRun`，所以 Inspector 的「分析历史」时间线做不出来。
9. **`DemoRecord.status` 没有「已分析」**（只有 discovered/indexing/ready/analyzing/failed/missing）。需要产品确认 ready 是否等价，或后端补标志。
10. **`AnalysisRun` 没有分母**，画板的「分析中 62%」做不了，§4.3 明令前端不模拟进度。
11. ~~**没有原生文件/目录选择命令**：导入走浏览器 `<input type=file>` + 拖放（可用），但「添加监听目录」只能手打路径。也没有 reveal-in-explorer、没有 demo 重定位、没有把 `exportDemos` 的 ArrayBuffer 落盘的命令——三处都渲染成 disabled + 写明原因。~~
    **✗ 这条是错的，§10.7 已更正。** `shared/desktop/dialog.ts` 一直就有目录选择、文件选择、另存为、写文件、资源管理器定位与打开目录，插件与权限都配齐了。当时没有去读 `shared/**`（铁律把它划成只读，于是连读都没读）。
12. **`scanDemos` 把 `recursive` 写死为 true**，`demo_watch_paths` 是裸 `string[]`，没有每目录的递归开关。「包含子目录」渲染成 checked + disabled 并写明「服务按目录递归监听，暂不能只监听顶层」。
13. **`PlayerAggregateStats` 没有 首杀 / 残局胜率 / 常用地图**，按地图表没有 `wins`，`EvidenceSearchItem` 没有 距离 / 交战轴 / 回合情境。**都省略而不是渲染 0.0m**；爆头率能由 headshots ÷ kills 推出所以照常显示。
14. **证据结果的「注释」列需要按 evidence_id 批量查注释状态**，没有这样的读，逐行查会 N+1，本轮留空。
15. **§10.3 缺口 7 仍未关闭**：`GET /players/:id/heatmap` 返回原始点不是分箱。缓解是路由自带 `maximum_points = 5000`，前端一次 O(n) 过 `binWorldSamples`，DOM 节点被 48²=2304 上界钉死；`complete=false` 时页面明写「取样 5000 / 12480 …这张图画的是这批取样，不是全部」。
16. **`DesktopClient` 此前不含证据/选手的写方法**，所以 `data/evidence.ts` 与 `data/players.ts` 本轮仍然只读，页面上的写按钮全是 disabled + 写明原因。现在中心 `Pick` 已经打开，3c/3e 加 hook 即可。

### 留给后续阶段的已知缺口

1. **分析流水线 5 个阶段的中文名仍是提案**（校验输入 / 排队等待解析 / 解析比赛数据 / 复核解析结果 / 位置采样），连同 9 个 `AnalysisRunEventCode` 的中文，都集中在 `pages/delivery/taskModel.tsx` 与 `taskDetailModel.tsx` 两张表里，方便被替换。需要产品确认。
2. **`MAX_TASK_ATTEMPTS = 3`、`cancelled.RESTART`、「只有录制需要显式确认」** 三条仍是 §10.3 缺口 5 里的推断，未确认。
3. **`domain/task` 的 `TaskCard.onCancel` / `TaskDetail.onRetry` 是裸回调**，没有 `{disabled, disabledReason}` 槽。所以服务离线时「取消」是全页唯一被隐藏而不是禁用的动作，与「不隐藏、不静默失败」相抵。建议给这两个组件补上 `Button` 早就有的那对属性。
4. **`data/index.ts` 桶文件没有跟上**：本轮新增的 hooks 都没挂进去，页面走深路径 import（`app/boundary` 早有先例）。要不要统一走桶，收口时定。
5. **§10.1 缺口 3 / §10.2 缺口 9 仍未收口**（`Inspector` 与 `Drawer` 两套焦点陷阱）。
6. **`check-web-i18n.mjs` 依旧全红**（~190 行 Han literal）。它是旧 i18n 体系的守卫，假设源码里没有中文，而重构的 `sourceLocale` 就是 zh-CN——两者根本对立。它不在 `pnpm lint` 里，§10 阶段 4 已排定删除。

---

## 10.5 阶段 3c 落地记录 —— 比赛工作区（2026-08-16）

出口条件全部达成，命令由我自己复跑：`pnpm --filter @vibe-cs/web lint` 退出码 0（`lingui compile --strict` → `layer check passed: 498 source files` → `tsc -b` 无诊断）；`typecheck` 0；`vitest` **394 通过 / 3 跳过（397 文件）· 3578 通过 / 4 跳过（3582 用例）**；`build` 0（`MatchWorkspacePage` 分片 119.34 kB / gzip 31.31 kB）；`cargo check --workspace --all-targets` 0；`lingui extract` 报 zh-CN 999 / en-US 999，**Missing = 0**。阶段 3a/3b/3d 的 364 个测试文件一个都没有掉出收集集（397 = 364 + 33）。`src/routes.tsx` 与 `app/router.tsx` 一字未动。

`/match/:demoId` 从占位变成九个子视图：概览 / 回合 / 玩家 / 对位 / 道具与经济 / 回放与热力图 / 高光 / Review 与注释 / 队伍。

### 契约先行，然后三组并行

本阶段是全程唯一一次「串行一步 + 并行三组」：壳层 agent 先独占产出 `pages/match/viewContract.ts`，三个视图 agent 再各写三个视图。理由是契约错了三组视图会一起返工，一次往返换掉整类返工。

骨架 agent 把任务书写的「id → 组件」改成了 **id → 模块**（`MatchViewModule { id, Body, Inspector? }`），理由我认可并采纳：正文列与 Inspector 在树里的父节点不同，且在 §8 折叠时**独立移动**（面板变抽屉，正文不变）。一个组件同时渲染两半再由壳层 portal，会让九个视图各自持有一份完全相同的摆放逻辑，还会把折叠抽屉 portal 进一个正在滚动的容器。注册表 `MATCH_VIEWS: Record<MatchViewId, MatchViewModule>` 少一个成员编译不过。

`MatchViewProps` 只有五个字段（`demoId` / `context` / `updateContext` / `addToVideo` / `collapsed`），**不含分析数据**——九个视图各自调 `useMatchAnalysis`，TanStack 按键去重成一次请求；穿 props 会让壳层在每次 refetch 时重渲染九个视图。选中态回写只有 `updateContext(patch, { replace? })` 一个口子，没有 `onSelectRound/onSelectPlayer/onSeek` 三件套；一条不变式由 `workspaceContext.ts` 统一执行：**换到不同的回合会丢掉过期的 tick 与 evidence**，换视图则什么都不丢。

### 页面层拍下的板

| 决定 | 值 | 依据 |
| --- | --- | --- |
| 播放循环归属 | 视图（`views/usePlaybackClock.ts`），不在 `Transport` 里 | §10.3 已立「Transport 是受控件，不许在里面开 rAF」。用 rAF 而非 `setInterval`：窗口被遮挡时浏览器自己停，桌面应用要的正是这个；耗时取回调的 timestamp 参数，掉帧变成一次大步进而不是漂移 |
| 步进 | `STEP_MS = 66`（≈15Hz） | 地图一步要重画几百个 SVG 节点，60Hz 是给不出可读性的白烧。playhead 是 tick 不是帧序号，所以粗步进不丢数据精度 |
| tick 写回 URL | 播放时最多 1000ms 一次，全部 `{replace:true}`；用户主动的 seek / 跳出入点 / 点交战轴立即写 | 下界 1s ＝「复制出去的链接和眼睛看到的差不超过一秒」，比任何人会剪的最短片段还短；上界是路由器——每次写都是整个工作区重渲染，在 15Hz 步进下低于 ~500ms 就把地址放进了动画的关键路径。一个 ref 记住「本视图上次写进去的 tick」，据此区分外来的 `?tick=`（深链 / Inspector 的定位 / Agent 的定位），外来的接管本地 playhead |
| 卸载停循环 | 有测试证明，不是「effect 里写了 cleanup」了事 | `ReplayView.interaction.test.tsx` 用一个手动驱动的 rAF 队列：`pending()` 是真实队列长度（cancel 真的把回调从 Map 里删掉），unmount 后 `pending()` 为 0，再 flush 两次既不跑回调也不再写地址。另一条证明暂停同样清空队列 |
| 轨迹抽稀 | 每条 ≤240 采样点，stride 值印在画布出处行 | §10.3 缺口 1 量到未抽稀的 240×600 是 2.65MB；抽稀后整张画布含 12000 点热力云 < 1MB，格子 ≤48²，标记恰好 10 个 |

### 与规格的偏离

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | **`data/keys.ts` 没有 match 命名空间**，而 `data/match.ts` 的七个读一个都没法用 `qk` 表达 | 骨架 agent 自行**纯增量**加了 `match` 命名空间并当即报备。我复核后保留：§4.1 的示例本来就写着 `match: { workspace: (demoId) => ['match', demoId] }`，是阶段 2 漏建。它挂在 `demos` 旁边而不是下面——资料库的重命名/扫描会失效 `demos`，那不该让回放重新解码一遍。`radar` 同理挂在 match **旁边**（属于地图，Mirage 上每场比赛共用一条），有测试钉住「失效一场比赛不会丢标定」 |
| 2 | **概览没有 Inspector，也没有第二块 Scoreboard** | 两条钉死的壳层测试逼的：`matchWorkspace.interaction.test.tsx` 用 `findByText('Aurora')`，而 `MatchContextBar` 在任何宽度都留着自己的 Scoreboard，正文再放一块就是两个 `textContent === 'Aurora'`；`matchWorkspace.test.tsx` 断言 `/match/aurora` 渲染**壳层**的回落面板，而壳层只在 `view.Inspector === undefined` 时才给。`MatchViewModule.Inspector` 是静态的，做不到「选中回合时是回合面板、否则是壳层的」。**后果我要认下来**：深链 `?view=overview&round=21` 会出现「条上 R21 已选中、Inspector 说没选中」。要修得让 Inspector 也能是函数，或者让壳层回落面板可被视图运行时接管 |
| 3 | **回放 / 高光 / Review 三个视图没走 `viewChrome` 的 `ViewFrame`** | 回放是满幅布局（190px 图层栏 + 画布 + 底部 transport），套上 `gap-5 p-6` 的面板堆叠等于给一个本身就是盒子的页面再加一层边框与内边距。这条我采纳。**但它们各自手写的 404 恢复少了主动作**——六个视图给「开始分析（服务离线时禁用并写明原因）+ 回到资料库」，这三个只给一条「回到资料库开始分析」的链接，把用户支去另一页按一个本页就能按的按钮。收口时把 404 恢复提成 `viewChrome.NotAnalysedState`，九个视图共用一份；三个视图保留自己的框。三条 markup 测试从断言那句合成文案改成分别断言两个动作 |
| 4 | **`首杀` 一词两义** | `domain/match/matchEnums` 的高光种类是「Opening kill」（指标名），而 `DuelsView` 的首杀对决表用它当**列头指人**——一列选手名顶着 "Opening kill" 是错的词性。给指人的那一对（首杀 / 被击杀）打 `context: 'duel-column'` → Opening killer / Victim。**同表的 回合 / 武器 / 时间码 故意不打**：它们与全应用同词同义，分叉只会产生两条能各自漂移的条目——`穿墙`、`爆头` 今天各被八处共用，那才是该学的样子。这条与 §10.4 偏离 3 的「整套词表一起打标签」不矛盾：那条针对的是闭集词表，这条针对的是一对语义确实分叉的列头 |
| 5 | `清除选择` 与 `清空选择` 两条 msgid 同义 | 收口时统一成 `清空选择`——`PlayersPage` 与 `PlayerComparePanel` 早已发布这句，一个动作一条条目 |
| 6 | Review 的 AI 点评列用 `--w-inspector-wide`(440) 承载画板的 400px | §3.5 宽度表没有 400，440 是最近的一档。若认为要精确 400，该改的是 `theme.css` / `tokens.data.ts` 而不是页面 |
| 7 | 时码差一档 | 画板 04 的 `01:12.4`（mm:ss.十分之一）在 `design/timeline/timeScale.ts` 里不存在（§10.3 偏离 5），用了 Transport 的 clock 档，显示 `01:12` |
| 8 | 「加入视频」全工作区 disabled | 录制队列不是服务端状态（见下方缺口 2），壳层下发**同一句**原因给九个视图，行内与批量两处都是 disabled + 写明原因，没有一个被隐藏，也没有偷偷写 localStorage |

### 后端契约缺口（本轮撞到的）

一样，全部**没有**用假数据兜住。

1. **没有半场边界。** `Scoreboard` 收 `periods`，但 `TeamSummary.side` 说的是「现在」（整场结束时那一次），回合只带累计比分。「上半 / 下半 / 攻守已交换」推不出来。按第 12 回合切等于把 MR12 规则套在一份从不声明自己赛制的文档上，一份 MR15 的 demo 会印出两个假的半场比分。**整块省略。** 需要 `RoundSummary` 补逐回合阵营，或 `AnalysisWorkspace` 补显式的半场列表。
2. **「加入视频」没有任何命令。** `planRecording` 生成的是带 `expires_at` 的临时方案，真正的持久队列是 `features/queue/queueStore.ts` 这个客户端 zustand store，而 §4.2 的替代品要到阶段 4 才动 `shared/stores`。
3. **回合经济按阵营记而不是按队伍。** `RoundEconomyInsightRecord.teams[].team` 是 `'CT'|'T'`，`crates/domain/src/insights.rs` 在构造它的那一行自己写了原因：选手的阵营半场会变，一次购买事件只对它自己那一回合的阵营有效。所以经济表保留阵营标注并在表头写明「购买事件带的是当回合的阵营，不是队伍」，而不是把半场比赛记到错误的队名下。
4. **残局只有候选数，没有胜负。** 画板的「残局 3 / 5」是胜/尝试。线上只有 `kind: 'clutch'` 的高光（检测器产物），另有一个 `fail` 但它标记**任何**失败候选（包括失败的多杀），映射过去会把失败的多杀归进残局筛选。只印「残局候选 N」并注明「按高光类型统计，胜负未记录」。
5. **没有开火事件**，所以画板「AK-47 16 杀 · 命中 34%」的分母不存在。按武器的击杀数可由 `rounds[].events` 推出，命中率省略——`players.test.tsx` 有一条断言钉住页面里不出现「命中」二字。
6. **击杀事件只带一个 `position`**，没有字段说明它是击杀者的还是被击杀者的。`domain/map` 的 `Engagement` 需要 attacker + victim 两个坐标。对位视图因此一行蓝图图层都没画（画了就是把一个真点和一个编出来的点连起来还挂上「经击杀验证的交战轴」的图例）。回放视图退而求其次：从击杀 tick 所在的**回放帧**里读双方位置，回放不可用时一条轴都画不出来，数量已计数并印在出处行。
7. **`TimelineEvent.position` 是世界坐标，产品里没有 callout 表**，所以「回合内事件」表的「位置」列（中路 / A 大道 / A 连接）整列省略而不是在一个承诺地名的表头下印三个浮点数。需要一张逐地图的「世界多边形 → 名字」表；这与 §10.3 缺口 8（雷达底图交付）相邻但是另一份资产。
8. **`TimelineEvent.actor` / `target` 是自由文本**，按 demo 不同可能是 id 也可能是名字。三处（回放选手匹配、对位名单、首杀归属）都先按 id 再按名字（大小写不敏感）匹配，两者都对不上的击杀被丢弃并计数印出。需要后端明确这两个字段的语义。
9. **`TimelineEvent.id` 与 `EvidenceSearchItem.evidence_id` 不是同一个 id 空间**（不同 pass 生成），而 §4.4 的 `evidence` 参数指的是后者。所以回合事件表的「定位」**只写 `tick`**，不写 `evidence`；从 `/evidence` 深链过来对不上时只是「没有选中」，不会出错。若两者其实可对齐，说一声就能一行都写。
10. **`PlayerAnalysis` 没有首杀、没有残局**，`RoundSummary.key`（关键回合）在 wire 上不存在，`TimelineEvent` 没有拆弹倒计时，投掷物没有实体 id（`detail` 是 `unknown`，一次投掷连不上它自己的引爆与致盲）。对应的列 / 标记 / 逐条表全部省略或换成数据真正支持的粒度（逐选手 `insights.player_utility`），没有一处渲染成 0。
11. **回合起始装备价值不存在。** `TeamPurchaseInsight.spend` 是**已解码购买事件**的花费，且只要一条没带价格就整体为 `null`。画板的柱图（柱高＝回合起始装备价值）与「枪局胜率 9/14」「经济劣势翻盘 3」都没做。
12. **teams 视图接管不了 `/lineups`。** `listLineups` 是按 lineup_id 的跨比赛目录，而没有任何读能把一个 demo 映射到它的 lineup_id。队伍视图只由本场的 `teams` + `insights.round_economy` 构成。
13. **§10.4 缺口 8 仍未关闭**（没有「某个 demo 的历次 analysis run」查询），所以 `getAnalysisRunRoundReplayBinary(runId, round)` 拿不到 runId。回放只能整场取 `getReplayBinary(demoId)`，按回合切片是前端做的。
14. **`ReplayFrameRecord` 不带楼层**（`HeatPointRecord` 带）。所以楼层控件只筛热力叠加，路径 / 标记 / 交战轴筛不了；控件只在采样点确实跨两层以上时才出现，并在下面写明这条限制。
15. **Review 没有导出命令**（`DesktopClient` 里没有任何复盘导出路由），「导出 HTML」渲染成 disabled + 写明原因。AI 点评的语气写死 `analytical`——画板把「语气：专业」画成 Tag 不是控件。
16. **注释必须先有锚点**：`CreateEvidenceAnnotation` 要 `evidence_id` + `round` + `tick`，所以只有三者齐全时输入框与按钮才可用，否则 disabled 并写明「注释要挂在具体的 tick 上」。这是契约决定的，不是设计取舍。
17. **高光类型词表两头对不齐**：wire 的 `knife` / `taser` / `defuse` / `fail` / `timeline` 在 `HighlightKind` 里没有成员，全部折进「其他」（行上仍印分析器自己的 label）；反过来 `opening-kill` / `match-point` / `eco-comeback` 在 wire 里没有对应 kind，这三个筛选片永远不出现（计数由真实数据算出，不印 0）。要么补 `matchEnums` 成员，要么补分析器的 kind。
18. **`/agent` 带不走选中集**：§7 把它的 query 定死为 `plan / session / mode`，没有参数能表达一组高光。按「用现有路由能到的地方」处理——按钮可用、`navigate('/agent')`，但选中的 N 条不会跟过去。这与 §4.6 缺口 8 是同一件事，阶段 3e 要给 `/agent` 定一个引用入参。
19. ~~**`RadarOverviewRecord.image_url` 本轮一律不用**（§10.3 缺口 8 未定 + Tauri CSP `default-src 'self'`）。画布画的是蓝图网格，只用 transform 做世界坐标→图像坐标标定。本轮没有引入任何图片资源。~~
    **✗ 括号里的理由是错的，§10.7 已更正。** CSP 放行 `vibe-cs-media:`，bridge 的 `media_uri` 白名单里就有 `/maps/{map}/radar`，路由 `/api/maps/{map}/radar` 与 `/radar/metadata`（带 `browser_displayable`）都在，`desktopMediaUrl()` 也在。真雷达底图是能画的。蓝图网格可以在后续轮次换掉。

### 我引入的技术债与已知风险

1. **`data/match.ts` import 了 `features/analysis/replayBinary.ts`。** 那是仓库里唯一的 ARPL 解码器，复制第二份必然漂移；代价是它还说着旧 `shared/i18n`（`msg("m0176")`）。**阶段 4 删旧 i18n 时，这个解码器必须搬进 `data/`（或搬进 worker）而不是随 `features/` 一起删。** 已核实：旧字典本来就因 `shared/desktop/client.ts` 在主 chunk 里，所以今天不增加体积。
2. **`decodeReplayBinary` 同步跑在主线程**，最多 20 000 帧，`data/` 层没有 worker 接缝。打开回放视图会有一次可感知的卡顿。没有藏，写在 `useMatchReplay` 的注释里（该 hook 也是这一层唯一默认 `enabled: false` 的，因为工作区开在概览，九分之七的视图不需要几 MB 的帧）。
3. **回放的「选手位置」图层画在页面层**（`views/ReplayCanvas.tsx` 的 `PlayerLayer`），因为 `domain/map` 没有当前帧选手标记组件而本轮不许改 `domain/**`。它走 `MapCanvas` 的 projection 回调这个官方接缝并复用 `useRovingSelection`。建议后续**原样上提**为 `domain/map/PlayerLayer`（是搬家不是重写）。同理缺 `ProjectileLayer` / `BombLayer`——画板 04 的图层清单有「投掷物与火」「C4 生命周期」，`ReplayFrameRecord` 里数据是有的，本轮两个开关一个都没画（不画死开关）。
4. **对位的「对手」半边不在地址里。** §4.4 只有一个 `player` 位，而选中一个矩阵单元格选的是**一对人**。行方选手写进 URL，对手留在视图本地 state（换行方选手时清掉）。复制出去的链接能还原「Kael」，还原不了「Kael → Sable」。没有把对手塞进 `?evidence=`（那个字段的语义是一条证据的 id，不是人）。要修得改 `workspaceContext.ts` 加第六个参数——同一个决定还卡着 Review 的分区 Seg（`?view=review` 的深链只能落在「结论」）。
5. **回放没做全屏。** 画板 04 有这个按钮；画布是停靠布局里的一格，全屏时壳层其余部分怎么处理没有产品决定，所以没造。「跨比赛热力图」同理没做——`data/match.ts` 全部按单个 demo 取数，跨比赛热力图现在只存在于 `/players/:id`。

### 留给后续阶段的已知缺口

1. **§10.4 的 6 条全部仍然成立**，其中缺口 4（`data/index.ts` 桶文件）到本轮为止已连续三轮被提。**收口决定：不做桶。** `data/` 的每个模块对应一个页面组，一个桶会把九组 hook 全拉进任何 import 其一的分片，恰好抵消 `MatchWorkspacePage` 独立分片的意义。深路径 import 是既定写法，`app/boundary` 早有先例。这条从缺口清单里划掉。
2. **概览深链的 Inspector 不一致**（本节偏离 2），要修得先决定 `MatchViewModule.Inspector` 能不能是运行时可选的。
3. **`viewChrome.ViewFrame` 与满幅视图的两分**（本节偏离 3）：要么给 `viewChrome` 补一个满幅变体，要么承认回放/高光/Review 是例外。本轮只统一了 404 恢复与两个探针属性（`data-match-view` + `data-match-view-state`），九个视图现在能用同一种方式读状态。
4. **四条「读不到分析」的句子各写各的**（壳层的、回放的、高光的、Review 的）。本轮**没有**统一：它们各自带着视图特有的名词（「读不到这场比赛的高光」），比一句通用文案更有用。若日后认为该收成一条，那是 catalogue 的取舍不是 bug。

---

## 10.6 阶段 3e 落地记录 —— Agent 创作面板（2026-08-16）

出口条件全部达成，命令由我自己复跑：`pnpm --filter @vibe-cs/web lint` 退出码 0（`layer check passed: 605 source files`）；`typecheck` 0；`vitest` **452 通过 / 3 跳过（455 文件）· 4214 通过 / 4 跳过（4218 用例）**；`build` 0（`AgentPage` 分片 77.67 kB / gzip 21.70 kB，是真代码不是壳）；`cargo check --workspace --all-targets` 0（本轮零 Rust 改动）；`lingui extract` 报 zh-CN 1268 / en-US 1268，**Missing = 0**。阶段 3c 的 397 个测试文件一个都没掉出收集集。

`/agent` 从占位变成完整页面：对话流与三种形态（`?mode=changes|inline|takes`）、方案面板与手动编辑、会话抽屉与新建会话、设置「AI 与 Agent」。

### §4.6 是关的，所以这一轮没有适配器

动手前先核实：`crates/application/src/routes/agent_sessions.rs` 的路由齐全（会话列表与搜索 / 重命名 / 删除 / 追加条目 / 触及引用 / 反向索引 / 方案列表与详情 / PATCH 编辑 / 还原 / 可引用对象 / 设置 / 存储统计与导出与清空 / 保留策略），`crates/domain/src/agent_session.rs` 有 `AgentObjectRef` / `based_on_revision` / `WorkspaceEditAuthor`，`shared/desktop/client.ts:493-570` 有全部方法。§4.6 的十项缺口在更早的阶段就补齐了。

所以 §10 给 3e 定的出口条件「适配器已换成真实后端命令」，本轮用**从来没有写过适配器**来满足。goal 里直接 grep：`data/{sessions,plans,editNotifier}.ts` 与 `pages/agent/**` 里没有 `localStorage` / `sessionStorage` / `indexedDB`，只有两处文档注释在说「不这么干」。

### 收口时抓到的一个真 bug

A 块（对话流）与 B 块（方案面板）在同一轮里各自实现了「变更卡 + 接受 / 拒绝」。B 块的 agent 在报告里主动点了名，他是对的。两个后果：

1. **在 `?mode=changes` 的对话流里按「接受」，卡片变成已接受，方案一个字没改。** A 的 handler 只写决定态，既不把变更落到镜头上也不 `record` 编辑；B 的 `onAccept` 会 `applyPlanChange(shots, change)` 再 `record(result)`。这是一次**静默的空操作**——用户会以为改动生效了。
2. 决定态存在两处独立的 `useState`，键的形状还不一样（A 用 `#` 分隔、B 用 `:`）。同一条变更在同一块屏幕上，方案面板说「已接受」，对话流里还是「待处理」。

**这是连续第三轮同一形状的问题**（§10.4 是两份 `serviceAction` 替身，§10.5 是三份缺了主动作的 404 恢复）。并行切分本身有效，错在**跨块共享的那一件东西没有由壳层持有**：`editNotifier` 这轮做对了（契约里写成不变式 5），决定态漏了。

收口方式：新增 `pages/agent/changeDesk.ts` 的 `useAgentChangeDesk`，由 `AgentPage` 调用一次，经 `AgentBlockProps.changes` 下发，并在契约里补成**不变式 6**（写法照抄不变式 5：同一条变更画在两列里，「已接受」是变更的事实，不是某一列的事实）。`accept` = `applyPlanChange` + `record` + `decide`，三件事一起做或都不做；`reject` 不动镜头，只写决定。两个块都不再持有自己的 state。`conversationModel.ts` 成为唯一的模型（`resolveChangeSet` 只剩一处实现，decisions 覆盖在前、`markStale` 覆盖在后的顺序未动），`planProposals.ts` 只保留它真正独有的 `PlanProposal` + `readPlanProposals`，重复的部分删掉且**没有留兼容别名**。

收口任务书要求那条测试**先写、先看它红、再改代码**。红的输出留档：`applies the change to the plan rather than only colouring the card` → `expected '…8.5s…' to contain '3.0s'`；`hands the edit to the one notifier` → `expected [] to have a length of 1`；`marks the panel's card accepted when the transcript's is pressed` → `expected 'pending' to be 'accepted'`。7 条全红，改完 7 条全绿。

顺带修掉的两条：`EditFlushReason` 补 `'restore'` 成员（「还原为 Agent 版本」原先借用 `'switch-plan'`，日志里会看到一个与事实不符的 reason）；`useEditNotifier` 的 `onError` 原先是空壳，现在用 `isRevisionConflict` 分开——冲突走已有的「基于修订 N 重算」，别的失败给一条就地 Notice。

另外，B 块的 agent 在实现中自己修掉了一个真 bug 并报备：`commitEdit` 闭包捕获了旧的 `planData` / `sessionData`，而 `switch-session` / `switch-plan` 的 flush **发生在地址已经变了之后**，那一帧新选中的 query 还在 pending，取值是 `undefined` → `commitEdit` 抛出 → notifier 吞掉 → **通知被静默丢弃**。这正是 §4.5.4 要防的事。改成读 ref 里的待写快照并校验 `plan.id === pending.planId`。

### 本轮拍下的三个板

| 决定 | 值 | 依据 |
| --- | --- | --- |
| §10.5 缺口 18（`/agent` 带不走选中集） | **不加第四个 query 参数。** 高光页把选中的 N 条先 `createAgentPlan` 成一个方案，再 `navigate` 到 `?plan=` | ① 方案本来就是「N 个镜头」，不需要新类型；② 已创建的对象扛得住刷新、复制链接、第二条会话，`?clips=a,b,c` 一样都扛不住，而且 `AgentObjectKind` 里根本没有「三条高光」这个种类，双向引用记不下；③ §4.5.1 说会话是**接管**已有对象，接管的前提是对象先存在——在发送侧创建才能接管，在接收侧创建等于「打开 /agent 就写库」。接收侧零改动：新建的方案是 draft，自动出现在 `listAgentWorkspaceReferences().pending_plans` |
| §10.1 缺口 2（保留策略没有调度器） | **周期性清理归后端 runtime，前端不做启动即扫。** 面板里只有一个触发点「立即应用」，带破坏性二次确认并回报 `removed_sessions` | ① 渲染进程不是调度器，只在开着窗口时扫会让「30 天」变成「30 天，如果你最近开过应用」；② 启动即扫是一次没有任何用户动作触发的**不可逆删除**，而且发生在用户能看到（更别说改正）策略之前，一个误设的「不保留」会在下次启动时静默清空；③ 与 §4.5.3 ① 同形：会毁东西的活儿要一次显式确认。**要后端加一个跟随 runtime 生命周期的清扫任务** |
| 镜头种类 | **7 个不是 5 个** | `AgentPlanShot.kind` 就是 `RecordingRequest['camera_style']`，比 §4.5.2 多 orbit 与 dolly，而画板正文自己写着「第 2 个镜头由 Dolly 改为 Tracking」。按 5 个建表会渲染不出后端合法返回的方案。记为与规格的偏离 |

### 与规格的偏离

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | 两份变更处理，其中一份的「接受」是空操作 | 见上。并成一份，补成不变式 6 |
| 2 | `AgentPlanShot.kind` 是 7 个成员 | 按 wire 建表，两个多出来的照样给标签，文件头写明 |
| 3 | `domain/agent/types.ts` **不重抄 wire 结构** | 与 `domain/match` 的先例相反，理由写进文件头：比赛是只读的，一份展示副本只花一个 mapper；方案要**写回**（`applyAgentPlanEdit` 要整个 `shots` 数组 + `expected_revision`），副本就要反向 mapper，而反向 mapper 正是 `params: unknown` 被悄悄丢掉的地方 |
| 4 | i18n 只给**两整套**词表打 `context` | `agent-object`（「输出」在 `/delivery` 是复数导航节，这里是单个对象种类）与 `plan-change`（「已过期」在比赛历史页是「Valve 不再保留」，这里是「基于旧修订」，根本不是错误）。**「等待确认」故意不打**——`domain/task` 早就发布了同词同义的这条，拆开只会产生两条各自漂移的条目（§10.5 偏离 4 的教训） |
| 5 | `SettingsPage.tsx` 改动大于「只挂上一节」 | 除挂上 `AiAgentSection` 外，还加了 `design/layout/SubNav` 的 190px 侧栏与 `?section=` 接线——否则 `?section=ai` 只能靠手敲地址才到得了。其余四节仍是 3g 的占位，`SECTION_BODY` 是 `Record<SettingsSection, ComponentType \| null>`，3g 只需在 `pages/settings/` 下加四个文件、把四个名字写进表里 |
| 6 | 「录制前始终由你确认」用 `Toggle locked` 而不是 `disabled` | `disabled` 会把它压成 45% 不透明度，读起来像「这个设置没加载出来」。`locked` 是 on + `aria-disabled` + 点了不动 + 一行 `aria-describedby` 的原因。**它的 checked 值来自 `domain/task` 的 `TASK_REQUIRES_CONFIRMATION.recording`**，也就是产品里真正拒绝无确认录制的那张表，而不是这个文件里敲的一个 `true`，有测试断言两者相等 |
| 7 | 跨页面目录 import | `pages/settings/AiAgentSection.tsx` 用了 `pages/delivery/outputModel.ts` 的 `formatBytes`（全仓只有那一个字节格式化器，第二个拼写就是 38 MB 和 36.2 MiB 出现在同一屏的方式）。分层 lint 允许，`pages/home/**` 早有先例。若要「页面目录互不依赖」，该把 `formatBytes` 提到共享模块 |

### 后端契约缺口（本轮撞到的）

1. **`AgentPlan` 不绑定 Demo，`AgentPlanShot` 没有 `demo_id` / `player_id`。** 而 `planRecording` 的每条 `RecordingRequest` 都要这两样。**「确认并生成视频」因此拼不出请求体**，渲染成 disabled + 写明原因，没有从 `params: unknown` 里猜字段。这一条同时削弱了上面那个 handoff 决定：高光页造出来的方案说不出这几条高光来自哪个 Demo。地址那层定死了，载荷这层没有，而载荷不是 query 参数能补的。
2. **线上没有任何 `ChangeSet` / `Change` 类型。** `AgentSessionProposal` 是 `{kind, title, plan_id, based_on_revision, payload: unknown}`，逐条变更全在 payload 里。落地方式：`readPlanChangeSet` 解析器——形状对不上返回 `null`（提议只印标题、不出变更卡），单条缺 `op` 或 `target` 才丢弃，缺 `rationale` / `delta` 只置 null。没有发明字段。`payload` 的 `replace` / `insert` 只有散字段没有镜头，所以这两个 op 的「接受」是禁用 + 写明原因。
3. **没有 accept / reject 的任何存储。** 哪几条变更被处理过只活在页面 state，刷新即失。而且「接受一条 Agent 变更」在线上表达成一次普通 `applyAgentPlanEdit`，`WorkspaceEditNotice.by` 恒为 `'user'`，所以线上分不清「我接受了 Agent 的建议」和「我自己改的」。
4. **流式 `AgentProposal` 不带 `plan_id` / `based_on_revision`**，且它的 `kind` 是四成员闭集（highlight_edit / beat_alignment / hlae / video_render），没有「方案变更」这一类。所以 `based_on_revision` 只能由前端在按下发送时按当时读到的 `plan.revision` 盖章——**这是全链路里唯一存在这个数字的地方，§4.5.3 规则 ③ 目前靠它成立。**
5. **流式 Agent 与会话存储是两套。** `agent_chat` 写它自己的 `AgentThread`，`AgentChatInput` 只有 `threadId` 没有 `sessionId`；`/api/agent/sessions` 是另一套。`useAgentChatStream` 做桥接（发送前写 user 条目、complete 后写 assistant 条目），后果记在文件头：user 条目写入后流中断，会话里会留下一个没有回答的问题。
6. **`AgentWorkspaceSettings` 只有 `session_retention` + `take_limit`。** 画板的五个开关（应用剪辑变更前先预览 / 显示 Agent 读取了哪些证据 / 默认成片时长 / 点评语气 / 自动带入当前选中的 Demo 与选手）**一个都没有字段，一个都没有画**。「录制前始终由你确认」本来就是不可关闭的常量，按常量处理。
7. **没有 Take 模型。** §4.5.2 的 `Take` / `Composition` 没有线上类型也没有路由，而 `AgentWorkspaceSettings.take_limit` 却在限制一个 API 列不出来的东西。`?mode=takes` 因此**没有编一张白板**：只比较真实存在的两个版本（`plan.agent_baseline` 与当前 `plan`），指标只用真有的字段，`CompositionRow` 一行不渲染并固定印一句「后端还没有 Take 模型」，markup 测试断言页面里不出现「Take A/B」。
8. ~~**`exportAgentSessions` 导出的文档没有落点。** 路由返回一份 JSON，而 bridge 的 141 个命令里没有任何通用的「保存文件 / 选择保存位置」命令。所以「导出」今天能做的只有取回文档、印一句「已导出 N 条会话」。没有假装成功，也没有用 `<a download>`（Tauri 沙箱里本来就不工作）。~~
   **✗ 这条是错的，§10.7 已更正。** 落点是 `shared/desktop/dialog.ts` 的 `chooseLocalSavePath` + `saveLocalBytes`。「没有通用的保存命令」这句话只有在不读 `shared/**` 时才成立。
9. **引用只能加，不能撤。** `touchAgentObjectRef` 是 POST，没有对应的删除路由，而画板「新建会话」右栏画了一个「取消引用」按钮。落地：创建之前「引用」只是本地选中，可以整体清空；创建之后没有任何办法撤销一次 touch，那个按钮就没有画。要修：一条 `DELETE /agent/sessions/{id}/refs/{kind}/{id}`。
10. **`AgentPlan` 没有 tick rate。** 编辑「时长 5.0s → 8.5s」时同一次改动的结果也该是 tick 顺着移动，但 64 与 128 之间只能猜。落地：把时长 / 起始 tick / 结束 tick 做成三个独立字段，并在时长旁写一句 hint 说 tick 区间不随它动。
11. **`AgentSessionEntry` 没有 token / 耗时 / 模型字段**，画板 07 的「工作进度」只能从 `tool_calls` 反推，而它的 `input` / `output` 都是 `unknown`。**`AgentSession` 也没有上下文字段**，所以「新建会话」的那排 chip（＋Demo ＋选手 ＋证据 ＋BGM）与会话行第二行「Aurora vs Meridian · Kael · R21」都没有落点，整块省略（不是画成不可点）。
12. **`AgentObjectRef.status` 与 `AgentWorkspaceReference.status` 都是自由文本**，映射不到 `StatusDot` 的闭集，各块直接印服务端原句。
13. **没有任何「预览这条」。** 2a 的逐条变更预览与 2b 的「换一个镜头」预览都没有命令（与 §10.3 缺口 8 同源：CSP `default-src 'self'`，没有可播放 URL）。同板的「影响」指标（录制耗时 6 分 → 5 分）也没有任何字段。
14. **`data/config.ts` 没有 `useTestLlm`。** `testLlm` 已经在 `DesktopClient` 的 Pick 里，但没有 hook 包它，所以设置「模型」块的「测试连接」与「连接正常 · 支持工具调用」那一行没有画。落地只要加一个 mutation 返回 `LlmTestResult`。没有在页面里直接 `useDesktopClient()` 绕过去——那会是全仓第一个这么干的页面。
15. **`output` 种类的引用 chip 点不进那个文件。** §7 给 `/delivery` 的只有 `?view=outputs|tasks`，没有 `/delivery/output/:id`。所以它落到列表页（最近的可寻址位置），理由写进 `sessionDrawerModel.ts` 并有测试钉住。要改得给 §7 加一个输出的一等地址——那是路由表的事，不该由页面偷偷加一个参数。

### 留给后续阶段的已知缺口

1. **409 冲突只做到「不静默」，没做到「不丢」。** 手动编辑撞上修订冲突时，界面会说清「屏幕上的改动还没有写进方案」并给出「基于修订 N 重算」，但那是**让 Agent 重新给变更**，不是把用户丢掉的编辑按新修订重放一遍。`createEditNotifier` 故意不重排队，重放需要壳层里第二条 commit 路径。报了没做。
2. **`domain/agent/AgentSessionRow` 的 `now` 是可选 prop，不传就每一行都退化成「08-15」这种日期形式**，画板的三档时间戳（09:02 / 昨天 / 08-13）会静默丢掉两档。抽屉自己读一次时钟并有一条**故意不传 `now`** 的测试盯着；以后用这个 row 的地方（方案详情的「改动来源」）要注意同一个坑。建议把 `now` 改成必填。
3. **§10.4 缺口 1 / 3 / 5、§10.5 的四条**仍然成立。
4. **`check-web-i18n.mjs` 依旧全红**（267 个文件），它是旧 typed-literal 体系的守卫，与 `sourceLocale: 'zh-CN'` 根本对立，不在 `pnpm lint` 里，§10 阶段 4 已排定删除。

---

## 10.7 阶段 3f-be 落地记录 —— 录制的四件事与 CI 的 Rust 门（2026-08-16）

第一轮纯后端。出口条件全部达成，命令由我自己复跑：`cargo clippy --workspace --all-targets -- -D warnings` 退出 **0**（**这条在 `feb1889` 上是红的**，见下）；`cargo test --workspace` 退出 0，30 个测试二进制 753 个用例全过；`pnpm --filter @vibe-cs/web lint` 退出 0（`layer check passed: 605 source files`）；`typecheck` 0；`build` 0（`✓ built in 2.54s`）；`vitest` **452 通过 / 3 跳过（455 文件）· 4214 通过 / 4 跳过（4218 用例）**；`lingui extract` 报 zh-CN 1268 / en-US 1268，**Missing = 0**。

后两个数字**与 3e 逐字相同，这正是本轮该有的样子**：没有一行前端 UI 被改，也没有一条新文案。`git diff --stat feb1889 -- apps/web/src/{pages,design,domain,features,styles}` 无输出；`apps/web/src/data` 只动了 `desktopClient.tsx`，且只往 `Pick` 里加了 24 个方法名。

改动规模：30 个文件、+3541 / −171，另有 5 个新文件（`domain/recording_preflight.rs`、`domain/recording_preset.rs`、`hlae/scene_presentation.rs`、`application/routes/recording_presets.rs`、`storage/repository/recording_presets.rs`）。

### 动手前先纠三条错：前几轮把已经有的能力记成了后端缺口

这一轮我在写任务书之前把 Tauri 外壳和 bridge 通读了一遍，撞见三条**记录本身是错的**的缺口。它们不是新做的功能，是**一直都在、但没人去读**：

1. **§10.4 缺口 11「没有原生文件/目录选择命令」是错的。** `apps/web/src/shared/desktop/dialog.ts` 里有 `chooseLocalFile(s)` / `chooseLocalDirectories` / `chooseLocalSavePath` / `saveLocalBytes` / `writeLocalBytes` / `revealLocalPath`（资源管理器里定位）/ `openLocalDirectory` / `openExternalHttpsUrl`，Tauri 的 dialog / fs / opener 三个插件与对应权限在 `capabilities/vibe-cs-workspace.json` 里配齐。
2. **§10.5 缺口 19 / §10.3 缺口 8「CSP 是 `default-src 'self'`，没有可播放 URL、不能用雷达底图」是错的。** 真实 CSP 是 `default-src 'self' customprotocol: asset:`，外加一个 `vibe-cs-media:` 自定义协议，`media-src` / `img-src` / `font-src` 全部放行；`bridge.rs` 的 `media_uri` 白名单包含 `/recorded-clips/{id}/stream`、`/media/assets/{id}/stream`、`/media/assets/{id}/proxy/stream`、`/players/{id}/avatar`、`/cosmetics/…/image`、**`/maps/{map}/radar`**；`client.ts` 一直有 `desktopMediaUrl(path)`。**视频预览、音频源、真雷达底图都是能做的。**
3. **§10.6 缺口 8「导出的文档没有落点」是错的。** 落点就是 `saveLocalBytes`。

三条同源：铁律把 `shared/**` 划成只读，于是并行 agent 连读都没读，于是「我这层做不到」被写成了「后端没有」。**只读不等于不用读。** 后续轮次的任务书已经改成显式点名 `shared/desktop/dialog.ts` 与 `desktopMediaUrl`，并要求页面经 `data/nativeShell.ts` 这层接缝去用（`pages/**` 不许直接 import `shared/**`）。

本轮又添两条同类纠错：

4. **相机路径的逐帧坐标一直拿得到。** `POST /api/agent/proposals/hlae/preview` 返回的 `HlaeProposalPreview.typed_plan` **就是一份 `HlaePlan`**：`shots[].keyframes[]` 每个带 `position{x,y,z}` / `rotation{pitch,yaw,roll}` / `fov`，插值 Cubic / SphericalCubic，关键帧由 `sample_four_frames` 从回放证据采样。dto.ts 把它写成 `unknown`，所以没人发现。画板 08 的导播预览因此**能画真实路径**，不是示意。
5. **我给出的「client 缺失方法」清单有四条是假的。** `generateAssetProxy` 实为 `generateMediaProxy`、`cleanupAssetProxies` 实为 `cleanupMediaProxies`、`getAssetAudioAnalysis` 实为 `analyzeAudioAsset`、`getRadarMetadata` 实为 `getRadarOverview`。我那份清单是路由表机器比对出来的，agent 逐个核实后没有加重复方法——**任务书里「我这份清单可能有误，先核实」那句话是有用的，保留**。

### CI 的 Rust 门在 `feb1889` 上就是红的

`.github/workflows/ci.yml:26` 是 `cargo clippy --workspace --all-targets -- -D warnings`。我在动手前跑基线：不带 `-D warnings` 退出 0 但产出 **59 条 warning**；带上 `-D warnings` 退出 **101**，11 条 error 就把编译停在 `crates/agent/src/tools.rs`（10 条）与 `crates/hlae/src/session_bootstrap.rs`（1 条），下游 crate 根本没被 lint 到——这也是那 27 处 `camera_style: Default::default()` 从来没人看见的原因。

仓库没有 `rust-toolchain.toml`，本机是 rustc / clippy 1.97.1（2026-07-14），这批基本是新版 clippy 新增 lint 扫出来的存量。**与本次重构无关，但既然要动 Rust 就一起清了**，作为本轮的一个串行步骤（四个实现 agent 停手之后再跑，避免撞车）。现在 `-D warnings` 退出 0。

**建议加一个 `rust-toolchain.toml` 把工具链钉住**，否则下一次 stable 发布会再次把门弄红，而且是在一个和改动无关的时刻。这条没做，记在这里。

### 本轮补的四件事

| # | 补了什么 | 为什么非补不可 |
| --- | --- | --- |
| 1 | **每镜头拍摄参数**：`RecordingRequest.presentation: Option<RecordingPresentation>`（camera_fov / viewmodel_fov / flash_alpha / show_hud / show_radar / voice） | 画板 08 的「片段属性」把这六项画在**单个镜头**上，而线上它们只存在于 `AppConfig.recording` 的全局默认里。`HlaePlayerPovPresentation` 这个结构在 hlae crate 里早就有——画板显然是照它画的——但从没接到每个镜头上 |
| 2 | **录制前校验**：`POST /api/recording/plans/{id}/preflight` → 闭集 `RecordingPreflightCheck { code, state, detail, affected_item_ids }` + `blocking` | 线上只有 `warnings: Vec<String>` 自由文本，界面逐行渲染不了，更做不出画板的「影响 N 个镜头」 |
| 3 | **镜头预设**：`recording_shot_presets` 表 + `/api/recording/shot-presets` 四个动作 | 「存为预设」无处可存；`EditorPreset` 是多轨编辑器的片段预设，与它零字段重合 |
| 4 | **方案 → 录制**：`AgentPlanShot.recording: Option<AgentShotRecording>` + `POST /api/agent/plans/{id}/recording-plan` | §10.6 缺口 1。方案拼不出 `RecordingRequest`，所以 3e 的「确认并生成视频」至今禁用，`pages/agent/agentHandoff.ts` 至今零调用点 |

三条实现上的要点：

- **`None` 表示「用全局默认」，不表示「关掉」。** 不在类型层展开默认值，否则「用户没设」与「用户设成了和默认一样」在存储里就分不出来。展开发生在 runtime。
- **每个 take 用自己的 presentation**，有测试证明同一个 job 的两段拿到不同的值。原先 `presentation(config)` 返回一个值给整个 job。
- **非 POV 镜头的 HUD / 雷达 / 队内语音 / 闪光四项也接上了**（原先 `build_camera_plan` 完全不吃 presentation），命令文本抽进新的 `crates/hlae/src/scene_presentation.rs` 由两条采集路径共用，**不是第二份字符串拼接**——那个模块刻意做成闭集编译，调用方不能注入自由控制台输入。

### 本轮拍下的四个板

| 决定 | 值 | 依据 |
| --- | --- | --- |
| 非 POV 镜头传 `camera_fov` / `viewmodel_fov` | **拒绝（InvalidInput），不静默忽略** | 观察者镜头的视野由相机路径的逐帧 `fov` 决定，viewmodel 根本不存在。静默忽略等于界面上摆一个不生效的滑块。界面上这两项对非 POV 禁用并写明原因 |
| `RecordingPreflightCode::CameraCollisionUnverified` | **保留** | 它不测量碰撞，它报告「这几个镜头的坐标在进游戏预览之前无法与地图几何核对」——而这正是画板第八行写的「碰撞几何未知（**影响 1 个镜头**）」。背后是真实存在的 `HlaeNoticeCode::CameraCollisionNotChecked`（`validate_hlae_plan` 对每份相机路径计划无条件抛出）。它**不是永远绿**：有非 POV 镜头时是 Warning 并列出 item id，全是 POV 时是 Ok（POV 采集不含任何编造坐标），且 `can_block()` 恒为 false。这一条会随「游戏内预览」按钮落地而变得可行动 |
| 镜头预设**不要** `expected_revision` | 与 `/api/editor/presets` 相反 | 编辑器预设会被套用到工程片段上并钉住工程修订；镜头预设只是把几个数复制进一个镜头，**服务端没有任何地方解引用预设 id**，没有可钉的东西。理由写进模块 doc comment |
| `presentation` 计入 plan binding 哈希 | **是** | `recording_plan_binding` 序列化 `items`，所以改一个镜头的 FOV 会让已生成的计划租约失效。这是对的：改了参数还录旧计划，用户看到的预览就不是要录的那份 |

### 与规格的偏离

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | `crates/application` 新增依赖 `vibe-cs-platform-windows` | `EncoderAvailable` 那条检查要读真实的 Media Foundation 编码器探测，实现在那个 crate 里。`recording` / `runtime` / `storage` 三个 crate 早就依赖它，application 加入不引入任何新约束；CI 的 Rust job 本来就是 `windows-latest` |
| 2 | 四条 runtime 规则在 application 里重写了一遍 | runtime 依赖 application 而不是反过来，原件又是 `pub(crate)` 或私有。**这是真重复，会漂移**。要收口得把这四条提到 domain 或一个共享 crate。已报，未做 |
| 3 | `crates/storage/src/schema.rs` 指纹变了 | 加 `recording_shot_presets` 表与索引，改动 `CURRENT_SCHEMA` 即换指纹，既有本地库会以 `StorageError::CurrentSchemaRequired` 拒绝启动。产品未发布，这是该文件顶上写明的既定做法，但**它是一次真实的破坏性变更**，记在这里 |
| 4 | 契约 agent 改了任务范围外的 `routes/recording.rs` | 不可避免：给 `RecordingRequest` 加一个 Rust 侧必填字段，会强制更新全仓 22 处字面量（8 个文件，机械的 `presentation: None`）。另加 4 行把 `presentation` 透传进私有的 `RecordingQueueItem`——不加的话该结构 `deny_unknown_fields`，任何带 `presentation` 的请求都会 400，那份 dto 镜像从第一次请求起就是假的 |
| 5 | `RecordingDefaults` 保持两个 bool（`mute_voice` + `isolate_target_voice`）不动 | 新的 `RecordingVoicePolicy` 是三值枚举，两个 bool 表达三个状态、第四个组合非法（runtime 里第一件事就是拒绝它）。但改配置结构会牵动配置读写与设置页，不是本轮的活。runtime 负责把两个 bool 折成枚举。**3g 做设置「游戏与录制」那一节时应该一并收口** |

### 后端契约缺口（本轮撞到的）

1. **结构化的 422 body 到不了渲染进程。** `POST /agent/plans/{id}/recording-plan` 在有镜头未绑定时返回 `{code, message, shots:[{id,title}]}`，但 `bridge.rs` 的 `DesktopCommandError::from_problem` 把任何错误体压成 `{status, code, message}`，`client.ts` 的 `DesktopError` 也只有这三样，`shots` 在路由与页面之间被丢掉。**前端不需要它**：`recording === null` 的镜头就是未绑定的镜头，而那份方案页面本来就拿在手里；422 的 `code` 决定说哪句话，方案决定标哪几张卡。Rust 侧与 JSDoc 两处都写明了这一点，免得下一个人去找一个永远不会到的字段。要真honour它，`DesktopCommandError` 与 `DesktopError` 各加一个透传字段，约 10 行
2. **两行校验在自动化测试里永远绿不了**：`capture_component_ready` 需要 data dir 下有一份准备好的受管 HLAE，`encoder_available` 读的是本机真实的 Media Foundation 注册表。测试只能覆盖「缺失时的形状」，不能覆盖「就绪时的形状」
3. **`AgentShotRecording` 没有 tick rate**（§10.6 缺口 10 的延续）：绑定里存的是秒（前后留白），镜头本体存的是 tick，两者之间的换算仍然要靠 Demo 的 tick rate，而方案不绑定 Demo 之外的任何东西
4. **没有「预设应用到全部」的服务端语义**：那是界面上的一次批量赋值，服务端看到的只是 N 个改过的镜头。撤销要由前端负责

### 留给后续阶段的已知缺口

1. **加 `rust-toolchain.toml`。** 本轮把 clippy 清零了，但没钉工具链，下一次 stable 发布会以同样的方式把 CI 弄红
2. **偏离 2 的四条重复规则要找一个共享的家。**
3. **偏离 5 的 `RecordingDefaults` 三值化**，随 3g 的设置「游戏与录制」一节做
4. **`vendor/demoparser` 在 `cargo fmt --check` 下是脏的**，本轮未动。它是 vendored 外部代码，要么排除在 fmt 之外，要么一次格式化掉
5. **§10.4 缺口 1 / 3 / 5、§10.5 的四条、§10.6 的四条**仍然成立，其中 §10.4 缺口 11 与 §10.5 缺口 19、§10.6 缺口 8 **已按本节开头更正为「不是缺口」**

### 产品决定：饰品与 Demo 改写不做

设计稿在「仍未画」清单里把它列为「已建议移入资料库 Inspector，需要独立编辑器再画」，至今没有画板。**决定：不做。** 后端 `crates/application/src/routes/cosmetics.rs`（521 行，检查 / 改写 / 目录）保留不动，界面不建。这一条从此**不是缺口**——缺口是等着被补的，这个是定了不补。

### 产品决定：使用引导做两块

设计稿的处置建议是「工作台首页已接管入口，引导建议改成首次使用时的三步提示条」。决定做**两块**：

- **首页三步提示条**（导入 Demo → 分析 → 用 Agent 制作视频）。三步的完成状态**从真实数据推，不存标志位**：资料库里有 Demo 第一步就完成，有一场已分析第二步就完成。三步都真完成它自己消失，也能手动关掉（关闭状态进 `app/shell/shellStore`，与 `sidebarCollapsed` 同类，符合 §4.2）。一个纯标志位会对着一个空资料库说「你已经完成引导了」
- **`/guide` 独立页**，§7 新增一条路由。内容不是凭空造：旧的 `features/guide/GuidePage.tsx`（198 行）已经定死了这一页装什么——CS2 环境自检（逐项 `DependencyCheck` + 重新检查）加一排入口卡——本轮之后是**把一页已有内容换成新设计语言重述**，与 3d 把旧分析页搬成九个子视图同类。路由表的改动由 3g 的壳层步骤统一做（`routes.tsx` + `app/router.tsx` + `pageSkeleton.test.tsx` + 侧栏与命令面板注册），不许页面 agent 顺手加参数（§10.6 缺口 15 的教训）

旧的 `features/guide/` 仍按 §10 阶段 4 删除。

---

## 10.8 阶段 3f-1 落地记录 —— 录制计划与快速合辑（2026-08-16）

画板 08 与 09 接上真数据。3f-be 刚补的四件事（每镜头拍摄参数 / 八条录制前校验 / 镜头预设 / 方案↔录制绑定）在这一轮全部有了调用点，`agentHandoff.ts` 也终于有了调用者——它从写出来那天起一直没有。

出口条件达成：`pnpm lint`（含 `i18n:compile --strict` 与分层检查 653 个文件）/ `typecheck` / `build` 退出码 0；vitest 473 文件 4574 用例通过（3 文件 4 用例 skip 是既有的 `features/analysis` 外部数据库审计），相对 3f-be 的 455/4218 净增 18 文件 356 用例；lingui 1608 条，英文缺失 0。Rust 一行未动（这是纯前端轮次，见本节末尾的「时间去哪了」）。

### 这一轮建了什么

**四个数据层模块**：`data/recording.ts`（683 行）、`data/montage.ts`（413）、`data/mediaAssets.ts`（343）、`data/nativeShell.ts`（279）。最后一个是 §10.7 那条更正的收口——原生对话框在 `shared/desktop/dialog.ts` 里一直是有的，页面此前只是不知道，现在页面通过 `data/nativeShell.ts` 这道缝去用它，不直接碰 `shared/`。

**08 录制计划与镜头预览**，`pages/recording/` 17 个文件 + `RecordingPage.tsx`。要点：

- **`/recording/:taskId` 的 `taskId` 是 Agent 方案 id，不是录制任务 id。** 这一页此前的注释写反了。已经在跑的录制任务本来就有一个一等地址 `/delivery/task/:taskId`（带阶段日志、重试提示与输出），在这里再建一个就是一个对象两个地址，正是 §2 要防的那件事。所以：`/recording` 是可录制方案列表加最近任务，`/recording/<planId>` 是画板全貌，「返回方案」回 `/agent?plan=`，开始录制成功后去 `/delivery/task/<jobId>`。
- **租约只铸一次。** `POST /api/recording/plan` 给的是五分钟租约，是 mutation 不是 query；用 `useQuery` 会在重挂载时把导播的结果换掉，而用户正看着那份预览。「重新生成预览计划」是一个按钮，不是一个副作用。
- **编辑镜头会让校验列表消失而不是变陈旧。** 编辑改的是租约绑定的 sha256，所以 `recordingShotSignature(items)` 一变，上一次的八条校验就作废——不是标灰，是不显示。
- **导播预览画的是真实相机路径**：`HlaeProposalPreview.typed_plan` 是完整的 `HlaePlan`，`cameraPlan.ts` 是一个不用 `as` 的检查式解析器（25 条单测）。路径、朝向箭头、视场角楔形与高度带都画了。
- **八条校验是闭集**，`blocking > 0` 是禁用开始录制的全部契约。`camera_collision_unverified` 在方案里有非 POV 镜头时是 warning，全 POV 时是 ok，永远不会 blocked。

**09 快速合辑**，`pages/montage/` 18 个文件 + `MontagePage.tsx`。

### 偏离与更正

| # | 偏离 | 处置 |
| --- | --- | --- |
| 1 | 两处 msgid 撞车，英文会印错词 | `MusicBeatBlock` 的「应用」是动词 Apply，而裸 msgid「应用」是设置页的名词 App（已译成 "App"）；`montageSettings` 的转场「滑移」撞上 `design/timeline` 的 slip 工具（已译成 "Slip"）。两处都按 `ColumnConfigDialog` 立的先例加 `context`（`dialog-confirm` / `video-transition`），没有改动既有译文。**这是「语义确实分叉才加 context」的正例**——不是为了消歧而消歧，是英文里它们真的是两个词 |
| 2 | `branding_theme` 四个成员画板只画三个 | 按 wire 建表，四个都给标签（线框 / 极简 / 转播 / 霓虹），穷举测试钉住。同 §10.6 偏离 2 的先例——存着 `neon` 的工程要能渲染出来 |
| 3 | 节拍建议卡文案改写 | 画板写「把片段 02 的入点移到 00:24.0」，但合辑模型没有时间轴位置（下面缺口 6），只能改 `trim_end`。卡片改写成「把片段 02 的时长改为 20.0s（+1.60s）· 对齐第 85 拍到第 125 拍，之后的片段会跟着前后移动」——描述真会发生的事 |
| 4 | 画板第二张建议卡「在 01:12.5 加入切换」未实现 | 在某一时刻插入切点要把一个片段切成两段，`MontageClipRecord` 没有这个操作（一个 `clip_id` 只能出现一次）。建议一律按片段给，不做假的切点卡 |
| 5 | 情景标签（回合 / 类型）整块省略 | `MontageSettingsRecord` 没有这个字段。省略，不渲染一个永远关着的开关 |
| 6 | 导出面板不印体积预估，也不给「更改导出目录」 | `quality` 走恒定质量（`quality_to_crf`），码率随内容差数倍，「约 540 MB」会错在用户据以清磁盘的方向；导出目录是 `export.rs` 里写死的 `data_dir/exports`，改它等于搬整个应用数据目录，那是设置页的事。面板只读地显示目录，给「打开输出目录」（真原生能力），并印出真实的命名规则而不是编一个文件名 |
| 7 | `AgentPage.tsx` 的「确认并生成视频」由本轮收口，不在页面 agent 的范围内 | 它此前硬禁用，理由写着「方案的镜头没有带上 Demo 与选手」——**3f-be 之后这句话是假的**。屏幕上的一句假话比一个缺的功能更糟，所以这一轮把它接上了：`confirmGuard` 只为服务端真会拒绝的两件事拒绝（镜头全被移除 / 还有镜头未绑定），并且**在跳转前 await 一次 `editNotifier.flush('confirm-video')`**——`/recording/<planId>` 是从存下来的方案铸租约的，没提交的编辑会被当成没发生过。按下去不录制，只换地址：§4.5.3 规则 ① 说录制只从 08 的「开始录制」开始 |

### 后端契约缺口（本轮撞到的）

1. **租约不可寻址。** 没有 `GET /api/recording/plans/{id}`，所以在途的租约活不过一次刷新，`/recording/<planId>` 重载会重新铸。这里能接受只是因为地址里的 id 是**方案 id** 而不是租约 id。
2. **`pages/delivery/useTaskActions.tsx:144` 现在是坏的。** 「重试录制」拿 `planRecordingRetry` 返回的 `RecordingPlanResponse.plan_id`（一个**租约 id**）去跳 `/recording/<id>`，而这一页现在按**方案 id** 解释这个参数，会读不到方案。3a 写下它时 `/recording/:id` 还是空壳，所以一直没暴露。**成因和缺口 1 是同一个，一条路由能同时修掉两个**，所以留到 3g-be 一起做，不在这里塞一个之后要删的 router-state 传递。
3. **结构化 422 body 仍到不了渲染进程**（§10.7 缺口 1 的延续）。已处理不是绕过：`agentPlanShotsNeedingBinding(plan)` 从页面本来就拿着的方案里还原同一批镜头，422 的 `code` 决定说哪句话。
4. **没有路由能启动导出的 HLAE 包。** `exportHlaeProposal` 答 `launched: false`，`playDemo` 走 `build_playback_command`——是带 `+demo_gototick` 的普通 CS2，不是 HLAE 的自定义 loader，所以那个进程里没有 `mirv_*`，相机路径**不会被画出来**，除非手动加载导出的 bootstrap。没有粉饰：确认对话框写明服务不会加载它，启动后面板印出包目录并给「打开脚本目录」。要闭掉它需要一条「以预览模式在某个包上启动受管 HLAE 会话」的路由（机器在 `crates/runtime/src/hlae_session.rs`，目前只在录制路径后面）。
5. **`AgentPlanSummary` 说不出一个方案的镜头有没有绑定**（没有 `recordable_shot_count`，`GET /api/agent/plans` 也没有 `?recordable=`）。所以裸 `/recording` 列出所有 `shot_count > 0` 的方案，答案要等打开才知道（422 `agent_plan_shots_unbound`）。summary 上加一个字段就能让这一列改成过滤而不是承诺。
6. **`MontageProjectRecord` 没有 `revision`** —— 没有 If-Match，没有 409，与 `EditorProject`、`AgentPlan` 都不同。`useSaveMontageProject` 用读-改-写缓解（从服务重读，把调用方的编辑函数应用到新文档上，再 PUT），另给一个可选的 `baseUpdatedAt` 守卫抛 `MontageWriteConflictError` 并带上新文档。**这是收窄不是关闭**：`updated_at` 是秒级的，同一秒内的两次保存分不出来。照实记，不粉饰。
7. **`MontageClipRecord` 没有源时长也没有时间轴位置。** `trim_end: null` 的片段在录制片段列表加载出来之前长度未知，`montageTimeline` 返回 `null`（不是 0），头部写「时长待定」。片段严格顺序排列，所以拍点建议只能靠改上游的 `trim_end` 实现，需要留空隙的建议无法应用。
8. **`background_music` 存的是绝对路径不是 asset id**，而 BPM 与拍点来自 media asset，页面只能用 path 反查素材库。没导入过的音乐仍能导出但没有分析，界面明说「未在素材库中，无法分析节拍」。
9. **合辑转多轨没有路由。** `MontageProjectRecord`（有 clips 无 revision）与 `EditorProject`（有 tracks 有 revision）是两张表，没有任何接口把前者变成后者。顶栏「在多轨编辑器中打开」保留、禁用、写明原因，不跳到一个不存在的工程 id。
10. **没有「预设应用到全部」的服务端语义**（§10.7 缺口 4 的延续）：那是 N 次本地赋值加一次重新铸租约，没有原子调用，也没有部分失败态。撤销由前端负责。

### 归位建议（都是搬家，不是重写）

- `HlaeProposalPreview.typed_plan` 在 dto 里是 `unknown | null`，其实是完整的 `HlaePlan`。类型该回到 `shared/desktop/dto.ts` 的 HLAE 组里，`cameraPlan.ts` 的解析器随之搬进 `data/recording.ts`。
- `domain/map/CameraPathLayer` 画了轨迹、端点与关键帧，但没画朝向箭头和视场角楔形，`WorldPoint` 也没有 `z`。这两样本轮画在页面级图层里（走 `MapCanvas` 的投影回调，`ReplayCanvas.PlayerLayer` 是先例）。把 `HeadingLayer` 与高度带提到 `domain/map` 是搬家。
- `domain/task/TaskCard` 的 `onCancel` 仍是裸的，没有 `{disabled, disabledReason}` 槽（3a 已报）。裸 `/recording` 列表复用 `TaskFeedList`，继承了这个问题。

### 留给后续阶段的已知缺口

1. **`scripts/check-web-i18n.mjs` 退出 1**，先于本轮存在且是结构性的：它拒绝生产源码里出现任何汉字字面量，而 Lingui 宏体制落地之后全仓每个文件都有。它也不检查 `src/locales/**`。§10 阶段 4 本来就要删它，现在确认它已经无法通过，删除是正确处置而不是回避。
2. §10.7 的四条「留给后续阶段」全部仍然成立（`rust-toolchain.toml`、四条重复的 runtime 规则、`RecordingDefaults` 三值化、`vendor/demoparser` 的 fmt）。
3. 本节缺口 1 与 2 应在 3g-be 一并做掉：一条 `GET /api/recording/plans/{id}` 同时修好刷新丢租约和 delivery 的重试跳转。

### 时间去哪了（对上一轮 91 分钟的回答）

3f-be 那一轮统计出来是 724 次工具调用 / 9 个 agent / 91 分钟，其中 **108 次 cargo 调用**（58 clippy + 38 test + 12 check）。实测空转 `cargo clippy --workspace --all-targets` 31 秒，改一个 domain 文件后 16 秒，`cargo test --workspace` 要链接跑 30 个测试二进制。三条结构性浪费都是任务书自己写出来的：收敛循环每轮重跑整套门禁（约 10 分钟、完全串行、跑了两轮）；四个实现 agent 各自验证同一批 crate；**后端轮次的 agent 在跑 vitest 和 `pnpm build`，前端轮次的 agent 在跑 `cargo check`**——两边都在验证自己一行都没碰的东西。

从下一轮起改成：迭代期用 `cargo check`，只在最后一次用 clippy；实现 agent 只跑 `-p <自己的 crate>`，workspace 级验证只在收敛阶段发生一次；后端轮次不跑 vitest / build，前端轮次不跑 cargo，改成用一条 `git diff --stat` 断言那一侧没有改动；收敛循环先跑便宜的（typecheck / lint / diff），全过了才跑贵的。本轮已经按最后三条执行——Rust 一行未动，也一次 cargo 都没跑。

---

## 10.9 阶段 3f-cg 落地记录 —— 线上类型改成生成（2026-08-16）

`shared/desktop/dto.ts` **2421 行 → 864 行**。259 个手抄的类型定义换成 303 条再导出，指向 `shared/desktop/generated/` 下 299 个由 `cargo test` 写出来的文件。

出口条件达成：`check-web-layers`（954 个文件）/ `typecheck` / `lint` / `build` 退出码 0；vitest 473 文件 4574 用例通过，与 3f-1 一字不差；`cargo clippy --workspace --all-targets -- -D warnings` 退出码 0；`cargo test --workspace` 全绿（domain 从 89 涨到 267，多出来的 178 个是 ts-rs 自己生成的 `export_bindings_*`）；`check-rust-format.ps1` 退出码 0。改动 543 个文件，+5750/−2911。

### 为什么是 ts-rs 而不是 utoipa

原计划是 utoipa → `openapi.json` → openapi-typescript。清点之后发现是 155 条路由加约 250 个类型，而**这个 session 里真实发生过的每一处漂移，ts-rs 都能抓到**：一个完整的 `HlaePlan` 被写成 `unknown`、八条校验的枚举靠手抄、`branding_theme` 四个成员被记成三个。utoipa 额外保证的是「哪条路径返回哪个类型」——那个映射由 `client.ts` 一个文件承担，是 grep 得到的，而且从来没出过错。

代价差了一个数量级：ts-rs 是 250 个 derive、路由零改动；utoipa 是 155 条 `#[utoipa::path]` 标注加重写 `client.ts` 的 180 个方法。选了便宜的那条。

### 机制

- 根 `Cargo.toml`：`ts-rs = { version = "12.0", features = ["chrono-impl", "uuid-impl", "serde-json-impl", "format"] }`（MIT，2026-06-22 发布，MSRV 1.88）
- `.cargo/config.toml`：`TS_RS_EXPORT_DIR = apps/web/src/shared/desktop/generated`（相对根），`TS_RS_LARGE_INT = "number"`
- 类型上 `#[derive(..., TS)]` 加 `#[ts(export)]`，`cargo test` 时写盘，文件签入仓库
- CI 的 rust job 在 `cargo test --workspace` 之后加一步 `git add --intent-to-add` 再 `git diff --exit-code -- .../generated/`。`--intent-to-add` 不是修饰：新 derive 的类型生成的是**未跟踪**文件，不加它 `git diff` 看不见，这道门就会对新增类型永远放行

**`TS_RS_LARGE_INT = "number"` 不是可选项**：这条线上每一个 tick、字节数和时长都是 `i64`，默认绑定是 `bigint`，而 JSON 永远不会产生 bigint。

**Rust 的文档注释会带进 TSDoc。** 这是附带的最大好处——解释一个字段为什么长这样的那段话，从此只存在一份，而且在离定义最近的地方。dto.ts 因此删掉了大量重复的散文，只留下 Rust 侧不可能知道的东西：客户端怎么用这个值。

### 抓到的漂移（21 处，都是真的）

按影响排：

1. **`PlayerStats` 少了一整个字段。** 手写那份的注释原话是「Wire DTO mirrored from `vibe-cs-domain::PlayerStats`」，而它漏了 `spectator_slot: number | null`。这个字段不是装饰：它是 `RecordingPreflightCode::SpectatorEvidenceComplete` 检查的那个「解析器观测到的 CS2 观察位」，`build_player_pov_plan` 拒绝凭空发明的就是它。domain 里甚至有一条专门的测试（`analysis_without_current_spectator_slot_contract_is_rejected`）钉住它是线上必需的。前端一直看不见它。
2. **`DemoStatus` 手写四个成员，真枚举六个，只重合一个。** 手写的是 `'pending' | 'parsing' | 'ready' | 'error'`，Rust 是 `discovered / indexing / ready / analyzing / failed / missing`。**资料库的状态筛选一直是错的。** 四态的显示折叠搬到了 `viewModels.DemoDisplayStatus` 并改了名，免得再被当成生命周期枚举。
3. **`RecordingRequest.id` 是可空的**（Rust 是 `Option<Uuid>` 加 `deserialize_required_nullable`），手写的是非空 `EntityId`。这是本轮最大的一处连带：录制页的选中、逐镜头编辑、移除、导播查找和风险徽章全部按这个 id 做键。修法是在边界上收窄——`recordingContract.ts` 加了 `RecordingShot = RecordingRequest & { id: string }` 与 `identifiedShots()`，没有持久身份的镜头在边界处被丢掉，而不是带着一个 `null` 当键走下去。`RecordingJob::retryable_suffix` 明确处理 `id == None`（「published recording request has no durable identity」），所以 null 是后端真会产生并会推理的状态。
4. **两个 Rust 类型共用一个 TS 名字，两处。**
   - `DemoRecord`：`/api/demos` 那一行其实是 application 的 `DemoSummaryDto`（把 `player_names` 改名成 `players`），而 domain 自己的 `DemoRecord` 是导出/饰品改写那条路的形状。现在分成 `DemoRecord` 与 `DemoCatalogRecord`。
   - `HlaeStatus`：`/api/hlae/status` 返回的是 application 的 `ManagedHlaeStatusDto`，把三个安全布尔重新嵌进 `safety_boundary`；而 `HlaeProposalPreview.installation_status` 是 domain 的 `HlaeStatus`，**是平的**。也就是说 `preview.installation_status.safety_boundary` 在运行时永远是 `undefined`，而 typecheck 是绿的。现在分成 `HlaeStatus` 与 `HlaeInstallationStatus`。
5. **`ReplayPlayer` 带着四个 API 从不发送的字段**（`money`、`current_equipment_value`、`round_start_equipment_value`、`has_helmet`），`ReplayPayload` 多一个 `freeze_end_tick`。根因查清了：前端有**两个解码器共用一个类型**——`replayBinary.ts` 解的是 `encode_binary_replay`，`roundReplayBinary.ts` 解的是解析器的回合回放产物（`crates/demo/src/round_replay.rs`），后者确实有这五个。拆开了。
6. **`HlaePlan` 与 `CompiledHlaePlan` 被写成 `unknown`。** 现在是 18 个生成文件的真实类型树。这是 §10.8 归位建议里的第一条，本轮顺手做掉。
7. `PlayerHeatmapKind` 是三个成员不是两个；`CosmeticValues` 的可选性**正好写反**（响应上每个键都在且可空，手写的是可选且非空）；`CosmeticPlan.patches` 其实是 `JsonValue`（storage 存的是 `serde_json::Value`），**手写那份比服务端更精确**——这个方向的漂移同样危险；`DemoQuery` 少了后端支持的 `source` 筛选；`ApiProblem` 允许一个结构化的 `detail` 对象，那个形状在整个 `crates/` 里不存在。

### 三类必须手写的类型，以及它们各自是什么问题

改写之后 dto.ts 里剩下的手写定义只有四组，每一组都在文件里标了出处：

1. **无类型路由**（`DemoPlaybackStatus`、`DemoPlaybackPreflight`、`DemoPlaybackLaunch`、`DemoPlaybackStop`、`LlmTestResult`、`MatchHistorySyncResult`、`RecoveryStatus`）——`crates/runtime/src/integration.rs` 用 `json!` 现搭文档，以 `Json<serde_json::Value>` 发出去，Rust 侧根本没有结构体可生成。**这是七个后端缺口，不是命名问题。**（顺带一个陷阱：`crates/platform-windows/src/backup.rs` 有一个同名但形状不同、且没有 `Serialize` 的 `RecoveryStatus`，名字对上了不代表是原型。）
2. **Tauri 侧类型**——流式 Agent 对话契约（`AgentStatus` / `AgentMessage` / `AgentThread` / `AgentChatInput` / `AgentEvent` / `AgentChatResult` / `AgentProposal` / `AgentVideoProposal` / `AgentShotDesign`）与 `HlaeBundleHandoff` 定义在 `apps/desktop/src-tauri/src/`，不在 ts-rs 的接线范围里。`HlaeBundleHandoff` 也是这里唯一一个 camelCase 键的类型，同一个原因。
3. **客户端对无类型字段的收窄**——`DependencyKind`、`DependencyState`、`ActivityKind`、`ActivityStatus`、`ActivityAction`。Rust 侧这些是 `match` 臂写出来的 `&'static str`，生成的类型说 `string`，**这是对的**。这几个联合是客户端自己对那组封闭值的读法，**服务端不保证**。文件里写明了这一点。把它们变成真正的 serde 枚举是后端改动。（注意活动的**查询侧** `ActivityKindFilter` / `ActivityStateFilter` 是真枚举，已生成；只有响应侧是裸字符串。）
4. **前端别名**——只剩 `EntityId`。

### 视图模型搬出了 dto.ts

一批「这个应用从线上数据推出来的形状」原本混在 dto.ts 里冒充线上契约。它们搬进了新的 `shared/desktop/viewModels.ts`：`PlayerAnalysis`（`headshot_rate` 是客户端算的）、`RoundSummary`、`Highlight`（`confidence` 在线上根本没有对应物）、`AnalysisWorkspace`（`crates/` 里没有任何 `struct AnalysisWorkspace`，它是 `normalizeAnalysis` 拼出来的）、`DemoSummary`、`DemoDisplayStatus`、`RecordedClip` 的短形态、以及 `ActivityItem` / `ActivityFeed` 的收窄形态。回合回放的三个记录类型搬去了 `features/analysis/roundReplayBinary.ts`，因为那份产物从来不以类型化 body 过 HTTP。

**dto.ts 是线上契约的镜像，不是类型杂物间。** 一个 UI 派生的形状放在这里，看起来就像服务端承诺过它。

另外新增 `shared/desktop/json.ts`（`jsonObject` / `jsonMember`）作为 `JsonValue` 的**唯一**收窄点——`serde_json::Value` 现在会如实生成成 `JsonValue` 而不是 `unknown`，读它的地方需要一个统一的检查入口。

### 偏离与代价

| # | 事项 | 处置 |
| --- | --- | --- |
| 1 | `Option<T>` 生成成 `x: T \| null`（必需键、可空值），不是 `x?: T` | ts-rs 12 在决定可选性时**不认** `#[serde(default)]` 与 `#[serde(skip_serializing_if)]`，这一点在 `ErrorBody.detail`、`RecordingRequest.presentation`、`AgentPlanShot.recording` 三处逐一验证过。这是本轮 diff 体量的最大来源。**没有用 `#[ts(optional)]`**：请求体上诚实的形状确实是「可以不传」，响应体上诚实的形状确实是「一定在、可能是 null」，逐字段选哪个是契约决定不是机械替换。留着，等真被卡住时按字段做 |
| 2 | 改了 `features/**` 124 个文件 | 那是阶段 4 要删的旧前端，但在删掉之前它必须能通过 typecheck。21 处漂移里有相当一部分的调用点在那里 |
| 3 | 每次编译有 140 条 ts-rs 警告 | 两种：`deserialize_with = "deserialize_required_nullable"` 136 条、`deny_unknown_fields` 4 条。**两种都核过，忽略它们是对的**——前者要的就是「键必需、值可空」，正是 ts-rs 的默认输出；后者在 TypeScript 里没有对应表达。**没有开 `no-serde-warnings`**：开了会连同将来真正不受支持的属性一起静音，而那正是要看见的信号。基线记在这里，第 141 条出现时是新的 |
| 4 | `format` feature 把 dprint 与 swc 拉进了构建 | 值得：这些文件是当 diff 读的，一个四十字段结构体的未格式化 diff 没法审 |
| 5 | `generated/` 里有 299 个文件，前端未必每个都 import | 传递规则决定的——一个 `#[ts(export)]` 类型能到达的每个类型也必须导出，否则 ts-rs 生成的 import 会指向不存在的文件 |

### 留给后续阶段的已知缺口

1. **七个 `json!` 路由应该有真结构体**（上面第 1 组）。做掉之后 dto.ts 的手写部分只剩 Tauri 侧和 `EntityId`。
2. **五个响应侧的 `&'static str` 应该变成 serde 枚举**（上面第 3 组）。现在客户端在猜一组它无法验证的封闭值。
3. **`LineupMapItem.team_slot` 是 `string`**，`crates/storage` 声明的就是 `String`，没有任何东西把它收成 `'A' | 'B'`。dto.ts 如实再导出并写明了原因。
4. §10.8 的十条缺口全部仍然成立，其中「`typed_plan` 该回到 dto.ts」这条**本轮已经做掉**（而且做得更彻底：整棵 `HlaePlan` 树都是真类型了）。
5. `apps/desktop/src-tauri` 不在 ts-rs 接线范围里。把它接进来需要给那个 crate 也加 ts-rs，是一轮小活，可以随 3g 顺手做。


---

## 10.10 阶段 3f-2 落地记录 —— 多轨编辑器（2026-08-16）

分两次提交，因为这一轮真的是两件事：**先把时间轴内核补齐**（`design/timeline/`，不碰数据层与页面），**再接真素材**（`pages/editor/` + `data/editor.ts`，不碰算法）。顺序反过来的话，性能问题会和数据问题混在一起，分不清是谁的——这条是 `design/timeline/README.md` §4 建议 2 原话，照做了。

出口条件达成：`check-web-layers`（980 个文件）/ `typecheck` / `lint` / `build` 退出码 0；vitest 484 文件 4722 用例通过（3f-cg 时是 4674，新增 48 个页面与适配层用例，加上内核那 94 个共 +142）；en-US 目录零缺失（新增 93 条已翻译）。

### 10.10.1 内核：四条必补项

`README.md` 第 2 节把「阻塞阶段 3f 的程度」排过序，前四条点名说「缺一个都不能算多轨编辑器」。逐条：

| 缺口 | 模块 | 关键决定 |
| --- | --- | --- |
| 1 修剪 | `trim.ts` | 两条边**一个符号约定**（正 = 时间轴上更晚），调用方不按抓的是哪个把手翻转 delta；四条边界（素材余量 / 邻居 / t=0 / 一帧）全部**钳位**而不是拒绝，与 `slip.ts` 一致；链接组按**同一 delta** 修剪，J-cut 的偏移因此保住——按同一时刻修剪会把 J-cut 悄悄压平 |
| 2 自动滚动 | `autoScroll.ts` + hook 里的 rAF 循环 | 难点不在算术在循环：指针停在边上**不发事件**，所以滚动由时钟驱动、指针只给速度。另一半是**滚动量进了拖拽的算术**（`deltaXPx = 指针位移 + 滚动位移`），漏掉它的话地面一动片段就从光标下滑走 |
| 3 帧网格 | `frameGrid.ts` | 只有两处量化：`commit` 与**挂载时**。真正保证接缝无缝的是不变式「文档里每个 start 都在帧上」，而不变式要从第一帧起成立——线上工程不保证在网格上，`EditorProject::validate` 只限值域不做舍入 |
| 4 虚拟化 | `virtualize.ts` | 只做水平。轨道就五条，虚拟化它们的滚动记账比省下的多。**没有引入 `@tanstack/react-virtual`**：它解决「等高行 + 索引推位置」，而片段的位置是 `start`，一个任意浮点数，两者没有对应关系（§1.2 的依赖准入） |

顺带做掉的：**指针捕获**（第 5 条，能力检测 + window 监听不动，捕获的事件照样冒泡，所以是纯增益）、**变速**（第 9 条，`speed.ts`）、**标记可写**（第 7 条，画板上有「标记」按钮）。

`TrackKind` 从原型的 `video | audio | subtitle` 换成线上的 `video | audio | text | overlay`。适配层若要映射，就得替 `overlay` 编一个答案。

**帧网格顺手修对了一个数字**：画板 Inspector 写的是 `00:00:04:08`，而未量化的 fixture 之前一直打印 `04:07`——4.133s 是 247.98 帧，时间码向下取整。

### 10.10.2 接真素材：适配层是这一轮的核心

`pages/editor/editorDocument.ts`。一条硬规则：

> **时间轴模型没有描述的一切，必须原样活过一次往返。**

做法是影子（`EditorDocument.clips` 持有原始 `EditorClip`），保存时把时间轴的五个字段**写回**影子而不是重建它。重建会悄悄抹掉这个文件没想到的东西——而 `metadata` 是开放字段，「没想到的东西」是个永久类别。

三处 join：

- **素材长度**。`EditorClip` 有 `source_in` / `source_out`（这一段的窗口），**没有素材总长**，那在 `MediaAsset.duration_seconds` 上，是另一个请求。两个数都需要：窗口用来画，总长用来知道还能修剪 / 滑移多远。素材未知或未探测时**退回窗口本身**，后果是可见的：没探测过的素材报告零余量，向外修剪被拒而不是对着没人量过的长度放行。这个「是否退回过」记在 `unmeasuredClipIds` 里而不是事后推断——一个头部还剩 3 秒的片段两种情况下都有余量，余量是否真实取决于数字从哪来。
- **身份**。线上 id 是 uuid，剃刀铸的是 `<uuid>~2`。边界处换成新 uuid，mint 注入所以适配层仍是纯函数。
- **轨道名**。`EditorTrack.name` 是自由文本（`"Video"`），画板画的是 `V1 主画面`——代号由 kind 与它在同类里的位置推出（从下往上数，V1 在 V2 下面），角色就是存着的名字。

**三处会导致保存 400 的问题，在写测试时暴露出来并修掉了**：

1. **孤儿链接组**。`EditorProject::validate` 要求链接组至少两个成员且跨两条轨道。删掉 A/V 对的一半就剩一个——保存时 400，而用户从没见过这条规则。保存前统一解散不满足的组，无损（一个孤零零的链接组本来就没有意义）。
2. **越界关键帧**。keyframe 的 `time` 是片段内的，文档要求 `time <= duration`。修剪 / 剃刀 / 变速都会缩短片段。选择**丢弃**而不是钳位：钳位会把多个关键帧堆到最后一帧，文档同样拒绝（同属性同时刻重复），而且一条以垂直悬崖结尾的曲线也不是用户画的。`droppedKeyframeCount` 让页面**在保存之前**说清代价——保存之后撤销救不回来。
3. **`duration_seconds` 要装得下标记**。文档要求每个片段**和每个标记**都在工程长度之内。

**能力限制被说出来而不是藏起来**：带 `speed_segments`（分段变速）的片段在这个模型里没有表示（模型只有一个常量 speed），编辑它会打乱速度曲线。`clipRestrictions` 点名它不能接受哪些操作，界面据此禁用**并把原因挂上**——时间轴上干脆不画修剪把手（一个松手才拒绝的把手比从没出现过更糟，手势已经做完了）。

### 10.10.3 与规格 / 画板的偏离，各一条理由

| # | 偏离 | 理由 |
| --- | --- | --- |
| 1 | **有「保存」按钮，画板没画** | 画板画的是「已保存 · 版本 24」。但这一页不是「09」：编辑器工程**有 revision 也有 409**，而一次时间轴编辑是一个手势——拖拽要么每秒写 60 次要么根本不写。所以显式保存 + 顶栏三态（已保存 / 未保存 / 保存中），并且会丢改动的动作（恢复版本、应用预设、两个导出）在有未保存改动时禁用并写明原因 |
| 2 | **节目监看是单轨预览** | 叠加、不透明度、变换、调色、转场、混音都不生效——那些是导出渲染器的，而导出渲染器是 Rust 侧的 ffmpeg，页面跑不了。**这条限制印在监看上**（「单轨预览，不含叠加与调色」）。一个看起来像合成、实际不是的监看，会让用户在导出后才发现名牌不见了 |
| 3 | **属性面板的画面 / 音频组只读** | 缩放、不透明度、音量、链接住在 `EditorClip` 的影子字段里，时间轴模型不带。做成可编辑要么把它们塞进模型（那每个编辑操作都得学会忽略它们），要么写第二条不进撤销栈的修改路径。这一轮显示存着的真实值并标「只读」——**缺的是控件，不是数据**，而控件比第二条撤销栈是更小的缺口。唯一接通的是调色，走 `applyEditorPreset`（服务端改、答复新文档），没有影子突变也没有第二条撤销栈 |
| 4 | **冲突只呈现不合并** | `data/montage.ts` 的读-改-写在那边是对的（合辑没有 revision，两个面板改的是不相交的字段）。时间轴不是：如果它在你脚下动过，你刚拖的那个片段可能已经不存在。合并那个不是合并，是猜，而且是看不见的猜 |
| 5 | **`/editor` 列表页可滚动，工作区不可** | 时间轴自管视口（`tl-viewport` 是缩放锚点与自动滚动测量的对象）；列表页是张表 |

### 10.10.4 缺口

**本轮没做，且知道没做：**

1. **roll 与 slide**（拖接缝 / 在邻居之间滑动）。画板上没有入口——没有接缝把手、没有修饰键图例、工具栏里没有——做了也够不着。**有意不做。**
2. **导入素材没有文件对话框**。`importMediaAsset` 收的是调用方已经有的路径，而挑文件需要原生对话框，这一页够不到。按钮画着、禁用、写明原因。「重新定位」同理。
3. **拖素材到时间轴**没有做，只有「添加到时间轴」按钮（放在播放头处，同类型轨道，冲突则拒绝并说明）。空工程因此可用——第一条轨道随第一个素材一起建好。
4. **多选 / 框选 / 复制粘贴 / 成组**、**转场与关键帧编辑**、**片段里的真波形与缩略图**：README 第 6、8、10、11 条原样。
5. **性能仍未量过。** 虚拟化的裁剪算术测了，但**没有在真实浏览器里量过 60fps**，也没做节流 / rAF 合批（自动滚动那个循环除外）。README 第 12 条原样成立。
6. **暗色仍未单独核对**（README 第 13 条）。

**后端缺口（新增）：**

7. **`EditorProject` 没有「新建轨道」路由**。轨道只能随片段一起出现（适配层在没有对应类型轨道时自己造一条，保存时随文档一起过去）。用户想要一条空的 V2 叠加轨，没有地方点。
8. **`speed_segments` 没有编辑入口**，前端也没有模型。文档禁止它与非 1 的基础速度并存，画板只画了一个「速度」字段，而速度斜坡是曲线界面不是数字。
9. `EditorExportRequest` 是 `{ encoder, quality, range_* }`，画板没有导出对话框，所以页面固定发 `encoder: 'auto', quality: 85`。要让用户选，需要先有画板。


---

## 10.11 阶段 3g-be 落地记录 —— 后端补齐（2026-08-16）

六项全部做掉。出口条件：`cargo clippy --workspace --all-targets -- -D warnings` 退出码 0；`cargo test --workspace` 全绿；`check-rust-format.ps1` 退出码 0；前端 `typecheck` / `lint` / `build` 退出码 0，vitest 484 文件 4722 用例通过。

**前提说明**：用户明确「不需要任何兼容，该系统从未上线过」。所以新字段一律是**必需字段**，没有 `#[serde(default)]`，没有迁移，也没有为旧文档写兜底——旧文档不存在。这也是为什么四个作业结构体能直接加字段：它们的实体存在 `document_json` 里，列只是索引，schema 一行没动。

### 1. Agent 设置五个开关（§10.5 缺口 6）

`AgentWorkspaceSettings` 从两个字段变成七个：`auto_attach_context` / `preview_before_apply` / `show_evidence_reads` / `default_video_seconds` / `commentary_tone`（新枚举 `CommentaryTone`，专业 / 节目化）。默认值逐个取自画板的绘制态。

**「录制前始终由你确认」故意没有字段。** 画板自己写的是「不可关闭」，所以它是产品常量而不是设置项——一个谁都不许设成 false 的布尔，最终一定会被设成 false。

`default_video_seconds` 有值域 5…3600 并在 `validate` 里拒绝越界：它是 Agent 瞄准的目标长度，0 秒不是目标。

### 2. 引用删除路由（§10.5 缺口 9）

`DELETE /api/agent/sessions/{id}/refs/{kind}/{object_id}`。画板右栏画了「取消引用」而没有路由可调，所以那个按钮一直没画出来。

**幂等**：删一个不存在的引用答 204 而不是 404。按两次、或者另一个窗口已经删过，都不是失败——调用方要的是「这条引用没了」，而它确实没了。404 留给真正缺的东西：会话本身。

删引用**不动会话的 `updated_at`**，除非真的删掉了什么。一次没删到东西的请求不是编辑，让它顶起会话列表的排序是错的。

### 3. 保留策略调度（§10.1 缺口 2 / §10.5 决议）

`crates/runtime/src/session_retention.rs`，跟随 runtime 生命周期。**渲染进程不是调度器**——只在开着窗口时扫，会把「30 天」变成「30 天，如果你最近开过应用」。

**第一次扫描延迟 5 分钟**，这是对「启动即扫」那条反对意见的软化而不是消除：用户启动后看到「不保留」并在这段时间内改掉，就不会丢东西。诚实的说法是**它让误设在常见情况下可挽回，而不是不可能发生**——五分钟是对人反应速度的猜测，不是契约。

失败只记日志、下一轮重试，不结束任务：数据库忙是暂态的，而一个第一次失败就停掉的清扫器会让策略在整个会话期间失效且无人知晓。

### 4. `OutputItem` 媒体元数据与输出流

画板 11 每行印的是「42 秒 · 60 fps · 186 MB · H.264 / AAC」和「1920×1080」。新增 `OutputMediaInfo`（分辨率 / 时长 / 帧率 / 编码），字段全部可空，**每个可空各有一个理由**而不是一律兜底：静态图没有时长和帧率，纯音频导出没有分辨率，文件不在了根本探测不了，容器打不开就答不出来而不是从扩展名猜。

帧率是**精确有理数字符串**（`"60"` / `"30000/1001"`）。浮点会让 29.97 和 30 在界面精度下变成同一个数，而它们是两种不同的格式。为此给 `MediaStream` 加了 `frame_rate`，取 `avg_frame_rate` 而不是 `r_frame_rate`——后者对 VFR 素材可能是 1000/1。

**探测发生在分页之后**，不在 `into_dto` 里。后者对库里每一个输出都跑一次，在过滤与分页之前——为了渲染二十行会打开几百个容器，而且是在搜索框每敲一个字的时候。带一个按「路径 + 大小」为键的进程内缓存，**大小进键**是为了原地替换的文件会被重新探测而不是沿用上一个文件的分辨率。探测失败也缓存，免得每次翻页都重开一个打不开的容器。

`GET|HEAD /api/outputs/{kind}/{id}/stream` 是「播放」的落点。它是独立路由而不是复用录制片段的流：一个导出只有 `ExportJob` 的 id 和路径，没有 clip 记录可查。两种 kind 都在这里解析成文件，共用同一个 range 工具，所以两者不会在 seek 或 `Content-Type` 上分叉。**availability 不是 Present 的直接拒绝**——列表已经告诉页面它播不了，一个越过这道检查的流路由就是一条读任意路径的通道。桥接白名单加了 `["outputs", kind, id, "stream"]`，`kind` 写死两个词而不是宽松匹配。

### 5. 活动失败码

`JobFailureCode`：Cancelled / Interrupted / DiskFull / InputMissing / PermissionDenied / DependencyMissing / DependencyFailed / InvalidInput / Timeout / Unknown。四个作业结构体各加一个 `error_code`，`ActivityItem` 暴露 `failure: { code, retryable }`。

**成员的划分标准是「用户下一步做什么」，不是子系统。** FFmpeg 挂了和 HLAE 挂了都是 `DependencyFailed`；`DiskFull` 和 `PermissionDenied` 都是「写失败」，分开是因为一个靠删文件解决、另一个不是。

**`DiskFull` 不可重试。** 重试会以同样方式失败，而提供重试就是界面在明知答案的情况下说「再试一次」。画板自己的句子是「释放 4.2 GB 后可重试」——先是指令，然后才是重试。

**`Unknown` 是一个真答案**，不是不好意思的兜底：它表示这次失败不在这套分类里，而页面还有 `error` 原文可印。从消息文本猜一个码，比承认不知道更糟。

打码的位置是**错误产生处**：导出链路完整映射了 `MediaError`（含 `Io` 的 `ErrorKind::StorageFull` → `DiskFull`，这正是画板画的那个），重启打断与取消也各自打码。**其余链路目前多数是 `None`**，这是如实的现状，不是完成度声明——见下面的缺口 3。

### 6. `GET /api/recording/plans/{id}`（§10.8 缺口 1 + 2）

一条路由修两个：刷新页面丢租约，和 delivery 的「重试录制」把**租约 id** 交给一个按**方案 id** 解释参数的页面。

租约现在**原样存下它答复过的文档**（`Arc<RecordingPlanResponse>`），读的时候原样交回。重算是显而易见的替代方案，也是错的：导播计划和时长估计都来自持久化的分析，而两次读之间分析可能变过，同一个 id 会得到不同的文档。`binding_sha256` 存在的全部意义就是「一个租约描述一组固定的输入」，那么它产出的方案也是固定的。

**过期答 `410 Gone` 而不是 `404`**：两件不同的事，页面要说不同的话——过期的方案可以从同一个队列重新创建，从来不存在的不行。正在启动中的租约（`Starting`）不按过期处理，`execute_plan` 会在移交给录制器的过程中持有它。

### 缺口

1. **`RecordingJob` 没有 `error` 字段**，它用 `message` 兼作失败文本，所以那条链路只有 `error_code` 没有配套原文。要么给它加 `error`，要么承认 `message` 就是。本轮按后者处理并写在类型注释里。
2. **`AppConfig` 与其它 `document_json` 结构体加字段时会读不出旧文档**（`deny_unknown_fields` + 无 `serde(default)`）。本轮不成问题（未上线），但**上线之后第一次加字段就会撞上**，届时需要一个真的迁移机制。
3. **下载 / 分析 / 录制三条链路的 `error_code` 目前基本是 `None`。** 类型、存储与呈现都通了，缺的是在各自的错误产生处打码——每条链路的错误类型不同，逐条映射是独立的活。**这是本轮如实的完成度**，不是「已支持」。
4. **`OutputMediaInfo` 的探测是同步顺序的**：当页每个输出依次 `probe`。一页二十行、每次几毫秒可以接受，但没有并发也没有量过。
