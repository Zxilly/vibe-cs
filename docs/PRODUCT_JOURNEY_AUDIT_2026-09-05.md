# 产品流程审查与用户故事（2026-09-05）

状态：审查与实验完成；本文件不是功能全部验收通过的声明。
审查基线：`8e4b9f1`，UNRELEASED。主 Agent 实际操作 Tauri WebView2；三个子 Agent 分别审查素材/录制/导出、Agent 协作、人类时间轴。生产代码没有修改，未设置 Agent 工具次数限制。

## 1. 产品判断

Vibe CS 要让一个人和 Agent 在同一个 Project 中完成“Demo 证据 → 选材 → 待录镜头 → 可用素材 → 时间轴编辑 → 成片交付”。统一 Editing Document、Timeline Transport、Capture Intent / Take 和单一 Agent Conversation Projection 符合这个目标，值得保留。

当前更大的问题是能力之间的衔接。单项插入、撤销、停止和导出都有实现，但连起来会出现错误目标、状态丢失和过早承诺。应优先修复这些故事级缺陷，而不是继续增加专业工具按钮。

审查依据：AGENTS.md、CONTEXT.md、README.md、TIMELINE_PRODUCT_REQUIREMENTS.md 以及下面列出的调用链。FEATURES.md、PRODUCT_CAPABILITIES_AND_VISUAL_REDESIGN_BRIEF.md 中仍有独立 Montage、Agent 修改前确认和本地服务状态等旧描述；有冲突时以 AGENTS / CONTEXT 和当前代码为准。建议用本轮故事验收替换过时的“功能存在即完成”判断。

## 2. 用户故事与验收门槛

### US-01 首次使用：从比赛中手工取一个 NiKo 镜头

作为高光创作者，我希望导入本地 Demo、找到 NiKo 的关键操作、设置入出点并加入当前作品，得到一个可录制的片段。

1. 选择真实比赛规模的文件后，界面始终可操作，能看到成功或失败；重试不会重复建库。
2. 分析完成后可识别选手、回合和可用证据；稀疏数据、缺失地图底图不能伪装成连续真实回放。
3. 从作品进入 Demo 选材保留目标作品；创建后回到同一 Project，显示选手、源区间、待录状态。
4. 不相关的代理预览、标记跟随、其他轨道和时间轴设置保持原样。

本轮：真实 Mirage 文件可以入库，重启后分析约 12 秒完成；选择 NiKo 的 tick 60–61 做选区功能 smoke，成功加入本轮测试 Project，版本从 1 到 2，待录 1 / 已录 0，战术面板能显示 Mirage 地图。录制确认可打开和取消，缺失素材时导出被禁用。该片段仅测试身份和入出点传递，不代表精彩镜头质量；默认 padding 后序列显示 2.516 秒。上传期间两次出现页面 renderer 退出，不能判为完整通过。组件测试另确认加入片段会重置两项设置。

### US-02 精剪：同一素材取两段，加字幕和背景音

作为剪辑者，我希望从同一视频取 0–3 秒与 6–9 秒，分别放在开场和结尾，再加字幕、背景音和转场。

1. 源素材始终可在 Project 素材库重复使用；每次插入获得独立 Timeline Placement，源资产不复制。
2. Source In/Out 不改变 Program 的时间轴位置；预览、波形和输出采用相同源范围、速度和混音语义。
3. Story 编辑关闭间隙；自由轨不被无意移动。每个手势一次提交，取消手势不产生修改。
4. 代理只是预览选择，最终输出使用正确素材；一次插入不关闭代理。

本轮：基础编辑、音频/字幕、预览与 Undo/Redo 有组件级路径；但源素材使用一次后失去再次插入/覆盖入口，该故事失败。真实媒体流畅度与音画输出未验收。

### US-03 Agent 理解“这里”，完成一组可解释的修改

作为创作者，我希望选中几个片段或一个时间范围，说“把这里压缩到 15 秒，保留结尾”，Agent 准确理解我的指向。

