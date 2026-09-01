# Vibe CS 统一时间轴产品需求文档

| 字段 | 内容 |
| --- | --- |
| 文档状态 | Active / 迭代基线 |
| 产品状态 | UNRELEASED |
| 负责人 | Product + Editing |
| 基准产品 | Adobe Premiere Pro Desktop |
| 审计日期 | 2026-09-01 |
| 实现范围 | `domain/editing/ProjectTimeline`、Program Monitor、Project Media、Inspector、Project Change Groups |

## 1. 背景与问题

Vibe CS 需要的不是“能摆几个片段”的演示时间轴，而是一套可以承载真实剪辑、录制、导出和 Agent 协作的统一编辑界面。Adobe Premiere Pro 是交互和能力基准；Vibe CS 不复制其视觉皮肤，但应复用成熟的编辑概念、快捷键和可预期行为。

当前产品已经具备较深的直接编辑能力，但过去的开发是逐项补齐，缺少一份完整、可验收的产品基线。结果是：已经实现的能力不容易被看见，缺口的优先级不明确，新功能也容易绕过统一 Timeline Module。

本文档解决三个问题：

1. 定义一个完整时间轴必须支持的操作集合。
2. 逐项标记 Vibe CS 当前实现状态与偏差。
3. 把缺口组织为可连续交付的产品里程碑。

## 2. 产品目标

### 2.1 用户目标

- 人类剪辑师可以只使用一个统一工作区完成素材选择、组接、精剪、音频、审阅、录制和导出。
- 熟悉 Premiere 的用户不需要重新学习最基本的时间轴心智模型和快捷键。
- Agent 使用同一个 Project Head 和同一套编辑操作，可以一次重排整个 Story，也可以做精确的单片段修改。
- Agent 持有 Edit Lease 时，人类仍能浏览、播放和检查，但所有修改入口明确只读。
- 每次完成的手势只产生一个可撤销 Change Group；拖动预览不写入中间状态。

### 2.2 业务目标

- 时间轴上不存在“看起来可点但没有行为”的控件。
- 所有录制、预览、导出和 Agent 工具都消费相同的 Timeline Clip identity。
- 任何导出都可追溯到明确的 Project revision。
- 通过自动化交互测试覆盖所有 P0/P1 编辑命令和快捷键。

### 2.3 非目标

- 不克隆 Premiere 的菜单结构、颜色或面板皮肤。
- 不引入第二套时间轴模型、兼容层或插件式编辑引擎。
- 不在本阶段实现 Premiere 的每一种专业格式、第三方特效或广播交付能力。
- 不用通用工作流引擎替代 Project Patch、Change Group、Edit Lease 和 Agent Session。

## 3. 关键产品决策

### 3.1 一个权威编辑文档

时间轴、Program Monitor、Tactical Monitor、Inspector、录制、导出和 Agent 都读取 canonical Editing Document。任何可见修改必须通过 Project Patch 写回 Project Head。

### 3.2 Story 与自由轨的语义差异

- Story Track 是成片叙事主轨：移动、修剪、切分和删除采用波纹语义并闭合间隙。
- 其他视频、音频和文字轨默认自由定位，不因为普通删除自动闭合间隙。
- 后续的 Sync Lock 明确控制 Story 波纹是否带动其他轨道；不能暗中把所有轨道改成 Story。

这与 Premiere 的“Clear”和“Ripple Delete”可分别选择不同：Vibe CS 在 Story 上有意选择 gapless 默认值，必须在 UI 和文档中明确。

### 3.3 Program Monitor 从属于 Transport

Program Monitor 不拥有独立播放条。时间轴播放头是唯一 Transport authority；媒体池保持稳定挂载，seek 合并到最新目标，替换帧准备好之前保留上一帧。

### 3.4 Agent 是编辑者，不是第二套界面

- Agent 工具调用、输出和 HITL 是一个对话流。
- Agent 改动直接显示在时间轴位置上，而不是另建“建议时间轴”。
- Agent 可以原子地重排整个 Story；人类直接操作仍按完成手势提交。
- Agent 操作期间人类只读；HITL 结果显示在对应 Tool UI 内。

### 3.5 素材状态是时间轴的一等信息

Timeline Clip 必须明确显示 Planned、Recorded、Imported、Stale/Needs Recording 等物化状态。未录制片段仍然是真实 Timeline Clip，不使用占位模型。

## 4. 用户与核心任务

| 用户 | 主要任务 | 成功标准 |
| --- | --- | --- |
| 人类剪辑师 | 组接并精剪 NiKo 集锦 | 不离开统一工作区即可完成 3 分钟 Story、音频和交付 |
| 人类审阅者 | 检查 Agent 修改 | 在变化发生的位置理解新增、删除、时长和波纹影响，并可撤销 Change Group |
| Agent | 分析 Demo、重排时间轴、请求录制/导出 | 渐进读取必要上下文，原子提交，等待 HITL 时不产生外部副作用 |
| 录制/交付操作者 | 补录缺失镜头并导出 | 每个输出绑定当前 revision，过期输出不会伪装成当前交付 |

## 5. 交互原则

