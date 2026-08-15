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
| 3f | 录制计划 / 快速合辑 / 多轨编辑器 | 时间轴接真数据 |
| 3g | 设置 5 节 / 恢复中心 / 工作台首页 | |
| 4 | i18n 英文收口；测试回归；删除 `styles/index.css`、旧 `features/`、旧 `shared/ui`、旧 `shared/i18n`、`check-web-i18n.mjs`、三个被移除的依赖 | `pnpm lint && pnpm typecheck && pnpm test` 全绿，旧目录清零 |

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
