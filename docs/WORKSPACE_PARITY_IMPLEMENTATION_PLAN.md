# Vibe CS 功能对齐与桌面工作台设计规范

- 日期：2026-08-13
- 参考基线：CS Demo Manager v3.20.1 (`8961f5072fe4d42803dde68e8e71b3c90b216504`)
- 数据基线：IEM Cologne Major 2026 决赛 M1 `de_mirage`、M2 `de_anubis`、M3 `de_inferno`
- 视觉方向：用户已选择“选项二 · Context Canvas”；以 CS Demo Manager 的工作台密度补强，但所有字段必须来自真实证据
- 关联审计：[CS_DEMO_MANAGER_UI_PARITY_AUDIT.md](CS_DEMO_MANAGER_UI_PARITY_AUDIT.md)

## 1. 产品目标

Vibe CS 要成为“证据驱动的比赛分析与视频制作工作台”，而不是一个更松散的 CS Demo Manager 皮肤。

目标用户应能完成四件事：

1. 在大量 Demo 中快速找到一场比赛、一个玩家、一个回合或一个事件。
2. 从聚合结论下钻到可验证的 round/tick/player 证据。
3. 在同一上下文中回看、比较、批注并加入制作。
4. 跨页面、跨重启追踪分析、下载、录制、渲染和交付任务。

“最大化不空”不是把卡片和字号放大。空间只能分配给以下真实对象：

- 可排序、筛选和批量操作的数据表。
- 两队、两名玩家或两个回合的比较区。
- 当前对象的 Inspector 与证据 lineage。
- 当前任务与历史任务的 Activity。
- Replay、Heatmap、Editor 的地图或时间线画布。

## 1.1 已选择方向与当前落地

`Rounds` 使用 Context Canvas，而不是继续堆纵向大卡片：

- 48px 单行回合带，保留胜方、当前回合、键盘左右/Home/End 导航与自动滚入视口。
- 主证据 pane 用 encounter 分组；选中组以横向原子事件序列展示 actor、target、weapon、damage、headshot 与精确 tick。
- 右侧 Inspector 只展示可验证的 T/CT 购买、参与者、原子证据和 Watch / 2D / 加入制作；未知存活和装备明确为不可用。
- 下方空间上下文使用真实 Valve radar 与事件坐标；不生成地点名、队徽、现金/装备快照、官方回合时钟或混入历史阵容。
- `1672×941` 为事件 + 空间 + 352px Inspector；`1100×700` 保留同样三类能力并各自滚动，不通过 `display:none` 删除证据。

本切片完成不等于全功能对齐。Evidence Search 已在真实产品库中覆盖 M1/M2/M3 共 11,548 条证据、50 行默认页、`scan_complete=true`、唯一 FalleN R20 结果及 Round/Replay 深链；实际 Watch 启动和投影重建仍未过。Player 原子证据、Weapons、Heatmap 点选、Library power table/Inspector 与 SQLite 侧 search/filter/stable-sort/page、只含真实数据的 URL 列选择、当前页 Player compare、分页 Activity Center、canonical Evidence Annotation 和带方向矩阵的 Openings 已落。current desktop 与同源重建 sidecar 已重新分析真实 M1（Mirage、21 rounds、10 players、457 highlights、3,628 evidence）；Openings 实测 21/21 verified，`karrigan→FalleN` 命中 R17 tick 143316，10×10 矩阵在 2560×1392 和 1100×700 都无页面溢出。Library 的 1100×700 列选择、表内横滚与固定操作列已过真实 Tauri 验收；文件大小不在当前 DTO 中，所以明确 unavailable。`furia-vs-falcons-m1-mirage` R1 tick 1 annotation 已完成创建、resolve→reopen、正文/标签编辑与保存；使用同一隔离数据目录完整重启后，编辑后正文与包含 `current-audit` 的标签集合精确读回。服务端 `q/tag/state/demo/evidence` 筛选已实现并通过自动化门禁，但全局 annotation index UI 尚未产品验收。Activity 最大化实测 1 条 completed analysis 且无伪百分比。Library 多页/大库、Activity 多页和 Queue recovered-cancel 仍只有单页/source/focused 门禁，不能外推。Queue 执行具有 exact lease/原子发布/启动复核；真实 HLAE active-cancel/成片仍未闭合。Team continuity、跨工作流 review/taxonomy、连续高保真 Replay 和可复用工作台原语继续按后续阶段推进。

