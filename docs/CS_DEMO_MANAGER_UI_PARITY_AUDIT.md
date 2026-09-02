# CS Demo Manager 与 Vibe CS 界面逐页对比审计

- 审计日期：2026-08-14
- CS Demo Manager 基线：v3.20.1，commit `8961f5072fe4d42803dde68e8e71b3c90b216504`
- Vibe CS 代码基线：exact product build `ba06e65` / tree `51a693afaa0e14be664720ca72af4dec197232f1`（cross-match Player heatmap，包含此前 producer-bound Objective Review、persistent truthful Player directory、Man Advantage、Activity exact context 与 Analysis cancel/XState）；文档更新单独记录，不冒充产品构建输入
- 真实数据：IEM Cologne Major 2026 决赛 FURIA vs Falcons，M1 `de_mirage`、M2 `de_anubis`、M3 `de_inferno`

> 退役说明（2026-08-13）：本文中 OBS、OBS WebSocket、OBS diagnosis 和 OBS backup 的
> 描述是本轮审计开始时的历史界面证据，不是当前可执行能力。公开入口、控制路由和录制
> 实现已经退役，仅保留不会恢复 OBS 能力的旧配置/校准兼容字段；当前录制方向是应用托管 HLAE +
> Windows Media Foundation，并保持 fail-closed。

## 1. 结论

Vibe CS 目前还不是 CS Demo Manager 的完整替代品。它已经补上跨三场 Major 的 Evidence Search、exact player-involvement 查询、绑定 canonical evidence 的持久复盘注释与全局注释索引、Highlights 对同一注释的摘要/CRUD 复用、CSDM-style Demo/Player/Round Comment/Tags、单场 Player Atomic Evidence、全局 Player profile 的 first-10 持久证据预览、SQLite 持久 Player-match projection 上的全局筛选/稳定排序/分页/coverage、最多两个 URL-owned 显式 ID 的 exact compare、跨比赛 Player 地图热图、Clutch Review、带 10×10 方向对位矩阵的 Openings、基于逐回合 5v5 roster 真值的 Team Round、Team Economy、Man Advantage Review 与 producer-bound Objective Review、SQLite 边界分页和 exact kind/UUID detail 的 Activity Center、current-only durable Analysis Run/bounded events/exact producer result、exact-run cooperative cancel 与 cancelled 一等 Activity、Production exact task deep link、只重放可证明 unpublished suffix 的 recording retry，以及 Library 服务端查询、power table/Inspector、真实 URL 列选择和最多 12 个显式 ID 的批量 Analysis 选择。Analysis 页面用 XState v5 管理 renderer request/observation 与 stale-route abort，Rust/SQLite 仍独占 durable truth。既有产品库已索引 M1/M2/M3 共 11,548 条证据并报告 `scan_complete=true`；Player fresh gate 另证明 10 人、projection coverage `3/3`、三条日期未知但目录时间单独标注的本地比赛明细，以及 single/pair URL Reload/Back；后续 current projection gate 证明 FalleN 三图 heatmap 与双尺寸。最新 Comment/Tags gate 以真实 M1 证明共享标签、Player Steam64 评论、source-bound R13 评论、restart readback 与双尺寸；Evidence Annotation 仍明确是 Vibe 自有。剩余差距集中在持久团队实体、尚缺的高级指标/矩阵、跨 subject tag filter/权限、连续高保真回放，以及真实 CS2 + HLAE 成片与 retry 门禁：

2026-08-15 的当前产品 Tauri CDP 验证已通过真实 M1 的 NiKo R21 `2K` canonical highlight 成片门禁：Agent 建立 MP4 任务，受管 HLAE 启动 exact CS2 child、鉴权本地 bridge、跳转并采集 tick 173423–174143，Windows Media Foundation 最终发布 677 帧、11.28 秒、21,834,672 bytes 的 H.264/AAC MP4。此前 `NVAPI_ACCESS_DENIED` 的根因是受管进程缺少标准 Windows desktop environment，而非 NVIDIA 驱动；同时修复了 Win32 verbatim 搜索路径、启动 cfg 时序和 mirv-script `const enum` 运行时引用。

分类边界：Evidence Annotation、exact evidence locator、Analysis Run、Activity、Man Advantage 与 Objective Review 是 Vibe 自有增强；CS Demo Manager 没有 Evidence Annotation。它们可以提升产品，但不能被计入 CSDM parity。真正的对齐项仍按 CSDM 的通用 Comment/Tags、Player/Team heatmap、Rank、Ban、导出与数据库维护分别验收。

1. 团队级 weapon/duel/utility 矩阵、equipment value/economy type/freeze-time advantage、权威 site/spatial 语义，以及首杀地图和跨比赛趋势；Man Advantage 与 Objective Review 已落，但分别只表示 roster minus death targets 与 canonical plant-to-round-end atoms。
2. 队伍实体、队伍历史、队伍热图和表现页。
3. Comment/Tags 的跨 subject filter、批量赋值、作者/权限、Match Chat 与 Round→Video timeline 提示；Evidence Annotation 的更多 evidence consumer 另行推进，不能混算。
4. 连续高保真 2D Viewer 的音频、绘图、全屏、击杀流和完整 HUD。
5. FACEIT、Renown、5EPlay 等多来源下载入口。
6. 可暂停/恢复的制作任务队列、真实磁盘/ETA 与逐阶段日志，以及 recording suffix retry 的真实 HLAE 产品门禁。
7. Library 的真实跨页选择门禁、除 Analysis 外的批量动作、Activity run history 的 Library 内嵌入口，以及大库性能产品门禁。
8. durable Analysis Run 的 heartbeat/lease、并发 retry、永久数据库损坏 quarantine 与其他 failure 形态；completed、startup interruption→new-run retry 及 exact cancel 已过 fresh Tauri/真实 Major 门禁。

Vibe CS 当前做得更好的部分也很明确：

- 默认信息层级更容易理解，不要求用户先适应图标侧栏、超宽表格和十二个并列标签。
- Analysis、Replay 与 Editor 已闭合本轮 1100×700 P0：比赛头不再覆盖标签、Replay transport 留在首屏、Editor 属性面板通过键盘可达 drawer 保留；最大化仍按数据页与画布页分别利用空间。
- 首页在只剩一个用户前置 CS2 后已收为 64px inline preflight，三步工作流在 1100×700 同屏，不再为 OBS/Encoder/FFmpeg 等应用内部实现预留整列。
- 缺失数据、稀疏回放和未知生命值会明确说明，不用估算值冒充事实。
- AI 只能基于已入库证据提出 typed proposal，写入工程前需要预览与确认。
- 内置 Montage、Timeline Editor、BGM 卡点、Output Library 和恢复中心，覆盖了 CS Demo Manager 需要外部 NLE 才能完成的后半段工作。
- 文件、凭据、sidecar、回放缓存和导出路径有更严格的本地安全边界。

因此，正确的对标方向不是复制 CS Demo Manager 的像素和密度，而是保留 Vibe 的轻量工作台，把 CS Demo Manager 已证明有价值的“信息深度、原子证据、全局检索、任务状态”补回来。

## 2. 审计口径

### 2.1 状态定义

| 状态 | 含义 |
|---|---|
| `更好` | Vibe 已覆盖同一用户结果，并在可读性、安全性或工作闭环上明显更完整。 |
| `相当` | 两边都能完成核心任务，信息深度或交互方式不同。 |
| `部分` | Vibe 有一部分界面或后端能力，但用户结果、信息维度或入口不完整。 |
| `缺失` | Vibe 没有可执行的产品入口，或没有支撑该入口的数据能力。 |
| `独有` | 只有 Vibe 有，不能因为 CS Demo Manager 没有就删减。 |
| `不建议照搬` | CS Demo Manager 的实现存在明显可用性、可访问性或维护代价。 |

### 2.2 比较原则

- “有组件”不等于“有能力”：必须能从真实数据进入、执行并看到可信结果。
- “有后端”不等于“界面完整”：没有入口、状态、错误恢复或深链，仍计为部分覆盖。
- “信息更多”不等于“体验更好”：默认首屏应渐进展开，而不是一次铺满所有列和指标。
- 不把两种不同语义混为一谈，例如 AI 对话不等于比赛内聊天记录，稀疏事件回放不等于连续轨迹回放。
- 不把 T/CT 跨半场累计误标为组织队比分；无法证明时保持通用 Team A/B 或显式 T/CT。

### 2.3 本轮视觉证据索引

最新 Analysis cancel/XState gate 位于本地 `target-currentaudit-next/analysiscancel-xstate-visual/`，使用 exact HEAD `adf4d08f7b4524a9f451362d30b44bc05ac51db9`、fresh identifier `app.vibecs.analysiscancel-xstate-audit`、Desktop EXE SHA-256 `b64c6a94da0e0c9d4259ddc0959a945473a5a343534e72ede2243d71618c3c3c` 与 worker/manifest SHA-256 `f7f37918e9eca55c58743853649a3ef582dbbaefdd68bd24078062efff589958`。`agent-browser` 直连 Tauri WebView2 CDP 9371，未使用 Computer Use。真实 M2 run `3133c56c-b932-4d9d-bd9f-0c0bd098a262` 在 validation 取消，retry 创建 distinct completed run `c08ada94-3d5e-403f-adad-2102e07e6d70` 且旧 run 保持 cancelled。真实 M3 run `96009b44-b7ca-4bf1-9d20-ae2d4e872192` 在 `running/parser_running` 取消，worker `1→0`、task files `1→0`、result rows `0`，Demo 回到 Discovered 且 SHA 保留；Activity exact selection 经重启保持，cancelled filter 与 Analysis cancelled notice→exact Activity 均通过。最大化/1100 comparison 视觉 PASS、无 document overflow、console/page errors 为 0；accepted screenshot 为 `screenshots/06-activity-parser-running-cancellable-max.png`、`07-activity-parser-cancelled-max.png`、`08-activity-parser-cancelled-1100.png`、`09-activity-cancelled-restart-1100.png`、`10-activity-cancelled-filter-1100.png`、`11-analysis-cancelled-1100.png`，结构化证据为 `target-currentaudit-next/analysiscancel-xstate-visual/evidence.json`。comparison SHA-256 分别为 `37bd494356b4d47e661ba0cb61ac4299a5eac153fa468cfa3bb17fdac6638354` 与 `9a9cbaf90ed1154c1889cf03c1edb264996b3ee7205d44e1bf4c6787dc4c2d7d`。这些 `target` 文件是本地审计证据，不是 tracked asset；验收后 desktop/worker/CDP listener 均为 0。

所有 Vibe 截图都来自真实 Tauri/WebView2 运行态；单场工作台使用已持久化的 Major M1，Evidence Search、Library、Players 与 Activity 使用真实产品数据，不是 Storybook、静态 HTML 或 synthetic fixture。旧缺陷基线在 `target/visual-audit-20260813-0805-tauri/`，既有闭合证据分布在 `target/ui-parity-closure-20260813/`、`target/parity-continuation-20260813/`、`target/activity-center-audit-20260813/`、`target/product-audit-20260813-current/`、`target/product-audit-20260813-current-build/`、`target/product-audit-20260813-player-directory/`、`target-workflow-audit-20260813/` 与 `target-agent-browser-audit-20260813/screenshots/`。这些旧 run 前截图继续作为对应页面证据，但旧 `analysis:<demo_id>` 行不再冒充 current `analysis:<run_id>` contract。

最新 durable-run gate 位于 `target-analysisrun-audit-82617d4/screenshots/`，使用 exact HEAD `d733b6cf8690996db516a08edc0e0df37b41851c`、identifier `app.vibecs.analysisrun-audit`、Desktop EXE SHA-256 `dafa01d17351d9b0730816b6e6bf320a509be201f102679a922d1f2e22100d1d` 与 sidecar SHA-256 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`。`agent-browser` 直连 Tauri WebView2 CDP，未使用 Computer Use。fresh DB 完成 M1/M2/M3 三个真实 Major run；accepted screenshots 为 `01-analysis-run-result-max-final.png`、`02-activity-analysis-run-max-final.png`、`03-players-match-history-max-final.png`、`04-activity-analysis-run-1100-final.png` 与 `05-players-match-history-1100-final.png`。Player 最大化首次审计暴露 Inspector bottom `1788 > 1392` 的 P1；exact HEAD 中的 TDD 修复已用上述 final 最大化截图和几何复验通过，初次失败截图不作为 accepted evidence。

最新 `target-manadv-activity-audit-20260814/screenshots/` gate 使用 fresh identifier `app.vibecs.manadv-activity-audit`，由 `agent-browser` 直连 Tauri WebView2 CDP 9341，未使用 Computer Use。截图 01–07 来自 `2d73e7f` 初始 EXE（SHA-256 `c7b1af286654ee988fe2f3a927e639d68bb9873258de41bb2ac1b92585b517ca`）：M1 Demo `97221743-7c59-4ae3-bdfd-7eb427c0e75d` / run `47499075-333f-4cac-803d-ae7dbfbc12de` 的 Man Advantage 21/21、矩阵 `7/3/1/10`、首次领先方胜 17/负 4、5 个 lead-change rounds；Production exact deep link、filter-out/reload selection 与 Activity 双尺寸；真实 M3 run `4ded8b20-59e9-4e14-961e-e2e44995e497` startup `interrupted` 后 retry 为 distinct completed run `02a7df9d-6a5c-456c-baac-6a461fb4e200`，旧 run 保留。截图 08 来自 `fc80c5f` final EXE（SHA-256 `b77b0a458d1e4ccdc034d44404bca7b0d759364a5676436099698b64f3721ad8`），只确认 exact completed Activity 初始加载时 `receipt=[]`。该 build 嵌入 2,600-module Web asset，worker/manifest/runtime SHA-256 均为 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`。同一 exact task 状态/stage 前进后自动退役 queued receipt 没有第二次视觉重演；它由新增确定性 TDD、focused 24 tests，以及全 Web 619 passed / 3 skipped、lint/typecheck/build 门禁支持。

Player projection gate 位于 `target-playerprojection-audit-20260814/visual/screenshots/`，使用 exact HEAD `1f7397ec857dc592d4e8525fc9ac4bf299d34db7`、fresh identifier `app.vibecs.playerprojection-audit`、Desktop EXE SHA-256 `792eca8491d4ae36dfbfcc5ff3c9fed322edd1d72e58e0e7dc1abb85e1bfad01` 与 worker SHA-256 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`。本次只在完整功能完成后执行最终一次 `agent-browser` Tauri/WebView2 CDP 界面门禁，未使用 Computer Use。fresh 产品流程设置真实 Major M1/M2/M3 Demo 目录，Library 发现三条并逐个完成 Analysis；Players 为 10 人、projection coverage `3/3`。FalleN 三条 exact local rows 均明确“比赛日期不可用”并另标本地 catalog time；single profile 与 FalleN/NiKo exact pair 经 Reload 保持，Back 恢复 drawer closed 的 single selection bar。accepted files 为 `01-players-max-profile-top.png`、`02-players-max-match-history.png`、`03-players-1100-profile-drawer.png` 与 `04-players-1100-pair-drawer.png`；2560×1392/1100×700 无 document overflow，console/page errors 为空。

最新 Objective Review gate 位于 `target-objective-audit-20260814/visual/screenshots/`，使用 exact HEAD `fbc9c6a2c80fb44099bb62eec6b7e7b322afb58d` / tree `ef344b8d699c2088f66ff0db2c3f77066437f31b`、fresh identifier `app.vibecs.objective-audit`、Desktop EXE SHA-256 `ab3a18edd0993e2d8f1920dea40f9e30f32cf1b9582e01bf5e71c2f82a4f7c29` 与 worker SHA-256 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`。fresh profile 通过真实产品目录 watch/discovery path 找到三场 Major，但只分析 M1 Mirage；Demo `12f8900f-5ef4-4e50-b338-2f44f0a7dc45` / run `03fda7f2-89d5-4578-a4f8-37d8b20b7bbc` completed 且 result producer-bound。页面 exact 显示 8/8、种包方 `7/1`、defuse/explode/no-canonical-terminal `1/3/4`、19 kill atoms 与 55 damage-event atoms。R6 为 molodoy · Team A · T，plant tick 39930，Team B 胜，defuse 与独立 `round_end` 同为 inclusive tick 40691，site 只显示 raw code `407`。2560×1392 三列无 overlap/document overflow；1100×700 隐藏 desktop Inspector、保留 trigger，并打开同一证据的 430×700 Drawer，所选 plant atom 的 Round/Replay/Watch/Add 均 enabled。accepted files 为 `01-objective-max.png`、`02-objective-1100.png` 与 `03-objective-1100-inspector.png`，结构化证据为 `target-objective-audit-20260814/visual/evidence.json`；console/page errors 为空。`agent-browser` 直连 Tauri WebView2 CDP，未使用 Computer Use。