1. **焦点决定快捷键作用域。** Timeline 获得蓝色焦点状态后，Space、JKL、剪辑和导航快捷键才作用于 Timeline。
2. **播放头不拖动片段。** 标尺或播放头拖动只改变时间；选中片段保持原位。
3. **预览与提交分离。** Pointer Move 只更新 draft；Pointer Up 提交一个 Project Patch；Cancel 恢复原值。
4. **帧对齐。** 所有播放头、移动、修剪、转场、标记和关键帧时间都吸附到项目 fps 的帧网格。
5. **吸附可见。** 吸附到片段边缘、标记或播放头时显示单一垂直 guide；Shift 临时反转当前手势的吸附行为。
6. **锁定是硬边界。** 锁定轨可以被查看和选中，但不能被移动、修剪、删除、粘贴、链接或 Agent 局部编辑。
7. **没有死按钮。** 不可用命令保持禁用，并在 Hover/Focus 说明原因；可用命令必须有真实结果和回归测试。
8. **操作可逆。** 人类和 Agent 的完成编辑都进入同一 Change Group 历史；Undo/Redo 不能只在本地伪造。

## 6. 状态定义

| 标记 | 含义 |
| --- | --- |
| ✅ 已实现 | 当前生产路径存在，并有代码或交互测试证据 |
| 🟡 部分实现 | 主路径存在，但少了 Premiere 基线中的重要子能力 |
| ⬜ 未实现 | 当前生产路径中没有该能力 |
| ⛔ 有意不采用 | 与 Vibe CS 产品模型冲突，保留明确差异 |

优先级：P0 阻断可靠剪辑或可逆性；P1 是完整剪辑器核心；P2 是专业效率；P3 是高级/特定工作流。

## 7. 功能需求与当前实现审计

### 7.1 面板、焦点与显示

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-UI-01 | 全高 Project 面板 | 素材库全高停靠，支持列表/图标、搜索、状态筛选 | ✅ | P0 |
| TL-UI-02 | 可停靠工作区 | Project、Program、Tactical、Timeline、Agent 可分栏、停靠、合并 Tab、调整尺寸、最大化和重置 | ✅ | P0 |
| TL-UI-03 | Timeline 焦点 | 指针操作后 Timeline 获得键盘焦点；面板焦点有明确视觉状态 | ✅ | P0 |
| TL-UI-04 | 统一浅色设计系统 | 使用 `theme.css`、`design/timeline`、`design/review`，无页面私有时间几何 | ✅ | P0 |
| TL-UI-05 | 轨道高度 | 单轨展开/折叠、拖动高度，视频缩略图和波形随高度重排 | ✅ | P1 |
| TL-UI-06 | 轨道显示设置 | 切换片段名称、缩略图、波形、关键帧、重复帧/Through Edit 标记 | 🟡 目前名称、缩略图、波形和关键帧固定显示，无设置面板 | P2 |
| TL-UI-07 | 时间码输入 | 播放头时间码可点击输入、拖动 scrub、切换时间码/帧计数 | ⬜ | P2 |
| TL-UI-08 | 工具说明 | 所有工具 Hover/Focus 显示名称、快捷键、行为或不可用原因 | ✅ | P0 |

### 7.2 时间导航、缩放与滚动