## 2. 不变量

### 2.1 数据真实性

- 没有 parser 或持久分析证据的指标必须显示 `—` 与原因，不能估算。
- `rating = kills / deaths` 只能标为 K/D；不得显示为 Player Rating。
- T/CT 是回合阵营，Team A/B 是跨换边组织身份；证据不足时不可互换。
- 稀疏事件回放必须持续标为 `event_sparse`，不能使用实时 1× 语义。
- 每条可执行证据都必须有稳定的 `demo / round / tick / player / evidence_id`。

### 2.2 布局真实性

- 数据页最大化后至少 70% 可用面积属于 table、compare、inspector 或 activity。
- 画布页最大化后至少 70% 可用面积属于 canvas 或 timeline。
- 表单页允许窄内容列；Library、Players、Rounds、Production、Outputs 不允许继承文章式 `max-width`。
- 1100×700 不能通过 `display: none` 删除能力；次级 pane 必须变成可发现、可键盘操作的 drawer。
- 一个 pane 只有一个外层 surface；内部优先使用分组、对齐和分隔线，不做 card 套 card。

### 2.3 任务真实性

- 只有真实百分比才显示百分比；否则显示阶段、开始时间和耗时。
- analysis、download、record、render、export 和 agent mutation 使用统一 job identity。
- 需要跨重启的任务必须持久化；页面内 Zustand 不是任务系统。
- error 必须保留稳定 code、阶段、可恢复动作和脱敏日志入口。

## 3. 统一工作台原语

```tsx
<WorkspacePage variant="data | evidence | canvas | form">
  <WorkspaceHeader />
  <WorkspaceToolbar />
  <WorkspaceBody>
    <NavigationPane />
    <PrimaryPane />
    <InspectorPane />
  </WorkspaceBody>
  <ActivityDrawer />
</WorkspacePage>
```

### 3.1 页面类型

| 类型 | 页面 | 最大化空间 | 1100×700 |
|---|---|---|---|
| `data` | Library、Search、Players、Teams、Outputs | 表格 + Inspector + Activity | 表格全宽，Inspector drawer |
| `evidence` | Overview、Rounds、Player Detail、Insights | 导航 + 原子证据 + Inspector | 主证据全宽，导航/Inspector drawer |
| `canvas` | Replay、Heatmap、Editor | canvas/timeline + controls | canvas 常驻，HUD/Inspector drawer |
| `form` | Settings、配置向导 | 820–1080px 阅读列 | 单列滚动 |

### 3.2 Grid contract

```css
.workspace-page {
  width: 100%;
  max-width: none;
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  padding: clamp(12px, 1.1vw, 20px);
  container-type: inline-size;
  overflow: hidden;
}

.workspace-body--two-pane {
  grid-template-columns: minmax(0, 1fr) clamp(320px, 22cqw, 400px);
}

.workspace-body--three-pane {
  grid-template-columns:
    clamp(210px, 16cqw, 260px)
    minmax(560px, 1fr)
    clamp(300px, 21cqw, 380px);
}
```

### 3.3 密度与 pane

- 每个数据工作台支持 `紧凑 / 舒适` 两档并按页面持久化。
- 紧凑行高 32px、工具栏 36px；舒适行高 42px、工具栏 44px。
- pane separator 支持拖动、方向键、双击恢复和持久化。
- 1100px 默认把全局导航折叠到 64–68px；用户 pin 后才保持文字侧栏。
- 断点基于 workspace container，而不是 viewport。

## 4. 页面设计

### 4.1 Library

最大化采用 `Demo/Match power table + 360px Inspector`：

- 常驻列：状态、名称、地图、双方/比分、日期、来源、时长、分析阶段、主动作。
- 可选列：文件、路径、tick/tickrate、server、tags、comments、checksum。
- Inspector：文件详情、Watch、Reveal、Analyze/Retry、source correction、tags/comments、导出和逐阶段日志。
- 未选择对象时显示监听目录与真实 Activity；多选时变成批量操作。
- 必须使用 server-side pagination 或虚拟化，不能停在固定前 100 条。

