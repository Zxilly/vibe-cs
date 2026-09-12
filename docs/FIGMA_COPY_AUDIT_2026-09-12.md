# Figma 界面文案审视 · 2026-09-12

用户要求检查全部界面的类似问题，介绍不应写在产品界面上，搜索并应用设计师技能后重新审视。

## 范围与结果

采用 Impeccable 的 clarify、distill、critique 和 craft-floor，以当前 PRODUCT.md、DESIGN.md 和实时 Figma 为依据。独立设计评估和独立截图证据检查各做一次，再实施清理。

- 61 张画板文案检查，42 张画板调整，79 处文案处理：39处删除、40处改写。
- 另移除3个空文本节点，修复复制反馈关闭按钮被裁切的问题。
- 20张代表画板重新截图，391个原型导航目标均存在，指定介绍/实现文案扫描无残留。
- [完整变更与前后截图](<C:/Users/12009/.codex/visualizations/2026/09/12/01a0941b-43b8-7450-bf7f-bc326df871db/figma-copy-review/index.html>)。

## 设计判断

1. 页面标题、数据和控件足以表达用途时，删除功能介绍和操作教学。
2. 分析概览、队伍、检索和玩家目录删除解析、索引、可选集成等实现说明。
3. 复盘笔记保留真实正文和定位操作，删除保存机制介绍；保存反馈缩为“已保存”。
4. 任务卡显示结果、范围和必要限制；错误卡使用具体问题与恢复动作。
5. 文件详情保留版本、时间、参数和路径，删除人工验收旁白；复制路径改成轻量反馈。
6. S3是画板外的状态规范展示，顶层设计说明保留；嵌入状态示例中的实现文字已清理。
7. 保留真实用户/Agent对话、复盘内容、字段含义、权限限制、预卷/后卷、删除恢复期限、重置/撤销后果与快捷键提示。

## 验证限制

自动浏览器检测尝试因浏览器发现/启动失败未完成，空结果不算通过；没有使用生产代码检测替代设计稿证据。本次验证为Figma静态截图和节点检查，不证明生产应用、键盘、剪贴板、录制或导出的实际行为。

Questions skipped: 用户已经明确要求清理，直接完成，无额外设计决策待确认。

## 技能环境

Impeccable当前v4.2.1，提示v4.3.1可用；本轮未更新。辅助上下文提示设计sidecar过期，本轮依照DESIGN.md和实时Figma，没有扩展为配置维护。

## 全部变更