旧 Activity gate 的几何以及旧 Player 三卡/链接/双尺寸布局证据保持有效，但旧 `analysisrun-audit` 的卡片标签和 Inferno/Anubis/Mirage 顺序不作为比赛日期证据；日期真值只使用 Player projection gate。Activity 现在覆盖一次真实 startup interruption→retry、validation/parser-running cancel、cancelled→distinct retry，以及 exact URL 独立于 filter/reload；仍不能证明多页/性能、concurrent retry、其他 kind 的真实 mutation、Steam/recording retry、录制、下载、导出、Watch、CS2、HLAE、heartbeat/lease 或永久 DB corruption quarantine。Player gate 也未启动 Watch/CS2/HLAE，未执行真实 Steam 网络下载。Man Advantage 只证明 remaining-uneliminated state stream；Objective fresh visual 只证明 analyzed M1，三场 34 verified plant rounds 等仍来自独立 read-only SQLite audit。隔离运行不是旧默认数据库的迁移或兼容。选项二参考与真实 Context Canvas 的等尺寸归一化并排证据仍为 `target/parity-continuation-20260813/13-option2-vs-real-context-normalized.png`；它不冒充同一原生 viewport。CSDM 截图来自 v3.20.1 exact commit 的官方仓库预览和当前官方文档。所有 `target` 目录只作为本地审计证据，不进入 Git。

| 对比对象 | CS Demo Manager 证据 | Vibe CS 证据 | 本轮直接观察 |
|---|---|---|---|
| 资料库 | `csdm/05-official-repo-preview-v3.20.1.png`、`csdm/07-official-analysis-queue-doc.png` | `parity-continuation-20260813/09-library-power-table-2560x1392.png`、`product-audit-20260813-current/08-library-columns-1100x700.png`、`09-library-columns-menu-1100x700.png`、`target-workflow-audit-20260813/06-library-max-selection.png`、`11-library-1100-selection.png` | Power table + Inspector/drawer 与 SQLite 侧 search/map/status/stable-sort/page 已落；当前列选择器只提供后端真实存在的列。最多 12 个 explicit IDs 的 batch Analysis selection 不表示全部结果；真实最大化选择 M2+M3 后排序仍保留 2 条且没有 thead select-all，workspace side 746px、当前表无需横滚。1100×700 隐藏 side，表格 1100px 在 972px 容器内局部横滚，sticky actions/pagination 与 selection bar 可见，document 无横溢出。数据库只有 3 条，因此真实跨页/大库性能仍未验收。 |
| Evidence Search | CSDM Search 工作台源码 | `02-evidence-search-fallen-r20-1440x900.png`、`parity-continuation-20260813/04-evidence-search-three-demos-2560x1392.png`、`product-audit-20260813-current/10-evidence-annotation-edited-1440x900.png`、`11-evidence-annotation-after-restart-1440x900.png` | 产品库三场 Major 共 11,548 条证据（M1 3,628 / M2 3,943 / M3 3,977），默认每页 50 行且 `scan_complete=true`；FalleN + multi-kill + R20 唯一命中并能进入精确 Round/Replay。真实 Tauri 在 `furia-vs-falcons-m1-mirage` R1 tick 1 完成注释创建、resolve→reopen、正文/标签编辑与保存；使用同一隔离数据目录完整重启后，编辑后正文与包含 `current-audit` 的标签集合精确读回。实际 Watch 与投影重建仍未跑。 |
| 比赛总览 | CSDM exact commit 的 Overview/scoreboard 源码 | `06-analysis-overview-1100x700.png`、`07-analysis-scoreboard-1100x700.png`、`compare-analysis-overview-before-after.png`、`target-analysisrun-audit-82617d4/screenshots/01-analysis-run-result-max-final.png` | 既有 1100×700 比赛头、玩家链接和完整 scoreboard 保持可达。current fresh M1 run 完成后 Analysis URL 精确保留 `demo=ee98d419-cf81-4a3a-831f-e0e19882d3b0` 与 `run=65dd6401-278c-4c5d-be32-27ab6c9fb13a`，页面读取 exact producer result。 |
| 回合与玩家证据 | CSDM Rounds、Match Players 与 Player profile 源码 | `08-evidence-round-link-1100x700.png`、`19-rounds-context-canvas-compact-nav-1100x700.png`、`target-playerprojection-audit-20260814/visual/screenshots/01-players-max-profile-top.png`、`02-players-max-match-history.png`、`03-players-1100-profile-drawer.png`、`04-players-1100-pair-drawer.png`、`target-currentaudit-next/player-heatmap-ba06e65-max.png`、`player-heatmap-ba06e65-1100.png` | 单场原子证据与 Openings 既有门禁保持。fresh current FalleN `76561197960690195` profile 来自 coverage `3/3` 的持久 Player-match projection，显示三条 exact local rows，比赛日期均明确不可用；跨比赛 Evidence Index 为 `indexed_demos=3`。后续 current projection gate 验证 Mirage `9/14`、Anubis `18/15`、Inferno `10/15` 的 exact Player heatmap、双尺寸与筛选 Reload/Back。仍不能写成真实多页、大库、趋势或 Team heatmap 通过。Watch 未点、CS2 未启动。 |
| Team Round 控制 | CSDM team overview/performance 与 round detail 源码 | `product-audit-20260813-current-build/01-team-round-max-2560x1392.png`、`02-team-round-1100x700.png` | fresh current-only DB 导入真实 M1，并由同源 fast worker 在约 2.6 秒完成分析；Demo `d394e562-7324-446f-a995-f35ed2eb6efd` 有 21 rounds / 10 players。只有 exact 5v5 roster 能证明 Team A/B 跨换边连续性时才显示 2×2 矩阵：A/T `4/12`、A/CT `4/9`、B/T `5/9`、B/CT `8/12`，数值是胜回合/已打回合，不是胜率。点选 cell 会筛到相同回合的 kill 与 canonical `round_end` 证据；两个宽度均无 document 横向溢出。它不是持久 Team entity，也不生成组织名、KAST、trade 或 rating。 |
| Team Economy 控制 | CSDM economy/team performance 与 purchase detail 源码 | `target-agent-browser-audit-20260813/screenshots/09-team-economy-max-final.png`、`07-team-economy-1100-green.png`、`08-team-economy-1100-inspector.png` | fresh M1 的四格 exact purchase/cost oracle 为 A/T `456 / $255,700`、A/CT `209 / $128,650`、B/T `281 / $174,200`、B/CT `420 / $253,000`，合计 `1,366 / $811,550`、拒绝 0 条；每格 3 个 item chips + 1 remainder，详情固定 50 行。最大化通过；首次 1100 检查发现 matrix/evidence overlap，修复与 TDD 后 workspace 纵向滚动且横向隐藏，滚至 max 265 后 Inspector 位于 `483.3–677.3px`，document/body 保持 `1100×700`。初次 RED 截图不作为 accepted evidence。 |
| Man Advantage Review | CSDM advantage 视图 | `target-manadv-activity-audit-20260814/screenshots/01-man-advantage-max.png`、`02-man-advantage-1100.png`、`03-man-advantage-1100-inspector.png` | 真实 M1 为 21/21 verified；first-lead A/B × final-winner A/B 矩阵 `7/3/1/10`，首次领先方胜 17、负 4，5 个 lead-change rounds。same-tick deaths 原子结算，actorless/teamkill 明确保留语义。双尺寸和 drawer 通过；它只表示 roster minus parsed death targets，不是 health/alive、win probability、trade、KAST 或 rating。 |
| Objective Review | CSDM objective/bomb event 与 round detail 源码 | `target-objective-audit-20260814/visual/screenshots/01-objective-max.png`、`02-objective-1100.png`、`03-objective-1100-inspector.png` | producer-bound M1 为 8/8 plant rounds、种包方 `7/1`、defuse/explode/no-canonical-terminal `1/3/4`、19 kill atoms 与 55 damage-event atoms。R6 defuse 和独立 `round_end` 同在 inclusive tick 40691；raw site 只显示 `407`。最大化三列和 1100×700 430px Drawer 通过。三场 34-round 总数来自独立只读 SQLite oracle，不是 fresh UI 三场观察；未点击任何 evidence action。 |
| 2D 回放 | `csdm/01-official-2d-viewer-doc.png` | `21-replay-final-1100x700.png`、`compare-replay-before-after.png` | 1100×700 下 workspace 使用完整剩余高度，304px 方形 radar、transport 与独立滚动证据栏都留在 700px 视口内；仍只有 2,479 稀疏帧/3,129 定位事件，不等于 CSDM 连续 Viewer。 |
| Heatmap | CSDM Heatmap 源码 | `parity-continuation-20260813/05-heatmap-r20-evidence-2560x1392.png`、`08-heatmap-r20-selected-1100x700.png` | 真实 M1 产品页使用 3,262 个稳定 ID 点；R20 可过滤出 FalleN 4 个 killer kill，点选后显示 player/side/floor/round/tick 并能进 Round/Replay/Watch，键盘 roving focus 实测通过。 |
| Activity | CSDM Analyses/Downloads 队列 | 历史 `target-manadv-activity-audit-20260814/screenshots/04-08`；当前 `target-currentaudit-next/analysiscancel-xstate-visual/screenshots/06-11` | exact kind/UUID row 独立于 list filter/page，Production deep link、filter-out/reload 与 startup interrupted→distinct retry 保持已过。当前 gate 另证明真实 M2 validation cancel→distinct completed retry、真实 M3 parser-running cancel 的 worker/artifact cleanup、cancelled summary/filter/Inspector、重启保持及 Analysis exact Activity link；双尺寸 comparison PASS。仍未验其他 kind mutation、多页/性能、heartbeat/lease、concurrent retry 或永久 DB corruption quarantine。 |
| Production | CSDM Video queue | `product-audit-20260813-current-build/05-production-max-2560x1392.png`、`06-production-1100x700.png`、`07-production-activity-1100x700.png`、`target-manadv-activity-audit-20260814/screenshots/04-activity-exact-max.png` | 页面已移除文章式宽度上限；最近持久 Activity row 现在进入 exact `activity=<kind:uuid>`，不再依赖当前 Activity list window。本轮用真实 M1 completed row完成深链；没有由此执行 HLAE、录制、下载或导出。 |
| Outputs | CSDM Videos queue/output folder | `product-audit-20260813-current-build/08-outputs-zero-1100x700.png`、`09-outputs-zero-max-2560x1392.png` | true-zero 会隐藏无意义的筛选、批量和分页控件，保留“制作中心”以及独立的 staged-cleanup recovery 动作；两个宽度均无 document 横向溢出。该空态不能证明有真实 output 时的表格、metadata、rename/reveal/delete 或 cleanup 执行成功。 |
| 视频与制作 | `csdm/03-official-video-interface-doc.png` | `11-editor-drawer-1100x700.png`、`13-editor-maximized-2560x1392.png`、`17-queue-empty-compact-nav-1100x700.png`、`compare-queue-before-after.png` | Queue 零项时已移除无意义统计/操作 dock，仅保留一个去资料库 CTA；Editor 1100px 用同一属性面板的 modal drawer。Agent 视频提案现在展开真实 Queue，用户调整选择后由 inline alertdialog 确认；真实 NiKo R21 已完成 HLAE 采集和 H.264/AAC MP4 发布。active recording recovery 与 suffix retry 仍需各自真实故障门禁。 |
| 下载 | `csdm/04-official-download-view-doc.png` | Vibe Match History 当前界面与代码 | CSDM 在一处呈现多平台、比赛详情与下载队列；Vibe 只覆盖 Steam 工作流，跨平台能力不足。 |
| Settings | `csdm/06-official-settings-doc.png` 与 Settings 源码 | `vibe/18-settings-general-max.png`、`vibe/19-settings-paths-max.png` | 两者大屏都有窄内容列/长设置页问题；Vibe 分组更少，但 General 混入外观、存储、更新、诊断与迁移，并暴露占位更新地址。 |
| AI 协作 | CSDM 无对应界面 | `vibe/20-copilot-empty-max.png`、`vibe/21-copilot-m1-selected-max.png`、`vibe/22-copilot-m1-1100x700.png` | 这是 Vibe 独有优势；当前 Agent 从 canonical highlight 生成 `video_render` MP4 任务后会展开真实录制编辑区，用户选择与确认后跟随 durable job。HLAE 是内部采集工具；真实 NiKo R21 成片门禁已通过。 |

这里的“最大化通过”只表示没有裁切且主任务可以完成，不表示功能 parity 已完成。Library 已有服务端查询窗口、power table/逐条 Inspector、当前 URL 列选择和 explicit batch Analysis selection；Players 已以持久 SQLite projection、coverage、truthful nullable date 与 URL-owned explicit compare 把宽屏空间交给真实对比/证据，Team Economy 同样使用矩阵/证据。Activity 已在 SQLite 边界稳定查询四个权威来源；聚合 feed 仍不是物化统一 history 或任意规模性能结论，但 exact Analysis detail 已有 bounded 持久事件。Production 的持久 Activity preview 与 Outputs 的 true-zero 恢复入口已过旧双尺寸检查；durable Analysis Run Inspector、非零 recording/export/output、Steam/recording retry、Library/Players 真实多页与大库性能、非分析任务日志和通用可恢复动作仍需要继续实测。Editor 的大画布与空时间线属于工具语义，不应和资料页的无效留白混为一谈。

## 3. 全局能力矩阵