1100×700：保留状态/名称、地图/比分、日期、主动作；Inspector 为 overlay drawer。

当前落地边界：最大化已是 `power table + 逐条 Inspector`，1100×700 复用同一详情的 drawer；Watch、Reveal 与生命周期主动作均保留，表格横滚只发生在自身容器。Library 通过 `/demos/compact` 把 search/map/exact status、稳定 sort、page/page_size 下推到 SQLite，默认 50 条，允许 20/50/100/200，URL 可恢复且超范围页会回正。当前-only `columns=` 只接受真实列的唯一键，未知或重复值不会成为隐性兼容状态；文件大小由于 DTO 没有数据而明确 unavailable。真实 Tauri 1100×700 已验证 selector、表内横滚、固定操作列与无页面溢出。仍缺阶段日志、tags/comments、跨页批量导出，以及 SQLite `LIKE`/JSON player search 与高 offset 的真实大库性能门禁；多页验收尚未完成。

### 4.2 Match Overview

最大化采用 `scoreboard/round flow/evidence table + 380px Inspector`：

- 不同时常驻 roster rail 与重复 scoreboard。
- 玩家 KPI 合并成紧凑 facts strip，归入 Inspector。
- 主区优先完整 scoreboard、回合胜负序列和关键证据行。
- 每个聚合指标能进入对应原子 evidence，不做无入口的总结卡。
- 选中玩家时 Inspector 可切换“详情 / 与另一玩家比较”。

1100×700：Match header 压到 56–64px；玩家选择变为 combobox；Inspector 为 drawer。

### 4.3 Rounds

最大化采用 `220px Round Navigator + Event Stream + 360px Round Inspector`：

- Event Stream 按 encounter、objective、utility、economy 分组。
- 连续 damage + kill 归并为一次 encounter，同时允许展开原始事件。
- Round Inspector 显示双方现金/装备/存活、当时 scoreboard、comments/tags、Watch/Replay。
- 事件动作紧邻正文，且可访问名称包含 actor、target、round/tick。

1100×700：回合导航成为顶部 sticky strip；Inspector 为 drawer；主区只保留事件与 More。

### 4.4 Players

最大化采用 `240px Roster + Atomic Evidence + 360px Compare Inspector`：

- 未选玩家才显示全场 scoreboard。
- 选中玩家后主区切换为 Overview、Kills & Deaths、Weapons、Utility、Duels、Clutches。
- 每条原子行都能跳 Round、Replay、游戏内 Watch 和 Production。
- Compare Inspector 允许最多两名玩家，并明确指标来源和不可用原因。

1100×700：Roster 变成 Team A/Team B player picker；Compare 为 drawer。

### 4.5 Advanced Analysis

将当前 More 拆成三组：

- 高级分析：Economy、Weapons、Duels、Grenades、Heatmap。
- AI：AI Review。
- 制作辅助：Cosmetics。

Economy、Weapons、Duels、Grenades 复用 `主表 + Evidence Inspector`，不再各造一组 KPI 卡。Openings 已作为独立工作台落在高级分析组：每个回合只考察最早 tick 的 kill，无法验证该首事件时整回合显式 unavailable，不把后续 kill 提升为首杀。当前 10×10 方向矩阵以行表示 actor、列表示 target，点选 cell 后同步筛选可验证的原子证据。真实 Tauri M1 为 21/21 verified；`karrigan→FalleN` 对应 R17 tick 143316。2560×1392 使用 matrix/evidence/Inspector 三列，1100×700 受控堆叠且页面无横向溢出。Watch 仍未点击，CS2 仍未启动。

### 4.6 Replay

最大化使用 `HUD 240px + Canvas + Evidence 320px + Transport 52px`：

- Transport 始终可见。
- HUD 只显示已验证 health/armor/money/weapon；未知明确标注。
- Evidence 显示当前帧覆盖数、事件流、对象详情和 display controls。
- Canvas 支持 focus/fullscreen，不保留 card padding。
- 功能槽位：radar level、drawing、audio sync、kill feed、bomb、projectiles、shortcuts。
- 默认 `event_sparse`；未来 selected-round high-fidelity 作为独立模式和缓存。

