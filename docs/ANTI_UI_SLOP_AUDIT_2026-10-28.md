# anti-ui-slop 逐页审查 · 2026-10-28

本次审查覆盖30个页面或独立子视图，每页完成46条目录规则与X1–X4，共1,380条规则判断、120条组合判断。三组subagent并发检查，第四组只读复核修复；主代理合并并逐页验收。代码版本为`17af3a8eed47e949161d689b9551f725d83479b8`。

规则来自[anti-ui-slop原文](https://github.com/discountry/ritmex-skills/blob/main/skills/anti-ui-slop/SKILL.md)，实际读取内容的SHA-256与完整规则ID保存在[逐页记录](design-audit/2026-10-28/anti-ui-slop.json)。规则中的Source、Render和Judgment分别用源码、浏览器与产品语义确认；Impeccable为补充扫描。没有把46条判断都表述为自动检测。

## 修复结果

- 共享空态、提示、表单说明、错误、输入长文，以及设置、引导、Agent、录制和分析注释的连续内容使用14px正文与合适行高；紧凑数据、时间码、键名与短标签保留原角色。
- 比赛页使用现有可见比赛身份作为h1，内容标题依次下降；删除嵌套main与非法dl子节点。素材listbox分组和真实Timeline轨道采用合法语义，选择列表头具名，属性区域只保留一个同名region。
- 筛选、更多与模式菜单采用非模态交互，保留页面可达性；正式确认继续使用Dialog焦点陷阱。任务详情抽屉复用compact布局去掉重复外框和外边距。
- 修复缩小SVG产生的约4.64px选手字母：共享MapCanvas维护一个可清理的尺寸观察器，Replay与编辑器战术预览使用相同标注尺度，字母13px、背景24px；世界坐标和时间逻辑不变。装备曲线在原滚动区域保持12px轴标签。
- 缩略图拒绝空媒体URL，加载失败保留已有图标或轨道底，成功后恢复；音量表由height动画改为scaleY。诊断长路径允许折行，AI请求参数摘要与实际自定义数量一致。

## 逐页覆盖

“通过”指适用规则完成检查；“例外”有功能或设计依据；“不适用”指页面没有对应表面。三类合计均为46，具体依据逐条保存在JSON。最后一列为1440×1000、1100×760各自浅深主题的四组结果。

| 页面/子视图 | 路由 | 通过 | 例外 | 不适用 | 渲染通过 |
| --- | --- | ---: | ---: | ---: | ---: |
| 成品文件 | `/delivery` | 27 | 13 | 6 | 4/4 |
| 作品工作区 | `/projects/80000000-0000-4000-8000-000000000000` | 27 | 14 | 5 | 4/4 |
| 证据检索 · 证据 | `/evidence` | 31 | 12 | 3 | 4/4 |
| 证据检索 · 注释 | `/evidence?view=annotations` | 31 | 12 | 3 | 4/4 |
| 使用引导 | `/guide` | 36 | 4 | 6 | 4/4 |
| Steam 比赛历史 | `/library?view=steam` | 32 | 7 | 7 | 4/4 |
| 工作台 | `/` | 27 | 13 | 6 | 4/4 |
| Demo 资料库 · 表格 | `/library` | 31 | 8 | 7 | 4/4 |
| Demo 资料库 · 卡片 | `/library?view=card` | 30 | 9 | 7 | 4/4 |
| 对位 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=duels` | 31 | 12 | 3 | 4/4 |
| 高光选材 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=highlights` | 31 | 12 | 3 | 4/4 |
| 比赛概览 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=overview` | 31 | 12 | 3 | 4/4 |
| 单场选手 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=players` | 31 | 12 | 3 | 4/4 |
| 回放与热力图 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=replay` | 31 | 12 | 3 | 4/4 |
| 复盘笔记 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=review` | 31 | 12 | 3 | 4/4 |
| 逐回合复盘 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=rounds` | 31 | 12 | 3 | 4/4 |
| 队伍 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=teams` | 31 | 12 | 3 | 4/4 |
| 道具与经济 | `/match/3f2c9a10-11d4-4a6e-9d21-6b0f1a2c3d41?view=utility` | 31 | 12 | 3 | 4/4 |
| 找不到页面 | `/does-not-exist` | 30 | 7 | 9 | 4/4 |
| 选手目录与比较 | `/players` | 31 | 12 | 3 | 4/4 |
| 选手档案 | `/players/76561197960266729` | 31 | 12 | 3 | 4/4 |
| 作品 | `/projects` | 27 | 13 | 6 | 4/4 |
| 恢复中心 | `/recovery` | 35 | 4 | 7 | 4/4 |
| 设置 · 高级与诊断 | `/settings?section=advanced` | 35 | 4 | 7 | 4/4 |
| 设置 · AI 与 Agent | `/settings?section=ai` | 35 | 4 | 7 | 4/4 |
| 设置 · 应用 | `/settings` | 36 | 3 | 7 | 4/4 |
| 设置 · 文件与资料库 | `/settings?section=files` | 35 | 4 | 7 | 4/4 |
| 设置 · 游戏与录制 | `/settings?section=game` | 36 | 3 | 7 | 4/4 |
| 后台任务详情 | `/tasks/download%3Add444444-4444-4444-8444-444444444444` | 32 | 7 | 7 | 4/4 |
| 任务中心 | `/tasks` | 31 | 8 | 7 | 4/4 |

## 验证

- 120组页面检查与截图均完成；每组axe扫描0条violations，无文档横向溢出、可见破图或紧行高多行正文；六张联系表逐张复查。窗口类为产品支持的宽、窄桌面，未将手机当作本产品支持目标。
- axe对SVG单字、数据轴和Timeline叠层留下的incomplete已人工审定。浅色普通辅助字对比7.46:1，浅色地图字母最低5.14:1；暗色对应颜色最低8.35:1。Timeline两种半透明标签在黑白底极值中最低6.03:1，高于4.5:1。
- 空回合的表格保留真实表头与独立空态，th-has-data-cells的incomplete据此分类。portalled菜单的region最佳实践提示按其真实menu语义处理；aria-controls引用实际存在，键盘关闭返回触发按钮。没有用虚假区域或隐藏内容消除报告。
- 实际展开检查了资料库筛选、导入、监听、列配置、属性、布局、录制确认、选手比较、证据/复盘注释、AI参数和清理确认；确认弹窗Tab/Shift+Tab循环与Escape焦点恢复通过。设置诊断210字符文件名由614/1483px溢出修复为614/614px。
- 全量前端测试：317个文件，3,383项通过、2项跳过。命令为`pnpm --dir apps/web test --maxWorkers=4`。测试环境仍输出jsdom未实现HTMLMediaElement.pause的提示。
- `pnpm --dir apps/web lint`与生产构建通过；英文2,359条消息无缺项。68个JS chunk均≤500,000 bytes，静态依赖无循环。
- Impeccable扫描0条主要发现；27条颜色advisory均来自开发fixture或测试样例。

## 验证边界

浏览器使用现有开发fixture IPC，验证前端布局、语义和交互；没有执行真实Steam下载、模型API连接、CS2/HLAE录制或媒体导出。截图和原始日志位于忽略的`artifacts/anti-ui-slop-2026-10-28/`。逐页JSON保存这次审查的证据与例外，不代替未来改动的重新检查。
