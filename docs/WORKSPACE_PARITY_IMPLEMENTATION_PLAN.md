# Vibe CS 功能对齐与桌面工作台设计规范

- 日期：2026-08-14
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

本切片完成不等于全功能对齐。Evidence Search 已在既有真实产品库中覆盖 M1/M2/M3 共 11,548 条证据、50 行默认页、`scan_complete=true`、唯一 FalleN R20 结果及 Round/Replay 深链；实际 Watch 启动和投影重建仍未过。Player 原子证据、Weapons、Heatmap 点选、Library power table/Inspector 与 SQLite 侧 search/filter/stable-sort/page、只含真实数据的 URL 列选择、最多扫描 1,000 Demo 后 server filter → stable sort → paginate 的 Players 目录、最多两个显式 ID 的 Player compare、SQLite 边界分页 Activity、canonical Evidence Annotation 与全局 index、Clutch Review、Openings、roster-verified Team Round 与 Team Economy 已落。本轮进一步加入最多 12 个显式 Demo ID 的 Library 批量 Analysis 选择、Evidence Search 的 exact player-involvement 查询、Player profile 的 first-10 跨比赛证据预览、Highlights 对同一 canonical annotation 的摘要与 CRUD drawer 复用、只重放可证明未发布后缀的 recording retry，以及 current-only 的 durable Analysis Run、bounded events、exact producer result 与 Activity run Inspector/retry。

此前 workflow 产品检查使用隔离的 `app.vibecs.currentaudit-workflows` identifier。M1 `03e65851-742f-47af-ad60-955ffdbd0c23` 由同源 fast worker 在约 3.4 秒完成分析，得到 21 rounds、10 players、457 highlights，并验证 tick 189316；M2/M3 只处于 discovered。Library 在最大化下显式选择 M2+M3 共 2 条并在排序后保留，没有 thead select-all。Players 的 NiKo profile 显示 10/473 条证据、`indexed_demos=1`，可见 canonical actor/target 行，Round/Replay URL 均保留 `player=76561198041683378`。Highlights 第一条 canonical evidence 创建正文 `M1 开局 one-tap：复核交叉火力与首杀节奏`、标签 `major-audit/opening` 后，卡片显示 1 待复盘 / 1 复盘注释；完整退出重启后正文与标签精确读回。当时旧 Activity read model 的 exact ID `analysis:03e65851-742f-47af-ad60-955ffdbd0c23` 只返回该行而全局 summary 仍为 `1/0/0/1`，重启后 exact row 仍在。上述页面在 2560×1392 与 1100×700 都满足 `document.scrollWidth == innerWidth`；该 ID 是历史 Demo identity，不是当前 `analysis:<run_id>` contract 的产品证据。

durable Analysis Run 落地前最后一次 current-only 界面检查使用全新 `app.vibecs.currentaudit-next` identifier，由 `agent-browser` 直连 Tauri WebView2 CDP，未使用 Computer Use。只有 M1 `5269e18b-d647-4d98-91de-437ce391054d` 被分析；Players 在 2560×1392 右侧 Inspector 与 1100×700 drawer 中显示 FalleN/NiKo 两人 exact compare，搜索缩到 NiKo 一行后仍保留两名显式选择。Team Economy 的四格真值为 A/T `456 / $255,700`、A/CT `209 / $128,650`、B/T `281 / $174,200`、B/CT `420 / $253,000`，合计 `1,366 / $811,550`、拒绝 `0`；每格只展示 top 3 item groups 与一个 remainder，详情固定 50 行。agent-browser 首次在 1100×700 发现 matrix/evidence overlap；修复与 TDD 后复验为 document/body `1100×700`、workspace 纵向滚动且横向隐藏，matrix/evidence/Inspector 不再重叠，滚到底后 Inspector 完整落在视口内。旧 Activity 在 1100×700 用 Demo-based exact ID `analysis:5269e18b-d647-4d98-91de-437ce391054d` 返回一行，全局 summary 为 `1/0/0/1`；本轮 console 与页面 errors 均为空。它不能作为当前 run events、run-result endpoint 或 retry UI 的验收。