1100×700：只常驻 canvas + transport；HUD/Evidence 各由明确按钮打开 drawer。

当前落地边界：本轮先闭合了能力裁切，1100×700 的 271px radar、transport 和独立滚动 Evidence Inspector 都在 700px 视口内且无 document 横溢出；Evidence 尚未改为 drawer，因此画布尺寸仍小于最终目标。连续 selected-round、高保真 HUD、drawing 与 audio 也仍未实现。

### 4.7 Heatmap

最大化使用 `Map Canvas + 320px Controls/Legend/Evidence`：

- 默认用 KDE、hexbin 或分箱强度，不叠加 3,262 个同色原始圆点。
- Inspector 显示类型、样本数、归一化、半径、模糊、透明度和色阶。
- 点击区域列出真实证据，并可跳 round/tick/replay。
- 原始点仅在筛选后或放大时作为可选模式。

### 4.8 Production 与 Activity

- 四张流程说明卡压成 56px pipeline rail：Source → Capture → Edit → Deliver。
- 主区为当前队列、最近项目、失败任务和下一待办。
- 右侧 Readiness/Activity 显示 CS2、托管 HLAE、Windows 原生编码器与路径状态。
- 持久 job 支持 pause/resume/retry、阶段日志、重启恢复。
- 空任务只有一个真实下一步 CTA，不展示装饰统计。

当前落地边界：Queue 零项只保留一个“打开资料库”CTA，零值 stats、空列表布局和固定操作 dock 已移除；非空编辑计划已持久化到本机 WebView，并由既有真实 Tauri 记录验证 reload 恢复。执行中 job 已使用精确 artifact lease、原子发布、DB commit acknowledgement 与启动恢复；runtime state 的 durable active recording id 会在 job 详情 hydration 前保持 cancel 可用。启动恢复会复核已发布产物，或把歧义 running/cancelling 安全终结，不声称从中间 capture tick 续跑。统一 Activity 能读取 analysis/download/recording/export 的持久事实，按更新时间和稳定 id 排序后支持 search/kind/state 与 50 条分页，并把 HLAE recording 显示为 1/5–5/5 阶段而非假百分比；该分页是完整读取四类来源后的应用层窗口，不是 SQL cursor 或统一历史表。真实 Tauri 2560×1392 已显示 1 条 completed M1 analysis 且没有伪百分比，多页仍未测；recovered-cancel 只有 focused/工作区门禁。pause/resume/retry、完整日志和真实 HLAE active-cancel/成片仍未闭合。HLAE 与 Media Foundation 是应用管理的实现细节，用户依赖检查只应要求 CS2。

### 4.9 Outputs

- 最大化采用 `Output table + 360px Preview/Metadata Inspector`。
- Inspector 显示预览、文件、source project、proposal/evidence lineage、日志与动作。
- 空态提供回到 Production 或打开 Editor 的唯一下一步。
- 没有暂存残留时不显示“重试暂存清理”。

### 4.10 Editor

- 最大化保持 Media、Preview、Inspector 三栏可 resize，Timeline 跨全宽。
- 1100×700 只常驻 Preview；Media/Inspector 成为互斥 dock drawer，不能隐藏能力。
- Timeline 占 50–55% 高度，低高度时工具栏压缩到 36–40px。
- Preview `object-fit: contain`，不得因为 pane 最小宽度裁切。
- 空时间线属于正确的编辑画布空间，不用卡片填充。

当前落地边界：最大化三栏保持不变；1100×700 的属性能力已用同一面板的 modal drawer 保留，真实键盘检查通过 focus trap、Esc 与焦点归还，且无横向溢出。Media pane 的互斥 drawer 与有真实素材时的低高度编辑密度仍是后续项。

### 4.11 Settings

- 保留窄阅读列，但分离普通设置、依赖 readiness 和危险维护。
- 增加设置搜索与 deep link。
- 每个路径持续显示已验证、不存在或自动发现为空。
- 移除 `updates.example.com` 这类看似真实的占位配置。

