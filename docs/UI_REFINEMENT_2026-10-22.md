# UI 细节调研 · 2026-10-22

本次参考 8 个剪辑与 CS2 分析产品的官方资料。以下记录区分已查看的界面图、官方交互说明与本项目建议；不代表本项目已实现或通过验证。项目边界以 `apps/web/PRODUCT.md`、`apps/web/DESIGN.md` 和当前代码为准。

## 官方来源与观察

| 产品 | 来源与证据 | 可确认的模式 |
| --- | --- | --- |
| DaVinci Resolve | [Edit 官方介绍](https://www.blackmagicdesign.com/ca/products/davinciresolve/edit/)，已查看[官方工作区图](https://images.blackmagicdesign.com/images/products/davinciresolve/edit/hero/hero-still.jpg?_v=1592448885) | 左侧素材、中间监视器、右侧属性；时间线占下部。面板靠细分隔组织，工具栏以紧凑动作承载操作。 |
| Adobe Premiere | [工作区与首页](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/what-are-workspaces.html)，已查看文中首页图 | 新建、打开与最近项目是直接入口；最近项目采用对齐的名称、时间等列。文档说明，使用经验增加后，首页展示更多最近项目、减少教程。工作区可调整和保存。 |
| Final Cut Pro | [窗口布局](https://support.apple.com/en-me/guide/final-cut-pro/ver2a27194eb/mac)，已查看[官方布局图](https://help.apple.com/assets/6A29F5537442EFE69C0CD4F3/6A29F558FEEBDB01270C8EF2/en_US/2b445d858e1885107ef05b16a9592b9e.png) | 素材浏览器、监视器、Inspector 共用上部边界，时间线横贯下部。面板可以隐藏和缩放；属性以字段和值排列。 |
| CapCut | [PC 与 Mac 操作指南](https://www.capcut.com/resource/how-to-use-capcut-on-pc)，已查看[桌面编辑图](https://p16-seeyou-useast5.capcutcdn-us.com/tos-useast5-i-2zwwjm3azk-tx/8730d3773a1e446c838bc33ea78450b1~tplv-2zwwjm3azk-compress%3Aq75.image) | 素材类别和属性类别各自使用短标签；分割、撤销、吸附、缩放靠近时间线；导出位于右上。控件周围没有重复解释其用途的段落。 |
| Descript | [Scene Editor](https://help.descript.com/visuals/scene-editor-overview)、[View 菜单](https://help.descript.com/hc/en-us/articles/10164575118989-Auto-scrolling)；已读交互说明，图片地址返回签名错误，未作为视觉证据 | 工具栏随所选图层变化；面板可显隐；高级时间线工具可按需展开，轨道高度可调，支持适配全部内容或当前场景。 |
| Leetify | [Profiles Update](https://leetify.com/blog/profiles-update/)（2026-08-17），已查看[导航图](https://leetify.com/blog/content/images/2026/08/image-4.png)；另读[首页调整说明](https://leetify.com/blog/our-new-home-page-a-place-to-celebrate-accomplishments/) | 分类标签替代不断增长的长滚动页；当前标签用细下划线表示。首页从近期比赛摘要进入详细报告，概要与深入分析有明确连接。 |
| CS Demo Manager | [官网](https://cs-demo-manager.com/)、[Demo 分析说明](https://cs-demo-manager.com/docs/guides/demos-analysis)，已查看[官方统计图](https://cs-demo-manager.com/img/stats.png) | 统计值在上，击杀、死亡、武器等证据在下；事件行提供邻近的播放入口。该图标示版本 3.0.0，只参考结构，不视作当前版本完整界面。 |
| SCOPE.GG | [Demo Viewer](https://scope.gg/replay/)、[Demo 指南](https://scope.gg/guides/cs2-demo-guide-en/)；已读交互说明并查看首页地图示意图 | 每回合有事件时间线，可点击时间或事件跳转；比赛下按回放、数据等任务组织入口。首页地图图是宣传示意，不作为完整实际界面证据。 |

## 应用于 Vibe CS

| 建议 | 在当前界面的落点 | 边界 |
| --- | --- | --- |
| 让最近工作先出现 | 工作台优先展示最近作品、进行中任务及恢复入口；常用功能使用短标题和直接动作。 | 首次使用提示仍可提供下一步；不让教学段落长期占据主要工作面。参考 Premiere、Leetify。 |
| 分开状态与动作 | 作品卡的“素材就绪 → 可以导出”可缩为“可以导出”，“N 段待录制 → 录制缺失片段”可缩为“N 段待录制”；按钮负责说明动作。 | 保留任务阻塞原因和真实下一步，继续使用现有交付判断。参考 CapCut、CS Demo Manager。 |
| 删除与标题重复的导语 | Steam 下载标题下“从 Steam 同步最近比赛并下载回放”可省略；搜索未命中保留查询词与清空入口即可。 | 录制占用、不可逆操作、失败原因和输入约束属于必要信息。 |
| 固定浏览和动作的轴线 | 列表标题、筛选、行内容、底部操作沿现有 `panel-inset` 对齐；名称突出，时间、版本和状态作为紧凑元数据。 | 复用现有行高、字级与 spacing token；避免每个页面另定尺寸。参考 Premiere、CS Demo Manager。 |
| 属性跟随选择，高级操作按需出现 | Inspector 优先显示当前对象的字段；时间线保持播放、分割、撤销、吸附常驻，其余按现有分组展开。 | 不隐藏正在生效的非默认状态；保留键盘等价操作和禁用原因。参考 Resolve、Descript。 |
| 导航用短标签建立稳定位置 | 分析的概览、回合、选手、回放维持固定分类；标题附近展示当前比赛身份，避免各面板重复解释所在位置。 | 不新增产品模式或第二套导航。当前分类已有时打磨顺序和选中反馈即可。参考 Leetify、Final Cut Pro。 |
| 把证据和回放入口放在一起 | 高光、事件、统计结果旁保留直接预览或定位入口；缩短从找到信息到检查证据的距离。 | 沿用当前回放时间与选材身份，不从播放头猜测录制范围。参考 CS Demo Manager、SCOPE.GG。 |
| 用色阶和留白组织密集工具 | 保留浅蓝灰工作面、白色内容面和细分隔；蓝色集中于主动作、选择和焦点。大面积深色留给媒体。 | 参考产品多数为暗色，借鉴层级和操作布局即可；不照搬配色、营销首页或制造更多卡片。 |

## 后续检查点

- 对照实际界面检查浅色、暗色与窄桌面宽度，确认表头、滚动内容、页脚同轴，文本截断有完整名称入口。
- 检查空状态、搜索无结果、加载、失败和任务进行中的操作，不以精简文案代替恢复路径。
- 编辑工作区继续使用既有 Dock、`ProjectTimeline`、`design/timeline`、Timeline Transport 与 Agent 权威状态；不为视觉调整建立平行实现。

## 本轮落实

- 工作台：缩短首次模式介绍，将最近作品与选材入口放在环境和任务恢复信息之前；保留失败原因和重试，去掉重复导语与外层卡框。
- 作品列表：把重复的素材就绪信息合为一条，显示画幅、帧率和时长；增加名称自然排序，搜索条件在切换排序时保留；空列表只显示一个新建动作。
- 剪辑工作区：作品名、版本、素材状态组成身份区，操作集中在右侧；缩短导出说明，保留录制、导出、只读与禁用原因。
- 成品列表：保留文件身份与播放、定位动作；完整路径、文件类型和来源任务进入现有详情抽屉。删除后果留在确认弹窗中。
- 选手比较：增加聚焦选手的「加入比较」入口，复用既有选择状态；每项指标改为共尺度的独立横条；删除永久无数据的占位。按钮采用固定短文字，完整姓名保留在可访问名称及悬停提示中。
- 资料库：默认筛选不再重复「全部」，活跃条件仍显示具体值；保存视图集中在菜单，当前视图名称保持可见。

上述改动使用现有组件和主题，未新增样式表、时间几何、编辑写入路径或后台运行时。

## 验证范围

- 浏览器使用项目现有开发数据，覆盖 1000–1600 px 桌面窗口、浅色与深色主题、中文与英文布局。
- 实际检查搜索无结果与恢复、排序选择、选手加入比较、保存视图与键盘菜单、成品详情与剪辑工具栏；检查窗口和主内容的横向溢出。
- 中英文目录各 2351 条，缺失翻译为 0；严格编译、TypeScript、生产构建和前端分层检查通过。
- 全量 Web 测试：315 个文件通过，3341 项通过、2 项跳过；包含排序、空列表单一新建入口、比较选择、长名称、菜单键盘操作和成品详情回归。
- 未启动真实 CS2 录制或原生媒体导出；浏览器预览不是这些原生路径的验证证据。