1. 本轮上下文包含项目 revision、选择的片段/轨道、播放头、入出点；通过小型引用渐进读取证据。
2. 不确定的意图才提问；工具输出与 HITL 都在同一对话流中。
3. Agent 修改期间人类只读但可检查和停止；Agent 不抢走人类选择。
4. 完成时说明修改范围、时长变化和重新录制需求；整条重规划仍可作为一个高层操作。

本轮：当前 Workspace Context 只有 projectId、lens、selectedClipId，缺少播放头、多选和范围。不能把完整上下文感知标成已实现。没有真实模型任务或质量评分，因此不能量化改进后的成功率。

### US-04 定向审阅：撤回 Agent 修改，保留我之后的编辑

作为审阅者，我希望 Agent 改好片段后再手工加标记，然后撤销 Agent 的“这组修改”，保留自己的标记。

1. 注释展示的 Change Group ID 必须与撤销请求 ID 一致。
2. 全局 Undo 与定向撤销是不同意图；定向撤销不触碰无关的后续修改。
3. 有冲突时显示实际冲突字段；不能静默回滚整份文档。

本轮：真实 Workspace React 交互探针失败，按钮把最新 Human group 发给撤销接口。属于高优先级正确性缺陷。

### US-05 停止与继续：保留完成部分，恢复人工控制

作为剪辑者，我希望随时停止 Agent，已完成的修改仍可见、可撤销，下次“继续”不会失去已完成步骤。

1. Stop 之后旧事件不能再写回复或清理新请求状态。
2. AgentSession 创建/执行/终态写入任一步失败都能恢复输入和人工编辑；错误可理解，输入不丢。
3. 有已提交修改的 interrupted group 是可撤销历史，不应跳过它撤销更早的人类编辑。
4. 下一轮保留取消前完成的工具证据，并读取当前 Project Head。

本轮：持久化失败卡只读、Stop 后旧文本复现、interrupted 撤销目标错误均有交互实验；Cancelled 工具证据被过滤有静态证据。该故事失败。

### US-06 录制与交付：补齐失败镜头，导出当前作品

作为创作者，我希望录制中途失败后保留成功 Take，只补齐剩余镜头，确认完整后输出可播放的视频。

1. 录制前展示范围、依赖与错误原因；确认后才执行外部副作用。
2. Take 回填原 Timeline Clip，重试不重复已兼容素材；Capture Intent 改变会使旧 Take 过期。
3. 拒绝更新原工具卡且重开后保持；过期 revision 或缺失素材不能批准导出。
4. 导出检查与真正渲染消费相同的启用内容；禁用片段不阻塞其余成片。
5. “接受修改”“素材可导出”“成片已生成”含义明确；输出必须能定位到实际文件和项目版本。
6. 实际验收至少检查输出时长、目标选手、帧范围、黑帧/重复帧、音画同步、字幕与音量。

本轮：预检、任务终态刷新、HITL 拒绝和导出入口测试通过；未运行真实 CS2/HLAE 录制和视频编码，整条交付链未验收。存在未录制即宣称可交付，以及禁用嵌套依赖仍阻塞的缺陷。

## 3. 实际桌面操作记录

环境：Windows，Tauri debug，Vite 当前源码，`VIBE_CS_CDP_PORT=9341`，通过 agent-browser 直接操作 WebView2。原始截图 2160×1350。没有沿用历史截图作为证据。