## 5. 功能对齐落位

| CSDM 能力 | Vibe 目标入口 | 不应怎样实现 |
|---|---|---|
| Tags、comments、source correction、analysis logs | Library Inspector | 不新增四个顶级页面 |
| Cross-match event Search | 独立 Evidence Search，复用 Agent evidence ID | 不用 Agent 对话替代确定性搜索 |
| Round economy/equipment/comments/Watch | Round Inspector | 不把所有值挤进事件正文 |
| Player kills/deaths/weapons/duels/utility/clutches | Player Atomic Evidence | 不用 6 张 KPI 卡替代原子行 |
| Radar level、drawing、audio、HUD | Replay tools/drawers | 不把稀疏模式冒充连续 Viewer |
| Sequence、应用托管 HLAE / Windows Media Foundation、video queue | Production | 不回退为外部依赖专家配置巨页，也不恢复 OBS |
| Player/Team profiles | Players/Teams data workspaces | 不从最终 side 猜组织身份 |
| Downloads 与 Analyses | 独立 data workspaces + unified Activity | 不创建彼此孤立的任务状态机 |

### 5.1 公共证据契约

所有 Search、Player、Round、Replay、Agent 和 Editor 应共享：

```rust
EvidenceRef {
    demo_id,
    source_kind,
    source_id,
    round,
    tick,
    end_tick,
}

Availability {
    state: available | partial | unavailable,
    reason,
}
```

建议 ID 规范：

- `demo:{uuid}/event:{event_id}`
- `demo:{uuid}/highlight:{highlight_id}`

URL 至少能恢复：

```text
#/analysis?demo=…&tab=rounds&round=20&tick=160986&evidence=…&player=…
```

`event.id` 目前依赖解析顺序；持久化索引必须同时绑定 `demo_id` 和 projector/parser revision。

### 5.2 Evidence Index

`analyses.document_json` 适合作为解析事实源，但不适合跨比赛逐条反序列化查询。新增可重建投影：

```text
evidence_search_items
  evidence_id, demo_id, source_kind, source_id,
  round, tick, end_tick, event_family, event_type,
  actor_id, target_id, actor_name, target_name,
  weapon, headshot, penetrated, attributes_json, search_text

evidence_search_victims
  evidence_id, position, victim_id, victim_name

evidence_search_projection_state
  demo_id, analysis_updated_at, indexed_items
```

- 在 `complete_demo_analysis` 的同一事务中替换当前 Demo 投影。
- re-analysis 失败时保留上一份成功 analysis 与 index。
- Demo 删除时级联删除。
- 当前 analysis 在写入事务中同步生成索引；缺少当前投影契约的数据直接拒绝，不提供回填或迁移路径。
- 第一版直接覆盖现有 kill/death/damage/objective/grenade/purchase 与 highlights；不需要修改 parser。

全局查询接口：

```text
GET /api/evidence/search
  ?q=&event_family=&actor=&victim=&weapon=&map=&source=
  &source_kind=&match_date_from=&match_date_to=&round=
  &headshot=&demo_id=&page=&page_size=
```

返回 total、capabilities、indexed demo 数和 scan completion；unsupported filter 必须禁用并说明，不能表现为 0 结果。

### 5.3 Player Atomic Evidence

第一条 tracer bullet 不等待全局索引：先从当前 `AnalysisWorkspace` 纯派生玩家证据，验证 UI 与交互模型。

```ts
buildPlayerMatchEvidence(
  workspace: AnalysisWorkspace,
  playerId: string,
): PlayerMatchEvidence | null
```

第一片只承诺：

- Kills：round、tick、target、weapon、headshot、penetrated、position。
- Deaths：同一 kill event 按 target 过滤。
- Weapons：kills、headshots、damage、damage event 数。
- Duels：方向性 matchup 和原子交锋，过滤队友。
- Utility：throw/detonation/damage 与 availability。
- Objectives：plant/defuse/explode，归属不确定时保守呈现。
- Highlights：按 player/round/tick 过滤，不把 timeline/fail 全部包装成高质量高光。

