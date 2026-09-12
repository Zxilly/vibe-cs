# Figma 全量 UI 视觉审查 · 2026-09-12

本轮承接用户“视觉审查一遍所有 UI”的要求，以当前 Figma 为准。逐张检查60个现有界面、状态、弹窗，另检查10组共享组件和浅/深色字体、色板，共14张基础图。只做视觉与理解层面的修正，没有修改生产代码或真实项目数据。

## 结论

- 初始60个UI画板全部有本轮截图和检查记录。
- 将已有“命令面板无匹配”变体移出正常搜索画板，最终为61个独立UI画板；未增加功能。
- 清单中31个通过、30个已修正，本轮待完善项已清零。用户确认设计图使用示意占位数据后，两张图表已补齐并截图复核。
- 修正后截图复查覆盖31个原画板和独立展示的无匹配状态。
- 最终核对391个带目标导航动作，空目标0。7个分析页的标签文字、相对位置和宽度一致。
- 完整逐屏记录及前后截图：[视觉审查报告](C:/Users/12009/.codex/visualizations/2026/09/12/01a0941b-43b8-7450-bf7f-bc326df871db/figma-audit/all-ui-visual/index.html)。

## 已处理的问题

1. **稳定导航。** 选中标签原先被100px下划线撑宽，切换会推移后续标签；改为同一字级、固定内边距和不撑宽容器的下划线。设置、恢复、玩家目录、玩家档案、证据检索正确高亮自身入口；修订历史复用剪辑侧栏。
2. **修复文字和容器。** 录制素材标题从两个字宽度改为随内容撑开；标题区局部白底和玩家档案双栏外部白底已清除。完整回复保留纵向滚动并增加明确提示。
3. **统一弹窗与工具栏。** 导入和批量加入保留来源背景；正常命令面板不再同时显示无匹配浮层。排序与批量选择置于同一行，任务抽屉补关闭和间距。
4. **纠正表格强调与列关系。** 旧成片行残留的3px内阴影已清除；文字和按钮恢复默认层级。队伍对比增加指标表头，B队标题与数值对齐。
5. **修复共享时间线底栏。** 范围条设置拉伸约束，右侧手柄跟随右边界，避免缩窄后压住适应按钮；时间线内容和时间几何没有重做。
6. **改善状态和预览。** 完成阶段使用一致的标记；待录制标签不再写成含糊的准备就绪，错误/进度正文不暴露实现说明。移除战术预览中的空文本占位，保持比例放大地图。
7. **提高文字对比度。** 25处浅绿底上的绿色文字复用现有 `color/text/strong` 角色，不新建色板。对应浅色组合的计算对比度从约4.43:1提高到约7.08:1。
8. **整理展示画布。** 放大后的Agent抽屉与相邻任务卡分开排布。初步怀疑的拒绝卡布局损坏，经独立渲染和几何读取确认未复现，已排除误报，没有重建组件。

## 图表示意已补齐

| 状态 | 画板 | 原问题 | 完成结果 |
| --- | --- | --- | --- |
| 已完成 | [道具与经济](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=980-5493) | 两队相加失去比较意义 | 改为21回合的两队装备价值折线、0–30k刻度、胜方标记及R20双方装备/购买类型/差额 |
| 已完成 | [玩家档案](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=985-5673) | 近20场只有12柱，缺少坐标 | 使用20场示意数据，补齐场次、0–120刻度和均值线；数据平均值为89.2，与标题一致 |

用户明确这些图表是设计示意，不要求真实业务数据。本次按此授权构造占位数值，保留既有视觉体系；这不是实际比赛分析结果。

## 经济语义与界面文案复查