| 步骤 | 实际操作与结果 | 判定 |
| --- | --- | --- |
| 1 | 启动，工作台加载；新建空作品进入统一编辑器 | 可用 |
| 2 | 默认布局中 Project 工具栏、空状态文案被右侧裁切 | 布局缺陷 |
| 3 | “从 Demo 创建剪辑”进入携带 project 参数的资料库 | 可用 |
| 4 | 选择并导入 `furia-vs-falcons-m1-mirage.dem`（438,520,684 bytes） | 两次 renderer 退出，失败 |
| 5 | 重启，库内有一条 Demo，重复上传未产生第二条 | 入库/去重成功，反馈失败 |
| 6 | 点击分析，任务显示完成约 12 秒；de_mirage、21 回合可见 | 本次分析通过 |
| 7 | 从 Demo 创建剪辑，选择 NiKo，设入点/下一帧/设出点 | 选区路径可用；仅功能 smoke，非精彩镜头验收 |
| 8 | 打开“加入作品”对话框，选择本轮测试 Project | 对话框可用；同名作品难区分 |
| 9 | 点击加入，再“打开作品”：同一 Project 版本 2，待录 1 / 已录 0，Mirage 地图可见 | 创建到工作区成功 |
| 10 | 缺失媒体时“导出成片”禁用；打开录制确认后取消 | 基础 Gate / 确认入口通过，未执行录制 |

截图目录：`C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-audit-20260905/`。

- `01-home.png`：启动。
- `02-empty-editor.png`：默认布局裁切与空项目检查通过状态。
- `03-imported-after-restart.png`：第一次故障后重启，文件已入库。
- `04-before-import-repeat.png`：第二次导入前。
- `06-analysis.png`：真实分析任务完成，成品数量为 0。
- `07-niko-replay.png`：NiKo 选择与回放控制；地图底图未显示，界面标注使用 fallback 标定。
- `08-add-to-project.png`：加入作品对话框。
- `10-unrecorded-project.png`：已加入的 NiKo 片段、地图和未就绪状态。
- `11-record-confirmation.png`：录制确认对话框；本轮点击取消，未启动 CS2。

本轮保留的测试数据：Project `466cbbc1-ce2e-4d73-81ca-96392fc388b4`（界面默认名称“新作品”）及其中一段 NiKo 取段；已导入和分析的 Mirage Demo。没有修改源 Demo、既有项目内容或导出文件。没有为了恢复页面而删除数据库。

故障时 Page.captureScreenshot 返回 Internal error 或一直不能完成；未把失败截图当作有效证据。第一次桌面 PID 42164 保持 Responding=True；第二次导入前 renderer PID 95920，导入后通过带 app.vibecs.desktop 过滤的进程列表找不到 renderer，而主进程 PID 123540 仍 Responding=True。底层退出原因尚无 crash dump 证明，不写成已确认 OOM。

## 4. 缺陷清单与修复方向

### P1-01 大文件导入后页面 renderer 退出

严重度高，现象置信度高（两次桌面复现），根因置信度中。

触发：上述 Mirage 文件经“导入 Demo → 选择文件 → 导入”上传。文件已入库，但用户无法继续，必须重启。

相关代码：`apps/web/src/shared/desktop/client.ts:259` 整文件 arrayBuffer 经 invoke 发送；`apps/desktop/src-tauri/src/bridge.rs:488` Raw body 再 clone。文件仍在声明的 2 GiB 导入上限内（`crates/application/src/routes/demos.rs:33`）。这些是大对象传输的调查线索，尚不能仅凭静态代码断言退出机制。

方向：用 renderer 崩溃信息和不同文件体量确认接缝；评估让原生文件选择返回本地路径，由 Rust 流式读取，避免本地文件完整往返 WebView。继续保留路径、类型和大小校验。不要加通用重连框架掩盖失败。

### P1-02 撤销动作丢失目标身份或跳过 interrupted 修改

严重度高，置信度高，两个真实组件探针失败；合并为同一“历史动作资格与目标”修复主题。

- Agent 注释的“撤销这组修改”调用全局 onUndo。Agent group ...0070 后有人类 ...0071 时，实际发送 ...0071。证据：`ProjectWorkspacePage.tsx:602,604,1125,1289`；`ProjectTimeline.tsx:2547,5503,5644`。
- `projectHistory.ts:25` 只纳入 completed，Ctrl+Z 跳过有已提交修改的 interrupted ...0025，实际撤销较早 human ...0024。