暂不承诺 shots、accuracy、hitgroup、KAST、trade、Rating 2、完整 equipment snapshot。当前 `rating = kills / deaths` 必须先从 UI 改名为 `K/D`；`kills * 2 - deaths` 只能标为派生分。

真实 M1 FalleN 验收 oracle：

- 9 kills、14 deaths、6 assists、6 headshots、1638 damage、ADR 78。
- weapon kills：USP-S 3、M4A1-S 2、Galil 1、Tec-9 1、AWP 1、M9 Bayonet 1。
- utility：54 throws、53 detonations、89 damage、14 damage events；flash availability=false。
- objectives：R9/R11 plant，R11 explosion。
- 首次 death 为 R1 tick 3329；首次 kill 为 R5 tick 29723。

### 5.4 Unified Activity

现有 recording/export/download jobs 与 Demo analysis lifecycle 已聚合为只读 Activity read model；SSE/轮询只做 invalidation，不当历史：

```text
GET /api/activities?search=&kind=&state=&page=&page_size=

ActivityItem {
  id, kind, subtype, job_id, context_id, subject, status, stage,
  progress_percent: Option,
  completed_units, total_units, unit,
  created_at, updated_at, error,
  available_actions,
}
```

当前 Analysis 没有独立 job 表，因此 Activity 只使用 `DemoStatus + analysis row` 的权威事实：Analyzing/Failed 来自 Demo lifecycle，Ready 且 analysis row 存在才是 completed；不伪造 job id、百分比或错误文本。API 会完整读取 recording/export/download/analysis 四类来源，以 `updated_at DESC, id ASC` 稳定排序，先计算全局 summary，再按 search/kind/state 过滤并用 `page/page_size` 截取；默认 50、上限 100。它是 bounded application read model，不是持久 event history、SQL cursor 或四表统一查询。后续若需要大规模历史、queued → validating → parsing → projecting 的细阶段、取消和日志，必须新增持久 `analysis_runs` 与 bounded `analysis_run_events`，并把分页下推到合适的持久查询，不能从 Demo status 反推。

### 5.5 Annotation、Tag 与 Team

- 当前 `EvidenceAnnotation` 精确绑定 `demo_id/evidence_id/round/tick`；创建时必须能在 `evidence_search_items` 找到 canonical evidence，且 round/tick 完全匹配，否则拒绝写入。
- 记录包含正文、自由标签、open/resolved、created/updated 时间；后端提供分页 CRUD 与 `q/tag/state/demo/evidence` 筛选，Evidence Search drawer 当前提供创建、正文/标签编辑、resolve/reopen 与删除。Demo 删除会级联删除 annotation。
- 真实 Tauri 已在 `furia-vs-falcons-m1-mirage` R1 tick 1 创建注释，完成 open→resolved→open、正文/标签编辑与保存；在同一隔离数据目录完整应用退出重启后，编辑后正文与包含 `current-audit` 的标签集合精确读回。截图为 `target/product-audit-20260813-current/10-evidence-annotation-edited-1440x900.png` 与 `11-evidence-annotation-after-restart-1440x900.png`；删除和 1100×700 drawer 尚未做人工产品验收。
- 当前未发布产品只维护一份 exact schema；不导入或迁移旧 Demo remark，也不保留旧 annotation contract。现有 Demo remark 继续是独立字段，不伪装成 evidence annotation。
- 自由标签尚不是全局 taxonomy；缺作者/权限，以及 Agent、Highlights、Round、Editor 的复用。服务端筛选已实现并测试，但没有全局 annotation index UI 的真实产品验收。
- Algorithm highlight tags 与用户 tag taxonomy 必须保持分离；更丰富 review state 只能在有明确工作流后直接修改当前 contract，不预埋兼容枚举。
- Team 名称只使用 Demo 声明的 `team_name/team_clan_name` 或明确 roster-only identity；不从文件名、HLTV 页面或最终 side 猜。
- fast parser 目前没有请求 team props；Team directory 前必须先补解析、provenance 与 match-team binding。

### 5.6 Parser 边界