| 界面 / 能力 | CS Demo Manager | Vibe CS | Vibe 状态 | 主要问题 |
|---|---|---|---|---|
| 全局导航 | 60px 图标侧栏，入口多，队列数量 badge | 带文字的可折叠侧栏、面包屑、服务状态、自绘窗口栏，Evidence Search 为常驻入口 | 相当 | Vibe 的上下文页不全在常驻导航；Ctrl+K 仍只是路由跳转，不能与独立证据检索混为一谈。 |
| 首页 / 引导 | 无独立首页，按设置进入工作页 | 任务导向首页，解释分析、制作、交付流程 | 更好 | 首页与真实任务状态联动仍有限，容易变成静态导航板。 |
| 原始 Demo 资料库 | 独立 Demos 表格、可见列、批量、标签、评论、来源修正、Watch/Reveal/Analyze | Library power table、逐条 Inspector/drawer、服务端 search/map/status/sort/page、当前 URL 列选择、导入、扫描、监听目录、生命周期、单 Demo Comment/Tags、最多 12 个 explicit IDs 的批量 Analysis、Watch/Reveal | 部分 | 查询与列状态写入 URL；selection 只在当前页面会话保存，跨 page/sort/layout 保留，membership filter 改变时清除，并在导航前逐条 preflight。比赛日期只读 nullable `match_date`；缺失时明确不可用，`cataloged_at` 仅以本地目录化时间标签/tooltip 呈现。真实 M1 已保存共享标签；M2+M3 选择经排序保留，双尺寸局部横滚/sticky actions 已过。只有 3 条记录，不能视为跨页门禁；仍缺 source correction、批量 Comment/Tags、其他跨页动作和大库性能。 |
| 已分析比赛列表 | 独立 Matches 表格、比分/地图/日期/来源、改队名、标签、Watch/Reveal | ready Demo 与未分析 Demo 共存于 Library | 部分 | 生命周期更连贯，但重度用户无法只看已分析比赛，也缺少密集列与批量动作。 |
| 分析任务中心 | 独立 Analyses 页，Pending/Analyzing/Inserting/Done/Error、日志、See Demo/Match | 独立 Activity 聚合 analysis/download/recording/export 的权威持久状态与真实动作，并支持 search/kind/state/分页、exact kind/UUID detail；Analysis 有 exact run/stage/error/fingerprint/events/result/cancel/retry | 部分 | summary/filter/page 同 snapshot；exact row 另在单一 transaction 读权威 source 与 retry/result capability。真实 completed、startup interrupted→distinct retry、validation/parser-running cancel、cancelled→distinct retry 与双尺寸已过。XState v5 只管理 renderer request/observation，durable truth 在 Rust/SQLite。仍没有 heartbeat/lease；concurrent retry、其他 kind mutation、多页/性能与永久 DB corruption quarantine 未验。 |
| Demo 下载 | Valve、share code、FACEIT、Renown、5EPlay、Pending Downloads | Steam match history、持久下载 job、进度、取消、具备 readiness 的失败/取消任务 retry、服务端全库搜索、全结果 CSV | 部分 | current schema 以唯一 non-null SHA-256 和 claim-time Demo identity 保护导入；active claim、match transition、terminal finalize/cancel/startup recovery 都有原子/CAS 边界。retry action 只在 latest eligible、match 未下载、当前 Steam ID/key 语法有效且 owner 相同时出现；runtime 在持久化前再次 fail closed，之后才创建新 queued job并保留旧事实。当前 sync 的 `played_at=None` 不会被目录/同步时间替代。以上路径只有 storage/runtime/Web TDD，未在真实 Steam 网络任务触发，也不证明 key 在线有效；仍缺多平台入口和 Download All。 |
| 全局事件搜索 | 事件、玩家、受害者、武器、地图、日期、来源、标签及击杀属性组合筛选 | 独立 Evidence Search、持久投影、组合筛选、exact participant filter、稳定 evidence ID、Round/Replay/Watch 动作、逐证据复盘注释 | 部分 | 既有真实 M1/M2/M3 共 11,548 条索引、50 行默认页和唯一 FalleN R20 结果已通过；`player` 可 exact 匹配 actor/target/highlight victim。current FalleN profile 从三场 completed analysis 报告 `indexed_demos=3`；应用重启后的投影复核和实际 Watch 启动仍未验收。 |
| 比赛总览 | Scoreboard、round timeline、比赛信息、上下场导航、上下文菜单 | 紧凑比赛头、完整 10 人榜、选中玩家证据、round flow、关键时刻 | 部分 | Vibe 默认更清楚，但没有可配置 scoreboard 列、前后比赛快捷键和每项原子 Watch。 |
| 回合列表 / 回合详情 | 回合导航、单回合详情、评论/标签、直接游戏内 Watch | 命名事件、类型过滤、精确 round/tick/player 深链、source-bound Comment/Tags、加入制作、2D 回放 | 部分 | 真实 M1 R13 评论/标签、restart readback 与双尺寸已过；Round identity 绑定 current Demo SHA，不继承到替换内容。仍缺逐回合完整装备/经济快照、Round→Video timeline 提示和广泛键盘导航。 |
| 单场玩家 | Weapons、Kills、Utilities、Clutches 等独立面板 | K/D/A、ADR、爆头；kills/deaths/weapons/duels/utility/objectives/highlights 原子证据 | 部分 | 每条原子证据已可 Watch、开 Round/Replay、加入制作；仍缺部分团队级矩阵和独立高级分析页，真实多比赛 compare 门禁未验收。 |
| 全局玩家目录 | 表格列、筛选、标签、评论、封禁、XLSX；个人 Overview/Charts/Maps/Heatmap/Rank/Matches | 持久 SQLite Player-match projection、服务端搜索/分页/稳定排序、coverage、最多两个 URL-owned ID 的 ordered exact compare、bounded aliases + total、汇总、地图表现、本地比赛明细、first-10 exact involvement evidence、exact map-scoped cross-match kill/death heatmap、Steam64 Comment/Tags | 部分 | fresh FalleN profile 为 projection `3/3`、三条 `match_date=NULL` 的 exact local rows 与 `indexed_demos=3`；后续 current projection gate 验证三图 Player heatmap、max/Drawer 与 URL Reload/Back。最新 M1 gate 验证 Player 评论/共享标签跨应用重启保留。目录仍只有一页，不能外推真实多页/大库；仍缺趋势图、rank history、tag filter/批量、封禁和导出。 |
| 队伍目录 | Teams、Overview、Maps、Heatmap、Performance、Matches | 无稳定的全局 Team 实体页 | 缺失 | 无法跨比赛观察同一阵容、地图池、攻守表现和队伍热图。 |
| 武器分析 | 独立 Weapons 页，命中部位与准确性 | 独立 Weapons master-detail，真实 kills/headshot kills/damage events/damage 与原子证据动作 | 部分 | 当前事件不能证明 shots/hits/accuracy/hitgroup，界面明确 unavailable；仍缺团队矩阵和命中部位。 |
| 对位分析 | 对位矩阵、opening duel stats、opening duel map | Duels directional matchup + 原子 engagement；Openings 逐回合首个 kill、10×10 actor→target 矩阵、玩家首杀/首死汇总与证据 Inspector | 部分 | Openings 只使用可验证的逐回合首个 kill；真实 M1 为 21/21 verified，`karrigan→FalleN` 筛到 R17 tick 143316，且 2560×1392/1100×700 无页面溢出。无 kill 或不可验证的首事件仍显式 unavailable，不会提升后续 kill。仍缺首杀地图和跨比赛趋势，Watch 未启动。 |
| 道具分析 | Grenades stats + Finder，地图位置和筛选 | 独立 Utility 原子表、玩家/回合/类型筛选、Replay lifecycle、Heatmap grenade 模式 | 部分 | 只消费已解码 grenade/player_blind/utility damage；没有起点→落点/爆点关系、可复用 lineup/callout，缺值明确 partial/unavailable。 |
| 经济分析 | 装备价值、经济类型、优势曲线 | 21 回合 T/CT 表、购买数/金额/物品证据 | 部分 | Vibe 真实性更好，但缺趋势图、经济类型、优势变化和组织队连续性视图。 |
| Team Round 控制 | 逐回合与 team performance | 2×2 Team A/B × T/CT 胜回合/已打回合矩阵、kill/round_end 原子证据与 Inspector | 部分 | 真实 M1 双尺寸已过；只在 exact 5v5 roster 能证明连续性时开放，不能代替持久 Team entity、跨比赛趋势或组织队名。 |
| Team Economy 控制 | team economy、equipment value 与 breakdown | 2×2 Team A/B × T/CT 购买数/explicit decoded cost/item breakdown、50 行 canonical purchase 证据与 Inspector | 部分 | 真实 M1 四格 oracle、top-3+remainder 与双尺寸已过；首次 1100 overlap 经修复/TDD 后 GREEN。它只证明单场 decoded purchases，仍缺 equipment value、economy type、advantage、持久 Team entity 与跨比赛趋势。 |
| Man Advantage Review | advantage by round/team | 2×2 first-lead Team A/B × final-winner Team A/B、逐 tick atomic death state 与 canonical evidence Inspector | 部分 | 真实 M1 21/21、`7/3/1/10` 与双尺寸/drawer 已过。状态是完整 roster 减 parsed death targets，不是 health/alive/disconnect 或 win probability；跨比赛趋势和 freeze-time equipment advantage 仍缺。 |
| Objective Review | objective/bomb events 与逐回合详情 | producer-bound plant-to-round-end atomic stream、planting-team result、terminal state、canonical Inspector/actions | 部分 | fresh M1 8/8 与双尺寸/drawer 已过；三场 34-round 只读 oracle 已过。raw site 不映射 A/B/空间，no-terminal 只表示没有 canonical terminal；不推断 retake/save/trade/KAST/rating，外部 Watch 未跑。 |
| 热图 | Match、Player、Team 多层热图 | Match heatmap + cross-match Player kill/death point map；真实雷达、exact point Inspector、Round/Replay deep link、URL filter | 部分 | Player 跨比赛与点选证据已落；仍无 Team heatmap、强度/区域聚合和归一化解释。 |
| 2D Viewer | 连续位置、shots、kill feed、完整双方 HUD、回合条、全屏、绘图、上下层雷达、音频同步 | 真实雷达、event-sparse 帧、玩家/道具/炸弹、回合/tick/player 深链、保真说明、缓存 | 部分 | 不是连续轨迹；缺 shots、kill feed、护甲/当前武器 HUD、绘图、音频、全屏和 lower-radar 调节。 |
| Highlights / Review | player event sequences、timeline、编辑与 comment 提示 | Highlight 筛选/多选/Preview/Queue，以及 canonical EvidenceAnnotation open/resolved 摘要与 CRUD drawer | 部分 | fresh M1 创建正文/标签后卡片显示 1 待复盘 / 1 注释，双尺寸 drawer 与完整重启读回已过。仍缺 accepted/rejected/needs-trim、团队队列、timeline/虚拟化；close-during-pending 只有 TDD。 |
| 比赛视频制作 | 单场 sequence timeline、HLAE/FFmpeg/VirtualDub、分辨率/语音/X-ray/death notices、加入队列 | Highlights→Queue、director preview、应用托管 HLAE、原生 Windows Media Foundation H.264/AAC、POV、预后滚 | 部分 | OBS 已从产品入口与可执行录制路径退役；Queue 编辑计划可跨 WebView reload 恢复，但真实 CS2+HLAE 端到端仍是发布门禁，不能把本地编辑状态等同于后台任务耐久性。 |
| 视频队列 | Pause/Resume、移除完成/全部、每 job 状态 | 计划、执行、取消、重排、启用、预检、持久 job 状态、启动恢复、失败/取消任务的 proven-suffix retry | 部分 | 运行时暴露的 active recording id 会在详情 hydration 前保持取消可用；启动恢复会复核已发布产物，或把歧义 running/cancelling 状态安全终结。retry 创建 immutable-lineage child，只执行由 request IDs/published prefix/cursor 证明的 unpublished suffix，不猜测续跑 tick。仍缺 pause/resume、完整日志、可信磁盘/ETA，以及真实 HLAE retry/job 验收。 |
| 比赛聊天 | 展示/导出 Demo 内聊天消息 | AI Review 与 Agent 对话 | 缺失 | AI 对话不是原始比赛聊天；Vibe 没有聊天记录读取/导出。 |
| 评论 / 标签 | Demo、Match、Player、Round 评论，round comment 可进入 video timeline；Tags taxonomy | shared Review Tag catalog；Demo catalog metadata、Player Steam64 metadata、current-source Round metadata；另有独立的 Vibe Evidence Annotation | 部分 | 真实 M1 已验证 Demo/Player/R13 共用标签，Player/Round 评论保存、restart readback 与最大化/1100；Round 行绑定 current SHA。仍缺 Match Chat、Round→Video timeline、跨 subject filter/批量、作者/权限。Evidence Annotation 的 open/resolved/global index 不作为本行 parity 证据。 |
| 封禁统计 | 玩家封禁标记和全局 Ban charts | 无 | 缺失 | 若目标包含 MM 用户研究，这是信息缺口；若只服务职业赛可列为可选范围。 |
| 输出管理 | 主要围绕 video queue 与输出文件夹 | 独立 Output Library，搜索/筛选/进度/rename/reveal/delete/cleanup | 更好 | true-zero 已隐藏无意义 collection 控件，并保留 Production 与 staged cleanup；非零结果视觉门禁仍待复核。HLAE bundle 继续保持与普通 media output 不同的 handoff 语义。 |
| Montage / Timeline Editor | 生成素材后依赖外部 NLE | 内置 Montage、multi-track Editor、BGM 卡点、字幕/图像/音频、undo/redo、package | 独有 | 是 Vibe 的核心差异，不能为了 CSDM parity 被挤到边缘入口。 |
| AI 协作 | 无 LLM Agent | 证据工具、typed proposal、preview/confirm/apply、MP4/beat/edit intent | 独有 | Agent 的视频任务现在端到端指向 MP4，HLAE 只作为内部工具。仍需用真实成片证明最终质量；Agent 不能替代全局确定性证据搜索。 |
| 恢复 / 诊断 | 分析日志、数据库优化、常规日志入口 | Recovery Center、redacted diagnostics、cache/storage/managed HLAE/sidecar 状态 | 更好 | 入口较深，且 Settings 信息量过大。 |
| 设置 | 13 类：UI/Folders/Tags/Maps/Download/Playback/Analyze/Video/Cameras/Ban/Integrations/Database/About | 6 类：General/Paths/Steam/Video/Analysis/Recording | 部分 | Vibe 分组更少更易扫读，但每页过长；缺 tags/maps/provider accounts/analyze concurrency/database maintenance UI。 |
| 快捷键 | 系统化快捷键文档，列表/Viewer/前后比赛均覆盖 | Ctrl+K 与少量 Editor/回放操作 | 部分 | Vibe 没有可发现的快捷键总览，More 与上下文页主要依赖鼠标。 |
| 响应式与可读性 | 桌面优先、密集、小字号、超宽表 | 1100×700 与最大化布局、文字导航、渐进 disclosure、Editor 属性 drawer | 更好 | Analysis/Replay/Editor 本轮 P0 已闭合；仍需检查 200% 缩放、读屏，以及自绘窗口的物理拖动/Snap。 |

## 4. 逐页详细对比

### 4.1 全局壳层与导航

**CS Demo Manager**

- 60px 图标侧栏直接容纳 Matches、Demos、Players、Teams、Downloads、Bans、Search、Analyses、Videos 和 Settings。
- 分析、下载和视频入口可以显示 pending badge，重度用户能快速看到后台活动。
- 优点是路由完整、到达快；缺点是图标优先、依赖 tooltip、默认信息密度高，第一次使用时不容易理解每个入口。

**Vibe CS**

- 常驻导航只保留总览、AI 协作、比赛、制作、交付和设置，文字标签明显，侧栏可折叠。
- 自绘标题栏同时承载页面 breadcrumb、Ctrl+K、服务状态、播放停止和窗口按钮。
- `/analysis`、`/players`、`/match-history`、`/queue`、`/studio`、`/editor`、`/recovery` 都是上下文路由，不常驻显示。

**Vibe 做得不好的地方**

1. Ctrl+K 已覆盖所有可独立进入的核心页面，并刻意排除缺少 demo 参数的 Analysis 深链；它仍只是导航检索，不是比赛证据搜索。跨比赛证据应进入独立 Evidence Search，不能让两类搜索继续共用含混文案。
2. Activity Center 已有独立入口，但全局壳层没有统一 badge；用户离开 Analysis/Queue 后，仍不能在任意页面直接看到活跃/失败数量。
3. 自绘窗口栏虽然已覆盖按钮行为，但物理拖动和 Windows Snap 仍需人工系统级验收。
4. 中文界面中仍混有大量英文 eyebrow，例如 `MATCH INTELLIGENCE`、`TOP PARSED HIGHLIGHT`、`OUTPUT LIBRARY`，品牌感存在，但语言一致性不够。

**建议**

- 把 Ctrl+K 明确拆成“导航”与“证据搜索”两组，后者复用统一 Evidence Index。
- 在标题栏增加指向现有 Activity Center 的统一 badge；analysis/download/recording/export 已有权威来源，Agent mutation 只有建立持久来源后才能并入。
- 保持文字侧栏，不复制 CSDM 的 icon-only 导航。

### 4.2 首页 / 工作流引导

**差异**

- CSDM 没有独立产品首页，用户通过设置选择初始页，默认进入资料型工作台。
- Vibe 有引导页，将“导入分析 → 选择片段 → 录制 → 剪辑 → 交付”表达成制作流程。

**Vibe 的优势**

- 新用户能理解产品不仅是 Demo 分析器，还是制作工具。

**Vibe 的不足**

- 首页更像静态目录，而不是今日工作台：没有最近分析、失败任务、待确认 Agent proposal、进行中 export、磁盘风险等真实状态聚合。

**建议**

- 首页只展示跨域的“需要处理”状态；不要再重复每个页面的大标题和静态说明。

### 4.2.1 AI 协作

**CS Demo Manager**

- 没有 LLM Agent，也没有“模型提出剪辑/镜头/卡点变更，再由用户确认”的交互面。

**Vibe CS**

- 可选择真实 Demo、剪辑工程和 BGM；MP4 proposal 会展开对应的录制编辑区，用户在那里调整镜头选择，再预览并显式确认，Agent 随后跟随录制进度和最终输出。
- 缺模型凭据、录制素材、HLAE 或工程时会阻止对应动作；proposal 不会因为聊天输出而自动写入工程。

**Vibe 做得不好的地方**

1. 最大化空态首屏先展示三项上下文和 HLAE bundle，真正的对话区域被压到下方；用户还没开始对话就要理解 Demo、工程、BGM、模式和 HLAE。
2. “复盘指导 / 协作剪辑 / 镜头设计”改变工具集和结果类型，但差异只靠小型 segmented control，缺任务模板和结果预期说明。
3. Thread、tool call、proposal、preview、apply/export 与最终 Editor/Output 的 lineage 没有一条持续可见的时间轴。
4. Agent 只能消费被放入上下文的有界证据，仍需确定性 Search/Players/Rounds UI 让用户独立复核，不能成为信息能力的唯一入口。
5. 空会话仍暴露“取消本次生成”控件；未配置 provider 时也缺一张可直接完成配置与测试的 readiness checklist。

这是 Vibe 的核心差异化能力，应继续保留，但需要把“选择上下文”渐进收起，把对话、证据引用和待确认变更作为主视觉。

### 4.3 Library：原始 Demo、已分析比赛与生命周期

**CS Demo Manager**

- 将 Demos、Analyses、Matches 分成三个明确阶段。
- Demos/Matches 使用高密度表格，支持选择、列显隐、上下文菜单、rename、tag、comment、source correction、Analyze、Watch、Reveal 和导出。
- Analyses 提供单独状态、日志、跳转 Demo/Match 与清理动作。

**Vibe CS**