后果：改动了用户没有要求撤销的内容。根因：定向操作身份丢失，并把“正常结束”当成“可逆”。方向：定向回调带实际 group ID；全局历史包含已提交且终止的 interrupted 组；保留冲突处理，不引入第二套 Undo 权威。

### P1-03 Agent 一轮生命周期不能正确清理失败与迟到事件

严重度高（失败卡编辑）；置信度高（hook 实测）。

- `data/sessions.ts:418,433,437,500`：streaming=true 后两次 append 在 try 外。第一次 append 失败时 streaming=true/error=null；`ProjectWorkspacePage.tsx:569` 因此继续只读。
- `sessions.ts:386,465,512`：Stop 清 request ID，但旧回调仍改 draft。实验中 streaming=false 而 draft 重新出现 late old response。后端取消时 flush pending_text（`agent.rs:1455`）使这不是仅建立在断线假设上的问题。

根因：一轮请求的所有权和清理范围不完整。方向：创建到终态覆盖在同一生命周期清理内；事件和清理确认仍属于当前请求；保留输入与错误。不需要框架更换、逐工具持久化或工具调用上限。

### P1-04 已使用源资产失去再次插入能力

严重度高，置信度高（实际 ProjectMediaPanel 组件复现）。

`ProjectMediaPanel.tsx:1291,1298,1319,1323` 从 importedItems 排除被引用 asset，同时 timelineItem.importedAsset=null；`:253,269,455` 由 importedAsset 控制插入/覆盖。第一次用逗号插入能调用 onInsert，引用后按钮消失、逗号无动作。

根因是产品模型限制：源素材和它的一次 Timeline 用法被视作互斥身份。方向：源资产可复用，独立显示使用次数和已录/待录状态。现有测试“never ... place again”固化该限制，必须按新验收改写。Timeline 复制可以绕行，但不能替代源取段流程。

### P2-01 加入 Demo 片段误重置项目设置

严重度中，置信度高（基线/消融）。`domain/project/collectedClip.ts:47` 构造 replace_settings 时将 ripple_sequence_markers/use_media_proxies 写成 false；`AddToProjectDialog.tsx:66` 将它应用到已有 Project。

根因：局部追加携带无关默认值。移除这两项默认重置、继承当前 settings 后，clip/capture/revision 输出完全相同且设置保留。应作局部修复。

### P2-02 把修改待审阅误报为成片可交付

严重度中，置信度高（组件复现）。`ProjectAgentPanel.tsx:119,238` hasDelivery 只看修改组和 completed assistant，deliveryReady=false 也渲染“成片可以交付了”。实际导出仍有 gate，未发现由此绕过导出校验。

根因：编辑审阅与文件交付状态混用。方向：显示“修改待审阅/接受修改”；实际产物交付关联输出文件、版本和 Gate。

### P2-03 取消轮的完成工具证据被过滤

严重度中，置信度高（静态确认；模型行为未评测）。`sessions.ts:399` 保存 cancelled 工具调用；`apps/desktop/src-tauri/src/agent_context.rs:234,245,254` 不将 Cancelled 放入后续上下文。

方向：Cancelled 和 Failed 共享完成工具证据投影，保留当前 Head checkpoint。没有真实模型实验，不能声称已经证明重复编辑率。

### P2-04 嵌套片段的 enabled 规则前后不一致

严重度中，置信度高，区分两条证据强度：

- UI 实测：`timelineSelection.ts:53` canNestSelection 漏 enabled；`ProjectTimeline.tsx:579,2279,2831` 菜单和确认可用；后端 `routes/projects.rs:795` 明确拒绝 disabled Story。应提前解释不能嵌套的原因。
- 静态调用链：`routes/projects.rs:239` 和 `runtime/export.rs:228` 检查禁用 Sequence 依赖，而 `media/plan.rs:160` 不渲染禁用片段。禁用过期嵌套片段仍可能阻塞导出。应统一实际消费内容与依赖检查，补运行时验收。