用户指出两队装备价值合计没有分析意义后，核对了 CS Demo Manager 当前源码：[装备价值图](https://github.com/akiver/cs-demo-manager/blob/main/src/ui/match/economy/team-equipment-values-chart.tsx)使用两队逐回合折线与胜方信息；[经济优势图](https://github.com/akiver/cs-demo-manager/blob/main/src/ui/match/economy/team-economy-advantage-chart.tsx)比较两队差额；[回合页](https://github.com/akiver/cs-demo-manager/blob/main/src/ui/match/rounds/overview/rounds.tsx)组织回合历史、条目和导航。

- A4删除合计柱图与未标明所属队伍的全起/强起/ECO汇总，改为两队冻结结束装备价值、逐回合胜方与选中R20对比。胜方示意为A队8回合、B队13回合；R20装备价值26,400/22,600，差额3,800。
- 清理9处操作提示或实现说明：回合标题中的“点击行”、三个概览变体的“点击回合”、高光的“点击展开”、玩家页的点击/本地解析说明、对位页的点击回放说明、道具生命周期说明、经济页底部操作说明。
- 保留现有详情、收起、回放控件。回合、玩家、对位、经济画板已重新截图复核；界面页中上述点击指令及生命周期说明扫描结果为0。
- 本节与实时Figma为本次语义修正后的记录；上方HTML报告截图反映此前视觉审查阶段。

## 范围限制

本轮是Figma静态视觉与几何核对，不是生产应用交互测试。没有验证实际键盘焦点、屏幕阅读器、真实滚动、数据输入、录制或导出，也没有把每个页面的全部深色和动态组合展开检查。正常的长路径换行、列表滚动裁切、浮层遮挡和禁用样式没有误报为缺陷。截图比例和原始尺寸由Figma返回，完整文件保存在本轮报告目录。

## 逐屏清单

| # | 画板 | 结果 | 处理/说明 |
| --- | --- | --- | --- |
| 1 | [剪辑工作区 · 加入前 r12（30个片段）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=532-3157) | 已修正 | 共享时间线范围条改为随容器拉伸，适应按钮不再被覆盖。 |
| 2 | [02 · 分析模式 · 比赛数据工作区](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=533-5737) | 通过 | 概览/数据/Inspector层级清楚；列表底部截断是滚动视口，非文字框溢出。 |
| 3 | [03 · 工作台](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-4388) | 通过 | 继续、待办和快捷入口分组清楚，无明显裁切。 |
| 4 | [04 · Demo 资料库](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-4553) | 通过 | 三列信息结构清楚，地图和路径有可理解的省略；未把正常省略判为布局缺陷。 |
| 5 | [05 · 导入 Demo](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-4909) | 已修正 | 改用与现有确认框一致的半透明遮罩，保留来源页面。 |
| 6 | [06 · 高光选材](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-5279) | 已修正 | 排序和批量选择改为同一水平工具行。 |
| 7 | [07 · 回放与热力图](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-5924) | 通过 | 地图、事件与传输条均完整；底部时间信息偏密，但无直接遮挡。 |
| 8 | [08 · 选材与创建剪辑](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-6568) | 通过 | 来源、范围、目标及提交清楚，主按钮完整；焦点框作为明确状态保留。 |
| 9 | [09 · 导出设置](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-7245) | 通过 | 导出弹窗层级清楚；质量值接近右边缘，需与新版导出统一内边距时一并核对。 |
| 10 | [10 · 成品文件](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-9817) | 已修正 | 清除旧版本行残留的内阴影和额外强调，恢复默认文字与按钮样式。 |
| 11 | [状态 · Agent 完整回复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=604-6424) | 已修正 | 确认纵向滚动已启用，并在标题明确可滚动；保留完整内容。 |
| 12 | [状态 · 剪辑 · 源预览展开](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=622-5995) | 已修正 | 随同一共享时间线组件修正底栏约束；源预览内容保留。 |
| 13 | [T01 · Agent 录制授权](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17410) | 通过 | 确认卡标题、范围、保留结果与主次按钮均清晰完整。 |
| 14 | [T02 · 录制任务详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17443) | 已修正 | 进度文案改为录制期间只读、完成后通知，去掉实现说明。 |
| 15 | [T03 · 录制失败恢复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17472) | 通过 | 失败颜色、原因与重试按钮明确，无裁切。 |
| 16 | [T04 · 录制取消恢复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17501) | 通过 | 取消与失败可区分；结果和恢复动作完整。 |
| 17 | [T05 · 录制已完成](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17530) | 通过 | 当前截图内容完整，状态与操作层级清楚。 |
| 18 | [T06 · 导出任务详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17559) | 通过 | 当前截图内容完整，状态与操作层级清楚。 |
| 19 | [T07 · 导出失败恢复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17578) | 已修正 | 错误正文直接描述空间不足与恢复动作。 |
| 20 | [T08 · 导出取消恢复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17597) | 通过 | 当前截图内容完整，状态与操作层级清楚。 |
| 21 | [T09 · Agent 请求被拒绝](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17616) | 通过 | 独立渲染和节点几何复核均正常，排除初步观察中的卡片错位误报；没有重建此组件。 |
| 22 | [Agent 抽屉 · 1100窗口](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=704-23332) | 通过 | 右侧抽屉宽度、关闭入口和内容完整。灰色部分为独立导出的遮罩，不判为背景丢失。 |
| 23 | [T11 · 待录制任务范围](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=709-22963) | 已修正 | 状态标签明确为待录制。 |
| 24 | [D01 · 精确来源与时间基准](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18877) | 通过 | 当前截图内容完整，状态与操作层级清楚。 |
| 25 | [D02 · 成品 r12 文件详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18888) | 通过 | 完整长路径自然换行但未丢失内容，复制入口完整。盘符独行属排版可优化项，不改变路径字符串。 |
| 26 | [D03 · 成品 r10 文件详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18897) | 通过 | 历史版本说明和完整路径可读，动作完整。 |
| 27 | [D04 · 成品 r14 详情示例](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18906) | 通过 | 当前截图内容完整，没有明显遮挡或边界溢出。 |
| 28 | [D05 · 原型复制动作说明](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18921) | 通过 | 当前截图内容完整，没有明显遮挡或边界溢出。 |
| 29 | [状态 · 加入后 · 31 个片段 / 1 个待录制](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=783-22794) | 通过 | 当前截图内容完整，没有明显遮挡或边界溢出。 |
| 30 | [B · 任务中心（队列 · 重试 · 部分成功）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=786-2) | 通过 | 任务类别、进度与错误详情对齐，较长标题未遮住动作。 |
| 31 | [C · 高光证据详情（单高光全证据视图）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=788-2) | 已修正 | 移除空文本占位，按比例扩大战术预览到310px。 |
| 32 | [D · 作品库（多项目管理）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=792-2) | 通过 | 卡片排列、状态颜色与搜索宽度正常，无需为填满留白添加内容。 |
| 33 | [状态 · Demo 解析完成](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=816-2) | 已修正 | 统一完成勾选与完成状态文字颜色。 |
| 34 | [状态 · 批量加入（重复与无效取段）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=817-2) | 已修正 | 保留选材背景并统一半透明遮罩。 |
| 35 | [状态 · 录制完成 · 31 个片段就绪](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=818-2) | 通过 | 当前截图主要内容和操作完整，无明显文字裁切。 |
| 36 | [S1 · 设置（游戏与录制）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4954) | 已修正 | 正确高亮设置与诊断。 |
| 37 | [S2 · 命令面板（Ctrl+K）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4955) | 已修正 | 无匹配变体移出主面板，成为独立状态964:5050。 |
| 38 | [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | 通过 | 这是状态规范展示板，各示例边界清楚、正文可读；不当作真实整页空状态。 |
| 39 | [S4 · 恢复中心](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=967-5070) | 已修正 | 移除标题白底残留，正确高亮设置与诊断。 |
| 40 | [S5 · Steam 比赛历史](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=969-5127) | 已修正 | 移除标题白底残留。 |
| 41 | [S6 · 任务中心（抽屉态）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=970-5181) | 已修正 | 增加关闭入口，并与清空动作保留12px间距。 |
| 42 | [剪辑工作区 · 1100×760](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=971-5235) | 通过 | 1100窗口时间线、时间码和素材名均完整；长名称保持可理解的换行。 |
| 43 | [S8 · 修订历史（变更组面板）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=974-5235) | 已修正 | 复用剪辑侧栏，选中作品；标题背景统一。 |
| 44 | [S9 · 筛选预设（组合条件）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=976-5280) | 已修正 | 移除标题白底残留，保留正常的菜单覆盖。 |
| 45 | [A1 · 回合逐条详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=977-5344) | 已修正 | 统一标签尺寸和下划线约束。 |
| 46 | [A2 · 玩家单场分析](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=978-5388) | 已修正 | 统一标签尺寸和下划线约束。 |
| 47 | [A3 · 对位 · 首杀对决](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=979-5433) | 已修正 | 统一标签尺寸和下划线约束。 |
| 48 | [A4 · 道具与经济](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=980-5493) | 已修正 | 两队21回合装备价值折线、胜方与R20装备对比；移除实现说明。 |
| 49 | [A5 · Review 与注释](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=981-5538) | 已修正 | 统一标签尺寸和下划线约束。 |
| 50 | [A6 · 队伍](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=982-5586) | 已修正 | 统一标签位置，补指标表头，使B队标题与数值对齐。 |
| 51 | [A7 · 玩家目录](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=983-5631) | 已修正 | 正确高亮玩家目录，并统一标题背景。 |
| 52 | [A8 · 玩家档案](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=985-5673) | 已修正 | 补齐20场ADR示意图、场次、刻度和89.2均值线。 |
| 53 | [A9 · 证据检索](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=986-5715) | 已修正 | 正确高亮证据检索，并统一标题背景。 |
| 54 | [开始 · 还没有比赛](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1005-7569) | 通过 | 当前截图主要内容、按钮与边界完整。 |
| 55 | [任务 · 导出 r14](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1006-7576) | 通过 | 当前截图主要内容、按钮与边界完整。 |
| 56 | [确认 · 导出当前作品 r14](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1007-7576) | 通过 | 当前截图主要内容、按钮与边界完整。 |
| 57 | [状态 · 复盘笔记已保存](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1010-7576) | 已修正 | 保存后状态与同组分析标签几何一致。 |
| 58 | [添加复盘笔记](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1010-8790) | 通过 | 当前截图内容完整，无明显裁切或按钮遮挡。 |
| 59 | [文件 · 录制素材](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1012-7642) | 已修正 | 标题按内容撑开，完整显示录制素材。 |
| 60 | [状态 · Agent 规划中（可查看，可停止）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1018-7694) | 通过 | 当前截图内容完整，无明显裁切或按钮遮挡。 |
| 61 | [命令面板 · 无匹配](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=964-5050) | 通过 | 只拆分展示已有状态，没有增加功能。 |