- 把 discovered/indexing/analyzing/ready/failed/missing 放在同一个 Library，减少三个入口之间的跳转。
- 默认使用高密度 power table；支持真实状态动作 Start/Progress/Retry/Open Match、Watch、Reveal、监听目录与批量分析。
- 最大化已改为无文章宽度上限的 `table + selected-Demo Inspector`；窄窗复用同一详情的 drawer，文件路径、来源、分析状态和主动作仍可达。
- Batch Analysis 只保留最多 12 个显式 canonical ID，跨 page/page-size/sort/columns/view 保留，search/map/status 改变时清除；它不是 select-all。导航前会从本地服务重新读取每个 exact ID，并验证 identity 与 current lifecycle。
- 单 Demo Comment/Tags 继续绑定 Demo catalog identity，并与 Player/Round 使用同一个 Review Tag catalog；它与 exact Evidence Annotation 是两套模型。

**Vibe 做得不好的地方**

1. 服务端 search/map/status 与稳定 sort/page 已落，但 SQLite `LIKE`/JSON player-name 搜索和高页码 offset 尚未用大资料库做真实产品性能门禁。
2. Analysis 已有独立 run history 与 bounded events，但 Library Inspector 尚未内嵌；用户仍需进入 Activity 或带 exact `run` 的 Analysis 上下文查看。
3. 已有单 Demo Tag/Comment；仍缺批量赋值、Demo source correction、XLSX/JSON analysis export。
4. ready 与 raw lifecycle 共用一个视图，在大量 Demo 下不如 CSDM 的 Demos/Matches 分离高效。
5. 缺少一键只看失败/缺失并执行批量恢复的运维视图。
6. Power table、逐条 Inspector 与 explicit batch Analysis selection 已落，当前真实列的显隐状态也会写入 URL；仍缺对现有 run event history 的 Library 内嵌入口、跨页 tags/comments/reveal/watch/export 等其他动作，以及完整路径等字段的产品化展示。

**建议**

- 保留合并生命周期和现有 server-side query window；在 exact lifecycle filter 上补保存视图，并为大库引入合适的搜索索引或 cursor，而不是退回前端全量排序。
- Power table 增加列管理、批量标签/备注和 Export；保留现有 Reveal/Watch。
- 复用已落地的 Activity Center 承担任务状态，不重新复制一个完整 Analyses 顶级页。

fresh Tauri 最大化显式选择 M2+M3 后排序仍保留 2 条，thead 没有 select-all；workspace side 为 746px，当前表无横滚。1100×700 下 side 隐藏，表格 1100px 在 972px 容器内横滚，sticky actions/pagination 与 selection bar 可见，document 无横溢出。数据库只有 3 条，因此跨页保留、上限、partial rejection 与竞态仍由 TDD 覆盖，不能写成真实多页/大库验收。

### 4.4 Match History / Downloads

**CS Demo Manager**

- 提供 Valve、share code、FACEIT、Renown、5EPlay 和 Pending Downloads。
- 支持 Download All、单场详情、下载进度、下载后 Watch/See Demo/Reveal。

**Vibe CS**

- 提供 Steam match history，同步、服务端全库搜索后分页、按同一查询导出全部结果 CSV、持久 download job、进度、取消和自动导入。
- 当前 URL 只接受 exact `q/page/page_size` 查询；搜索或页容量变化会回到第一页，异步结果只有在请求仍对应当前 URL 且未取消时才提交。
- 已下载记录以及刚完成且带 `demo_id` 的任务可以直接进入真实 Analysis 深链，不再停在禁用按钮。
- Demo 非空 SHA-256 在 current schema 中唯一；上传、本地导入、Watch discovery 与 Steam import 在 SQLite writer transaction 外完成 byte validation，再原子 claim/merge/recover。同 ID 换 bytes 会在同一事务失效旧 Analysis 及 projections；same-hash duplicate 不会生成第二个 catalog owner。
- Steam active claim 同事务创建 job、更新 match 状态并捕获 linked Demo identity；import/finalize 以 claim-time identity 及验证后的 path/hash/size 做 CAS，stale worker 不能覆盖并发恢复的新 Demo/Analysis。terminal job/record、cancel-wins、单调 progress、panic supervision、暂时持久化失败重试和 startup orphan recovery 均有确定性门禁。
- 当前 share-code sync 明确写 `played_at=None`，不会从 sync、download 或 catalog time 推导比赛时间；只有显式可信 `Some` 才能进入 Demo nullable `match_date`，已知值冲突 fail closed。

**Vibe 做得不好的地方**

1. 平台覆盖明显不足。
2. Steam 配置需要多项凭据，但 UI 缺少逐步向导和每一项的来源说明。
3. 没有 Download All 与统一 Pending Downloads 页面。
4. `q/page/page_size` URL 恢复、严格参数和请求竞态已有 TDD；真实 Tauri 1100×700 只在 Steam 未配置空态验证 URL 与布局，没有真实 Match History 行，因此搜索结果、全量 CSV、Analysis 深链和多页仍不能写成真实数据门禁已通过。证据见 `target/product-audit-20260813-player-directory/06-match-history-url-1100x700.png`。
5. 内容寻址、并发 claim/CAS、terminal reconciliation 与日期信任边界只有 storage/runtime/application 测试；最新 Player 产品门禁没有执行真实 Steam 网络下载，不能把本地三场导入分析外推为 Steam 下载成功。

### 4.5 Analysis 生命周期与批量分析

**CS Demo Manager**

- 阶段和日志是第一等产品对象，用户能看到 Pending、Analyzing、Inserting、Done、Error。
- 支持配置并发分析数量。

**Vibe CS**

- 既有 current-build 隔离验收中，同源 fast worker 在真实 438MiB M1 上约 2.6 秒完成核心分析，得到 Demo `d394e562-7324-446f-a995-f35ed2eb6efd`、21 rounds 与 10 players；最新 `currentaudit-workflows` fresh run 约 3.4 秒，得到 Demo `03e65851-742f-47af-ad60-955ffdbd0c23`、21 rounds、10 players、457 highlights，并验证 tick 189316。两次都是各自 current-only 构建的观察，不是通用性能承诺。
- Analysis workspace 可带最多 12 个 Demo，展示各自状态并切换活动比赛。
- 当前 desktop 必须与同一源码构建的 sidecar 配对：真实验收中，旧 sidecar 对 current desktop 返回缺少 `status` 的响应并被 fail-closed 拒绝；重建同源 sidecar 后 M1 成功得到 Mirage、21 rounds、10 players、457 highlights。未发布产品不为旧 worker response 增加兼容分支。
- 当前 Analysis 已以 `analysis_runs` 和 `analysis_run_events` 持久每次尝试。状态为 `queued/running/completed/failed/interrupted/cancelled`；固定阶段覆盖 input validation、parser queue/start、parse 后 source revalidation、projection 与 terminal state。每 run 最多 32 个顺序事件并保留 terminal event 容量，error/detail 最多 2,000 字符，不生成 percentage。
- `POST /api/demos/{demo_id}/analysis-runs` 返回 `202`，后台 owner 不依赖请求继续存活；active/detail endpoint 读取 exact run，`GET /api/analysis-runs/{run_id}/result` 只返回由该 completed run 生产的结果。`analyses` 以 producer run/status 与 Demo 做外键约束；completion 同事务提交 run/event、result、evidence projection 与 Demo `ready`。
- `POST /api/analysis-runs/{run_id}/cancel` 通过 Running/Cancelling/Committing owner registry 只取消 exact live run；等待 validation/parser/sidecar 退出和 task artifacts cleanup 后才持久化 cancelled，late Committing 返回 `409`，cleanup debt/owner panic/永久持久化失败不伪装成功。Activity 使用 `analysis:<run_id>`，Inspector 显示 exact stage、SHA-256/size、persisted error、result availability 与 ordered events。eligible latest failed/interrupted/cancelled attempt 可以创建新 run retry，旧 attempt 不被改写；completed 只有 exact producer result 存在时才能 Open Analysis。
- 启动时 queued/running run 会原子成为 `interrupted` 并追加 terminal event；只有仍为 `analyzing` 的 Demo 才改为 failed，ownerless Indexing/Analyzing 也会终结。recovery 失败会阻止 runtime 开始服务，不留下可见 zombie active row。
- fresh `analysisrun-audit` 在 M1/M2/M3 各完成一个 exact run。M1 Demo/run 为 `ee98d419-cf81-4a3a-831f-e0e19882d3b0` / `65dd6401-278c-4c5d-be32-27ab6c9fb13a`，从 `00:52:30.728Z` 到 `00:52:43.139Z`；六个持久事件依次覆盖 validating/input verified/parser started/revalidation/projecting/completed，绑定 SHA-256 `04f26f0f092f24fd13e7939dc56e72a3783a61872500b97b09810ed5a2363697`、`438,520,684 B` 且 `result_available=true`。Analysis URL 与 Activity 的 Open Analysis 都保留 exact demo+run。
- M2 Anubis Demo/run 为 `70330609-4b7a-44d3-9c03-47336e5e578c` / `234dc7ac-1abd-448f-8474-fb32ccb4bc97`，SHA-256 `89907025d5d5c3d05ef7859d8437303cc83ff1be0be8bb3c92e14c6a774c5fa8`；M3 Inferno 为 `c4d1caa5-3d4c-4e71-9df1-3716334ed887` / `16b18d2d-4be4-40ec-b5ab-cd110a97b8be`，SHA-256 `374b2f600880e2f8b0437314924b3745c2b0d32e63d53abbedd8bfd52ab8b0b8`。两者也为 completed exact producer result；当前没有把这一观察外推为失败恢复证据。
- 最新 fresh gate 另用真实 M3 证明一次 failure recovery：run `4ded8b20-59e9-4e14-961e-e2e44995e497` 在分析启动后立即停止 host，重启后 exact row 为 `interrupted`；`retry_analysis` 创建新 run `02a7df9d-6a5c-456c-baac-6a461fb4e200` 并 completed，旧 run/error/events 保留。
- Analysis renderer 现在由 XState v5 管 `loading/observing/ready/cancelled/failed/unavailable` request/observation state 与 stale-route abort；Rust/SQLite durable run 与 Demo lifecycle 是唯一权威。最新 cancel gate 的 M2 `3133…` 在 validating 取消并 distinct retry completed；M3 `9600…` 在 parser-running 取消后 worker/task files 都从 1 归零、result 为 0、Demo Discovered/SHA 保留，Activity restart/filter 与 exact Analysis link 通过。

**Vibe 做得不好的地方**

1. completed run/Inspector、startup interruption→distinct retry、validation/parser-running cancel 与 cancelled→distinct retry 已经过 fresh Tauri/WebView2 + 真实 Major 门禁；其他 failure 与 concurrent retry 尚未实跑。
2. 没有 heartbeat/lease、用户可配置并发数或永久数据库损坏 quarantine；当前全局单 parser admission 更偏安全策略，界面未解释。
3. exact stage、开始/更新时间和失败阶段尚未在 Library 等所有入口一致显示；只有 Activity 读取完整 bounded events。
4. 没有“重新分析并保留旧结果直到新结果成功”的明确版本语义；当前 completed result 会阻止再开一次 run。
5. hard crash 仍可能留下 worker process 和 `worker-tasks` request/response/repair artifacts；durable run recovery 不等于物理 sidecar cleanup。
6. run fingerprint 只是在 parse 前后从 source path 观察到相同 SHA-256/size，不证明 parser 从同一 open handle 消费了每个字节。terminal-tail recovery 解析 bounded repair copy，而 copy 自身 provenance 不在 event 中，仍保留窄的 physical-file TOCTOU。

### 4.5.1 Cross-match Evidence Search

**CS Demo Manager**

- 有独立 Search 工作台，不是导航跳转框。事件条件包括 kills、4K/5K、1v3/1v4/1v5、ninja defuse 和 round start。
- 可继续叠加 actor、victim、weapon、headshot、no-scope、wallbang、jump、smoke、team kill、collateral、map、source、match/round tags 和日期。
- 结果保留 map、日期、round、comment 与 kill feed，并可直接 Watch、See Round、See Match。
- Idle、Searching、Error、No results 和未分析数据分别有不同状态。

**Vibe CS**

- 已有独立 Evidence Search 路由和常驻搜索入口，不再把 Ctrl+K 导航框冒充证据搜索。
- analysis 持久化时事务性更新 evidence projection；应用启动会重建缺失投影，查询有明确的 bounded page/page-size 和 scan completeness。
- 支持 event family、actor、victim、weapon、map、source、source kind、headshot、round 和日期组合筛选；结果使用与 Player/Round/Replay 相同的 canonical evidence ID。
- `player` 使用 normalized exact ID/name 匹配 actor、target 或 indexed highlight victim；全局 Player profile 复用该接口显示 first-10、total、indexed Demo 数与 scan completeness。
- 每条结果能进入精确 Round、Replay 或受管游戏内 Watch；URL 保留 demo/round/tick/player/evidence。
- 每条结果现在可以打开复盘注释 drawer；创建时后端要求 `demo_id/evidence_id/round/tick` 与持久 projection 的 canonical locator 完全一致，locator 不随编辑改变。记录支持正文/自由标签编辑、open/resolved、分页读取和删除，删除 Demo 会级联删除注释。
- Search 与“复盘注释”现在是同一工作台的两个明确视图；全局注释索引保留 `q/tag/state/page` URL 查询、分页和 Round/Replay 深链。
- 真实 Tauri 的 M1 产品库显示 3,628 条已索引证据、默认 50 行/页；`FalleN + multi_kill + R20` 唯一命中，并已实际跑通对应 Round 与 Replay 深链。

**Vibe 做得不好的地方**

1. 还没有保存查询、最近查询、批量 collection/production 或导出。全局 annotation index UI 已在真实 Tauri 1100×700 通过 0-result 空态门禁，且 `q/tag/state/page` 契约已有 TDD；最新 workflow 库虽有一条 Highlight annotation，但本轮未打开 global index，因此仍不能声称非空列表、跨页或 Round/Replay index 深链已实机通过。空态证据见 `target/product-audit-20260813-player-directory/05-annotation-index-1100x700.png`。
2. 当前 projection 只覆盖已定义事件/高光族；CSDM 的 no-scope、jump、smoke、team kill、collateral、ninja 等条件需要 parser 有权威字段后再开放。
3. M1/M2/M3 multi-match 与 `scan_complete=true` 已在产品库通过；应用重启后的投影重建，以及会真实启动 CS2 的 Watch 仍是明确门禁。
4. Highlights 已消费同一 canonical annotation，显示 open/resolved summary 并复用 CRUD drawer；Agent、Round、Editor、Library 和全局 Player profile 仍未全部消费统一 review 状态。
5. fresh M1 第一条 canonical Highlight 保存正文 `M1 开局 one-tap：复核交叉火力与首杀节奏` 与 `major-audit/opening` 标签后，卡片显示 1 待复盘 / 1 复盘注释；完整退出重启后精确读回。最大化为 1050px Highlights view / 4 列 card，1100×700 的 card/action 可见、drawer 430×700。请求过快，视觉只证明 success callback refresh；close-during-pending 是 TDD。全局 annotation index 的非空/多页与 Round/Replay index 深链仍未做产品验收。

这一项已从“功能缺失”进入“三场产品检索闭环已过、外部动作/重启门禁待验收”；不能把当前三场成功外推为任意规模资料库的性能结论。

### 4.6 比赛头部、标签与上下文导航

**CS Demo Manager**

- Overview、Rounds、Players、Heatmap、Weapons、Duels、Grenades、Economy、2D Viewer、Video、Chat 全部作为并列标签。
- 支持 Previous/Next match 和键盘快捷键。

**Vibe CS**

- 只把 Overview、Rounds、Players、2D Replay、Highlights 作为核心标签；Insights、Heatmap、AI Review、Cosmetics 放进 More。
- 1100px 宽度下明显更易用，回合/回放使用全宽，不长期占用玩家 rail。

**Vibe 做得不好的地方**

1. More 混合了“深度分析”“空间分析”“AI”“外观编辑”四种完全不同的任务，信息架构仍不稳定。
2. Weapons、Duels、Grenades、Economy 被聚合为 Insights 后，原子数据深度下降。
3. 没有前后比赛按钮和对应快捷键。
4. generic Team A/B 是诚实 fallback，但缺少可信组织名时应在 UI 明确“未取得队名”，避免像正式队名。

### 4.7 Overview / Scoreboard

**CS Demo Manager**

- Scoreboard 是核心，包含 K/A/D、K/D、DMG、KAST、ADR、UDR、HS、MVP、HLTV rating、道具、首杀/首死、trade、穿墙、多杀、残局和目标等可配置列。
- 比赛信息还显示 source、client/server、tickrate、framerate、checksum；支持 Watch/指定 tick、Reveal、复制分享数据以及 XLSX/JSON 导出。
- 信息完整度和可操作性很强，但默认横向列极多，缩写与 tooltip 依赖重，阅读顺序更像数据库而不是比赛叙事。

**Vibe CS**