| 画板 | 原文 | 处理 |
| --- | --- | --- |
| [03 · 工作台](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-4388) | 处理待办，继续作品，或者开始新的作品 | 删除 |
| [S1 · 设置（游戏与录制）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4954) | 应用、资料库、录制环境与诊断。配置备份与损坏文件隔离在恢复中心。 | 删除 |
| [S4 · 恢复中心](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=967-5070) | 配置备份、输出清理与损坏文件隔离。所有清理动作都需要二次确认。 | 删除 |
| [S5 · Steam 比赛历史](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=969-5127) | 同步最近比赛并下载 Replay；下载完成经校验后进入 Demo 资料库。 | 删除 |
| [S5 · Steam 比赛历史](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=969-5127) | Steam 凭据在 设置 · 文件与资料库 配置；公共数据不可用时，本地解析与编辑不受影响。 | 删除 |
| [S8 · 修订历史（变更组面板）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=974-5235) | 查看谁修改了作品，选择要撤销的内容。 | 删除 |
| [A7 · 玩家目录](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=983-5631) | 查看资料库内选手的比赛记录与表现。 | 删除 |
| [A7 · 玩家目录](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=983-5631) | 公共 Steam 资料与头像为可选集成；缺失时不影响本地档案。 | 删除 |
| [A6 · 队伍](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=982-5586) | 团队维度（回合 / 经济 / 道具）由同一份解析推出；失败分析不回填估算值。 | 删除 |
| [A9 · 证据检索](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=986-5715) | 跨比赛检索事件、选手与注释；检索只读，定位跳到回放或证据详情。 | 删除 |
| [A9 · 证据检索](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=986-5715) | 检索覆盖库内全部已解析比赛；未分析的比赛先解析再纳入索引。 | 删除 |
| [A5 · Review 与注释](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=981-5538) | 先回看对应片段，再记录自己的结论。 | 删除 |
| [状态 · 复盘笔记已保存](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1010-7576) | 先回看对应片段，再记录自己的结论。 | 删除 |
| [A5 · Review 与注释](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=981-5538) | 笔记保存在这场比赛中，下次打开可继续查看。 | 删除 |
| [状态 · 复盘笔记已保存](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1010-7576) | 已保存到这场比赛，下次打开可继续查看。 | 已保存 |
| [添加复盘笔记](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1010-8790) | 笔记会与这场比赛一起保存。 | 删除 |
| [02 · 分析模式 · 比赛数据工作区](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=533-5737) | 先看回合，再回看关键片段 | 删除 |
| [S2 · 命令面板（Ctrl+K）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4955) | 都由这次分析的回合与事件推出 | 删除 |
| [S6 · 任务中心（抽屉态）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=970-5181) | 都由这次分析的回合与事件推出 | 删除 |
| [文件 · 录制素材](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1012-7642) | 录制素材 · 可从这里查找原始片段文件 | 录制素材 |
| [状态 · Agent 完整回复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=604-6424) | 完整回复 · 可滚动 | 完整回复 |
| [C · 高光证据详情（单高光全证据视图）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=788-2) | 可用，查看精确来源 | 可用 |
| [C · 高光证据详情（单高光全证据视图）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=788-2) | 取段范围可用；开始录制前会检查游戏环境。 | 范围有效 |
| [C · 高光证据详情（单高光全证据视图）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=788-2) | 可尝试跟随镜头；先检查预览效果。 | 删除 |
| [状态 · Demo 解析完成](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=816-2) | Mirage 已解析完成，选择接下来要做的事。 | 删除 |
| [状态 · Demo 解析完成](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=816-2) | 回合、事件和高光都已就绪，源 Demo 保持不变。 | 删除 |
| [状态 · 录制完成 · 31 个片段就绪](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=818-2) | 可以预览并继续调整，也可以导出这版作品。 | 删除 |
| [Agent 抽屉 · 1100窗口](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=704-23332) | 可以预览并继续调整，也可以导出这版作品。 | 删除 |
| [状态 · 加入后 · 31 个片段 / 1 个待录制](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=783-22794) | 接下来录制新片段，再导出成片。无需重新录制已有素材。 | 删除 |
| [状态 · 加入后 · 31 个片段 / 1 个待录制](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=783-22794) | 录制完成后可导出 | 删除 |
| [状态 · 录制完成 · 31 个片段就绪](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=818-2) | 可以导出成片 | 删除 |
| [剪辑工作区 · 1100×760](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=971-5235) | 可以导出成片 | 删除 |
| [状态 · Agent 规划中（可查看，可停止）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1018-7694) | 可以查看或停止 | 删除 |
| [05 · 导入 Demo](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-4909) | 校验文件头与大小；同一份内容不会重复入库 | 已存在的 Demo 将自动跳过 |
| [07 · 回放与热力图](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-5924) | 楼层只筛热力叠加：回放数据不记录楼层。 | 楼层筛选仅影响热力图 |
| [08 · 选材与创建剪辑](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-6568) | 楼层只筛热力叠加：回放数据不记录楼层。 | 楼层筛选仅影响热力图 |
| [07 · 回放与热力图](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-5924) | 只列击杀与目标事件，共 9 条。 | 击杀与目标事件 · 9 条 |
| [08 · 选材与创建剪辑](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-6568) | 只列击杀与目标事件，共 9 条。 | 击杀与目标事件 · 9 条 |
| [08 · 选材与创建剪辑](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-6568) | 自动保留事件前1.5秒、后1秒；完整片段13.75秒。 | 前置 1.5 秒 · 后置 1 秒 |
| [08 · 选材与创建剪辑](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-6568) | 加入后为待录制片段；录制完成后才能导出。 | 加入后待录制 |
| [S9 · 筛选预设（组合条件）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=976-5280) | 同时满足所有条件；可保存为常用筛选。 | 匹配全部条件 |
| [S4 · 恢复中心](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=967-5070) | 隔离文件不参与分析与库统计；源文件从不被修改。 | 删除 |
| [开始 · 还没有比赛](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1005-7569) | 导入 Demo 后，可以复盘比赛，也可以挑选高光制作视频。 | 删除 |
| [开始 · 还没有比赛](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1005-7569) | 支持 .dem 文件；分析比赛不需要先配置录制环境。 | 支持 .dem 文件 |
| [T06 · 导出任务详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17559) | 完整序列 03:13.750 · H.264 / MP4<br>任务入口固定在顶部；可以关闭此详情继续查看作品。 | 完整作品 03:13.750 · H.264 / MP4 |
| [T09 · Agent 请求被拒绝](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17616) | 已拒绝这次 Agent 请求。CS2 未启动，作品不变；这不等于取消一个已运行的任务。 | 已拒绝录制请求。CS2 未启动，作品未改变。 |
| [T05 · 录制已完成](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17530) | 录制素材已附加到原片段，作品为 r14。文件尚未导出；成片仍需人工观看检查。 | 1 个片段录制完成 · 作品 r14 · 尚未导出 |
| [状态 · Agent 规划中（可查看，可停止）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1018-7694) | 你可以查看内容；暂时无法手动编辑。停止规划后恢复编辑。 | 规划期间只读，停止后可编辑。 |
| [B · 任务中心（队列 · 重试 · 部分成功）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=786-2) | 错误码 LAUNCH_TIMEOUT · 游戏进程未在 30s 内响应 | CS2 启动超时 · 30 秒内未响应 |
| [任务 · 导出 r14](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=1006-7576) | 错误码 LAUNCH_TIMEOUT · 游戏进程未在 30s 内响应 | CS2 启动超时 · 30 秒内未响应 |
| [S6 · 任务中心（抽屉态）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=970-5181) | 错误码 LAUNCH_TIMEOUT · 已自动重试 1 次 | CS2 启动超时 · 已自动重试 1 次 |
| [02 · 分析模式 · 比赛数据工作区](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=533-5737) | 按高光类型统计，胜负未记录 | 删除 |
| [02 · 分析模式 · 比赛数据工作区](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=533-5737) | 可以画进 2D 回放的事件 | 删除 |
| [S2 · 命令面板（Ctrl+K）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4955) | 按高光类型统计，胜负未记录 | 删除 |
| [S2 · 命令面板（Ctrl+K）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4955) | 可以画进 2D 回放的事件 | 删除 |
| [S6 · 任务中心（抽屉态）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=970-5181) | 按高光类型统计，胜负未记录 | 删除 |
| [S6 · 任务中心（抽屉态）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=970-5181) | 可以画进 2D 回放的事件 | 删除 |
| [02 · 分析模式 · 比赛数据工作区](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=533-5737) | 带坐标证据 | 带坐标事件 |
| [S2 · 命令面板（Ctrl+K）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4955) | 带坐标证据 | 带坐标事件 |
| [S6 · 任务中心（抽屉态）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=970-5181) | 带坐标证据 | 带坐标事件 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | 导入 .dem 文件或添加监听目录；损坏文件会带错误码隔离，不进入分析流程。 | 导入 .dem 文件或添加监听目录。 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | 试试放宽类型、回合或选手条件；当前条件会保留以便调整。 | 试试减少筛选条件。 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | 录制、导出和下载完成后会在这里汇总；失败任务保留错误码与重试入口。 | 删除 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | 局部错误不吞掉整个应用。重试当前页面，或返回工作台。 | 请重试，或返回工作台。 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | 骨架复用页面版式，不用旋转菊花；路由级 Suspense 同理。 | 删除 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | info · 任务已开始，完成后会通知你 | 任务已开始 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | success · 导出完成，可定位到文件 | 导出完成 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | warning · 部分成功 8/10，失败项可重试 | 部分成功 · 8/10 · 失败项可重试 |
| [S3 · 全局状态规范（空 / 加载 / 错误）](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=960-4956) | danger · 录制失败 · 错误码 LAUNCH_TIMEOUT | 录制失败 · CS2 启动超时 |
| [09 · 导出设置](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-7245) | 文件写入「成品文件」。顶部任务入口可查看进度或取消。<br>质量 80：越高画质越好，文件通常越大；不代表固定码率。 | 质量越高，画质越好，文件通常越大。 |
| [T08 · 导出取消恢复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17597) | 作品 r14 与旧成品文件仍保留。此次任务没有可交付的新文件。 | 导出已取消，未生成新文件。 |
| [T04 · 录制取消恢复](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=689-17501) | 作品仍为 r13。新增片段留在时间线，待录制 1；原有 30 个录制素材不受影响。 | 录制已取消 · 作品 r13 · 1 个片段待录制 |
| [10 · 成品文件](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=543-9817) | r14 · 当前版本 · 待观看检查 | r14 · 当前版本 |
| [D05 · 路径复制反馈](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18921) | 复制完整路径 | 路径已复制 |
| [D05 · 路径复制反馈](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18921) | 此 Figma 原型展示复制动作的入口，不会读取或修改系统剪贴板。实际应用应复制完整路径并提供可感知的成功反馈。 | 删除 |
| [D05 · 路径复制反馈](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18921) | 返回 | 关闭 |
| [D02 · 成品 r12 文件详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18888) | 参数可读取；人工观看检查未确认。 | 移除尾注，保留文件参数与完整路径 |
| [D03 · 成品 r10 文件详情](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18897) | 这是旧导出，不代表当前作品状态。 | 移除尾注，保留旧版本标记、文件参数与完整路径 |
| [D04 · 成品 r14 详情示例](https://www.figma.com/design/N05FPVtPTwWV3ONlE48Fwv?node-id=693-18906) | 文件已生成；观看检查待确认。 | 移除尾注，保留文件参数与文件位置 |