### P2-05 默认布局裁切主要选材入口

严重度中，置信度高（本轮截图）。新建作品后默认 Project 宽度中，“待录/已录”换成多行，“从 Demo 创建剪辑”、导入和空状态文案被裁切；Timeline 工具栏底部也受可视高度约束。证据 `02-empty-editor.png`。

方向：在默认 1440×900 逻辑窗口及 Windows DPI 下验证面板最小宽度、工具栏溢出收纳和内部滚动。优先确保导入、选材、预览和时间轴可发现、可操作。此项是实际布局缺陷，不以屏幕阅读器整改代替。

## 5. 消融实验

消融只在临时副本或测试接缝改变一个变量，生产实现未改。所谓“passed”有时是成功断言错误现象，不能当成功能通过。

| 实验 | Baseline | 唯一消融 | 结果与决策 |
| --- | --- | --- | --- |
| 加入片段时写默认设置 | 原设置 true 变 false | 取消两项硬编码 false，继承当前设置 | 设置保持；clip/capture/base_revision 相同。删除这两处重置行为 |
| HITL 对话投影 | 拒绝卡保持 rejected，无批准按钮 | 去掉 tool_decision | 回到 awaiting_confirmation，批准按钮重新出现。保留决定合并 |
| Timeline Selection Lease | 5 新探针中 2 通过/3 已知失败 | 只把 selection 的 readOnly 输入改 false | 1 通过/4 失败，新增失败为 Agent 占用时菜单可编辑。保留这项职责 |

没有据此删除 Capture Intent、Delivery Gate、Change Group 或 Edit Lease；它们承载真实信息与行为。没有设置 Agent 工具循环限制，也没有添加复杂工作流框架。

## 6. 测试证据与复跑

- Timeline 现有工作区 198 + selection 5 = 203 项全通过；新增故事探针 3 失败/2 通过，消融后 4 失败/1 通过。
- Agent 2 文件/8 项通过，其中 4 项诊断证明当前错误行为；HITL 消融包含在内。
- Library/Replay/collect 23 项通过；录制预检/终态/导出等选测 10 项通过（与前一集合部分重叠，不相加宣称覆盖）；素材复用与设置消融共 5 项通过（诊断）。
- 各子任务临时测试已移出仓库，无生产修改。

完整命令、文件放置说明、探针及 JSON：

1. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-audit-timeline.md`
2. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-timeline-probe.interaction.test.tsx`
3. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-timeline-baseline.json`
4. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-timeline-ablated.json`
5. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-audit-agent.md`
6. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-audit-agent.repro.tsx`
7. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-audit-media.md`
8. `C:/Users/12009/AppData/Local/Temp/vibe-cs-pm-media-evidence/`

这些是本机临时证据，可能被系统清理；本文件保留结论、触发条件、代码位置和验收要求。

## 7. 后续迭代顺序

1. **保证操作不会改错东西**：定向撤销、interrupted 历史、Agent 请求生命周期；通过 US-04/05。另将大文件导入 renderer 故障作为首次使用阻断优先定位。
2. **打通选材到精剪**：源资产复用、追加片段保留设置、默认素材栏溢出；通过 US-01/02。将同一份 Project 从源导入到二次取段持续演进，而非每个测试重新造初始状态。
3. **打通可信交付**：审阅与成片文案分离、enabled 依赖统一；真实录制一段短镜头并导出，检查输出内容，再扩展到部分失败后重试的 US-06。
4. **提高 Agent 任务理解**：补多选/轨道/范围/播放头的紧凑上下文；保留 cancelled 完成证据；用 US-03 做真实模型对照评测。以完成率、错误修改数、澄清次数、上下文体积评价，禁止只用 token 减少作为成功标准。

现阶段继续横向堆功能收益较低。下一轮更适合修复和重跑上述六个故事；真实 HLAE 镜头质量、媒体性能和最终输出仍值得单独的端到端验收。