| 能力 | 现有数据足够 | 需要 parser/schema |
|---|---|---|
| 基础 Search、4K/5K、clutch | 是 | Evidence Index |
| Player K/D、weapon kills/damage、duels、utility、objectives | 是 | Evidence Index |
| no-scope/jump/smoke/team-kill/collateral 三态 | 仅部分 | 规范化 parser 字段 |
| shots/accuracy/hit regions | 否 | weapon_fire/bullet_impact/player_hurt |
| KAST/trade/真实 rating | 否 | 事件语义、正式公式与 metric projection |
| Activity | 四来源 read model + 应用层 filter/page 已有 | analysis runs/logs、持久查询/cursor、虚拟化 |
| Annotation/Tag | exact evidence annotation + 可编辑正文/自由标签 + open/resolved + 服务端筛选已有 | 作者/权限、全局 taxonomy/index UI 产品验收、跨工作流复用 |
| 组织队名 | vendor 支持但未请求 | team props + teams/match_teams |
| 真实 equipment value/economy type | 否 | freeze-time entity snapshot |

发布构建必须让 desktop 与 sidecar 来自同一 current source/manifest。真实验收第一次用旧 sidecar 配 current desktop 时，worker response 因缺少当前必需的 `status` 被 fail-closed 拒绝；重建同源 sidecar 后 M1 分析成功。当前未发布产品不为旧 worker response 增加 version shell 或兼容解码。

## 6. 实施顺序

1. **Player atomic evidence tracer bullet（已实现）**：点击玩家进入 kills/deaths/weapons/duels/utility/objectives/highlights 原子证据，并可 Watch、跳 Round/Replay、加入制作。
2. **Evidence Search tracer（已实现，multi-match 产品门禁已过）**：持久 evidence index、组合查询、canonical deep link；真实 M1/M2/M3 共 11,548 条、唯一 FalleN R20 条件结果、Round/Replay、URL 与 `scan_complete=true` 已过。剩余门禁是实跑 Watch 和应用重启后的投影复核，再扩保存查询/批量操作。
3. **Workspace primitives（页面级切片已开始）**：Library 宽屏 workspace、Queue compact empty state 与 Editor property drawer 已落，但尚未抽成完整 `WorkspacePage/DataGrid/Inspector/Drawer` 公共组件。
4. **Library power table（生产纵切已实现）**：真实 power table + 宽屏 Inspector/窄窗 drawer、SQLite 侧 search/filter/stable-sort/page 与当前 URL 列选择已落；1100×700 selector/表内横滚/固定操作列已过真实 Tauri 验收。下一步是大库性能产品门禁、阶段日志和跨页批量动作。
5. **Activity Center（生产纵切已实现）**：统一读取分析、下载、录制与导出事实，已有 search/kind/state 和应用层分页；真实 Tauri 单页 completed analysis 已过。下一步是持久查询/cursor、多页验收、analysis run 日志与通用 retry/pause。
6. **Advanced Analysis（进行中）**：Weapons、Duels、Utility 与 Openings 已落；Openings 真实 M1 21/21 和 10×10 方向矩阵双尺寸验收已过，Watch 未跑。Economy 仍以真实 T/CT 回合表为主，缺团队级原子工作台；Utility 的页面内双尺寸验收也仍未完成。
7. **Evidence Annotation（生产纵切已实现）**：exact locator、分页 CRUD、正文/自由标签编辑、open/resolved、服务端 `q/tag/state/demo/evidence` 筛选与 Evidence Search drawer 已落；真实 Tauri create/resolve/reopen/edit/restart 精确读回已过。全局 annotation index UI 尚未产品验收；下一步是 taxonomy/权限、删除与窄窗人工门禁，以及 Agent/Highlights/Round/Editor 复用。
8. **Replay high-fidelity round pass**：连续 selected-round 模式、HUD、kill feed、绘图/音频。
9. **Team continuity**：跨比赛 Player/Team 档案、maps/matches/heatmap。

每一步必须是可见入口 → 公共 route → 持久数据 → 真实 Major 证据 → Tauri/CDP 的纵向闭环，不能只完成 DTO 或静态页面。

## 7. 可访问性