当前 durable Analysis Run 产品门禁使用 exact HEAD `d733b6cf8690996db516a08edc0e0df37b41851c` 与隔离 identifier `app.vibecs.analysisrun-audit`。Desktop EXE SHA-256 为 `dafa01d17351d9b0730816b6e6bf320a509be201f102679a922d1f2e22100d1d`，同源 sidecar SHA-256 为 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`；由 `agent-browser` 直连 Tauri WebView2 CDP，全程未用 Computer Use。M1 Demo `ee98d419-cf81-4a3a-831f-e0e19882d3b0` 的 run `65dd6401-278c-4c5d-be32-27ab6c9fb13a` 从 `00:52:30.728Z` 到 `00:52:43.139Z` 完成，持久事件依次为 `validating_input/input_validation_started → parser_queued/input_verified → parser_running/parser_started → verifying_input_after_parse/input_revalidation_started → projecting/projection_started → completed/completed`。它绑定 SHA-256 `04f26f0f092f24fd13e7939dc56e72a3783a61872500b97b09810ed5a2363697`、大小 `438,520,684` bytes，`result_available=true`；Analysis URL、Activity exact ID `analysis:65dd6401-278c-4c5d-be32-27ab6c9fb13a` 与 Open Analysis link 都保留 exact Demo + run identity。

同一 fresh DB 还完成 M2 Anubis Demo `70330609-4b7a-44d3-9c03-47336e5e578c` / run `234dc7ac-1abd-448f-8474-fb32ccb4bc97` / SHA-256 `89907025d5d5c3d05ef7859d8437303cc83ff1be0be8bb3c92e14c6a774c5fa8`，以及 M3 Inferno Demo `c4d1caa5-3d4c-4e71-9df1-3716334ed887` / run `16b18d2d-4be4-40ec-b5ab-cd110a97b8be` / SHA-256 `374b2f600880e2f8b0437314924b3745c2b0d32e63d53abbedd8bfd52ab8b0b8`。Activity 在 2560×1392 与 1100×700 均满足 document 无横向 overflow；1100 下 table 为 `698.7×435.9px`、Inspector 为 `300×437.2px`、bottom 不超过 688px，Inspector 自身滚动范围为 `783/436px`。FalleN `76561197960690195` profile 显示 exact `3/3` recent matches（Inferno/Anubis/Mirage），每张卡的 Analysis link 都保留该 player 与 exact Demo，跨比赛证据报告 `indexed_demos=3`。最终最大化 shell bottom 为 1340px、height 为 867.7px，内部滚动为 `1572/868px`；1100 drawer body 为 `599.3×545.5px`，内部滚动为 `1759/545px`。两种尺寸的 document 都无 overflow，滚动到底均可到达三张 match card。

该 fresh 产品门禁只证明三次 completed success path、M1 exact event/result navigation，以及 Activity 与 Player 双尺寸 success path。accepted set 位于 `target-analysisrun-audit-82617d4/screenshots/`：`01-analysis-run-result-max-final.png`、`02-activity-analysis-run-max-final.png`、`03-players-match-history-max-final.png`、`04-activity-analysis-run-1100-final.png`、`05-players-match-history-1100-final.png`。没有执行 analysis failure/interruption/retry/cancel，也未点击 Watch 或启动 CS2/HLAE；并发、启动恢复与 retry eligibility 仍由确定性 TDD 支持。Player 最大化首次审计曾发现 Inspector bottom `1788 > 1392` 的 P1；修复后的 exact HEAD 已用 final 截图和上述几何复验通过，初次失败截图不列为 accepted evidence。其他旧观察也不能外推为 Library/Players 真实跨页、Activity 多页/大库性能或 Steam/recording retry 实机通过；默认旧实验数据库继续被 exact current schema 拒绝，隔离 identifier 是测试隔离，不是兼容迁移。

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

当前落地边界：最大化已是 `power table + 逐条 Inspector`，1100×700 复用同一详情的 drawer；Watch、Reveal 与生命周期主动作均保留，表格横滚只发生在自身容器。Library 通过 `/demos/compact` 把 search/map/exact status、稳定 sort、page/page_size 下推到 SQLite，默认 50 条，允许 20/50/100/200，URL 可恢复且超范围页会回正。当前-only `columns=` 只接受真实列的唯一键，未知或重复值不会成为隐性兼容状态；文件大小由于 DTO 没有数据而明确 unavailable。批量 Analysis 只保存最多 12 个显式 canonical ID，跨 page/page_size/sort/columns/view 保留，search/map/status 改变时清除，并明确不代表全部筛选结果；导航前逐条读取 exact Demo 与 current lifecycle，部分失效会先缩减选择并要求再次确认，非 404 读取失败则整批 fail closed。Analysis 页面随后把 primary `run=<uuid>` 写入 URL；切换批次中的 Demo 不会错误沿用另一个 Demo 的 run identity。

最新真实 Tauri 在最大化下显式选择 discovered M2+M3 共 2 条，排序后选择仍为 2，thead 没有 select-all；workspace side 为 746px，当前三行表无需横滚。1100×700 下 workspace side 隐藏，表格 `scrollWidth=1100`、容器 972px，只在表格内部横滚，actions 与 pagination 保持 sticky，selection bar 可见，document 无横溢出。由于 fresh DB 总共只有 3 条，这不证明真实跨页选择；跨页保留、上限、preflight 与竞态由 TDD 覆盖。Library Inspector 仍未内嵌 Activity 已有的 exact run event history；tags/comments、跨页 reveal/watch/export 等其他批量动作，以及 SQLite `LIKE`/JSON player search、高 offset 和真实大库性能门禁也未闭合。

### 4.1.1 Match History / Downloads

当前 URL contract 只接受唯一的 `q/page/page_size`，页容量限定为 20/50/100/200；搜索或页容量变化回到第一页，过期或已取消请求不能覆盖较新的 URL 结果。解析、序列化与 request-race 已有 TDD。真实 Tauri 1100×700 只在 Steam 未配置空态验证 URL 恢复和无 document 横向溢出，截图为 `target/product-audit-20260813-player-directory/06-match-history-url-1100x700.png`；由于没有真实 history 行，搜索结果、CSV、Analysis 深链和多页仍是 OPEN。

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

当前全局目录不是当前页本地排序：runtime 先从最多 1,000 个 Demo 构建 bounded player catalog，再执行 server filter、按显式列/方向稳定排序并以 SteamID 打破并列，最后分页。当前-only query 对 sort/direction 使用严格枚举；`/players/compare?left&right` 另要求两个 distinct、有效且属于该 catalog 的 Steam64，并按请求顺序完整返回，invalid/duplicate 为 400、任一缺失为 404，不返回 partial。UI 最多保留两个显式 ID，跨 page/search/sort/layout 保留，第三个替换最早选择；404 reconciliation 只移除 exact read 已证明不存在的 ID。旧 fresh M1 的 10 名玩家仍只有 1 页，但在 2560×1392 Inspector 与 1100×700 drawer 中均完成 FalleN/NiKo 对比，搜索缩到 NiKo 一行后两人选择仍在。新的 `analysisrun-audit` DB 已完成 M1/M2/M3；FalleN `76561197960690195` exact profile 显示 `3/3` recent matches，顺序为 Inferno/Anubis/Mirage，每张卡都链接 exact Demo 并保留 player，persistent evidence 报告 `indexed_demos=3`。最终最大化 shell bottom 为 1340px、height 为 867.7px，内部滚动 `1572/868px`；1100 drawer body 为 `599.3×545.5px`，内部滚动 `1759/545px`。两种尺寸都无 document overflow，滚动到底均可达三张 match card。首次最大化 `1788 > 1392` 的 P1 只作为失败基线，不纳入 accepted evidence；修复后最大化与 1100 profile gate 均已闭合，但真实跨页 compare 与大库性能仍未验收。

Evidence Search 现在提供 `player` involvement：按 normalized exact ID/name 匹配 actor、target 或 indexed highlight victim。全局 Player profile 预览前 10 条并显示 total、indexed Demo 数与 scan completeness；每行提供 Round/Replay，且显式保留正在查看的 player，另可打开完整 exact player search。旧 fresh DB 的 NiKo (`76561198041683378`) 为 10/473、`indexed_demos=1`，可见 canonical actor/target evidence。当前 `analysisrun-audit` 的 FalleN (`76561197960690195`) 已从三场 completed analysis 报告 `indexed_demos=3`，recent matches 为 exact `3/3`，三张卡的 Analysis link 都保留 player 与各自 Demo。最大化 Inspector 与 1100 drawer 都通过 own-scroll 到达三张卡，且 document 无 overflow；这证明 multi-match profile/recent-match 数据与双尺寸交互，不证明多比赛 ordered compare、目录跨页或大库性能。

### 4.5 Advanced Analysis

将当前 More 拆成三组：

- 高级分析：Economy、Weapons、Duels、Grenades、Heatmap。
- AI：AI Review。
- 制作辅助：Cosmetics。

Economy、Weapons、Duels、Grenades 复用 `主表 + Evidence Inspector`，不再各造一组 KPI 卡。Openings 已作为独立工作台落在高级分析组：每个回合只考察最早 tick 的 kill，无法验证该首事件时整回合显式 unavailable，不把后续 kill 提升为首杀。当前 10×10 方向矩阵以行表示 actor、列表示 target，点选 cell 后同步筛选可验证的原子证据。Team Round 另提供 2×2 Team A/B × T/CT 胜回合/已打回合矩阵；只有 exact 两组 5 人 summary roster 与逐回合 10 人 `_round_roster` 能证明 continuity、side、winner 和范围内 `round_end` 时才开放，raw T/CT summary 会 fail closed。真实 M1 为 A/T `4/12`、A/CT `4/9`、B/T `5/9`、B/CT `8/12`；双尺寸无 document 横向溢出。

Team Economy 复用同一个 roster-verified Team A/B context，只接收 ID 唯一、tick 在回合内、actor canonical 且任何显式 side 与 roster side 一致的 purchase。四格同时给出回合、购买数、explicit non-negative decoded cost 与物品计数；缺少 cost 时保留购买数，但金额为 `null`/partial。真实 M1 为 A/T `456 / $255,700`、A/CT `209 / $128,650`、B/T `281 / $174,200`、B/CT `420 / $253,000`，合计 `1,366 / $811,550`，拒绝 0 条。每格预览 top 3 item groups 与一个 remainder，详情页固定 50 行并从 canonical source 重建 Round/Replay/Watch/Add。最大化直接通过；agent-browser 在首次 1100×700 检查发现 matrix/evidence overlap，修复与 TDD 后复验为单一纵向滚动工作台，滚到底可完整到达 Inspector，document/body 无横向溢出。该单场购买控制仍不是 equipment value、economy type、趋势图或持久 Team entity。Watch 仍未点击，CS2 仍未启动。

Clutch Review 只投影能证明 outcome、唯一 `1vN` 场景、canonical player/round、合法 tick 范围和对手关系的 highlight；不完整或互相矛盾的候选 fail closed。真实 currentaudit M1 在 1100×700 为 20 opportunities、0 wins、20 attempts，截图为 `target/product-audit-20260813-player-directory/07-clutch-review-m1-1100x700.png`。M2 R16 m0NESY `1v2` 仍只有 TDD 与既有 real-data oracle，没有载入本轮 UI；该 M2 产品门禁保持 OPEN。本轮未点击 Watch，也未启动 CS2/HLAE。

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

当前落地边界：Queue 零项只保留一个“打开资料库”CTA，零值 stats、空列表布局和固定操作 dock 已移除；非空编辑计划已持久化到本机 WebView，并由既有真实 Tauri 记录验证 reload 恢复。执行中 job 已使用精确 artifact lease、原子发布、DB commit acknowledgement 与启动恢复；runtime state 的 durable active recording id 会在 job 详情 hydration 前保持 cancel 可用。失败或取消的 recording 现在只能把由 durable request identity 与已发布 prefix 精确证明的未发布后缀作为一个新 child job 重试；`retry_of` immutable、每个 parent 最多一个 child，plan 绑定 parent `updated_at` 与 suffix SHA 并在 execute 时复核，原 parent 不变。统一 Activity 从 `analysis_runs`、download、recording 与 export 的权威持久表在一个 SQLite snapshot 内计算全局 summary、filtered total 与 page；kind-specific query 只读对应来源，跨 kind 则先在每个来源 filter/order/window，再按 `updated_at DESC, activity_id ASC` 合并，download/recording/analysis retryability 与 analysis exact-result availability 只对最终页对应行计算。它不是持久统一 history 表或 compatibility view；analysis 的 bounded events 是单独的权威 detail source。

current durable Analysis Run 的 fresh Tauri gate 已在最大化与 1100×700 打开 exact Activity row `analysis:65dd6401-278c-4c5d-be32-27ab6c9fb13a`。Inspector 展示 M1 的 completed stage、完整 SHA-256/`438,520,684 B`、`result_available=true` 与六个按 sequence 排列的持久事件；Open Analysis link 同时保留 exact Demo 与 run。两个宽度都无 document 横向 overflow；1100 下 table 为 `698.7×435.9px`、Inspector 为 `300×437.2px`、bottom 不超过 688px，并以自身 `783/436px` 滚动到达全部事件。这覆盖的是 completed success path，未制造 failed/interrupted run，也未点击 retry/cancel。failed/cancelled Steam download 只有在 latest eligible、match 未下载、当前 Steam ID 与 32 位 hexadecimal key 语法有效且 owner 相同时才暴露 retry；runtime 会在新 queued job 持久化前再次验证，配置缺失或旧账户记录不会创建 job或改 match。Recording retry 同样只在 failed/cancelled parent 有一个可证明且尚未认领的 unpublished suffix 时出现，并创建新 durable child，而不是修改 parent 或猜测续跑 tick。这两种外部 retry contract 均有 TDD，Steam/recording failure/retry 仍未实跑。Production 已在最大化并列、1100×700 堆叠显示最近持久 Activity；Activity 多页/大库性能、download/export/recording 完整日志、通用 pause/resume 和真实 HLAE active-cancel/成片仍未闭合。

### 4.9 Outputs

- 最大化采用 `Output table + 360px Preview/Metadata Inspector`。
- Inspector 显示预览、文件、source project、proposal/evidence lineage、日志与动作。
- 空态提供回到 Production 或打开 Editor 的唯一下一步。
- staged-cleanup 是独立恢复能力，不以当前 output 行数推断是否可用；true-zero 仍可保留该动作，但不能暗示已知残留数量。

当前落地边界：true-zero 隐藏筛选、批量与分页外壳，保留进入 Production 与独立 staged-cleanup recovery；最大化和 1100×700 均无 document 横向溢出。export output 现在按精确 `project_id` 提供 source project 深链；若 source 已删除，Editor 显示所请求 ID 不可用并打开空白工程，不会静默回退到另一个项目。该路径已在真实 Tauri 1100×700 验收，截图为 `target/product-audit-20260813-player-directory/08-editor-missing-lineage-1100x700.png`；仍不能据此声称非零表格密度、metadata、rename/reveal/delete 或 cleanup 已通过。

### 4.10 Editor

- 最大化保持 Media、Preview、Inspector 三栏可 resize，Timeline 跨全宽。
- 1100×700 只常驻 Preview；Media/Inspector 成为互斥 dock drawer，不能隐藏能力。
- Timeline 占 50–55% 高度，低高度时工具栏压缩到 36–40px。
- Preview `object-fit: contain`，不得因为 pane 最小宽度裁切。
- 空时间线属于正确的编辑画布空间，不用卡片填充。

当前落地边界：最大化三栏保持不变；1100×700 的属性能力已用同一面板的 modal drawer 保留，真实键盘检查通过 focus trap、Esc 与焦点归还，且无横向溢出。`?project=` 只选择精确存在的项目；已删除/未知 ID fail closed 到带原 ID 的 danger notice 与空白工程，不选择第一个项目。Media pane 的互斥 drawer 与有真实素材时的低高度编辑密度仍是后续项。

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
  ?q=&event_family=&actor=&victim=&player=&weapon=&map=&source=
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

全局 Player profile 现在直接复用持久 Evidence Index，而不是逐场反序列化 analysis。`player` 只匹配 canonical actor、target 或 highlight victim 的 normalized exact ID/name；profile 首屏最多读取 10 条，并显示 total、`indexed_demos` 与 `scan_complete`，Round/Replay deep link 保留被检查玩家，完整结果进入同一 exact search。旧 `currentaudit-workflows` 的 NiKo 为 10/473、`indexed_demos=1`；current `analysisrun-audit` 的 FalleN 为 `indexed_demos=3`，并显示 M1/M2/M3 exact `3/3` recent matches。该产品证据证明三场 profile 数据已接通，但不证明跨比赛趋势图或两人 multi-match compare。

### 5.4 Unified Activity

现有 recording/export/download jobs 与 durable Analysis Run 已聚合为只读 Activity read model；SSE/轮询只做 invalidation，不当历史：

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

Analysis 的权威来源现在是 current-only `analysis_runs` 与 `analysis_run_events`。每次尝试有独立 UUID；Activity 的 `id` 为 `analysis:<run_id>`，`job_id` 为 run ID，`context_id` 为 Demo ID。状态是 `queued/running/completed/failed/interrupted`，阶段固定为 `validating_input → parser_queued → parser_running → verifying_input_after_parse → projecting → completed`，非终态也可直接进入 `failed`，重启恢复进入 `interrupted`。通用 Activity filter 把 `interrupted` 计入/呈现为 failed，但 exact Inspector 保留 run 的 `interrupted` status/stage、持久 error、SHA-256/size、`result_available` 与按 sequence 排序的事件。Analysis 不提供虚构百分比。

run event 只允许 `input_validation_started`、`input_verified`、`parser_started`、`input_revalidation_started`、`projection_started`、`completed`、`failed`、`interrupted`，并分别与一个固定 stage 一一对应；每 run 最多 32 条，detail/error 最多 2,000 字符。`POST /api/demos/{demo_id}/analysis-runs` 返回 `202` 并由 detached background owner 继续；`GET /api/demos/{demo_id}/analysis-runs/active` 和 `GET /api/analysis-runs/{run_id}` 读取 exact attempt，`GET /api/analysis-runs/{run_id}/result` 只返回 `analyses.producer_run_id` 精确指向该 completed run 的结果。run completion、producer-bound result、evidence projection 与 Demo `ready` 在一个 IMMEDIATE transaction 内提交。

Analysis `retry_analysis` 只对 failed/interrupted 的最新终态尝试开放，并要求不存在 active/newer attempt、没有 completed result，且 Demo 不处于 missing/indexing/analyzing；点击后创建并返回一个新的 exact run identity，旧 run/error/events 不变。`open_analysis` 只在该 completed run 的 exact producer result 可用时出现，并把 `demo` 与 `run` 一起写入 URL。Storage 仍在同一 SQLite transaction 中读取 summary、filtered total 与 page。kind-specific query 只生成对应权威来源的 SQL；跨 kind query 在 recording/export/download/analysis 四个来源分别 filter、按 `updated_at DESC, activity_id ASC` 排序并截取当前 page window，再 UNION 做最终稳定分页。final-page download/recording/analysis retryability 与 exact analysis result availability 才会额外查询。写入、删除和 cascade 会直接反映在下一次读取，不需要 `activity_projection`；当前 schema 也不保留该 view。默认 50、上限 100。聚合 feed 不是物化统一 history 或通用 SQL cursor，而 analysis detail 的 bounded event list 是独立持久事实。

启动会把遗留 queued/running run 原子终结为 `interrupted` 并追加事件；只有 Demo 仍为 `analyzing` 时才改为 `failed`，不会覆盖 concurrent missing/new Discovered fingerprint/Ready。随后 ownerless Indexing/Analyzing 也会 fail closed；任一 recovery 读写失败会让 runtime composition 失败，而不是带 zombie active row 启动。这个 contract 没有 cancel、heartbeat/lease 或 resume。hard crash 仍可能遗留 worker process 与 `worker-tasks` request/response/repair artifacts；startup run reconciliation 不等于物理 sidecar cleanup。

输入 provenance 只证明在 parse 前后分别从 Demo source path 观察到相同 SHA-256/size，并与当前 Demo record 一致；它不证明同一 open handle 的每个 parser-consumed byte。terminal-tail recovery 实际解析 bounded repair copy，而 copy 自身的 fingerprint/lineage 不在 run event 中，仍有窄的 physical-file TOCTOU。`analysisrun-audit` 已用 fresh Tauri/WebView2 + 真实 M1/M2/M3 证明三个 completed run；其中 M1 的 exact six-event sequence、fingerprint/size、producer result、Analysis URL 与 Activity/Open link run identity 已通过，Activity 双尺寸无 document overflow。该检查没有执行 failure/interruption/retry/cancel 或 startup recovery，也不能证明多页、search scan 或 high-offset 性能。

当前 action contract 始终允许从 download Activity 回到 Match History；`retry_download` 只对 latest failed/cancelled eligible attempt 开放，并要求没有 active/newer sibling、match 尚未 downloaded、当前 Steam ID 和 32 位 hexadecimal Web API key 语法有效且 record owner 与当前账户一致。runtime 在持久化前再次检查配置与 owner；失败时不创建 queued job，也不修改 match record。通过后 retry 才复用原 match id 创建新 queued job，旧 job、error 与 transferred bytes 保持为历史事实。该 contract 已通过 application/runtime/Web TDD，但未真实制造 Steam failure，也不证明 key 在线有效或网络下载一定成功。

Recording Activity 的 `retry_recording` 只对 failed/cancelled、没有 child 且能由 durable request IDs、published prefix 与 cursor 精确证明 unpublished suffix 的 parent 开放。用户先得到绑定 parent ID、`updated_at` 和 suffix SHA-256 的短期 plan；native consent 通过后 execute 再验并原子创建唯一 child，拒绝 consent 则创建 0 个 child。parent、既有 outputs 和 error 保持原事实，启动中断不会留下一个被 UI 当作可继续的非终态孤儿。该 contract 已通过 domain/storage/application/runtime/Web TDD；最新 fresh Activity 的 `recording + failed` 结果为 0，因此没有 retry UI 的产品证据，也未启动 CS2/HLAE。

### 5.5 Annotation、Tag 与 Team

- 当前 `EvidenceAnnotation` 精确绑定 `demo_id/evidence_id/round/tick`；创建时必须能在 `evidence_search_items` 找到 canonical evidence，且 round/tick 完全匹配，否则拒绝写入。
- 记录包含正文、自由标签、open/resolved、created/updated 时间；后端提供分页 CRUD 与 `q/tag/state/demo/evidence` 筛选，Evidence Search drawer 当前提供创建、正文/标签编辑、resolve/reopen 与删除。Demo 删除会级联删除 annotation。
- 最新 fresh Tauri 在 M1 第一条 canonical Highlight 创建正文 `M1 开局 one-tap：复核交叉火力与首杀节奏` 与标签 `major-audit/opening`；保存成功后同一卡片显示 1 待复盘 / 1 复盘注释。最大化 Highlights view 为 1050px、4 列 card；1100×700 保留 card/action，复用的 annotation drawer 为 430×700。完整退出重启后正文与标签精确读回。请求完成过快，因此视觉只证明成功 mutation callback 会刷新摘要；close-during-pending 由确定性 TDD 覆盖，不能写成人工观察。
- 当前未发布产品只维护一份 exact schema；不导入或迁移旧 Demo remark，也不保留旧 annotation contract。现有 Demo remark 继续是独立字段，不伪装成 evidence annotation。
- 自由标签尚不是全局 taxonomy；缺作者/权限，以及 Agent、Round、Editor、Library 和 Player-profile review UI 的复用。Highlights 已读取并写入同一 exact annotation，但只提供 open/resolved summary 与现有 CRUD drawer，不是 accepted/rejected/needs-trim 或团队审阅队列。全局 annotation index UI 已落，`q/tag/state/page` URL/分页契约有 TDD；既有产品检查只覆盖 fresh DB 的 0 annotation 空态，最新检查没有打开全局 index，因此非空列表、多页与 Round/Replay index 深链仍是 OPEN。
- Algorithm highlight tags 与用户 tag taxonomy 必须保持分离；更丰富 review state 只能在有明确工作流后直接修改当前 contract，不预埋兼容枚举。
- Team 名称只使用 Demo 声明的 `team_name/team_clan_name` 或明确 roster-only identity；不从文件名、HLTV 页面或最终 side 猜。
- Team Round 当前只接受 domain-normalized Team A/B summary roster 与 exact per-round 10-player `_round_roster`；同队不同 side、对手同 side、winner 不属于 A/B、越界或缺失 `round_end` 都使工作台 fail closed。该单场投影不创建组织身份。
- Team Economy 复用相同的 stable-match context；purchase 必须是唯一 source ID、位于 canonical round 内并有 roster actor，任何显式 side 字段必须与该 actor 的 round side 一致。只有显式非负 cost 才能进入金额，缺 cost 保留购买数但标 partial；canonical action 从接受过的源事件重建。
- fast parser 目前没有请求 team props；Team directory 前必须先补解析、provenance 与 match-team binding。

### 5.6 Parser 边界

| 能力 | 现有数据足够 | 需要 parser/schema |
|---|---|---|
| 基础 Search、4K/5K、clutch | 是 | Evidence Index |
| Player K/D、weapon kills/damage、duels、utility、objectives | 是 | Evidence Index |
| no-scope/jump/smoke/team-kill/collateral 三态 | 仅部分 | 规范化 parser 字段 |
| shots/accuracy/hit regions | 否 | weapon_fire/bullet_impact/player_hurt |
| KAST/trade/真实 rating | 否 | 事件语义、正式公式与 metric projection |
| Activity | 四个权威持久来源 + SQLite transaction 内 summary/filter/stable page + durable Analysis Run/bounded events/exact result + final-page download/recording/analysis retryability 已有；real-Major completed success path 与双尺寸已过 | analysis failure/interruption/retry/recovery 产品门禁、cancel/heartbeat、真实多页与大库性能、虚拟化、两种外部 retry 的真实失败任务门禁 |
| Annotation/Tag | exact evidence annotation + 可编辑正文/自由标签 + open/resolved + 服务端筛选 + 全局 index + Highlights 摘要/CRUD 复用已有 | 作者/权限、全局 taxonomy、非空/多页 index 产品验收、Agent/Round/Editor/Library/Player 复用 |
| Team A/B × T/CT round control | exact summary roster + per-round roster/winner/round_end 足够 | 持久组织身份与跨比赛 continuity 仍需 team props + teams/match_teams |
| Team A/B × T/CT economy control | exact summary/per-round roster + canonical purchase actor/round/side + explicit cost/item 足够 | equipment value、economy type 与 freeze-time advantage 仍需 entity snapshot |
| 组织队名 | vendor 支持但未请求 | team props + teams/match_teams |
| 真实 equipment value/economy type | 否 | freeze-time entity snapshot |

发布构建必须让 desktop 与 sidecar 来自同一 current source/manifest。真实验收第一次用旧 sidecar 配 current desktop 时，worker response 因缺少当前必需的 `status` 被 fail-closed 拒绝；重建同源 sidecar 后 M1 分析成功。当前未发布产品不为旧 worker response 增加 version shell 或兼容解码。

## 6. 实施顺序

1. **Player atomic evidence 与 explicit compare（已实现）**：点击单场玩家进入 kills/deaths/weapons/duels/utility/objectives/highlights 原子证据，并可 Watch、跳 Round/Replay、加入制作；全局 Player profile 另以 exact participant query 显示 first-10 持久证据、总数、索引完整性与 Round/Replay/完整 Search。全局目录最多保存两个显式 Steam64 进行 ordered exact compare，跨 page/search/sort/layout 保留，第三个替换最早选择。fresh `analysisrun-audit` 的 FalleN profile 已显示三场 exact `3/3` recent matches 与 `indexed_demos=3`；最大化 Inspector 与 1100 drawer 均以自身滚动到达全部三卡且 document 无 overflow。下一步仍是真实跨页与 multi-match compare 门禁。
2. **Evidence Search tracer（已实现，multi-match 产品门禁已过）**：持久 evidence index、组合查询、canonical deep link；真实 M1/M2/M3 共 11,548 条、唯一 FalleN R20 条件结果、Round/Replay、URL 与 `scan_complete=true` 已过。剩余门禁是实跑 Watch 和应用重启后的投影复核，再扩保存查询/批量操作。
3. **Workspace primitives（页面级切片已开始）**：Library 宽屏 workspace、Queue compact empty state 与 Editor property drawer 已落，但尚未抽成完整 `WorkspacePage/DataGrid/Inspector/Drawer` 公共组件。
4. **Library power table（生产纵切已实现）**：真实 power table + 宽屏 Inspector/窄窗 drawer、SQLite 侧 search/filter/stable-sort/page、当前 URL 列选择和最多 12 个 explicit ID 的 batch Analysis selection 已落。fresh Tauri 验证 M2+M3 选择在排序后保留及双尺寸局部横滚/sticky actions；只有 3 条记录，真实跨页仍未验收。下一步是大库性能、在 Library 内嵌已有 exact run events，以及跨页 tags/comments/reveal/watch/export。
5. **Activity Center（生产纵切已实现，completed run 产品门禁已过）**：统一读取分析、下载、录制与导出权威事实，已有 search/kind/state 和 SQLite 边界稳定分页。Analysis 现有 exact run identity、固定阶段、bounded events、持久 error/input fingerprint、strict producer result、startup interruption recovery，以及只为 eligible latest terminal attempt 创建新 run 的 retry；没有虚构百分比。exact HEAD `d733b6cf8690996db516a08edc0e0df37b41851c` 的 fresh Tauri/真实 Major gate 已完成三次 run，并在 M1 证明 six-event sequence、exact result navigation 与 Activity 2560×1392/1100×700 Inspector。failed/cancelled Steam download 与 recording suffix retryability、pre-persist fail-closed 已过 TDD，但外部 failure/retry 仍未实跑。下一步是 Analysis failure/interruption/retry/recovery 产品门禁、Steam/recording failure-retry、多页/大库性能、analysis cancel/heartbeat 与其他类型 pause/resume。
6. **Advanced Analysis（进行中）**：Weapons、Duels、Utility、Openings、Clutch Review、Team Round 与 Team Economy 已落；Team Round 真实 M1 2×2 矩阵和 kill/round_end Inspector 双尺寸验收已过，Clutch Review 真实 M1 1100×700 为 20 attempts/0 wins。Team Economy 真实 M1 的四格 purchase/cost/item oracle、top-3+remainder、50 行详情在最大化通过；agent-browser 首次发现 1100×700 overlap，修复与 TDD 后已复验为单一纵向滚动、Inspector 可达且无横向溢出。M2 R16 m0NESY `1v2` 仍只有 TDD/既有 real oracle，未在 currentaudit UI 载入；Watch 未跑。仍缺 equipment value/economy type/advantage、持久 Team entity，Utility 的页面内双尺寸验收也仍未完成。
7. **Evidence Annotation（生产纵切已实现）**：exact locator、分页 CRUD、正文/自由标签编辑、open/resolved、服务端 `q/tag/state/demo/evidence` 筛选、Evidence Search drawer、全局 index 与 Highlights 摘要/CRUD 复用已落；fresh Tauri 验证 canonical Highlight 保存后摘要刷新、双尺寸 drawer 和完整重启精确读回。close-during-pending 只有 TDD。下一步是非空/多页 global index、taxonomy/权限，以及 Agent/Round/Editor/Library/Player 复用。
8. **Replay high-fidelity round pass**：连续 selected-round 模式、HUD、kill feed、绘图/音频。
9. **Team continuity**：跨比赛 Player/Team 档案、maps/matches/heatmap。

每一步必须是可见入口 → 公共 route → 持久数据 → 真实 Major 证据 → `agent-browser` 直连 Tauri/WebView2 CDP 的纵向闭环，不能只完成 DTO 或静态页面。

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

- 全局部分 `.page` 仍有约 1540px `max-width`；Library、Production 与 Outputs 已移除数据/任务页面的文章式上限。Library 的 explicit batch Analysis selection 已落，但真实跨页及其他批量动作/大库性能、Production readiness/失败聚合和 Outputs 非零结果门禁尚未闭合。
- 已闭合：Analysis header 的 compact 修复通过真实 Tauri 1100×700；header 无内溢出，tabs 位于其下，“玩家资料”中心 hit-test 命中链接，scoreboard 各列可达且 document 无横溢出。
- 已闭合：651–1279px 的全局导航使用 68px rail；图标链接保留本地化 accessible name/title，命令面板覆盖所有可独立进入的核心页面，不把缺 demo 的 Analysis 深链伪装成可执行入口。
- 已闭合 P0：Editor 低于 1400px 不再删除属性栏；常驻触发器打开同一属性面板的 focus-managed drawer，1100×700 的 Esc/focus restore/overflow 已通过。尚缺 Media drawer 与真实素材低高度门禁。
- 已闭合 P0：Replay 原先在 1100×700 把 transport 推出首屏；当前 workspace 使用完整剩余高度，底部为 678px，transport 为 677px，document 不滚动。Evidence 仍内联占宽，最终 canvas-first drawer 结构尚未做。
- 已闭合真实纵切：Library 不再固定读取前 100 条；SQLite 侧 search/map/status/sort/page、默认 50 条、URL 恢复、current-only 列选择与最多 12 个 explicit ID 的 Analysis selection 已落。fresh Tauri 选择 M2+M3 后排序仍保留 2 条；最大化 table 无横滚，1100×700 只在 972px 表容器内横滚并保留 sticky actions/pagination/selection bar。数据库只有 3 条，真实跨页/大库性能仍未验收。
- 已闭合 contract/多比赛 profile：Players 在最多 1,000 Demo 的 bounded catalog 上执行 server filter → stable sort → paginate；ordered compare 另接收最多两个显式 catalog Steam64，选择跨 page/search/sort/layout 保留。旧 M1-only gate 已验证 FalleN/NiKo compare 与搜索保持选择。current fresh DB 的 FalleN profile 显示 Inferno/Anubis/Mirage `3/3` recent matches，链接保留 `player=76561197960690195` 与 exact Demo，persistent evidence 为 `indexed_demos=3`；最大化 shell 与 1100 drawer 均 own-scroll、无 document overflow且可达三卡。首次最大化 overflow 只保留为失败基线，修复后的 final gate 已通过；真实目录跨页、大库与 multi-match compare 仍未验收。
- 已闭合空态/竞态纵切：Match History 的 exact `q/page/page_size` URL 与 stale-request 抑制已有 TDD，1100×700 未配置空态已过；真实历史行、CSV、Analysis 深链和多页仍未验收。
- 已闭合 completed 产品纵切：Activity 在 SQLite 边界执行 summary/filter/stable page；Analysis 使用 durable run/event、exact producer result、startup interruption recovery 与 run-aware open/retry。fresh `analysisrun-audit` 在真实 M1/M2/M3 完成三个 run；M1 exact row `analysis:65dd6401-278c-4c5d-be32-27ab6c9fb13a` 显示 six-event sequence、SHA/size、`result_available=true`，Analysis 与 Open link 均保留 demo+run。Activity 2560×1392 与 1100×700 无 document overflow，1100 保留 `698.7×435.9px` table + `300×437.2px` own-scroll Inspector。未闭合的是 Analysis failure/interruption/retry/cancel/recovery 的产品路径；并发/recovery 仍只有 TDD。download retry 与 recording unpublished-suffix retry 也只有 readiness/runtime/Web TDD，真实失败任务、retry、多页和性能仍未验收。
- 已闭合真实纵切：fresh M1 canonical Highlight 完成 annotation create，正文为 `M1 开局 one-tap：复核交叉火力与首杀节奏`、标签为 `major-audit/opening`，卡片刷新为 1 待复盘 / 1 复盘注释；完整退出重启后精确读回。最大化 4 列 cards 与 1100×700 430px drawer 已过；close-during-pending 是 TDD，不是视觉观察。全局 index 的非空/多页产品门禁仍未验收。
- 已闭合真实纵切：Clutch Review 在 currentaudit M1 1100×700 显示 20 attempts/0 wins。M2 R16 m0NESY `1v2` 未载入本轮 UI，仍为 OPEN。
- 已闭合真实纵切：Openings 在 M1 为 21/21 verified，10×10 actor→target 矩阵的 `karrigan→FalleN` 对应 R17 tick 143316；2560×1392 与 1100×700 均无页面横向溢出。Watch 未点击、CS2 未启动。
- 已闭合真实纵切：Team Round 在 M1 为 A/T `4/12`、A/CT `4/9`、B/T `5/9`、B/CT `8/12`，并能下钻 kill/round_end；2560×1392 与 1100×700 均无 document 横向溢出。它不创建持久 Team entity。
- 已闭合真实纵切：Team Economy 在 M1 为 A/T `456 / $255,700`、A/CT `209 / $128,650`、B/T `281 / $174,200`、B/CT `420 / $253,000`，总计 `1,366 / $811,550`、拒绝 0 条；四格各显示 3 个 item chips 与 remainder，详情页 50 行。最大化通过；首次 1100×700 被 agent-browser 判定 matrix/evidence overlap 为 P1，修复与 TDD 后复验 workspace 纵向滚动、横向隐藏，滚动到底 Inspector 位于 `483.3–677.3px`，document/body 保持 `1100×700` 且 console/errors 为空。该产品证据只覆盖单场 decoded purchases，不覆盖 equipment value/economy type。
- 已闭合当前状态：Production 双尺寸显示真实持久 Activity preview；Outputs true-zero 双尺寸保留 Production 与 staged-cleanup recovery。非零 export 的 source-project 深链和 Editor deleted-source fail-closed 1100×700 已过；其他非零 metadata/动作与 cleanup 执行仍未验收。
- Queue 零项的装饰统计与无效操作栏已移除；非空编辑计划已通过 WebView local storage + reload 实测恢复。后台 recording job 有持久状态、发布复核、orphan terminalization 与只重放可证明 unpublished suffix 的 durable child retry，但这不等于可从中间 capture tick 续跑；recovered active id 的 cancel fallback 和真实 CS2/HLAE retry 仍只有测试门禁。
- Player 单场原子证据、最多两名显式目录玩家 compare、全局 profile 的 first-10 exact involvement evidence 与三场 recent matches 已接线；Player 最大化 overflow 修复已用 final build 复验。未完成的是真实跨页/multi-match compare、maps/charts/heatmap 和持久 Team entity。

这些问题必须通过工作台结构和公共能力一起解决；单独删除 `max-width` 只会把无用内容拉得更散。