- 当前最大化 Overview 已填满有效空间：完整 10 人榜、6 个选中玩家指标、round flow、武器/对位/道具/目标/全场经济和 5 个关键时刻。
- 缺失能力以 unavailable 呈现，不再保留巨大的空占位卡。
- 1100×700 实测比赛头 `clientHeight == scrollHeight == 88`，标签从其下方开始；“玩家资料”中心命中真实链接，完整 scoreboard 的 Player/K/D/A/KD/ADR/HS 均可达，document 无横向溢出。

**Vibe 做得不好的地方**

1. 选中玩家卡片中混入全场经济容易产生归属误解，当前虽已改为“全场经济”，结构上仍最好拆成 Match evidence。
2. Scoreboard 列不可配置，缺少 K-D 差、首杀、trade、utility 等完整维度。
3. 摘要卡不能展开为对应原子事件列表。
4. Key moments 上限固定为少量项目，用户不能按类型/玩家/回合筛选完整证据。
5. 最大化时左侧 10 人 rail 与下方完整 scoreboard 重复；在 1100×700 又会把完整信息推到深滚动位置。rail 应承担选择/导航，而不是复制同一组统计。

### 4.8 Rounds / 单回合证据

**CS Demo Manager**

- 总览逐回合同时显示双方现金、花费、装备价值、经济类型、击杀 feed、胜方和结束原因；详情再展示残局、装备/状态和经济走势。
- 回合条、单回合路由、Watch、评论和标签形成完整上下文，事件还能继续进入 Video timeline。

**Vibe CS**

- R20 已能显示实名 actor/target、翻译后的结束原因、combat/objective/utility/economy 过滤、精确 tick、加入制作和 2D 回放。
- URL 保存 `demo/tab/round/player/tick`，刷新和 Back 可恢复。
- 从 Search 进入的 canonical Evidence 深链会自动滚到 R20，并选中与 FalleN 重叠的 4K encounter（`161101–161310`），不会再误选同回合前一个无关事件组。

**Vibe 做得不好的地方**

1. 没有逐回合 scoreboard、装备和经济快照。
2. 已有 source-bound Round Comment/Tags，但仍没有逐回合 accepted/rejected 等人工 review taxonomy，也没有 Round→Video timeline 提示。
3. 缺少从任意事件直接“游戏内从此 tick 观看”的统一动作；有些证据只能进入 2D Replay 或 Queue 预览。
4. 购买/道具爆发虽然默认折叠更可读，但需要一个可展开的完整原子事件表，不能只保留摘要。
5. 最大化布局把短事件文本贴在左侧、`加入` 动作推到最右侧，中间形成大段无意义空白；应限定阅读列宽，并把 round scoreboard/经济/装备放入右侧证据栏。
6. 连续伤害被拆成大量几乎相同的行，每行按钮都只叫“加入”，缺事件专属可访问名称；应将一次交火分组，并让动作读作“将 FalleN→m0NESY @ tick … 加入制作”。

### 4.9 Players：单场玩家与全局玩家

**CS Demo Manager**

- 单场玩家页同时呈现 Rating 1/2、KAST、ADR、K/D、平均击杀/死亡、爆头、多杀、道具、目标与残局，并将 kills/deaths/weapons/clutches 落到可观看的原子事件。
- 全局玩家页支持 tables、tags、comments、ban、XLSX；个人页有 charts、maps、heatmap、rank、matches。

**Vibe CS**

- 单场提供核心统计，并在 Players tab 中按选中玩家展开 kills、deaths、weapons、duels、utility、objectives 和 highlights；原子行保留 round/tick/evidence ID。
- 每条可执行证据都能进入受管 Watch、精确 Round/Replay，或加入 Production；缺少 shots、accuracy、KAST、Rating 2 等权威字段时明确不可用。
- 全局玩家目录读取 Analysis completion 同事务写入的 `player_match_items` + `player_match_projection_state`，不再扫描最多 1,000 Demo 或逐场反序列化 Analysis。只有 projection timestamp 与 row count 均匹配当前 Analysis 的记录参与查询；SQLite 完成 filter、显式列/方向 stable sort、count 与 page，并用 SteamID 打破并列。
- directory/profile/matches/compare 都返回 `projected_demos/total_analyses/projection_complete`；coverage 不完整时 exact absence 不会伪装成 404。别名最多返回 32 个，并保留完整 `aliases_total` 供 UI 显示可见/总数。
- match row 通过 JOIN Demo 读取 nullable `match_date` 与 required `cataloged_at`；前者只表示可信比赛时间，后者只表示本地目录时间。已知日期优先，未知只用 catalog time 稳定排序并明确标为不可用。
- 严格 Player URL 拥有 `q/page/sort/direction/player/compare/matches_page/maps_page/heatmap_map/heatmap_kind/inspector=1`。最多两人 ordered exact compare、single/pair Inspector、match/map page 与 exact map heatmap 都可经 Reload/Back 恢复；未知/重复/不一致参数 fail closed。
- 全局 Player profile 另从 Evidence Index 读取 first-10 exact participation evidence，显示 total/index completeness；每行 Round/Replay 保留正在查看的 player，并提供完整 exact search。
- current fresh DB 的 FalleN `76561197960690195` profile 来自 projection coverage `3/3`，三条 exact local row 为 Inferno `10/15/7 · ADR 68.0 · K/D 0.67`、Anubis `18/15/4 · ADR 121.4 · K/D 1.20`、Mirage `9/14/6 · ADR 78.0 · K/D 0.64`；聚合 `37/44/17 · ADR 89.1 · damage 5,615`。NiKo 聚合 `51/32/20 · ADR 107.2 · damage 6,754`。三场 `match_date=NULL`，界面逐条显示“比赛日期不可用”并另标 catalog time；Analysis link 保留 player 与 exact Demo，Evidence Index 为 `indexed_demos=3`。最大化与 1100×700 single/pair 600px Drawer 均无 document overflow，console/page errors 为空。
- Player profile 已增加基于同一 producer-valid Evidence Index 的跨比赛地图热图：kills 只取 attacker role coordinate，deaths 只取 victim role coordinate；每点携 exact Demo/evidence/round/tick/player Round/Replay link。服务端上限为 5,000 点，超限时返回 exact total + empty points，不绘制 partial density。UI 一次读取完整点集后本地切换 kill/death 可见性，避免相对坐标随筛选漂移。

**Vibe 做得不好的地方**

1. 已有逐玩家地图聚合与跨比赛 kill/death 点分布，但仍没有趋势、强度/区域聚合和 rank history。
2. 已有 Steam64-bound Comment/Tags；仍缺 tag filter/批量、ban/export。
3. 当前 compare 保存最多两个 URL-owned canonical Steam64，第三个替换最早选择；route 按请求顺序 exact 返回，invalid/duplicate 拒绝，任一缺失不返回 partial。最新 gate 证明 single profile Reload、pair Reload 保持两个 checked + Drawer，以及 Back 恢复 drawer closed 的 single selection bar；但数据库仍只有一页，不证明真实多页/大库或跨多比赛图表。旧 M1-only gate 只继续证明 selection 与当时搜索结果行解耦；旧三卡截图不再作为日期证据。
4. 单人原子证据和 Weapons/Duels 专页已经落地，但团队级 weapon/duel matrix、grenade finder、完整 economy workbench 仍未建立。
5. 窄窗的 enabled icon 已补 title 且真实 M1 原子 workspace 可见；本轮没有实际启动 Player Watch，也没有完成 screen reader/全键盘路径验收，不能把“动作已接线”等同于外部 CS2 播放已通过。

### 4.10 Weapons

**CSDM 能力**：独立 Damages/Hits/Kills 摘要、逐武器 kills/damage/hits/accuracy/HS% 表和 Head/Neck/Chest/Stomach/arms/legs 命中分布。

**Vibe 能力**：More > Weapons 使用逐武器排名 + 原子证据表，支持玩家/回合过滤；只聚合可证明的 kills、headshot kills、damage events 和 numeric damage。

**差距**

- 真实 M1 FalleN R20 显示 4 kills、3 headshot kills、572 numeric damage、8 damage events 和 4 个 weapon IDs；每条证据能进 Round/Replay/Watch/Add，实际 Watch 未启动。
- 当前 TimelineEvent 不能可信地产生 shots/hits/accuracy/hitgroup，因此这些字段明确显示 unavailable；仍缺团队矩阵和命中部位。

### 4.11 Duels / Opening Duels

**CSDM 能力**：玩家对位矩阵、opening duel stats、opening duel map；明细保留 round、killer/victim、双方 side、weapon 和击杀属性，并可 Watch/See killer/See victim、导出矩阵。

**Vibe 能力**：独立 Duels master-detail 将全场 directional matchup 聚合与原子 kill/damage engagement 分离，支持 player/opponent/round 过滤与 canonical Round/Replay/Watch/Add 动作；More > Openings 另以每回合最早 tick 的 kill 生成首杀证据、玩家首杀/首死汇总和 Inspector。

**差距**

- 真实 M1 FalleN 全场为 5 组 matchup / 110 条原子交锋；R20 vs m0NESY 为 3 条事件，Round/Replay 深链已按 canonical evidence 实跑，Watch 未启动。
- Openings 只接受该回合第一条 kill：若它越界、缺 actor/target、无法映射到 canonical player 或为 self-elimination，该回合直接标记 unavailable，不会把后续 kill 提升为“首杀”。
- Openings 的 focused/全套自动化门禁已过；真实 Tauri M1 页面显示 21 verified rounds、0 unavailable、21 atomic opening kills，R1 Inspector 的 canonical source 是 `player_death-2598-26` / tick 2598。该次没有点击 Watch，也没有启动 CS2。
- 仍缺全队矩阵、首杀地图和跨比赛趋势；trade、shots、accuracy、KAST、Rating 没有权威字段，不能由 duel/opening 原子数推断。

### 4.11.1 Clutch Review

**Vibe 能力**：More > Clutch Review 只接受能同时证明 outcome、唯一 `1vN` 标签、canonical player/round、合法 tick 范围和对手关系的 highlight；其余候选 fail closed。可按结果、人数和玩家筛选，并保留 Round/Replay/Watch/Add 的 canonical 动作。

**当前门禁**

- 真实 currentaudit M1 在 1100×700 显示 20 个可验证残局机会、0 wins、20 attempts，证据见 `target/product-audit-20260813-player-directory/07-clutch-review-m1-1100x700.png`。
- M2 R16 的 m0NESY `1v2` 只由 TDD 与既有 real-data oracle 覆盖；最新 fresh DB 中 M2 也只处于 discovered，没有载入 Analysis，因此该产品验收仍为 OPEN，不能用 M1 页面代替。
- 本轮没有点击 Watch，也没有启动 CS2 或 HLAE。

### 4.12 Grenades / Utility

**CSDM 能力**：Flash/HE/Fire/Smoke 统计与 Finder；可按类型、玩家、回合、阵营过滤，复制 position 并直接 Watch。

**Vibe 能力**：独立 Utility master-detail 按玩家、回合、道具类型筛选已解码 grenade、player_blind 和 utility-attributed damage；每条保留 canonical Round/Replay/Watch/Add，汇总受 match-level capability 约束。

**差距**

- Vibe 已能查询玩家、回合、类型、效果对象和原子事件；但仍缺投掷起点→落点/爆点关系。
- 没有 lineup 收藏、复用或从雷达点选定位到回合。
- numeric damage/blind duration 只有在 capability 为真且所有筛选原子均有显式值时才聚合，否则显示 `—` 与 partial/unavailable；不能把 decoded events 称为 throws/hits/coverage。
- 真实 M1 最大化仅验证 More 菜单可发现入口；页面内、1100×700 与深链视觉验收仍未完成，Watch/CS2 未启动。

### 4.13 Economy

**CS Demo Manager**

- 以 outcome by economy type、equipment values、advantage 和 breakdown 四组视图表达 pistol/eco/semi/force/full buy 与胜负。

**Vibe CS**

- 当前真实 M1 显示 21 个非空 T/CT 回合、T 737 次购买、CT 629 次购买、总金额 `$811,550`。
- 使用明确 T/CT，不跨半场冒充组织队。

**Vibe 做得不好的地方**

1. 缺装备价值/优势曲线和经济类型。
2. 缺 per-player buy breakdown 与购买原子行深链。
3. T/CT 经济表适合真实性；新 Team Round 控制提供 roster-verified 的 Team A/B × T/CT 回合结果，但它不包含装备价值或经济类型，不能冒充组织队经济视图。

### 4.13.1 Team Round 控制

- 当前工作台只有在比赛摘要恰好有两组 5 人 roster，且每回合 `_round_roster` 能将同队玩家放在同一 side、对手放在相反 side，并能验证 Team A/B winner 与范围内 `round_end` 时才开放；仅有 raw T/CT summary 会 fail closed。
- 真实 M1 的 2×2 结果是 Team A/T `4/12`、Team A/CT `4/9`、Team B/T `5/9`、Team B/CT `8/12`；分子为胜回合，分母为该组合已打回合，不是 win rate。
- 点选 cell 会列出相同回合的 kill 与 canonical `round_end` 证据，并保留 Round/Replay/Watch/Add 动作；没有 POV actor 的 `round_end` 不会伪装成可加入制作的玩家片段。
- `target/product-audit-20260813-current-build/01-team-round-max-2560x1392.png` 与 `02-team-round-1100x700.png` 已确认双尺寸无 document 横向溢出。本轮未点击 Watch，未启动 CS2 或 HLAE。
- 这是单场 roster continuity，不是持久 Team entity、组织身份、队伍历史或跨比赛 performance parity。

### 4.13.2 Team Economy 控制

- 只有 exact 两组 5 人 summary roster 与每回合 exact 10-player roster 能证明 Team A/B、T/CT side 时才开放；purchase 还必须 source ID 唯一、位于回合内、有 canonical actor，任何显式 side 与 roster side 一致。
- 真实 M1 四格为 A/T `456 / $255,700`、A/CT `209 / $128,650`、B/T `281 / $174,200`、B/CT `420 / $253,000`，合计 `1,366 / $811,550`、拒绝 0 条。金额只累计 explicit non-negative decoded cost；缺 cost 会保留购买数但把金额标 partial。
- 每格只显示 top 3 item groups 与一个 remainder；详情固定 50 行，Round/Replay/Watch/Add 从 canonical source 重建，不能由伪造 cost 生成动作。
- accepted evidence 为 `target-agent-browser-audit-20260813/screenshots/09-team-economy-max-final.png`、`07-team-economy-1100-green.png` 与 `08-team-economy-1100-inspector.png`。agent-browser 首次 1100 检查发现 matrix/evidence overlap；修复与 TDD 后 workspace 改为纵向滚动、横向隐藏，滚至 max 265 后 Inspector 位于 `483.3–677.3px`，document/body 为 `1100×700`。初次 RED 截图不作为验收证据。
- 这仍不是 equipment value、economy type、advantage curve、持久 Team entity 或跨比赛 team economy。

### 4.13.3 Man Advantage Review

- 只有两组稳定 5 人 summary roster、每回合完整 10 人 roster、唯一 round number、唯一 canonical event IDs 与范围内唯一 `round_end` 都能证明时才开放；death target 必须属于该回合 roster，actor 若存在也必须 canonical。
- 状态从每回合 roster 开始，只减去 parsed death targets；同 tick deaths 原子结算，actorless death 保留但没有 POV Production 动作，team kill 只减少 target 队。重复 target 或同 tick 重复 target 会使该回合 fail closed。
- 真实 M1 Demo `97221743-7c59-4ae3-bdfd-7eb427c0e75d` 为 21/21 verified，first-lead A/B × final-winner A/B 矩阵按行为 `7/3/1/10`，首次领先方最终胜 17、负 4，5 个回合发生 lead change。
- accepted evidence 为 `target-manadv-activity-audit-20260814/screenshots/01-man-advantage-max.png`、`02-man-advantage-1100.png`、`03-man-advantage-1100-inspector.png`。这不是 health/alive/disconnect、win probability、trade、KAST、rating 或 equipment advantage；本轮未点击 Watch，未启动 CS2/HLAE。

### 4.13.4 Objective Review