Premiere 的标尺、播放头、Work Area 和底部 Zoom Scroll Bar 行为参考 Adobe 的 [Timeline navigation controls](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline.html)、[Navigate sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigate-sequences-in-the-timeline.html) 与 [Timeline preferences](https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/timeline-preferences.html)。

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-NAV-01 | 标尺与播放头 | 标尺点击/拖动、播放头拖动、全轨垂直线、帧对齐 | ✅ | P0 |
| TL-NAV-02 | 播放头吸附 | Shift-drag 临时吸附到片段边缘和标记，不移动片段 | ✅ | P0 |
| TL-NAV-03 | 缩放按钮/快捷键 | `=`/`+` 放大，`-` 缩小，保持播放头或指针下的时间 | ✅ | P0 |
| TL-NAV-04 | Fit | `\`、适应按钮、完全展开 Zoom Bar 都显示完整序列；长序列允许低于普通缩放阶梯 | ✅ | P0 |
| TL-NAV-05 | Zoom Scroll Bar | 中间拖动平移；两端拖动缩放；不移动播放头 | ✅ | P0 |
| TL-NAV-06 | Windows 滚轮 | 普通滚轮只水平；Ctrl 临时只垂直；到边界不切换轴；Alt 围绕指针缩放 | ✅ | P0 |
| TL-NAV-07 | 页面滚动 | Page Up/Down 左右移动一个可视页 | ✅ | P1 |
| TL-NAV-08 | 播放跟随 | 默认 Page Scroll；播放头离开页面才翻页；暂停导航只做最小 reveal | ✅ | P0 |
| TL-NAV-09 | Smooth Scroll | 可选让播放头固定在中间，内容连续滚动 | ⬜ | P2 |
| TL-NAV-10 | 手形/缩放工具 | H 拖动画布、Z 点按缩放，作为 Zoom Bar 的等价入口 | ⬜ | P2 |
| TL-NAV-11 | 手势边缘滚动 | 拖片段、修剪、框选接近边缘时水平/垂直自动滚动 | ✅ | P1 |

### 7.3 Transport 与定位

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-TR-01 | 播放/暂停 | Space 和 Program 按钮调用同一 Transport | ✅ | P0 |
| TL-TR-02 | 帧步进 | Left/Right 一帧，Shift 五帧；Program 上一/下一帧一致 | ✅ | P0 |
| TL-TR-03 | J/K/L Shuttle | J 反向、K 停止、L 正向 | ✅ | P0 |
| TL-TR-04 | 多级 Shuttle | 重复 J/L 提升速度；K 停止；连续按键提升到 4× | ✅ | P2 |
| TL-TR-05 | 编辑点导航 | Up/Down 在目标轨编辑点间移动，Shift 覆盖全部轨 | ✅ | P1 |
| TL-TR-06 | 入出点 | I/O 设置，显式清除；Lift/Extract/导出消费同一范围 | ✅ | P0 |
| TL-TR-07 | 跳转入出点 | Shift+I / Shift+O，清除单侧和双侧快捷键 | ✅ | P1 |
| TL-TR-08 | 循环播放 | 序列或 In/Out 范围循环 | ✅ | P2 |
| TL-TR-09 | Match Frame | F 从播放头打开最高目标轨的精确源帧 | ✅ | P1 |
| TL-TR-10 | 稳定媒体池 | 切片/拖播放头不重新挂载视频；seek 合并且保留上一帧 | ✅ | P0 |

### 7.4 选择、链接、分组与目标轨

Adobe 的基准行为参考 [Select clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/select-clips.html)、[Track Targeting](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/work-with-clips-on-the-timeline-using-track-targeting.html) 和 [Sync Lock](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/sync-lock-to-prevent-changes.html)。

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-SEL-01 | 单选/加选/范围 | 点击单选、Ctrl/Cmd 加选、Shift 同轨范围选择 | ✅ | P0 |
| TL-SEL-02 | 框选 | 空白处拖动框选，Ctrl/Cmd 增量框选，支持边缘滚动 | ✅ | P0 |
| TL-SEL-03 | 全选/取消选择 | Ctrl/Cmd+A 选择目标轨；Ctrl/Cmd+Shift+A 清空 | ✅ | P1 |
| TL-SEL-04 | Track Select | A 向前、Shift+A 向后；Shift-click 跨全部轨 | ✅ | P1 |
| TL-SEL-05 | Linked Selection | 全局开关；Alt 只选/只编辑一个声道 | ✅ | P1 |
| TL-SEL-06 | Link/Unlink | Ctrl/Cmd+L 与按钮原子更新跨轨 link group | ✅ | P1 |
| TL-SEL-07 | Group/Ungroup | Ctrl/Cmd+G 与 Ctrl/Cmd+Shift+G 写入独立 `group_id`；Group 始终扩展选择和移动，Link 只在 Linked Selection 开启时扩展；复制粘贴继续重建组 identity | ✅ | P2 |
| TL-SEL-08 | Track Targeting | 多目标轨控制 Add Edit、粘贴、导航、转场和 Match Frame | ✅，Match Frame 尚缺 | P0 |
| TL-SEL-09 | Source Patching | Source 视频/音频分别映射目标轨，可禁用某个 source channel | ✅ | P0 |
| TL-SEL-10 | Sync Lock | 每个 canonical 轨道有开关；Shift 点击切换同类轨；Story insert/ripple/extract/trim 用稳定 Clip identity 推导偏移并在同一 Patch 平移未锁自由轨 | ✅ | P1 |

### 7.5 轨道管理

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-TRACK-01 | 添加轨道 | 视频、音频、文字轨；Source Patch 缺轨时可同一 Patch 创建 | ✅ | P0 |
| TL-TRACK-02 | 删除轨道 | 非 Story 轨可删除；不删除源文件 | ✅ | P1 |
| TL-TRACK-03 | 重排轨道 | 非 Story 轨上下重排，保持 ID 和片段 | ✅ | P1 |
| TL-TRACK-04 | 轨道锁定 | 锁定轨可看不可改，链接编辑不穿透锁 | ✅ | P0 |
| TL-TRACK-05 | 输出控制 | 视频/文字 Eye，音频 Mute，Program 和导出一致 | ✅ | P0 |
| TL-TRACK-06 | Solo | 单独监听一条或多条音频轨 | ✅ | P2 |
| TL-TRACK-07 | 轨道命名 | 内联或 Inspector 重命名，保持 track ID | ⬜ | P2 |
| TL-TRACK-08 | 跨轨移动 | 兼容片段可垂直拖到另一条轨并一次提交；自由轨使用 Overwrite；Story compound 离开 Story 时拆成共享 Link Group 的视频/音频，进入 Story 时重新合并；缺少音频轨时同一 Patch 创建 | ✅ | P1 |

### 7.6 素材组接与三点编辑

Adobe 的 Insert/Overwrite 与 Source Patching 参考 [Add media using Source Patching](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/add-media-to-the-timeline-using-source-patching.html)。

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-ASM-01 | Project 素材库 | Planned、Recorded、Imported 分组/筛选，搜索、列表/图标视图 | ✅ | P0 |
| TL-ASM-02 | Source Monitor | 源播放、逐帧、源 In/Out、保持上一素材帧直到新源 ready | ✅ | P0 |
| TL-ASM-03 | 拖放组接 | 从 Project 拖到兼容轨；默认 Overwrite，Ctrl/Cmd 为 Insert | ✅ | P0 |
| TL-ASM-04 | Insert | `,` 或 Source 按钮插入并波纹；使用 Source Patch | ✅ | P0 |
| TL-ASM-05 | Overwrite | `.` 或 Source 按钮覆盖时间范围，不移动后续时间 | ✅ | P0 |
| TL-ASM-06 | 三点/四点编辑 | Source In/Out + Timeline In/Out；范围冲突时可选择 Fit 行为 | 🟡 已有两侧范围，缺 Fit Clip 决策 | P2 |
| TL-ASM-07 | Cut/Copy/Paste | Ctrl/Cmd+X/C/V；Paste Overwrite 与 Paste Insert；链接关系重建 | ✅ | P0 |
| TL-ASM-08 | Duplicate | Ctrl/Cmd+Shift+/ 在目标位置复制选择 | ⬜ | P2 |
| TL-ASM-09 | Replace Edit | 用新源替换选中片段并保留时间位置、长度和效果 | ✅ | P1 |
| TL-ASM-10 | Relink | 源文件改变位置后重连，不改变 Timeline identity | ✅ | P0 |
| TL-ASM-11 | Automate to Sequence | 按 Project 排序/标记批量组接，并可应用默认转场 | ⬜ | P3 |

### 7.7 片段移动、删除与范围编辑

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-EDIT-01 | 移动 | 拖动片段或选择组；Story 重排并闭合，其他轨自由定位 | ✅ | P0 |
| TL-EDIT-02 | Nudge | Alt+Left/Right 一帧，Alt+Shift 五帧 | ✅ | P1 |
| TL-EDIT-03 | Add Edit | Ctrl/Cmd+K 目标轨，Ctrl/Cmd+Shift+K 全部未锁轨 | ✅ | P0 |
| TL-EDIT-04 | Razor | C 点击切分；Shift 跨轨；Alt 仅当前声道 | ✅ | P0 |
| TL-EDIT-05 | Clear | 删除选择并保留空隙 | ✅ 自由轨；⛔ Story 采用 gapless 产品语义 | P0 |
| TL-EDIT-06 | Ripple Delete | 删除并关闭间隙；Track Lock 阻止修改，Sync Lock 决定其他轨移动 | ✅ | P1 |
| TL-EDIT-07 | Gap 操作 | 选择 gap、Ripple Delete gap、关闭全部 gap | ⬜ | P2 |
| TL-EDIT-08 | Lift | `;` 删除目标轨 In/Out 内容并保留范围空隙，同时复制到剪贴板 | ✅ | P1 |
| TL-EDIT-09 | Extract | `'` 删除目标轨 In/Out 内容并闭合范围，同时复制到剪贴板 | ✅ | P1 |
| TL-EDIT-10 | Q/W Ripple Trim | 把选中 Story 起点/终点波纹裁到播放头 | ✅ | P1 |
| TL-EDIT-11 | Extend Edit | 聚焦起点/终点 Trim Handle 明确选择 edit point；E 把它延伸到播放头并复用 Story/自由轨修剪语义 | ✅ | P1 |
| TL-EDIT-12 | Clip Enable | Shift+E 切换所选未锁片段 enabled，Program/导出一致 | ✅ | P1 |