- 数据表使用 table/grid 语义；虚拟化提供 `aria-rowcount` 和 `aria-rowindex`。
- resizer 使用 `role="separator"` 并支持方向键。
- drawer 支持 Esc、focus trap 和焦点归还。
- 阵营、胜负、状态不能只靠颜色。
- Canvas 有等价文本事件列表和“跳到证据”。
- 事件动作必须包含 actor、target、round/tick，不使用重复的“加入”。
- 任务状态使用 `aria-live="polite"`；错误包含恢复动作。
- 正文至少 13px，常规目标点击区域至少 36px；关键动作至少 40px。

## 8. 验收矩阵

每个纵切都必须同时通过：

- 真实 Major 数据，不以 fixture 代替产品结果。
- 聚合值可追溯到原子证据。
- 最大化无无效窄岛；1100×700 不丢功能、不横向裁切。
- URL 可恢复 demo/tab/round/tick/player/evidence 上下文。
- loading/empty/error/retry/cancel 状态与实际能力一致。
- 键盘可进入、操作并退出 drawer/inspector/table。
- console 无 error，IPC 无 4xx/5xx，页面无横向 overflow。
- 需要持久化的 selection、job、annotation 在重启后恢复。

## 9. 当前未完成根因与本轮闭合项

- 全局部分 `.page` 仍有约 1540px `max-width`；Library 已移除该上限并完成 power table/Inspector、服务端 query window 与当前 URL 列选择，但 Production/Outputs 等页面仍有独立宽度约束，Library 的跨页批量与大库性能门禁尚未闭合。
- 已闭合：Analysis header 的 compact 修复通过真实 Tauri 1100×700；header 无内溢出，tabs 位于其下，“玩家资料”中心 hit-test 命中链接，scoreboard 各列可达且 document 无横溢出。
- 已闭合：651–1279px 的全局导航使用 68px rail；图标链接保留本地化 accessible name/title，命令面板覆盖所有可独立进入的核心页面，不把缺 demo 的 Analysis 深链伪装成可执行入口。
- 已闭合 P0：Editor 低于 1400px 不再删除属性栏；常驻触发器打开同一属性面板的 focus-managed drawer，1100×700 的 Esc/focus restore/overflow 已通过。尚缺 Media drawer 与真实素材低高度门禁。
- 已闭合 P0：Replay 原先在 1100×700 把 transport 推出首屏；当前 workspace 使用完整剩余高度，底部为 678px，transport 为 677px，document 不滚动。Evidence 仍内联占宽，最终 canvas-first drawer 结构尚未做。
- 已闭合真实纵切：Library 不再固定读取前 100 条；SQLite 侧 search/map/status/sort/page、默认 50 条、URL 恢复与 current-only 列选择已落。真实 Tauri 1100×700 的 selector/表内横滚/固定操作列已过；多页/大库性能仍未验收。
- 已闭合基础纵切：Activity 支持应用层稳定排序/filter/page；真实 Tauri 2560×1392 的 1 条 completed analysis 无伪百分比，多页仍未验收。
- 已闭合真实纵切：Evidence Annotation 在 `furia-vs-falcons-m1-mirage` R1 tick 1 完成 create、resolve/reopen、正文/标签 edit/save；同一隔离数据目录完整应用重启后，编辑后正文与包含 `current-audit` 的标签集合精确读回。服务端 `q/tag/state/demo/evidence` 筛选已有自动化门禁；全局 annotation index UI、删除与 1100×700 drawer 尚未人工验收。
- 已闭合真实纵切：Openings 在 M1 为 21/21 verified，10×10 actor→target 矩阵的 `karrigan→FalleN` 对应 R17 tick 143316；2560×1392 与 1100×700 均无页面横向溢出。Watch 未点击、CS2 未启动。
- Queue 零项的装饰统计与无效操作栏已移除；非空编辑计划已通过 WebView local storage + reload 实测恢复。后台 recording job 有持久状态、发布复核和 orphan terminalization，但这不等于可从中间 capture tick 续跑；recovered active id 的 cancel fallback 仍只有 focused 测试。
- Player 单场原子证据已经接线；未完成的是跨比赛 compare、全局 Player evidence 和团队级高级分析。

这些问题必须通过工作台结构和公共能力一起解决；单独删除 `max-width` 只会把无用内容拉得更散。