- More > Objective Review 是 exact producer-bound Analysis 上的 deterministic current-match projection，不新增 parser/schema，也不改写 pinned demoparser worker provenance。它要求稳定的两组 5 人 summary roster、每个 source round 的 exact 10 人 roster、唯一正整数 round number，以及每个 published atom 非空且全局唯一的 canonical event ID。
- 每个 published plant round 必须只有一个 in-bounds plant、canonical T-side planter、verified Team A/B winner，以及一个唯一、in-bounds 且 tick 不早于 plant 的 `round_end`。canonical window 明确包含首尾：`plant.tick <= atom.tick <= round_end.tick`。同 tick 的 plant/kill/damage/defuse/explode/`round_end` 是一个原子组；source ID 只提供稳定展示顺序，不证明同 tick 内先后。
- 每个 target 和每个非空 actor 必须属于 exact round roster。任何已出现但为 null、非法、多个 alias 互相冲突或与 roster truth 不符的 actor/target/terminal/winner side 都使 round fail closed。Defuse 必须有 canonical CT actor；explode actor 只能为空或 canonical；terminal 必须唯一、位于 plant window 内并与 winner 一致。没有 terminal 只显示“未记录 canonical terminal”，不推断炸弹状态或回合原因。
- `round_end` 是独立 actorless boundary atom；Round/Replay/Watch/Add contract 每次从当前 source recanonicalize，只有 canonical actor 才能 Add POV。selected round 没有 plant 时仍保留该 round 并显示 truthful empty state，不会静默切到另一个 plant round。raw site 只接受非负 safe-integer 数字或 bounded decimal string，并原样标为 raw code；不命名 bombsite A/B，不生成空间位置。
- fresh Objective profile 只分析 M1 Mirage：Demo `12f8900f-5ef4-4e50-b338-2f44f0a7dc45` / run `03fda7f2-89d5-4578-a4f8-37d8b20b7bbc` completed，页面为 8/8、种包方 `7/1`、defuse/explode/no-canonical-terminal `1/3/4`、19 kill atoms、55 damage-event atoms。R6 为 molodoy · Team A · T，plant tick 39930，Team B 胜，defuse 与 `round_end` 同为 inclusive tick 40691，raw site `407`。
- accepted evidence 为 `target-objective-audit-20260814/visual/screenshots/01-objective-max.png`、`02-objective-1100.png`、`03-objective-1100-inspector.png` 与 `target-objective-audit-20260814/visual/evidence.json`。最大化三列无重叠/document overflow；1100×700 保留 trigger 与 430×700 Drawer，console/page errors 为空。M2/M3 在该 fresh profile 中仅 discovered；34 verified、种包方 `29/5`、terminal `5/16/13`、80 kill atoms/247 damage-event atoms 来自 environment-gated read-only SQLite audit，不是 fresh 三场视觉观察。
- alias/boundary/non-plant/action hardening 由确定性 TDD 支持，截图只证明 M1 数据与布局。本轮没有点击 Round/Replay/Watch/Add，没有启动 CS2/HLAE，也不声称 site A/B/空间、retake/save/trade/KAST/rating 或真实播放/录制。

### 4.14 Heatmap

**CS Demo Manager**

- Match、Player、Team 多层热图，支持不同事件和地图层。

**Vibe CS**

- 当前单场真实 heatmap 已区分 attacker kill 与 victim death，支持 damage/grenade/purchase、T/CT、player、floor 和真实 radar。
- 全局 Player profile 已按 exact Steam64 + map 聚合 producer-valid kills/deaths 坐标；完整有界点集支持 URL-owned `heatmap_map/heatmap_kind`、本地 radar 或稳定等比例相对平面、点选 Inspector 与 exact Round/Replay deep link。缺失或 stale player/evidence projection fail closed；超过 5,000 点时不画 partial heatmap。
- real Major current projection oracle：FalleN Mirage `9/14`、Anubis `18/15`、Inferno `10/15`，非法坐标为 0。`1440×900` 最大化与 `1100×700` Drawer 均保持正方形 radar、无 document 横溢出；Reload 保持 kill filter，Back 恢复全 23 个 Mirage 点。

**Vibe 做得不好的地方**

1. 跨比赛聚合目前只有 Player，没有 Team heatmap。
2. Player 事件表现仍是可核对点分布，不是强度图；缺清晰强度图例、采样/归一化解释和区域聚合。
3. Player 点已有稳定 ID、真实 round/tick、键盘可达选择与 Round/Replay；本轮没有启动 Watch，Player 热图也不提供伪 Watch 动作。
4. 完整点集的 bounds 已固定，筛选不再移动同一世界点；真实 Desktop 最大化和 1100×700 已完成视觉验收。
5. 单场默认“全部”仍会把大量购买、道具、伤害和击杀点叠在一起；Player 默认只有 kill/death，仍缺半径、模糊、透明度、色阶和归一化控制。
6. 单场 `purchase/grenade/damage/kill` 与“楼层 -2…3”仍直接暴露内部键/技术分桶；Player floor 也只显示解析数字，不能冒充地图楼层语义。

### 4.15 2D Replay / Viewer

**CS Demo Manager**

- 目标是“看完整比赛”：连续位置、shots、kill feed、双方血量/护甲/金钱/武器 HUD、回合条和事件 marker。
- 播放层支持暂停、前后回合、倍速和 fullscreen；雷达可调上下层、opacity 和坐标；绘图有画笔/橡皮/粗细/颜色/undo/redo/clear；音频有生成/选择、波形、同步 offset 和 unload。
- 缺 positions 时提供 Generate positions 恢复链，这是 Vibe 的稀疏默认模式不能直接等价替代的能力。

**Vibe CS**

- Demo-scoped 快速 fallback 仍是明确标注的 `event_sparse`；exact producer run + selected round 另有 source-bound `entity_snapshots` operation，不把稀疏帧冒充 dense state。
- exact route 将 completed run、current Analysis、Demo SHA-256/size 与 round 绑定；worker 重新打开 source，取每 16 tick 与 canonical event ticks。每帧必须是同一 verified 10-player roster，含 position/yaw/health/armor/life-state/money/equipment/helmet 与 nullable weapon；Web strict decoder 再次 fail closed。
- 最新真实 M1 R13 产品路径为 1,457 个 exact frames、57 个 positioned events、当前帧 10 人；无插值播放。最大化与 1100×700 均无 document overflow，Inspector 独立滚动。
- 首次 fresh 检查发现出生区十个常驻姓名严重叠压；修复后只在 hover/focus/selected 展开姓名，编号和右侧完整列表保持。第二次发现 1100 toolbar 截断 TEAM A/B；compact toolbar 改为两行后，全部/A/B 均在 723px 区域内可达。accepted files 为 `target-review-metadata-audit-20260814/visual/09-round-replay-max-final.png` 与 `08-round-replay-1100x700-final.png`。

**Vibe 做得不好的地方**

1. selected-round 是每 16 tick + event ticks 的 exact samples，不能回答采样间连续移动、插值轨迹、LOS 或完整阵型演化。
2. weapon 明确 nullable；没有 shots、bullet impact、ammo、完整 inventory 或 audio，不能从缺值填默认事实。
3. health/armor/money/current equipment/helmet HUD 已有，但仍缺专用 kill feed、round strip 与更完整队伍 HUD。
4. 缺 fullscreen、pan/zoom、drawing、audio sync 和多层 radar 调节。
5. `entity_snapshots` 可按真实 tick 间隔 0.5×/1×/2×；只有 `event_sparse` 继续使用证据步进语义，不能混用文案。
6. Evidence 仍内联占据 250px；1100 功能可达但下一步仍应改为 HUD/Evidence drawer，换取更大的空间画布。

**建议架构**

- 保留 `event_sparse` 快速 fallback 与当前 exact-run selected-round cache，两者继续显示不同 fidelity/timing truth。
- 下一纵切把专用 kill feed/round strip 和 HUD/Evidence drawers 接到现有 exact samples，不再建立第二条 parser path。
- drawing/audio/fullscreen/radar-level 分别作为独立 adapter 能力，不把缺失数据混入 current replay artifact。

### 4.16 Highlights

**CSDM 相近能力**

- 通过 player event 自动生成 video sequences，支持 tick timeline、编辑 sequence 和评论提示。

**Vibe CS**

- Highlights 是独立核心 tab，有筛选、多选、Preview、加入 Queue 和 collection/tag-derived grouping。
- canonical Highlight 卡片读取同一 EvidenceAnnotation 记录，显示 open/resolved 数量并打开现有 CRUD drawer；annotation 服务不可用时不会把错误伪装成 0 条。
- fresh M1 第一条 canonical evidence 保存正文 `M1 开局 one-tap：复核交叉火力与首杀节奏`、标签 `major-audit/opening` 后，卡片刷新为 1 待复盘 / 1 复盘注释；完整退出重启后正文与标签精确读回。最大化 Highlights view 1050px、4 列 cards，1100×700 card/action 可见、drawer 430×700，均无 document overflow。

**Vibe 做得不好的地方**

1. Highlight 分类数量多，但缺对规则、confidence 和证据来源的可展开解释。
2. 缺时间线式批量审查；卡片列表在 400+ highlights 时效率低。
3. 缺持久 review 状态，例如 accepted/rejected/needs trim。
4. Highlights 已能读取和写入 canonical annotation，但仍没有 accepted/rejected/needs-trim 状态或团队审阅队列；open/resolved 不能冒充这套工作流。
5. 最大化已把单卡整理为 rank/preview/main/actions 四栏结构，但 457 条证据仍是长距离卡片列表；需要虚拟化 power table/时间轴、快捷审查和可持久的筛选，而不是继续堆叠完整卡片。
6. 当前一次渲染全部 457 张卡，包含大量重复的 full-match reel、相同黑色缩略图、英文标题、SteamID 和 raw tick；信息噪声和 DOM 成本都过高。
7. 本轮 annotation 请求完成过快，只能视觉确认成功 mutation callback 后摘要刷新；close-during-pending 的 stale refresh 抑制只有确定性 TDD，不是人工时序验收。

### 4.16.1 AI Review 与 Cosmetics

- `AI Review` 是 Vibe 独有的证据解释入口，但未配置 provider 时只能呈现阻断态；即使可用，也不能替代确定性 Insights 和原子事件页。
- `Cosmetics` 是制作/视觉资产辅助能力，不是 CSDM 分析 parity 的替代项。它应继续位于次级工具，而不应与 Economy/Heatmap 等证据分析在 More 中保持同等语义权重。
- More 菜单需要按 `高级分析 / AI / 制作辅助` 分组，否则新增能力越多，导航越难预测。

### 4.17 Production / Video Queue

**CS Demo Manager**

- 单场 Video tab 提供 sequence timeline 与大量录制参数。
- 全局 Videos queue 支持 pause/resume、cancel/remove、retry、清理完成/全部，并显示 Pending、Recording、Moving、Converting、Concatenating、Error、Success、sequence 进度和 raw output。

**Vibe CS**

- Queue 支持多个 Demo/highlight、重排、启用、pre/post roll、第一人称 POV、director preview、preflight、execute/cancel。
- Queue 的编辑计划已持久化到本地 WebView storage；真实 Tauri 已验证从 R20 FalleN 4K 加入制作后整页 reload 仍恢复相同片段与选择。
- 执行后的 recording job 持久化到 SQLite；runtime state 暴露 durable active job id，当前 Queue 会优先用它执行 cancel，即使丰富 job 详情尚未 hydration 或暂时读取失败也不会静默 no-op。
- 主机重启不会猜测从任意 capture 点续跑：恢复逻辑先复核 job-scoped staging/publication，能证明成品已发布则补齐 completed；否则将遗留 running 标为 failed、遗留 cancelling 标为 cancelled，并保留失败原因。
- failed/cancelled recording 只有在 durable request IDs、published prefix 与 cursor 精确证明一个 unpublished suffix 且 parent 尚无 child 时才暴露 retry。短期 plan 绑定 parent ID、`updated_at` 与 suffix SHA-256，execute 再验 acknowledgement 后原子创建唯一 durable child；parent、已发布 clips 和 error 不变，拒绝界面确认创建 0 个 child。
- OBS 已退出公开 API、产品录制实现和界面；录制代码使用应用托管的 HLAE 离线帧/WAV 与 Windows Media Foundation H.264/AAC，Output Library 单独管理成品，但真实 CS2/HLAE 成片门禁尚未通过。
- Queue 零项在 1100×700 已只显示一个“打开资料库”CTA；无意义的零值 stats、空列表布局和固定操作 dock 不再占据首屏。
- Production 概览已移除文章式宽度上限，并读取最近四条持久 Activity；最大化与流程并列，1100×700 堆叠到流程下方。current-build 只显示真实 completed M1 analysis，没有生成预览数据。
- failed/cancelled 的持久 Steam download Activity 始终可回 Match History；只有 latest eligible、match 未下载、当前 Steam ID/32 位 hexadecimal key 语法有效且 owner 相同时才提供 retry。runtime 在持久化前再次校验，之后才创建新 queued job并保留旧 job/error/bytes。该分支仅有 TDD/runtime 验证，本轮没有实机制造失败下载，也不证明 key 在线有效。
- recording suffix retry 同样只有 domain/storage/application/runtime/Web TDD；最新 fresh Activity 的 `recording + failed` 为 0 行，没有可点击 action，本轮未伪造任务、未启动 CS2/HLAE，也未执行 retry。

**Vibe 做得不好的地方**

1. WebView local storage 仍只负责“待执行编辑计划”；SQLite job 是单机 host-owned 运行事实，没有跨设备同步，也没有可审计的完整 transition log。
2. 没有 pause/resume 和逐阶段日志；现有 recording retry 只重放可证明的 unpublished suffix，启动恢复的安全语义仍是验证发布或终结歧义 job，不是从中间 capture tick 续跑。
3. 估时主要来自片段时长，不是包含启动、录制和后处理的可信 ETA。
4. Queue、Studio、Montage、Editor、Outputs 分成多个上下文路由，但缺一条持续可见的项目/任务 breadcrumb。
5. 最近持久 Activity 已补入 Production；仍缺 readiness、失败/阻断聚合与当前项目上下文，最多四条 preview 也不能替代完整 Activity Center。
6. 旧的空队列黑色固定栏问题已随 compact empty state 移除；非空队列的风险提示、preflight 与执行 CTA 仍需用真实 HLAE job 复核，不能由空态截图推断通过。
7. “恢复出的 active id 在 hydration 前仍可取消”当前只有 focused 测试；尚未通过真实 Tauri + HLAE active job 人工验收。

### 4.18 Studio / Montage / Editor

这是 Vibe 的独有能力，不应以 CSDM 为上限。

**优势**

- Montage 可自动组装真实 recorded clips。
- Editor 有多轨、trim、speed、transition、keyframe、snap、marker、undo/redo、proxy、portable package。
- BGM 使用本地音频分析，beat proposal 在确认后事务性写入。

**仍需改进**

1. export output 已能按精确 `project_id` 深链回 Editor；如果 source project 已删除，Editor 显式显示所请求 ID 不可用并打开空白工程，不会静默选中另一个项目。该 fail-closed 路径已在真实 Tauri 1100×700 验证；分析证据、recorded clip、editor clip 三种 ID 的完整 lineage 仍缺。
2. 从 Highlight 进入 Queue、录制完成进入 Studio、再进入 Editor 的跨页状态容易丢上下文。
3. Agent 已可把 Demo highlight 直接提交为受管采集与 MP4 编码任务；Demo 本身仍不能被时间线假装成已有视频，只有已发布的 managed clip 才能进入后续剪辑。
4. Editor 的复杂能力没有统一快捷键/帮助和新手渐进模式。
5. Studio 在零素材/零工程时仍提供“开始编排/打开编辑器”，却没有唯一素材导入路径；动作先于前置条件。
6. Editor 的该 P0 已闭合：最大化仍保留 Media/Preview/Inspector 三栏；1100×700 有常驻“属性”触发器并复用同一个面板作为 `role=dialog`、`aria-modal=true` 的 drawer。真实键盘检查确认初始焦点在关闭按钮、Shift+Tab 不逃逸、Esc 关闭并把焦点还给触发器，document 无横向溢出。尚未验收的是有真实素材时的预览/时间线编辑密度，而不是属性能力丢失。

### 4.19 Outputs / 交付

**Vibe 优势**

- 同时管理 recording/export，支持 availability、job status、搜索、rename、reveal、记录删除、受管文件删除、批量和 staged cleanup。
- 对缺失/unsafe 文件有明确状态，而不是只显示路径。

**Vibe 的不足**

- 缺媒体缩略图、时长/分辨率/codec 的统一详情面板。
- export 行已提供 source project 深链；仍缺 proposal、recorded clips 和 evidence 的完整 lineage。若精确 source project 已删除，Editor 会 fail closed，不回退到任意首个项目。
- 旧 HLAE bundle 不是普通视频输出，仅作为历史兼容 handoff；当前 Agent 视频任务的成功结果必须是经过验证并发布的 MP4。
- true-zero 已隐藏筛选、批量与分页外壳，显示紧凑空态、直接进入 Production 的下一步，并保留独立 staged-cleanup recovery 动作；该动作不依赖已有 output 行。
- current-build 的最大化与 1100×700 空态均无 document 横向溢出；本轮另以非零 export 的 source-project 动作进入 Editor，并在删除 source 后于 1100×700 验证 fail-closed notice，见 `target/product-audit-20260813-player-directory/08-editor-missing-lineage-1100x700.png`。这不证明非零表格密度、metadata、rename/reveal/delete 或 cleanup 已通过。