### 7.8 精剪工具

Adobe 工具基准参考 [Tools panel](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/tools-panel-and-options-panel.html)、[Ripple Edit](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-ripple-edits.html)、[Rolling Edit](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-rolling-edits.html)、[Slip](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-slip-edits.html) 与 [Slide](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-slide-edits.html)。

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-TRIM-01 | Selection Trim | 选中片段后拖起点/终点；多选共享受限 delta；Alt 可只改一个链接声道 | ✅ | P0 |
| TL-TRIM-02 | Ripple Tool B | 显式 B 工具；仅在片段边缘命中；拖动期间预览整条轨的后续位移和序列时长；Story 保持 gapless，自由轨保留既有前置间隙；释放时复用 Sync Lock 原子 Patch | ✅ | P1 |
| TL-TRIM-03 | Rolling N | 移动相邻剪辑点，不改变组合时长，显示 Trim Monitor 帧 | ✅ | P1 |
| TL-TRIM-04 | Slip Y | 改变 Source In/Out，不改变 Timeline 位置和时长；支持选择组 | ✅ | P1 |
| TL-TRIM-05 | Slide U | 移动中间片段，同时补偿前后片段，外边界和自身时长不变 | ✅ | P1 |
| TL-TRIM-06 | Rate Stretch R | 拖边改变时长和速度；Story 实时波纹；Inspector 同一语义 | ✅ | P1 |
| TL-TRIM-07 | Time Remapping | 多速度段、边界拖动、Program/Export 同一映射 | ✅ | P2 |
| TL-TRIM-08 | Trim Mode | Shift+T 进入双画面 Trim Monitor；优先使用已聚焦剪辑点，否则取播放头最近 Story cut；±1.5 秒循环预览；Left/Right 1 帧、Shift 5 帧；Ctrl/Shift 点击 Rolling Handle 选择同轨或跨轨多个 edit point，并用共同受限 delta 原子调整 | ✅ | P2 |
| TL-TRIM-09 | Dynamic JKL Trim | Trim Mode 中 J/K/L 使用同一循环 Transport；重复 J/L 加速，K 在停止帧提交 Rolling trim | ✅ | P3 |
| TL-TRIM-10 | Reverse/Freeze | 负速度、反向、Frame Hold/Freeze Frame | ⬜ | P2 |

### 7.9 转场、效果与关键帧

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-FX-01 | 默认视频转场 | Ctrl/Cmd+D 在目标 cut 应用；Shift+D 对选择应用 | ✅ | P1 |
| TL-FX-02 | 默认音频转场 | Ctrl/Cmd+Shift+D 应用 Constant Power 语义 | ✅ | P1 |
| TL-FX-03 | 转场对象 | 时间轴内可选择、拖持续时间、双击进入属性；Program/Export 共用类型 | 🟡 拖时长和 Inspector 已有，缺完整 alignment/复制粘贴 | P1 |
| TL-FX-04 | 转场 Handles | 按可用源 handles 限制持续时间，缺帧时明确反馈 | ✅ | P1 |
| TL-FX-05 | 效果栈 | 启用/禁用、排序、参数调整；Program/Export 顺序一致 | ✅ 支持当前 renderer-backed 集合 | P1 |
| TL-FX-06 | 关键帧 | Timeline/Inspector 添加、移动、删除，静态值和动画值一致 | ✅ | P1 |
| TL-FX-07 | 插值 | Hold、Linear、Bezier/Ease 与切线编辑 | 🟡 Hold/Linear；缺 Bezier | P2 |
| TL-FX-08 | Program 直接变换 | 移动、缩放、旋转；一次手势一次 Patch；锁定只读 | ✅ | P1 |
| TL-FX-09 | Paste Attributes | Ctrl/Cmd+Alt+V 选择性粘贴变换、效果、关键帧、转场 | ⬜ | P2 |

### 7.10 音频

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-AUD-01 | 波形 | 录制/导入素材生成真实波形；高缩放下不伪造细节 | ✅ | P0 |
| TL-AUD-02 | Clip Gain | dB Rubber Band，拖动和键盘微调，限制与渲染器一致 | ✅ | P1 |
| TL-AUD-03 | Volume Keyframes | Clip/Track 级 Volume keyframe；Program/Export 预览一致 | ✅ | P1 |
| TL-AUD-04 | 音频转场/Fade | 时间轴内调整淡入淡出，使用统一 transition schema | ✅ | P1 |
| TL-AUD-05 | Pan/Balance | 轨道和片段 Pan，关键帧自动化 | ✅ | P2 |
| TL-AUD-06 | Mixer | Track Mixer、Mute/Solo、表头、峰值表、Automation modes | ⬜ | P3 |
| TL-AUD-07 | 音画同步提示 | Unlink 时记录最小相对同步参考；单侧移动后双方显示带符号帧差；恢复按钮按另一侧位移对齐，支持 Pointer/键盘并提交一个 Clip operation | ✅ | P2 |

### 7.11 标记、文字、字幕和事件

Adobe Marker 基准参考 [Markers overview](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/overview-of-markers.html)。

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-META-01 | Sequence Marker | M 添加，拖动、选择、编辑、删除、上一/下一、清空 | ✅ | P1 |
| TL-META-02 | Marker 属性 | 名称、颜色、注释、持续时间和类型 | 🟡 名称/颜色/时间；缺注释、范围、类型 | P2 |
| TL-META-03 | Clip Marker | Marker 随源片段和 Source Monitor 存在 | ⬜ | P2 |
| TL-META-04 | Ripple Marker 设置 | Story 波纹时选择 sequence marker 跟随或固定 | ⬜ | P2 |
| TL-META-05 | Text Track | 在播放头创建文字，编辑内容、字体、颜色、背景、布局 | ✅ | P1 |
| TL-META-06 | Caption Track | 字幕轨、字幕片段、前后字幕导航与导出 | ⬜ | P3 |
| TL-META-07 | CS 事件轨 | 击杀/回合等事件在自身时间范围内显示并可导航 | ✅ | P0 |
| TL-META-08 | Tactical 同步 | Tactical Monitor 跟随 Transport，地图上下文不可用时稳定降级 | ✅ | P0 |

### 7.12 专业与长项目能力

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-PRO-01 | Proxy | 可生成/清理代理，Program 自动选择可用代理，导出仍用原始素材 | 🟡 后端资产代理存在，统一工作区未形成完整控制/切换 | P2 |
| TL-PRO-02 | Nested Sequence | 选择片段创建子序列；父级作为单一 clip；双击回到源序列 | ⬜ | P3 |
| TL-PRO-03 | Multicam | 按时间码/音频/标记同步；播放中切角度；保留源角度 | ⬜ | P3 |
| TL-PRO-04 | Sequence Tabs | 多序列打开、切换、恢复布局 | ⬜ | P3 |
| TL-PRO-05 | Render Preview | In/Out 预渲染、状态条、失效管理 | ⬜ | P3 |
| TL-PRO-06 | Interchange | 导入/导出 OTIO/XML/EDL 的受支持子集 | ⬜ | P3 |

### 7.13 历史、协作与 Agent

| ID | 能力 | 产品要求 | 状态 | 优先级 |
| --- | --- | --- | --- | --- |
| TL-HIST-01 | Undo | Ctrl/Cmd+Z 撤销最近仍生效的非 System 编辑，可连续多步 | ✅ | P0 |
| TL-HIST-02 | Redo | Ctrl/Cmd+Shift+Z 重做最近撤销；普通新编辑清空 redo branch | ✅ | P0 |
| TL-HIST-03 | Cut | Ctrl/Cmd+X 先复制到 Timeline clipboard，再按轨道语义删除 | ✅ | P0 |
| TL-HIST-04 | 原子手势 | Pointer Move 不持久化；Pointer Up 只产生一个 Human Change Group | ✅ | P0 |
| TL-HIST-05 | Change Review | Agent 新增/删除/替换和波纹在真实时间位置呈现；可选中和撤销 Change Group | ✅ | P0 |
| TL-HIST-06 | Edit Lease | Agent 操作期间人类只读；播放和检查继续；结束后恢复 | ✅ | P0 |
| TL-HIST-07 | Revision delivery | Recording/Export/HITL 绑定 base revision；过期输出明确标识 | ✅ | P0 |
| TL-HIST-08 | Crash recovery | 已完成的工具 checkpoint、Project Patch 和工作区布局可恢复 | ✅ | P1 |