### 4.20 比赛聊天、评论、标签与人工 Review

**CS Demo Manager**

- Match Chat 展示和导出 Demo 内聊天。
- Comment 可绑定 Demo/Match、Player、Round，并在 Video timeline 上提示。
- Tags 用于表格过滤和组织。

**Vibe CS**

- Library 的 Demo metadata、Player profile 与 Round Inspector 现在共享一套 Review Tag catalog。Demo 绑定 catalog identity；Player 绑定 canonical Steam64；Round 绑定 `demo_id/source_sha256/round`，读写均验证 current completed producer、fingerprint 与唯一 round。
- Player 与 Round 复用同一 strict abortable editor；最大化 Inspector 和 1100×700 Drawer/独立滚动都保留完整编辑能力。same-ID content replacement 不把旧 Round 评论带到新 bytes，Analysis 重建也不删除 Player 评论。
- Evidence Search 已有 canonical evidence annotation：持久记录绑定 `demo_id/evidence_id/round/tick`，locator 不可通过编辑变更，正文与自由标签可创建和编辑，review state 为 open/resolved；Agent thread、AI Review 和 Demo remark 仍是不同信息。
- Highlights 的 canonical cards 已显示同一记录的 open/resolved summary 并复用 Evidence Search CRUD drawer；这不增加 accepted/rejected 等另一套 review state。
- Evidence Annotation 是 Vibe 自有的精确证据审阅扩展，不是 CS Demo Manager 已有功能，也不能作为其 Comment/Tags 对齐完成的替代证据。

**当前边界**

1. Demo/Player/Round 的通用 Comment/Tags 已落；仍没有原始比赛 chat 读取/导出、Round comment→Video timeline、跨 subject tag filter/批量、作者/权限。
2. Annotation 创建会校验 exact canonical evidence locator，后端支持分页 CRUD；UI 当前提供创建、正文/标签就地编辑、resolve/reopen 与删除。
3. 自由标签随 annotation 保存，服务端支持 `q/tag/state/demo/evidence` 过滤且已有自动化门禁；全局 annotation index UI 的 1100×700 空态与 `q/tag/state/page` URL 契约已过。最新 workflow 库已有一条 annotation，但本轮没有打开 global index，因此非空/多页 index 产品门禁以及全局 tag taxonomy、作者和权限模型仍缺。
4. Evidence Annotation 仍只由 evidence/highlight consumers 读取；它不自动出现在通用 Comment/Tags 面板，也不冒充 CSDM 模型。
5. 当前 `app.vibecs.review-metadata-audit` fresh gate 在真实 M1 保存 Demo tag、FalleN 评论/tag 与 R13 评论/tag；完整应用重启后精确读回。SQLite 只读核对 R13 source SHA 与 current Demo/producer 一致。Player 最大化/1100 Drawer 与 Round 最大化/1100 Inspector 均无 document overflow；首次 Round Inspector 裁剪由 TDD 修复后重新构建并复验。

### 4.21 Teams / Ban

**Teams**

- CSDM 有 team overview、maps、heatmap、performance、matches。
- Vibe 已有单场 roster-verified Team Round 控制，但没有持久 Team entity。前者不能代替跨比赛 roster、maps、heatmap、performance 或 matches；若要做教练/战术分析，持久 Team continuity 仍是 P1。

**Ban**

- CSDM 有玩家 ban indicator 与统计图。
- Vibe 无。职业比赛剪辑不一定需要，但 Valve MM 用户研究会需要。

### 4.22 Settings

**CS Demo Manager**

- 13 个类别覆盖 UI、folders、tags、maps、download、playback、analyze、video、cameras、ban、integrations、database、about。
- Maps 可配置 radar/lower radar/thumbnail、origin/scale/Z threshold；Analyze 暴露 positions 和并发数；Video/Cameras 管理 HLAE/FFmpeg 与地图机位；Database 提供 V2 import、optimize、清 missing/cache、delete positions、reset/disconnect。
- 粒度完整，但普通偏好、专家参数和破坏性维护处在同一层级，侧栏长、专业术语多、依赖 PostgreSQL/FFmpeg/HLAE 等外部组件。

**Vibe CS**

- 6 类覆盖 General、Paths、Steam、Video、Analysis、Recording。
- 额外提供 storage meter、只面向 CS2 的用户依赖检查、AI provider test、受管 HLAE 状态、recovery、diagnostics 和安全 secret 状态。

**Vibe 做得不好的地方**

1. 六个分类内部仍然很长，General 同时放 appearance、storage、updates 和 directories。
2. 没有设置内搜索和 URL/deep link，定位某个高级选项成本高。
3. `https://updates.example.com/manifest.json` 作为占位符过于像真实默认服务，容易被误认成已配置。
4. 缺 Tag、Map、Download provider、Analyze concurrency、Database maintenance UI。
5. 中英文、产品文案和底层实现名（HLAE、Media Foundation、manifest）仍有混排，对普通用户负担较大。
6. 最大化时左侧分类与约 1,000px 内容列仍形成窄岛；这适合表单阅读，但应把诊断、依赖 readiness 和危险维护动作做成独立宽屏工作区，而不是继续塞进纵向表单。
7. Paths 页没有为每一路径持续显示“已验证 / 不存在 / 自动发现为空”的即时结果；只有输入框并不足以证明下游 Replay/Recording/HLAE 可用。

### 4.23 错误、空状态与恢复

**CS Demo Manager 的优势**

- Analyses logs 和错误码让失败可诊断。

**Vibe 的优势**

- 大多数界面有 loading/empty/error/disabled reason，缺数据时 fail closed。
- 文件、缓存、输出、受管 HLAE 和配置有 Recovery/Diagnostics。

**Vibe 的不足**

- 失败信息分散在当前页 Notice；离开页面后很难追溯。
- 某些 CTA 在缺依赖时直接 disabled，用户只能通过 title 或旁边说明猜原因。
- 没有统一操作历史和任务日志。

**Recovery Center** 是 Vibe 独有且值得保留的界面：它把配置、缓存、存储、sidecar、受管 HLAE 和脱敏诊断集中起来，比让用户直接操作数据库更安全。但目前入口藏在 Settings 深处，也没有与具体失败 Notice 自动关联；每个可恢复错误都应提供带来源上下文的“打开 Recovery”深链。

## 5. 视觉与可访问性差异

| 维度 | CS Demo Manager | Vibe CS | 判断 |
|---|---|---|---|
| 密度 | 极高，适合专家扫表 | 默认较松，逐层展开 | 保留 Vibe 默认；增加 Power table，而不是全局变密。 |
| 导航 | icon-only、入口多 | text-first、入口少，Evidence Search 与 Activity 常驻 | Vibe 更易懂；下一项是给现有 Activity 补全局状态 badge，而不是再增加一个搜索入口。 |
| 标签数量 | Match 约 11 个并列标签 | 5 个核心 + More | Vibe 响应式更好；More 内需要二级结构。 |
| 主题 | 深色为主，细线与小字多 | 浅色/深色/系统，卡片层级明确 | Vibe 更友好；需减少卡片嵌套和英文 eyebrow。 |
| 表格 | 超宽、可配置、批量强 | 卡片优先，列表能力弱 | 两种模式都要，不应二选一。 |
| 最大化利用率 | 数据表几乎填满，但容易横向过载 | Overview/Replay/Heatmap/Editor 能铺开；Library 已有 power table/Inspector，Players 已有 persistent projection + profile/history/compare Inspector，Team Economy 已有矩阵/证据/Inspector，Production 已补持久 Activity preview，Outputs 已收敛 true-zero；Players 多页/大库与 Outputs 非零详情仍缺完整门禁 | 不要全局放大卡片；资料页深化表格/Inspector，画布页才应占满。 |
| 状态 | queue badge、analysis logs 明确 | in-context Notice、真实 disabled reason、独立 Activity Center、exact Analysis run events/cancel/retry | Vibe 仍需要全局 badge、Analysis heartbeat/lease 与 download/export/recording 更完整的持久日志。 |
| 键盘 | 快捷键覆盖较广且有文档 | Ctrl+K 为主，局部快捷键分散 | Vibe 需要快捷键面板和 focus/reader 回归。 |
| 响应式 | 桌面优先 | Analysis/Replay/Editor 的 1100×700 与 maximized 已验证；Library/Queue/Players single+pair Drawer/Team Round/Team Economy/Objective Review/Activity/Production/Outputs 也无 document 横溢出 | Team Economy 初次 overlap 与旧 Player 最大化 Inspector overflow 都已修复；Player gate 另验证 600×700 single/pair Drawer 与 URL Reload/Back，Objective gate 验证 430×700 evidence Drawer。200% 缩放、两种 retry 和真实素材 Editor 仍是独立门禁。 |
| 可访问名称 | 多依赖 tooltip/icon | 大部分按钮有文字或 aria-label | Vibe 更好，但仍需 screen reader 与系统标题栏实测。 |
| 色彩语义 | team/result 常依赖颜色 | 多数有文字和 badge | 继续确保 round flow/heatmap 不只靠颜色。 |

截图只能确认视觉层级、裁切和可见状态，不能证明完整 WCAG 合规。键盘顺序、屏幕阅读器输出、缩放 200%、高对比模式、减少动画和 Windows 自绘标题栏的系统行为需要单独实测。

用户所说的“最大化下界面空”并非一个统一 CSS 缺陷：

- Overview 原先的大空卡已经被真实 scoreboard/evidence 填充，本轮最大化截图不再空。
- Library 已把宽屏空白转换为 power table + 逐条 Inspector/drawer，并加入服务端 query window、当前 URL 列选择和 explicit batch Analysis selection；Players 也已把目录移到 persistent SQLite projection，以 coverage、truthful nullable match date、profile/history、compare 与跨比赛地图热图承载真实数据。M1/M2/M3 三条 exact local rows、FalleN/NiKo aggregate、heatmap point oracle、双尺寸 Drawer 与 URL Reload/Back 已过；两者仍缺真实多页、大库性能、趋势图与 Team heatmap 门禁。
- Team Economy 最大化把空间交给 2×2 matrix、50 行 evidence 和 Inspector；1100×700 初次 overlap 被 agent-browser 暴露，修复后以单一纵向滚动保留全部能力，未用 `display:none` 删除证据。
- Objective Review 最大化把空间交给 round rail、atomic event stream 与 Inspector；1100×700 隐藏 desktop Inspector 但保留 trigger，并用同一 430px Drawer 呈现证据和 footer actions，未删除能力。
- Queue 零项已收敛成唯一下一步；Production 已补最近持久 Activity，Outputs true-zero 已给 Production 与 staged-cleanup recovery。Production 的 readiness/失败聚合和 Outputs 非零结果仍待深化。
- Replay/Heatmap/Editor 属于画布型页面，扩大地图或时间线是合理的；重点是控制、证据和画布对齐，而不是塞更多卡片。

本轮还观察到以下可访问性风险：

- 多个事件的动作都只叫“加入”，读屏和语音控制无法区分目标。
- Editor 存在无名称的 generic clickable，回合网格主要依赖数字与颜色。
- 单场 Radar/Heatmap 仍没有完整等价的文本化空间证据列表；Player heatmap 只有当前选中点的 exact Inspector，尚非全点文本表。
- Team A/B、T/CT、英文 event key、英文 item id 和中文业务文案混排，增加理解成本。
- Recording Queue 的深色固定栏在浅色主题中出现低对比文字，需要主题级 contrast 回归。

## 6. Vibe CS 最需要优先修复的项目

### P1 — 影响核心产品结果

1. **完成 Evidence Search 外部动作与恢复门禁**

   持久 projection、组合查询和 canonical evidence deep link 已落；真实 M1/M2/M3 共 11,548 条、`scan_complete=true`、唯一 FalleN R20 命中、URL、Round 与 Replay 已过。下一门禁是实跑 Watch、应用重启重建，再扩保存查询/批量操作。

2. **高级比赛分析页**

   保持 5 个核心标签；Player atomic、Weapons、Duels、Utility、Openings、roster-verified Team Round、Team Economy、Man Advantage 与 Objective Review 已落。Objective fresh M1 的 8/8、`7/1`、`1/3/4`、19/55 与双尺寸已过，三场 34-round 另由只读 oracle 支持；raw site、post-plant atoms 不被提升为 site/spatial、retake/save/trade/KAST/rating。Team Economy 的真实 M1 四格 purchase/cost/item oracle、top-3+remainder、50 行详情已过最大化；1100 初次 overlap 经修复/TDD 后由 agent-browser 复验 GREEN。继续补 equipment value/economy type/advantage、权威 site/spatial 语义与 Utility 双尺寸，不复制不可靠指标。

3. **深化 Activity Center**

   已聚合 analysis/download/record/export 的权威持久事实和真实动作，并在 SQLite transaction 内提供 summary、search/kind/state、filtered total 与 stable page；exact kind/UUID endpoint 从单一权威来源同 transaction 计算 cancel/retry/result capability。URL selection、strict binding、observer guard 与 Production deep link 已落。真实 M3 startup interrupted→distinct retry 与最新 M2/M3 validation/parser-running cancel、worker/artifact cleanup、cancelled→distinct retry、restart/filter/双尺寸均已过；XState v5 只管理 renderer request/observation。下一步是真实多页/大库性能、其他 kind mutation、Steam/recording failure-retry、heartbeat/lease、concurrent retry、永久 DB corruption quarantine 与通用 pause/resume。Agent mutation 仍需单独确定持久来源。

4. **持久后台制作任务**

   Queue 编辑计划、recording transitions、exact artifact lease、DB commit acknowledgement、启动恢复与 proven unpublished-suffix durable child retry 已落；恢复出的 active id 在详情 hydration 前也会保持 cancel 可用。下一步是 pause/resume、日志、真实 disk/ETA，以及真实 HLAE active-cancel/retry/成片验收。

5. **CSDM Comment/Tags 与 Vibe Evidence Review 分轨**

   CSDM 对齐项已落 Demo/Player/Round Comment/Tags：共享 tag catalog、Steam64 Player identity、current-source Round identity、真实 M1 save/restart/SQLite lineage 和双尺寸已过。下一步是跨 subject filter/批量、Match Chat、Round→Video timeline 与作者/权限。Evidence Search 的 exact `demo/evidence/round/tick` annotation、open/resolved、Highlights 摘要/CRUD 与 global index 是 Vibe 自有工作流；后续非空/多页 index 与更多 evidence consumer 不能计入 CSDM parity。

6. **逐玩家广度与队伍实体**

   Analysis completion 同事务维护 persistent Player-match projection；SQLite server filter → stable sort → count → paginate、coverage 与 exact absence semantics 已落，不再运行时扫描最多 1,000 个 Analysis 文档。最多两个 URL-owned ID 的 ordered compare、single/pair Drawer、Reload/Back 已过；profile 另以 exact involvement query 显示 first-10 persistent evidence，并以 producer-valid role coordinates 提供 exact map-scoped cross-match kill/death heatmap。current FalleN 为 projection `3/3`、三条比赛日期明确不可用的 local rows、`indexed_demos=3`，三图 heatmap 为 Mirage `9/14`、Anubis `18/15`、Inferno `10/15`；双尺寸与筛选 Reload/Back 已过。继续补真实目录多页/大库、趋势/rank、Team continuity、Team maps/matches/heatmap。

7. **2D Viewer 双保真模式**

   event-sparse 保持快速默认；selected round 可按需生成连续轨迹，并补 shots、HUD、kill feed、fullscreen、audio 和 drawing。

8. **Library 大数据能力**

   Power table + 逐条 Inspector/drawer、SQLite 侧 search/filter/stable-sort/page、真实 URL 列选择和最多 12 个 explicit IDs 的 batch Analysis selection 已落；fresh M2+M3 选择在排序后保留，双尺寸表内横滚/sticky actions 已过。只有 3 条数据，继续补真实跨页门禁、跨页 tags/comments/reveal/watch/export、已有 run event history 的 Library 内嵌入口、ready-only saved view，以及真实大库性能。

### P2 — 影响效率与理解

1. Previous/Next match 与完整快捷键帮助。
2. Settings 搜索、deep link 和普通/高级分层。
3. Output/Project/Clip/Evidence lineage。
4. Heatmap 强度图例、区域聚合、Team 聚合与跨比赛趋势；Player 点选证据和跨比赛 kill/death 聚合已落。
5. 多平台下载与 Download All。
6. 统一中文文案，减少装饰性英文 eyebrow。
7. 更完整的媒体详情、缩略图和编码信息。

## 7. 不应照搬 CS Demo Manager 的部分

1. 60px icon-only 左栏。
2. 默认超宽表格和缩写列。
3. Match 页十二个同级标签全部常驻。
4. 低对比细线、小字号、深色密集布局。
5. 以 raw tick、SteamID 和文件路径作为第一层信息。
6. 把所有设置一次铺开，不区分普通与高级用户。
7. 把估算 rating 或不完整数据表现为确定事实。
8. 仅在进程内保存的队列状态；Vibe 如果实现 parity，应直接做到可恢复。

## 8. 推荐目标信息架构

```text
总览
AI 协作
比赛
  ├─ Library（全部生命周期）
  ├─ Activity（分析 / 下载）
  ├─ Evidence Search
  ├─ Players
  └─ Teams
选中比赛
  ├─ Overview
  ├─ Rounds
  ├─ Players
  ├─ Replay
  ├─ Highlights
  └─ Advanced
      ├─ Weapons
      ├─ Duels
      ├─ Grenades
      ├─ Economy
      ├─ Heatmap
      ├─ AI Review
      └─ Cosmetics
制作
  ├─ Queue / Activity
  ├─ Studio
  ├─ Montage
  └─ Editor
交付
设置 / Recovery
```

这套结构保留 Vibe 的任务流，同时让 CSDM 的分析深度有稳定归属，不需要回退到一个超宽、全入口常驻的工具面板。

## 9. 验收标准

只有满足以下条件，才能说某一项达到功能 parity：

- 使用真实 Demo，而不是 synthetic fixture。
- 用户能从可见入口进入。
- 数据来自持久分析或受管媒体，不由 UI 猜测。
- loading、empty、error、cancel/retry 状态完整。
- 结果有稳定 URL 或 evidence ID，可从 Agent、Round、Replay、Editor 互相到达。
- 1100×700 与最大化无横向裁切。
- 关键动作可键盘操作且有可访问名称。
- 重启后需要持久化的状态确实恢复。
- 与 CSDM 同名但语义不同的能力有明确说明，例如 sparse replay、AI chat、organization score。

## 10. 证据与来源

### CS Demo Manager

- 官方仓库：<https://github.com/akiver/cs-demo-manager>
- Demos analysis：<https://cs-demo-manager.com/docs/guides/demos-analysis>
- Downloads：<https://cs-demo-manager.com/docs/guides/downloads>
- 2D Viewer：<https://cs-demo-manager.com/docs/guides/2d-viewer>
- Video：<https://cs-demo-manager.com/docs/guides/video>
- Comments：<https://cs-demo-manager.com/docs/guides/comments>
- Shortcuts：<https://cs-demo-manager.com/docs/guides/shortcuts>
- 当前 UI 路由：`E:/Temp/cs-demo-manager/src/ui/router.tsx`
- Match tabs：`E:/Temp/cs-demo-manager/src/ui/match/match-tabs.tsx`

### Vibe CS

- 路由：[`apps/web/src/app/router.tsx`](../apps/web/src/app/router.tsx)
- 全局壳层：[`apps/web/src/app/AppShell.tsx`](../apps/web/src/app/AppShell.tsx)
- Library：[`apps/web/src/features/library/LibraryPage.tsx`](../apps/web/src/features/library/LibraryPage.tsx)
- Library query：[`apps/web/src/features/library/libraryQuery.ts`](../apps/web/src/features/library/libraryQuery.ts)
- Library selection：[`apps/web/src/features/library/librarySelection.ts`](../apps/web/src/features/library/librarySelection.ts)、[`apps/web/src/features/library/LibrarySelectionBar.tsx`](../apps/web/src/features/library/LibrarySelectionBar.tsx)
- Activity：[`apps/web/src/features/activity/ActivityPage.tsx`](../apps/web/src/features/activity/ActivityPage.tsx)
- Activity exact contract/observer：[`apps/web/src/shared/desktop/activityContract.ts`](../apps/web/src/shared/desktop/activityContract.ts)、[`apps/web/src/features/activity/activityObservation.ts`](../apps/web/src/features/activity/activityObservation.ts)、[`crates/application/src/routes/activity.rs`](../crates/application/src/routes/activity.rs)
- Activity storage query：[`crates/storage/src/repository/activity.rs`](../crates/storage/src/repository/activity.rs)
- Analysis Run domain/API/storage：[`crates/domain/src/analysis_run.rs`](../crates/domain/src/analysis_run.rs)、[`crates/application/src/routes/analysis_runs.rs`](../crates/application/src/routes/analysis_runs.rs)、[`crates/storage/src/repository/analysis_runs.rs`](../crates/storage/src/repository/analysis_runs.rs)
- Analysis Run Inspector：[`apps/web/src/features/activity/AnalysisRunInspector.tsx`](../apps/web/src/features/activity/AnalysisRunInspector.tsx)
- Evidence Search：[`apps/web/src/features/evidence-search/EvidenceSearchPage.tsx`](../apps/web/src/features/evidence-search/EvidenceSearchPage.tsx)
- Evidence Annotation：[`apps/web/src/features/evidence-search/EvidenceAnnotationPanel.tsx`](../apps/web/src/features/evidence-search/EvidenceAnnotationPanel.tsx)
- Highlight annotation：[`apps/web/src/features/analysis/HighlightAnnotationReviewControl.tsx`](../apps/web/src/features/analysis/HighlightAnnotationReviewControl.tsx)、[`apps/web/src/features/analysis/highlightAnnotationReview.ts`](../apps/web/src/features/analysis/highlightAnnotationReview.ts)
- CSDM Comment/Tags domain/storage/API：[`crates/domain/src/review_metadata.rs`](../crates/domain/src/review_metadata.rs)、[`crates/storage/src/repository/review_metadata.rs`](../crates/storage/src/repository/review_metadata.rs)、[`crates/application/src/routes/demos.rs`](../crates/application/src/routes/demos.rs)、[`crates/application/src/routes/players.rs`](../crates/application/src/routes/players.rs)
- Player/Round Comment/Tags editor：[`apps/web/src/features/review-metadata/ReviewMetadataPanel.tsx`](../apps/web/src/features/review-metadata/ReviewMetadataPanel.tsx)、[`apps/web/src/shared/desktop/reviewMetadataContract.ts`](../apps/web/src/shared/desktop/reviewMetadataContract.ts)
- Analysis：[`apps/web/src/features/analysis/AnalysisPage.tsx`](../apps/web/src/features/analysis/AnalysisPage.tsx)
- Player Atomic Evidence：[`apps/web/src/features/analysis/PlayerEvidenceWorkspace.tsx`](../apps/web/src/features/analysis/PlayerEvidenceWorkspace.tsx)
- Weapons：[`apps/web/src/features/analysis/WeaponAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/WeaponAnalysisWorkspace.tsx)
- Duels：[`apps/web/src/features/analysis/DuelAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/DuelAnalysisWorkspace.tsx)
- Openings：[`apps/web/src/features/analysis/OpeningDuelAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/OpeningDuelAnalysisWorkspace.tsx)
- Team Round：[`apps/web/src/features/analysis/TeamRoundAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/TeamRoundAnalysisWorkspace.tsx)
- Team Economy：[`apps/web/src/features/analysis/TeamEconomyAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/TeamEconomyAnalysisWorkspace.tsx)、[`apps/web/src/features/analysis/teamEconomyWorkspace.ts`](../apps/web/src/features/analysis/teamEconomyWorkspace.ts)
- Man Advantage：[`apps/web/src/features/analysis/ManAdvantageAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/ManAdvantageAnalysisWorkspace.tsx)、[`apps/web/src/features/analysis/manAdvantageWorkspace.ts`](../apps/web/src/features/analysis/manAdvantageWorkspace.ts)
- Objective Review：[`apps/web/src/features/analysis/ObjectiveReviewAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/ObjectiveReviewAnalysisWorkspace.tsx)、[`apps/web/src/features/analysis/objectiveReviewWorkspace.ts`](../apps/web/src/features/analysis/objectiveReviewWorkspace.ts)、[`apps/web/src/features/analysis/objectiveReviewEvidenceActions.ts`](../apps/web/src/features/analysis/objectiveReviewEvidenceActions.ts)、[`apps/web/src/features/analysis/objectiveReviewMajorOracle.audit.test.ts`](../apps/web/src/features/analysis/objectiveReviewMajorOracle.audit.test.ts)
- Utility：[`apps/web/src/features/analysis/UtilityAnalysisWorkspace.tsx`](../apps/web/src/features/analysis/UtilityAnalysisWorkspace.tsx)
- Players：[`apps/web/src/features/players/PlayersPage.tsx`](../apps/web/src/features/players/PlayersPage.tsx)、[`apps/web/src/features/players/PlayerViews.tsx`](../apps/web/src/features/players/PlayerViews.tsx)
- Player current response/URL contracts：[`apps/web/src/shared/desktop/playerContract.ts`](../apps/web/src/shared/desktop/playerContract.ts)、[`apps/web/src/features/players/playerDirectoryQuery.ts`](../apps/web/src/features/players/playerDirectoryQuery.ts)、[`crates/application/src/routes/players.rs`](../crates/application/src/routes/players.rs)
- Player persistent projection：[`crates/storage/src/repository/players.rs`](../crates/storage/src/repository/players.rs)、[`crates/storage/src/schema.rs`](../crates/storage/src/schema.rs)、[`crates/storage/src/repository/analysis_runs.rs`](../crates/storage/src/repository/analysis_runs.rs)
- Player cross-match evidence：[`apps/web/src/features/players/PlayerViews.tsx`](../apps/web/src/features/players/PlayerViews.tsx)
- Player cross-match heatmap：[`apps/web/src/features/players/PlayerHeatmapWorkspace.tsx`](../apps/web/src/features/players/PlayerHeatmapWorkspace.tsx)、[`crates/storage/src/repository/players.rs`](../crates/storage/src/repository/players.rs)、[`crates/application/src/routes/players.rs`](../crates/application/src/routes/players.rs)
- Steam content/download/date integrity：[`crates/runtime/src/integration.rs`](../crates/runtime/src/integration.rs)、[`crates/storage/src/repository.rs`](../crates/storage/src/repository.rs)
- Queue：[`apps/web/src/features/queue/QueuePage.tsx`](../apps/web/src/features/queue/QueuePage.tsx)
- Queue state：[`apps/web/src/features/queue/queueStore.ts`](../apps/web/src/features/queue/queueStore.ts)
- Recording retry：[`crates/application/src/routes/recording.rs`](../crates/application/src/routes/recording.rs)、[`crates/storage/src/repository.rs`](../crates/storage/src/repository.rs)
- Production：[`apps/web/src/features/production/ProductionPage.tsx`](../apps/web/src/features/production/ProductionPage.tsx)
- Editor：[`apps/web/src/features/editor/EditorPage.tsx`](../apps/web/src/features/editor/EditorPage.tsx)
- Outputs：[`apps/web/src/features/outputs/OutputsPage.tsx`](../apps/web/src/features/outputs/OutputsPage.tsx)
- Settings：[`apps/web/src/features/settings/SettingsPage.tsx`](../apps/web/src/features/settings/SettingsPage.tsx)
- 当前可执行能力：[`docs/FEATURES.md`](FEATURES.md)
- 真实数据 TODO/验收台账：`REAL_DATA_TEST_TRACKER.local.md`（本地忽略，不进入 Git）

### 本轮视觉证据

本轮最新 Player heatmap accepted set 为 `target-currentaudit-next/player-heatmap-ba06e65-max.png` 与 `player-heatmap-ba06e65-1100.png`，来自 exact feature commit `ba06e65` / EXE SHA-256 `c16d49785b7eec8fd9292fd8ed0ce31393d2c4a48038b5c43acec82e6a8e51e5` / identifier `app.vibecs.playerheatmap-audit`。该 current-schema profile 从真实 Major 的已完成 Analysis 文档重建 projection，但不是 fresh parser flow。上一组 Objective accepted set 位于 `target-objective-audit-20260814/visual/screenshots/`：`01-objective-max.png`、`02-objective-1100.png` 与 `03-objective-1100-inspector.png`，结构化证据为 `target-objective-audit-20260814/visual/evidence.json`，来自 exact HEAD `fbc9c6a2c80fb44099bb62eec6b7e7b322afb58d` / tree `ef344b8d699c2088f66ff0db2c3f77066437f31b` / EXE SHA-256 `ab3a18edd0993e2d8f1920dea40f9e30f32cf1b9582e01bf5e71c2f82a4f7c29` / identifier `app.vibecs.objective-audit`；worker SHA-256 为 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`。Player projection set 位于 `target-playerprojection-audit-20260814/visual/screenshots/`，来自 exact HEAD `1f7397ec857dc592d4e8525fc9ac4bf299d34db7` / EXE SHA-256 `792eca8491d4ae36dfbfcc5ff3c9fed322edd1d72e58e0e7dc1abb85e1bfad01` / identifier `app.vibecs.playerprojection-audit`。这些本地审计目录不进入 Git，不可把不同 executable/profile 的截图混写成同一流程。

Comment/Tags accepted set 位于 `target-review-metadata-audit-20260814/visual/`：`01-player-review-max.png`、`02-round-review-max.png`、`03-player-review-1100x700.png`、`04-round-review-1100x700.png`。它来自基于 HEAD `568d8443f34c7d817439ba6082f9ab9d38c46ce8` 的 dirty source、identifier `app.vibecs.review-metadata-audit`、EXE SHA-256 `583bfc61e29b35f03c145b5bd7d221ca24d4d94ef06d859fd069c055f68f096f` 与 worker SHA-256 `c07438df28a19cb45efc4cb92bca8a84ce45c248988d4fa7ab6198969849a472`。真实 M1 Player/R13 写入、完整应用重启、SQLite source lineage 与双尺寸已过；M2/M3 只 discovered。该 set 证明的是 CSDM-style Comment/Tags，不是 Evidence Annotation parity。

## 11. 审计限制

- 本次 CSDM 基线以 v3.20.1 当前源码、官方文档和官方界面截图为准；没有使用用户真实数据库完整跑一遍所有页面，因此 CSDM 的空状态、异常状态和部分数据密度只能结合源码判断。
- Vibe 使用真实 Major M1 验证当前比赛、回合、Player/Weapons/Duels 原子证据、经济、热图和 Replay；M1/M2/M3 均已进入产品索引并完成 Evidence Search multi-match 实测。Windows Media Foundation 的真实 synthetic H.264/AAC write/readback smoke 已过，但真实 CS2+受管 HLAE 成片仍是发布门禁，不能由 isolated codec smoke 代替。
- fresh DB 只有 3 条 Library 记录；Library 跨页/大库性能仍未覆盖。Player heatmap 使用 current schema + 真实 Major 已完成 Analysis 文档重建 projection，不是 fresh parser flow，也不证明 5,000 点边界附近性能。Objective fresh gate 只分析 M1，三场 34-round oracle 不是 fresh visual。Activity 已覆盖 completed、exact filter/reload、startup interruption→retry、validation/parser-running cancel、cancelled→distinct retry、restart/filter 与双尺寸，但仍不能证明多页/性能、concurrent retry或其他 kind mutation；`recording + failed` 是空态，因此 Steam/recording retry 均未跑。Watch、CS2、HLAE、录制、真实 Steam 下载和导出 mutation 均未在最新检查中触发。
- Comment/Tags fresh gate 只证明真实 M1 的单 Demo tag、单 Player 与单 Round save/restart/readback、current-source lineage 和双尺寸；没有证明跨 subject filter、批量赋值、Match Chat、Round→Video timeline、作者/权限或多用户并发编辑。
- durable Analysis Run 的 completed、startup `interrupted`→distinct retry、validation/parser-running cancel 与 cancelled→distinct retry 已在 fresh identifier/DB、同源 desktop/sidecar 与真实 Major 上完成产品验收；旧 run 没有被改写，M3 cancel 后 worker/task artifacts 归零且 result 为 0。仍没有 heartbeat/lease；没有覆盖 concurrent retry、hard-crash sidecar/process artifact cleanup、其他 job cancel 或永久数据库损坏 quarantine，也没有消除 source-path pre/post fingerprint 的窄 physical-file TOCTOU。永久 DB health failure 可能停在 active/no-owner fail-closed boundary，不能写成可信 cancelled/failed terminal。
- 初次 current desktop + 旧 sidecar 因 response 缺少 `status` 被 fail-closed 拒绝；重建同源 sidecar 后真实 M1 分析成功。该结果证明 exact current contract 生效，不构成旧响应兼容需求。
- 默认 identifier 下的旧实验数据库被 exact current schema 拒绝；最新 Player heatmap 检查使用独立 `app.vibecs.playerheatmap-audit` identifier 与 current-schema seeded profile。这是测试隔离和 projection 验收，不是兼容迁移或 fresh parse。
- 视觉截图不能证明屏幕阅读器、Windows Snap、物理拖动和所有键盘路径。
- “所有差异”以当前公开页面和当前 Vibe 路由为边界，不包含纯 CLI 命令、未公开实验页和仅存在于测试 fixture 的能力。