## 8. Premiere 快捷键基线

Adobe 官方 [Default keyboard shortcuts](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html) 是命名和默认键位的权威来源。Vibe CS 只在与 Story gapless 语义冲突时保留明确差异。

| 命令 | Windows | macOS | 当前 |
| --- | --- | --- | --- |
| Selection / Track Select | V / A / Shift+A | 同 | ✅ |
| Ripple / Rolling / Rate / Razor / Slip / Slide | B / N / R / C / Y / U | 同 | ✅ |
| Play / Shuttle | Space / J K L | 同 | ✅，缺多级速度 |
| Add Edit / All Tracks | Ctrl+K / Ctrl+Shift+K | Cmd+K / Cmd+Shift+K | ✅ |
| Insert / Overwrite | `,` / `.` | 同 | ✅ |
| Lift / Extract | `;` / `'` | 同 | ✅ |
| Cut / Copy / Paste / Paste Insert | Ctrl+X/C/V / Ctrl+Shift+V | Cmd 对应 | ✅ |
| Undo / Redo | Ctrl+Z / Ctrl+Shift+Z | Cmd 对应 | ✅ |
| Link | Ctrl+L | Cmd+L | ✅ |
| Group / Ungroup | Ctrl+G / Ctrl+Shift+G | Cmd 对应 | ⬜ |
| Mark In/Out | I / O | 同 | ✅ |
| Add / next / previous marker | M / Shift+M / Ctrl+Shift+M | Adobe macOS 对应 | ✅ |
| Snap | S | 同 | ✅ |
| Ripple to previous/next edit | Q / W | 同 | ✅ |
| Zoom / Fit / Page | =, -, `\`, Page Up/Down | 同 | ✅ |
| Match Frame / Extend Edit | F / E | 同 | ✅ |
| Select All / Deselect All | Ctrl+A / Ctrl+Shift+A | Cmd 对应 | ✅ |
| Enable Clip | Shift+E | Shift+Cmd+E | ✅ |

## 9. 性能与可靠性要求

| ID | 要求 | 验收方式 |
| --- | --- | --- |
| TL-PERF-01 | 拖播放头、移动、修剪时不重新创建可见视频 `src` | 交互测试统计媒体元素和 source URL 稳定性 |
| TL-PERF-02 | Pointer Move 通过 animation frame 合并，不发 Project Patch | 指针测试断言 release 前 mutation 为 0 |
| TL-PERF-03 | 大时间轴只计算可见 tick，tick 有硬上限 | `design/timeline/timeScale` 单元测试 |
| TL-PERF-04 | Filmstrip 使用静态缩略图，不为每个片段启动 video decoder | DOM/媒体桥交互测试 |
| TL-PERF-05 | Waveform 数据按显示宽度请求，缩放不伪造源细节 | waveform 单元与交互测试 |
| TL-PERF-06 | 所有完成手势在 100 ms 内给出本地视觉完成反馈 | 实机性能采样；不以网络往返阻塞 draft |
| TL-PERF-07 | 读取失败、未录制和地图缺失不会闪烁成空白 | 稳定上一帧/明确 empty state 的实机截图 |

## 10. 可访问性要求

- 每个工具、轨道控制、片段、标记、播放头、缩放控制都有可读名称。
- 禁用工具通过 Tooltip 说明原因，而不是仅降低透明度。
- 键盘可以完成播放、定位、选中、常用剪辑、Undo/Redo 和标记操作。
- 焦点不能被媒体元素或拖动手势丢失；Space 在聚焦按钮上只激活按钮，不同时播放。
- 颜色不是录制状态、锁定、变更或错误的唯一表达。
- Edit Lease 只读状态必须向辅助技术暴露，且不会留下仍可触发的隐藏写入口。
- 截图只能发现对比度和层级风险；完整 WCAG 结论仍需键盘遍历、语义树和屏幕阅读器测试。

## 11. 当前实机审计

审计环境：Tauri debug + CDP，2160×1350，Project revision 43。

### Step 1：统一工作区与 Timeline 全景 — 健康

![当前统一工作区](evidence/2026-09-01-timeline-prd-audit/01-current-workspace.png)

确认：Project/Program/Tactical/Timeline/Agent 同屏；Timeline 显示缩略图、波形、录制状态、变更、标记和事件；底部 Zoom Bar、Fit 和全局播放头存在。

风险：顶部 Timeline 命令密度已经较高；后续功能应进入结构化菜单或轨道头，而不是继续横向堆按钮。

### Step 2：工具说明 — 健康

![工具 Hover 说明](evidence/2026-09-01-timeline-prd-audit/02-tool-explanation.png)

确认：工具 Hover 使用成熟 Tooltip，包含名称、快捷键、行为或不可用原因。

限制：本次截图可确认视觉和文案，不能替代完整屏幕阅读器验证。

### Step 3：片段选择与直接审阅 — 健康但需继续扩展

![选中片段](evidence/2026-09-01-timeline-prd-audit/03-selected-clip.png)

确认：点击片段不会拖动它；选择状态、Program 帧和 Inspector/审阅入口使用同一 clip identity。

机会：选择、跨轨、Group/Link 和 edit-point selection 已形成完整基础；后续重点转向音频自动化、转场属性和长项目工作流。

### Step 4：Sync Lock 与多轨波纹 — 健康

![Sync Lock 轨道控制](evidence/2026-09-01-timeline-sync-lock/01-sync-lock-controls.png)

确认：Sync Lock 位于真实轨道头，Story compound audio 不重复展示第二个伪轨道开关；关闭后自由轨保持原位，开启后 Story 插入、提取、删除和时长变化会把符合条件的未锁轨道合并到同一个 Project Patch。跨越波纹边界的长片段保持原位，符合 Premiere 默认 Trim preference；纯 Story 重排不会误移动 B-roll。

### Step 5：Edit-point selection 与 Extend Edit — 健康

![选中的剪辑点](evidence/2026-09-01-timeline-extend-edit/01-selected-edit-point.png)

确认：选中片段的起点和终点是可聚焦的 `separator`，Focus/选中态明确；E 使用当前播放头调用同一帧对齐 Trim operation，Story 时继续带动后续片段和 Sync-Locked 轨道。菜单中的“延伸所选剪辑点到播放头”与快捷键调用同一函数。

### Step 6：Ripple Edit Tool B — 健康

![Live Ripple 预览](evidence/2026-09-01-timeline-ripple-tool/01-live-ripple-preview.png)

确认：B 工具只在片段左右 12px 边缘开始 Ripple 手势；拖动期间后续 Story 片段、波形和序列时长使用同一 draft 更新，Project revision 保持不变；释放后只生成一个 Change Group，并由 Sync Lock 扩展到其他轨。实机提交后使用 Ctrl+Z 完整恢复，证明该操作使用权威历史而非视图回滚。

### Step 7：Trim Mode 与循环 Transport — 健康

![Trim Mode](evidence/2026-09-01-timeline-trim-mode/01-trim-mode.png)

确认：Shift+T 在最近 Story cut 建立持久 Trim Mode，Program 复用稳定媒体池显示 Out/In 双画面；Transport 被限制在剪辑点前后各 1.5 秒并循环，实机播放读数从 00:30.083 推进到 00:30.852 后仍位于范围内；Space 停止、Escape 退出。Left/Right 和 K 的裁切仍写入统一 Rolling operation。

### Step 8：多 edit-point selection — 健康

![两个选中的剪辑点](evidence/2026-09-01-timeline-multi-trim/01-two-edit-points.png)

确认：Trim Mode 芯片紧凑显示当前选中数量和主 cut 时间，完整快捷键放入统一 Tooltip；Ctrl/Shift 点击 Rolling Handle 可添加或移除同轨/跨轨剪辑点。所有选中 cut 先共同收敛到最严格的源 handle delta，再在一个 Project Patch 中更新；相邻 cut 共享的中间片段会同时修改 In/Out，形成正确的源窗口滑移。

### Step 9：Group/Link 与 out-of-sync — 健康

![音画不同步帧数](evidence/2026-09-01-timeline-sync-status/01-out-of-sync.png)

确认：Group 与 Link 使用独立 identity 和选择规则；Unlink 后单侧移动时，视频显示 `+1f`、音频显示 `−1f`，两者来自相对参考位移而非绝对时间。点击视频的恢复同步提示后 revision 55 → 56 且偏移消失；随后通过统一 Undo 链完整恢复到仅含 Story compound 的 revision 63。

### Step 10：Audio Solo、Pan 与 Track automation — 健康

审计环境：fresh current-schema 数据库、Tauri debug + WebView2 CDP 9341、2160×1350，Project revision 1 → 3。

确认：Story compound audio 和独立音频轨共用 canonical `TimelineTrack` 的 Mute/Solo、Volume、Pan 与全局时间关键帧；轨道头可切换 Volume/Pan automation，播放头处增删关键帧，关键帧在轨道上可见且拖动只在释放时提交一次。Clip Inspector 同时提供 Clip Volume/Pan 静态值和关键帧。Program 使用共享 Web Audio gain + 两级 Stereo Panner，导出使用同一线性插值表达式、Solo 选择和 FFmpeg gain/pan filter。关闭并重开页面后 Solo 与 Pan keyframe 保持，控制台和页面错误为空。实机截图位于本地 `target/audio-automation-audit/screenshots/02-controls-compact.png`、`03-pan-tooltip.png` 和 `04-solo-pan-keyframe.png`。

### Step 11：In/Out 导航与循环 Transport — 健康

确认：Shift+I/Shift+O 跳转到同一 Timeline In/Out，Alt+I/O/X 与 Ctrl/Cmd+Shift+I/O/X 可分别清除单侧或双侧；标记菜单提供相同的可见命令和禁用态。Loop 开关在有完整 In/Out 时向 Program Transport 提供该范围，否则循环完整序列；它复用 Trim Mode 已验证的边界回绕，不创建第二个时钟。Tauri CDP 验证 Tooltip、菜单语义、pressed 状态和零 console/page error；截图位于本地 `target/audio-automation-audit/screenshots/05-loop-tooltip.png` 与 `06-loop-enabled.png`。

### Step 12：Replace Edit — 健康

确认：Project/Source Monitor 的“替换”动作只更新所选 Timeline Clip 的 source material、名称、source In/Out 和媒体 metadata，保留 Clip identity、Timeline start/duration/speed、Transform、Effect、Transition、Volume/Pan、Keyframe、Group/Link 与 Enable 状态。源类型不兼容、轨道锁定或源入点之后把手不足时动作禁用并由 Tooltip 解释；仍图像允许扩展到目标时长，但不会把不支持的 Speed Remap 带入图像。Tauri CDP 使用两个真实 MP4 完成 revision 4 → 5：Clip ID 保持 `dccde5b8-d7f3-4512-a02d-6bc2f6e7c813`，时长保持 5 秒，`x=32`、1 个 Effect 和 1 个 Keyframe 全部保持，source asset 改为 `c25eb40f-4352-4e90-9991-f2164ac0fc8e`，console/page error 为零。Tooltip 截图位于本地 `target/audio-automation-audit/screenshots/07-replace-tooltip.png`。

### Step 13：Timeline 本地 crash recovery — 健康

确认：项目级 current-only local document 恢复 Clip selection、目标轨、Sync Lock、Linked Selection、播放头、In/Out 和 Loop；Timeline clipboard 单独恢复完整多轨快照，重载后可立即 Paste。状态写入采用 250ms trailing debounce，播放过程中不会每帧同步写 localStorage；损坏或旧 shape 直接拒绝，不迁移、不影响 Project Head。Tauri CDP 在 revision 5 上选择同一 Clip、复制、设置 0–5 秒范围并启用 Loop，完整 reload 后播放头恢复为 5 秒、选中 ring 和 Loop 保持、Paste Overwrite/Insert 均 enabled，console/page error 为零。截图位于本地 `target/audio-automation-audit/screenshots/08-crash-recovery.png`。

## 12. 迭代计划

### Milestone 0：历史与基础命令闭环 — 本轮完成

- [x] Ctrl/Cmd+X Cut，并保留可粘贴 Timeline clipboard。
- [x] 基于 immutable Change Group 链重建 Undo/Redo cursor。
- [x] Ctrl/Cmd+Shift+Z Redo；新普通编辑清空 redo branch。
- [x] 补充纯函数和工作区交互回归测试。

### Milestone 1：核心多轨一致性 — 下一轮

- [x] Sync Lock 轨道状态与可见开关。
- [x] Story insert/ripple/extract/trim 对 Sync-Locked 轨道的一次原子 Patch。
- [x] 跨兼容轨垂直移动片段，保留 link/group identity，并完成 Story compound 音画拆分/合并。
- [x] Deselect All、Enable Clip、Match Frame 快捷键。
- [x] Extend Edit 与明确的 edit-point selection。
- [ ] 明确 Clear 与 Ripple Delete 的菜单文案和非 Story 行为。

验收：所有命令在锁定、链接、目标轨和 Agent Edit Lease 四种约束下都有交互测试。

### Milestone 2：精剪与音频效率

- [x] Ripple Tool B。
- [x] Trim Mode、多 edit-point selection、循环预览和键盘精调。
- [x] Dynamic JKL Trim。
- [x] 多级 JKL shuttle、循环播放和 Go to In/Out。
- [x] Group/Ungroup 与 out-of-sync 指示。
- [x] Audio Solo、Pan、Track keyframes。
- [ ] 转场 alignment、Paste Attributes、Bezier keyframes。

### Milestone 3：长项目和专业工作流

- [ ] 代理媒体在统一 Project/Program 工作流中的生成和切换。
- [ ] Nested Sequence 与 Sequence Tabs。
- [ ] Multicam 同步和播放中切角度。
- [ ] Caption Track、Render Preview 和 OTIO 互换子集。

## 13. Definition of Done

一个 Timeline 能力只有同时满足以下条件才可标记为“已实现”：

1. 通过 canonical Editing Document 或明确的 workspace-only 状态实现，不产生第二模型。
2. 可见控件、快捷键和 Agent 操作调用同一业务函数或 Project operation。
3. 锁定轨、Edit Lease、链接选择和目标轨行为明确。
4. 拖动只在完成时提交一个 Change Group。
5. Program Monitor 和导出读取相同的 source/time/effect 语义。
6. 至少包含纯函数测试；用户可见手势还必须有工作区交互测试。
7. Hover/Focus 有说明；禁用状态给出不可用原因。
8. Tauri 实机验证无控制台错误、视频重载或地图闪烁回归。

## 14. 参考资料

- Adobe Premiere: [Tools panel](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/tools-panel-and-options-panel.html)
- Adobe Premiere: [Default keyboard shortcuts](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html)
- Adobe Premiere: [Navigation controls in the Timeline](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline.html)
- Adobe Premiere: [Navigate sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigate-sequences-in-the-timeline.html)
- Adobe Premiere: [Timeline preferences](https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/timeline-preferences.html)
- Adobe Premiere: [Track targeting](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/work-with-clips-on-the-timeline-using-track-targeting.html)
- Adobe Premiere: [Source patching](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/add-media-to-the-timeline-using-source-patching.html)
- Adobe Premiere: [Sync Lock](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/sync-lock-to-prevent-changes.html)
- Adobe Premiere: [Edit track appearance](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/edit-track-appearance.html)
- Adobe Premiere: [Select clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/select-clips.html)
- Adobe Premiere: [Ripple Edit](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-ripple-edits.html)
- Adobe Premiere: [Rolling Edit](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-rolling-edits.html)
- Adobe Premiere: [Slip Edit](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-slip-edits.html)
- Adobe Premiere: [Slide Edit](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-slide-edits.html)
- Adobe Premiere: [Markers overview](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/overview-of-markers.html)
- Adobe Premiere: [Keyframes overview](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/about-keyframes.html)
- Adobe Premiere: [Default transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/set-and-apply-default-transitions.html)
- Adobe Premiere: [Nested sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-nested-sequences/about-nested-sequences.html)
- Adobe Premiere: [Multi-camera source sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/set-up-multi-camera-sequences-for-editing/create-a-multi-camera-source-sequence.html)
