/**
 * Token merge tables for the frontend redesign.
 *
 * This module is DATA, not style. `design/theme.css` is generated from it and
 * `tokens.data.test.ts` asserts that every bare value observed in the design
 * reference maps to a token here (spec §6.4).
 *
 * Authority: `docs/superpowers/specs/2026-08-15-frontend-redesign-design.md` §3.
 * The token sets below are fixed by that spec. The merge tables record which
 * raw value from the design reference lands on which token, together with the
 * occurrence count and the artboard(s) the value came from, so that a later
 * reader can tell a deliberate absorption from an accidental one.
 *
 * Extraction source: the 20-artboard design reference exported from the Claude
 * Design project `Vibe CS 重设计` (f5cf6827-461a-4508-837f-4d18ba7d192f).
 * Every declaration in that file is a hand written inline style; the counts
 * below are occurrences of the declaration, not of the rendered element.
 */

/**
 * The classification rules the extraction used. They are written down because
 * the raw file gives no semantics: `height:40px` is a table row in one place
 * and an Inspector head in another, and the counts only mean something if the
 * rule that produced them is reproducible. Re-running these rules over the
 * design reference must reproduce the `OBSERVED_*` fixtures in the test file
 * exactly; a hand-adjusted count is a count nobody can check.
 */
export const EXTRACTION_RULES = {
  fontSize: 'every `font-size:<n>px` declaration in a style attribute',
  controlHeight:
    '`height:<n>px` on <button> / <input> / <select> / <textarea>, or on an element whose class is one of btn / seg / input / field / tag / radio',
  barHeight:
    '`height:<n>px` between 26 and 100 inclusive on a non-control that is either a table cell/row or carries `display:flex` — i.e. a laid-out bar or row rather than a content box',
  panelWidth:
    '`width:<n>px` of at least 56 on an element whose declaration also carries `flex:none`, `border-left` or `border-right` — i.e. a layout column rather than a timeline clip, a table column or a thumbnail',
  hexColor: 'every 6-digit hex literal anywhere in the file, including SVG attributes and the spec prose tables',
  spacing: 'every px component of a `gap` / `column-gap` / `row-gap` / `padding*` declaration, plus the literal `0`',
} as const;

/** The 20 artboards, in file order. Used as the provenance vocabulary below. */
export const DESIGN_ARTBOARDS = [
  '补齐 · 手动编辑与编辑感知',
  '补齐 · Agent 会话历史与设置',
  '补齐 · 暗色与其余页面',
  '补齐 · 规范与状态',
  '补齐 · 比赛工作区子视图',
  '补齐 · 壳层规格',
  '页面状态机',
  'Agent 形态 · 第二轮',
  '01 工作台首页',
  '02 Demo 资料库',
  '03 比赛工作区',
  '04 2D 回放与热力图',
  '05 证据检索',
  '06 玩家目录',
  '07 Agent 创作面板',
  '08 录制计划与镜头预览',
  '09 快速合辑',
  '10 多轨编辑器',
  '11 输出与任务记录',
  '12 设置与诊断',
] as const;

export type DesignArtboard = (typeof DESIGN_ARTBOARDS)[number];

/**
 * One raw value observed in the design reference and the token it merges into.
 * `count` is the number of declarations carrying the value under the matching
 * rule in `EXTRACTION_RULES`. `specSilent` marks a value the spec's merge table
 * does not name; it is folded into the nearest token by the same rule as its
 * neighbours, and is called out so that a reviewer can veto the fold rather
 * than discover it later.
 */
export interface MergeEntry<Token extends string> {
  readonly raw: number;
  readonly token: Token;
  readonly count: number;
  readonly from: readonly DesignArtboard[];
  readonly specSilent?: true;
  readonly note?: string;
}

/** A raw value with more than one legitimate target; the choice is contextual. */
export interface AmbiguousMergeEntry<Token extends string> {
  readonly raw: number;
  readonly tokens: readonly [Token, ...Token[]];
  readonly count: number;
  readonly from: readonly DesignArtboard[];
  readonly note: string;
}

/** A bare value that reaches no token. Every one of these is a decision input. */
export interface UnmappedValue {
  readonly property: string;
  readonly raw: string;
  readonly count: number;
  readonly from: readonly DesignArtboard[];
  readonly reason: string;
}

/* ══════════════════════════════════════════════════════════════════════════
   §3.2 Type scale — 10 steps
   ══════════════════════════════════════════════════════════════════════ */

export type FontSizeToken =
  | '--text-2xs'
  | '--text-xs'
  | '--text-sm'
  | '--text-base'
  | '--text-md'
  | '--text-lg'
  | '--text-xl'
  | '--text-2xl'
  | '--text-3xl'
  | '--text-4xl';

export const FONT_SIZE_PX: Record<FontSizeToken, number> = {
  '--text-2xs': 11,
  '--text-xs': 12,
  '--text-sm': 13,
  '--text-base': 14,
  '--text-md': 15,
  '--text-lg': 17,
  '--text-xl': 19,
  '--text-2xl': 22,
  '--text-3xl': 26,
  '--text-4xl': 40,
};

/**
 * The design reference uses 17 distinct font sizes (10–56). The merge rule is
 * "nearest token, ties resolve downward"; applying it reproduces the spec's
 * prose absorptions (10→11, 16→15, 18→17, 20→19, 21→22, 24→22) exactly, so the
 * table below is mechanical rather than hand-picked.
 */
export const FONT_SIZE_MERGE: readonly MergeEntry<FontSizeToken>[] = [
  {
    raw: 10,
    token: '--text-2xs',
    count: 16,
    from: ['补齐 · 暗色与其余页面', '04 2D 回放与热力图', '补齐 · 壳层规格', '10 多轨编辑器'],
    note: '轨道片段角标、缩略图角标、时间轴刻度',
  },
  {
    raw: 11,
    token: '--text-2xs',
    count: 216,
    from: ['Agent 形态 · 第二轮', '页面状态机', '03 比赛工作区', '补齐 · 暗色与其余页面'],
    note: '分组标题（letter-spacing .16em）、徽标、图例',
  },
  {
    raw: 12,
    token: '--text-xs',
    count: 491,
    from: ['补齐 · 暗色与其余页面', 'Agent 形态 · 第二轮', '补齐 · 规范与状态', '补齐 · 比赛工作区子视图'],
    note: '元数据、说明、次级说明；设计稿第二常用字号',
  },
  {
    raw: 13,
    token: '--text-sm',
    count: 515,
    from: ['补齐 · 规范与状态', '补齐 · 暗色与其余页面', '09 快速合辑', '02 Demo 资料库'],
    note: '表格内容、小按钮、链接；设计稿最常用字号',
  },
  {
    raw: 14,
    token: '--text-base',
    count: 168,
    from: ['03 比赛工作区', '补齐 · Agent 会话历史与设置', '12 设置与诊断', '补齐 · 暗色与其余页面'],
    note: '正文、控件、表格主列；与 Industry `.btn` / `.input` 的 14px 同值',
  },
  {
    raw: 15,
    token: '--text-md',
    count: 23,
    from: ['11 输出与任务记录', '补齐 · 壳层规格', '页面状态机', 'Agent 形态 · 第二轮'],
    note: '段落；与 Industry body 的 15px 同值',
  },
  {
    raw: 16,
    token: '--text-md',
    count: 35,
    from: ['页面状态机', '补齐 · 暗色与其余页面', '补齐 · Agent 会话历史与设置', 'Agent 形态 · 第二轮'],
    note: '会话标题、方案标题；15 与 17 等距，向下取 15',
  },
  {
    raw: 17,
    token: '--text-lg',
    count: 36,
    from: ['补齐 · 规范与状态', '页面状态机', '07 Agent 创作面板', '补齐 · 壳层规格'],
    note: '卡片标题、空态标题、片段标题；与 Industry `.card-title` 同值',
  },
  {
    raw: 18,
    token: '--text-lg',
    count: 36,
    from: ['补齐 · 暗色与其余页面', '补齐 · 规范与状态', '补齐 · 比赛工作区子视图', '03 比赛工作区'],
    note: '规格允许 17 或 19；17 与 19 等距，向下取 17',
  },
  {
    raw: 19,
    token: '--text-xl',
    count: 20,
    from: ['补齐 · 比赛工作区子视图', '补齐 · 壳层规格', '补齐 · 手动编辑与编辑感知', '补齐 · Agent 会话历史与设置'],
    note: '面板标题、子视图标题',
  },
  {
    raw: 20,
    token: '--text-xl',
    count: 4,
    from: ['补齐 · 暗色与其余页面', '02 Demo 资料库', '12 设置与诊断'],
    note: '规格允许 19 或 22；最近为 19。暗色首页顶栏「今日工作」用 20 而浅色同一元素用 22，是设计稿自身的不一致',
  },
  {
    raw: 21,
    token: '--text-2xl',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    note: '暗色方案卡标题「Kael · Mirage 1v3 残局 · 4 个镜头」；最近为 22',
  },
  {
    raw: 22,
    token: '--text-2xl',
    count: 19,
    from: ['Agent 形态 · 第二轮', '03 比赛工作区', '01 工作台首页', '02 Demo 资料库'],
    note: '页面标题',
  },
  {
    raw: 24,
    token: '--text-2xl',
    count: 1,
    from: ['01 工作台首页'],
    note: '待确认方案的大标题；22 与 26 等距，向下取 22',
  },
  {
    raw: 26,
    token: '--text-3xl',
    count: 12,
    from: ['01 工作台首页', '02 Demo 资料库', '03 比赛工作区', '04 2D 回放与热力图'],
    note: '画板标题，产品内对应页面主标题；12 个编号画板各一次',
  },
  {
    raw: 40,
    token: '--text-4xl',
    count: 8,
    from: ['补齐 · 手动编辑与编辑感知', '补齐 · Agent 会话历史与设置', '补齐 · 暗色与其余页面', '补齐 · 规范与状态'],
    note: '章节大标题；8 个补齐画板的 h2',
  },
];

/* ══════════════════════════════════════════════════════════════════════════
   §3.3 Control heights — 4 steps, 32px floor, no exceptions (decision 5)
   ══════════════════════════════════════════════════════════════════════ */

export type ControlHeightToken = '--h-ctl-sm' | '--h-ctl-md' | '--h-ctl-lg' | '--h-ctl-hero';

export const CONTROL_HEIGHT_PX: Record<ControlHeightToken, number> = {
  '--h-ctl-sm': 32,
  '--h-ctl-md': 34,
  '--h-ctl-lg': 38,
  '--h-ctl-hero': 42,
};

/** Nothing below this may ship; briefing §15.3 and spec decision 5. */
export const CONTROL_HEIGHT_FLOOR_PX = 32;

/** Counted by `EXTRACTION_RULES.controlHeight`. */
export const CONTROL_HEIGHT_MERGE: readonly MergeEntry<ControlHeightToken>[] = [
  {
    raw: 26,
    token: '--h-ctl-sm',
    count: 2,
    from: ['补齐 · 手动编辑与编辑感知'],
    specSilent: true,
    note: '规格 §3.3 只列了 28–42；26 出现在第六轮补齐画板的「发送 / 接受」上，同样抬到 32',
  },
  {
    raw: 28,
    token: '--h-ctl-sm',
    count: 25,
    from: ['Agent 形态 · 第二轮', '补齐 · Agent 会话历史与设置', '09 快速合辑', '补齐 · 壳层规格'],
    note: '变更卡的「不用 / 加上」、会话卡的「引用」；抬高后需在 1100×700 复核',
  },
  {
    raw: 30,
    token: '--h-ctl-sm',
    count: 81,
    from: ['补齐 · 规范与状态', '10 多轨编辑器', '补齐 · 暗色与其余页面', '补齐 · 比赛工作区子视图'],
    note: '设计稿里最常用的次级按钮尺寸；多轨编辑器工具栏几乎全是 30',
  },
  {
    raw: 32,
    token: '--h-ctl-sm',
    count: 58,
    from: ['补齐 · 规范与状态', 'Agent 形态 · 第二轮', '02 Demo 资料库', '补齐 · Agent 会话历史与设置'],
    note: '卡内次级动作、工具栏',
  },
  {
    raw: 34,
    token: '--h-ctl-md',
    count: 42,
    from: ['Agent 形态 · 第二轮', '12 设置与诊断', '08 录制计划与镜头预览', '05 证据检索'],
    note: '顶栏动作、筛选器、表单控件',
  },
  {
    raw: 36,
    token: '--h-ctl-md',
    count: 5,
    from: ['06 玩家目录', '补齐 · 手动编辑与编辑感知', '补齐 · 暗色与其余页面', '04 2D 回放与热力图'],
    note: '与 Industry `.btn-icon` / `.input` 的 36px 同值',
  },
  {
    raw: 38,
    token: '--h-ctl-lg',
    count: 6,
    from: ['Agent 形态 · 第二轮', '01 工作台首页', '02 Demo 资料库', '03 比赛工作区', '05 证据检索'],
    note: 'Inspector 主按钮：打开比赛工作区 / 把这个回合加入视频 / 审阅方案',
  },
  {
    raw: 40,
    token: '--h-ctl-lg',
    count: 1,
    from: ['Agent 形态 · 第二轮'],
    note: '「确认合成结果并生成视频」',
  },
  {
    raw: 42,
    token: '--h-ctl-hero',
    count: 3,
    from: ['07 Agent 创作面板', '08 录制计划与镜头预览', '09 快速合辑'],
    note: '终局动作：确认并生成视频 / 开始录制 4 个片段 / 生成视频',
  },
];

/**
 * Divs the design reference draws to look like a select, a text field or a
 * segmented control. They match `EXTRACTION_RULES.barHeight` because they are
 * flex rows, but they belong to the control family — which is why the bar
 * inventory has a 26–32 tail that §3.4 has no token for.
 */
export const CONTROL_LOOKALIKE_HEIGHTS: readonly MergeEntry<ControlHeightToken>[] = [
  {
    raw: 26,
    token: '--h-ctl-sm',
    count: 3,
    from: ['补齐 · 暗色与其余页面', 'Agent 形态 · 第二轮', '10 多轨编辑器'],
    note: '暗色标题栏的搜索框、时间码输入框',
  },
  {
    raw: 28,
    token: '--h-ctl-sm',
    count: 1,
    from: ['补齐 · Agent 会话历史与设置'],
    note: '会话抽屉的「搜索会话、Demo 或选手」输入框',
  },
  {
    raw: 30,
    token: '--h-ctl-sm',
    count: 6,
    from: ['补齐 · 手动编辑与编辑感知', 'Agent 形态 · 第二轮', '补齐 · Agent 会话历史与设置', '补齐 · 暗色与其余页面'],
    note: '镜头卡的就地编辑输入框',
  },
  {
    raw: 32,
    token: '--h-ctl-sm',
    count: 30,
    from: ['补齐 · 规范与状态', '补齐 · 比赛工作区子视图', '02 Demo 资料库', '补齐 · 手动编辑与编辑感知'],
    note: '下拉、路径框、tick 输入框、搜索框、分段控件',
  },
];

/* ══════════════════════════════════════════════════════════════════════════
   §3.4 Bar and row heights — 8 role-named tokens
   ══════════════════════════════════════════════════════════════════════ */

export type BarHeightToken =
  | '--h-titlebar'
  | '--h-topbar'
  | '--h-bar'
  | '--h-panel-head'
  | '--h-thead'
  | '--h-row'
  | '--h-row-compact'
  | '--h-row-evidence'
  | '--h-row-task'
  | '--h-composer'
  | '--h-actionbar';

export const BAR_HEIGHT_PX: Record<BarHeightToken, number> = {
  '--h-titlebar': 44,
  '--h-topbar': 56,
  '--h-bar': 46,
  '--h-panel-head': 40,
  '--h-thead': 34,
  '--h-row': 42,
  '--h-row-compact': 38,
  '--h-row-evidence': 52,
  '--h-row-task': 64,
  '--h-composer': 80,
  '--h-actionbar': 92,
};

/**
 * Which raw values each §3.4 token claims, taken verbatim from the spec table
 * ("吸收原 …"). This is the forward direction; `BAR_HEIGHT_MERGE` is its
 * inverse and is therefore multi-valued for 34 / 38 / 40 / 44.
 */
export const BAR_HEIGHT_CLAIMS: Record<BarHeightToken, readonly number[]> = {
  '--h-titlebar': [44],
  '--h-topbar': [56],
  '--h-bar': [46],
  '--h-panel-head': [40, 38, 44],
  '--h-thead': [34, 32],
  '--h-row': [42],
  '--h-row-compact': [38, 34, 36, 40],
  '--h-row-evidence': [52],
  '--h-row-task': [64],
  '--h-composer': [80, 66],
  '--h-actionbar': [92, 96],
};

/**
 * The §3.4 tokens are named by role, not by size, so several raw values are
 * claimed by more than one token. The choice is a per-call-site decision that
 * cannot be derived from the pixel value; both candidates are recorded.
 */
export const BAR_HEIGHT_MERGE: readonly (MergeEntry<BarHeightToken> | AmbiguousMergeEntry<BarHeightToken>)[] = [
  {
    raw: 34,
    tokens: ['--h-thead', '--h-row-compact'],
    count: 28,
    from: ['12 设置与诊断', '补齐 · 暗色与其余页面', 'Agent 形态 · 第二轮', '补齐 · Agent 会话历史与设置'],
    note: '34px 同时是表头、密集列表行和「模型 / 会话 / 行为边界」这类分节头。分节头在实现时走 --h-panel-head',
  },
  {
    raw: 36,
    token: '--h-row-compact',
    count: 46,
    from: ['补齐 · 暗色与其余页面', '补齐 · 比赛工作区子视图', '补齐 · 规范与状态', '补齐 · 壳层规格'],
    note: '暗色映射表行与侧栏导航项；暗色画板一家占了 23 次',
  },
  {
    raw: 38,
    tokens: ['--h-panel-head', '--h-row-compact'],
    count: 50,
    from: ['补齐 · 壳层规格', '补齐 · 比赛工作区子视图', '03 比赛工作区', '补齐 · 规范与状态'],
    note: '设置分节导航项 38、诊断表行 38、视图导航项 38 —— 前者是面板头族，后两者是密集行族',
  },
  {
    raw: 40,
    tokens: ['--h-panel-head', '--h-row-compact'],
    count: 67,
    from: ['补齐 · 比赛工作区子视图', '补齐 · 壳层规格', '09 快速合辑', '12 设置与诊断'],
    note: '设计稿里出现最多的栏高。Inspector 头是面板头族；资料库表行是密集行族',
  },
  {
    raw: 42,
    token: '--h-row',
    count: 43,
    from: ['02 Demo 资料库', '05 证据检索', '补齐 · 比赛工作区子视图', '03 比赛工作区'],
    note: '表格行，设计稿明写的密度契约',
  },
  {
    raw: 44,
    tokens: ['--h-titlebar', '--h-panel-head'],
    count: 9,
    from: ['Agent 形态 · 第二轮', '补齐 · 壳层规格', '补齐 · Agent 会话历史与设置', '补齐 · 比赛工作区子视图'],
    note: '自绘标题栏是 44；Agent 面板头也画成 44，后者按 §3.4 归到 40',
  },
  {
    raw: 46,
    token: '--h-bar',
    count: 9,
    from: ['补齐 · 手动编辑与编辑感知', '补齐 · Agent 会话历史与设置', '补齐 · 比赛工作区子视图', '11 输出与任务记录'],
    note: '次级栏：筛选条、上下文条、任务记录头',
  },
  {
    raw: 48,
    token: '--h-panel-head',
    count: 3,
    from: ['补齐 · Agent 会话历史与设置', '补齐 · 暗色与其余页面', '10 多轨编辑器'],
    specSilent: true,
    note: '会话抽屉头、多轨编辑器轨道头画成 48；规格只写了吸收 38/44，48 按同一角色一并归入',
  },
  {
    raw: 50,
    token: '--h-bar',
    count: 2,
    from: ['补齐 · 暗色与其余页面', '补齐 · 比赛工作区子视图'],
    specSilent: true,
    note: '底部选择条（「已选 2 场」「已选 2 条」）。§8 的折叠规则把它写成 44，§3.4 没有对应 token；按次级栏归到 46',
  },
  {
    raw: 52,
    token: '--h-row-evidence',
    count: 15,
    from: ['04 2D 回放与热力图', 'Agent 形态 · 第二轮', '补齐 · 暗色与其余页面', '补齐 · 规范与状态'],
    note: '双行证据条目用 52（画板 04）。同一个 52 也被当成 take 卡与任务卡的行高，那些位置同样是双行条目',
  },
  {
    raw: 56,
    token: '--h-topbar',
    count: 18,
    from: ['Agent 形态 · 第二轮', '补齐 · 暗色与其余页面', '02 Demo 资料库', '补齐 · Agent 会话历史与设置'],
    note: '页面顶栏 / 比赛上下文栏',
  },
  {
    raw: 64,
    token: '--h-row-task',
    count: 4,
    from: ['01 工作台首页', '补齐 · 手动编辑与编辑感知', '补齐 · 暗色与其余页面'],
    specSilent: true,
    note: '工作台首页的双行任务行（状态点 ＋ 标题 ＋ 阶段 ＋ 动作）。离 --h-row-evidence 52 有 12px，超过 §3.4 任何一次归并的幅度，所以自成一档',
  },
  {
    raw: 66,
    token: '--h-composer',
    count: 1,
    from: ['补齐 · Agent 会话历史与设置'],
    specSilent: true,
    note: 'Agent 输入区的探索小样；定值取 07 正稿的 80',
  },
  {
    raw: 80,
    token: '--h-composer',
    count: 1,
    from: ['07 Agent 创作面板'],
    specSilent: true,
    note: 'Agent 输入区正稿（多行文本 ＋ 附件行）',
  },
  {
    raw: 92,
    token: '--h-actionbar',
    count: 2,
    from: ['04 2D 回放与热力图', '08 录制计划与镜头预览'],
    specSilent: true,
    note: '页面底部的终局动作条，单行版（padding 0，42px hero 按钮居中）',
  },
  {
    raw: 96,
    token: '--h-actionbar',
    count: 2,
    from: ['07 Agent 创作面板', '补齐 · 暗色与其余页面'],
    specSilent: true,
    note: '同一条动作条的双行版（padding 12–14px ＋ 一行说明）。与 92 的差是 4px，与 --h-panel-head 吸收 38/44 同幅度',
  },
];

/* ══════════════════════════════════════════════════════════════════════════
   §3.5 Panel widths
   ══════════════════════════════════════════════════════════════════════ */

export type PanelWidthToken =
  | '--w-nav'
  | '--w-nav-collapsed'
  | '--w-agent-rail'
  | '--w-subnav'
  | '--w-panel'
  | '--w-inspector'
  | '--w-inspector-wide'
  | '--w-split'
  | '--w-track-head'
  | '--w-overlay';

export const PANEL_WIDTH_PX: Record<PanelWidthToken, number> = {
  '--w-nav': 216,
  '--w-nav-collapsed': 56,
  '--w-agent-rail': 46,
  '--w-subnav': 190,
  '--w-panel': 340,
  '--w-inspector': 380,
  '--w-inspector-wide': 440,
  '--w-split': 520,
  '--w-track-head': 190,
  /* The command palette, drawn `left:172px;top:84px;width:600px`. Absolutely
     positioned, so `EXTRACTION_RULES.panelWidth` excluded it by construction —
     it is not in OBSERVED_PANEL_WIDTHS and therefore carries no MERGE entry.
     Recorded here because the palette still has to get its width from a token,
     and every existing token would be a fold rather than a match. */
  '--w-overlay': 600,
};

/**
 * The widest fold §3.5 asks for: `--w-subnav` 190 absorbs 270, an 80px move.
 * Every other fold in the table is well under it. Recorded as a bound so that a
 * later edit cannot quietly widen a fold past the loosest one the spec itself
 * signed off on.
 */
export const PANEL_WIDTH_MAX_FOLD_PX = 80;

/** Counted by `EXTRACTION_RULES.panelWidth`. */
export const PANEL_WIDTH_MERGE: readonly MergeEntry<PanelWidthToken>[] = [
  {
    raw: 56,
    token: '--w-nav-collapsed',
    count: 1,
    from: ['补齐 · 壳层规格'],
    note: '侧栏收起态图标条',
  },
  {
    raw: 180,
    token: '--w-subnav',
    count: 1,
    from: ['03 比赛工作区'],
    note: '比赛工作区左侧视图导航',
  },
  {
    raw: 190,
    token: '--w-subnav',
    count: 2,
    from: ['补齐 · Agent 会话历史与设置', '补齐 · 比赛工作区子视图'],
    note: '设置分节导航、子视图导航；§3.5 的基准值',
  },
  {
    raw: 200,
    token: '--w-subnav',
    count: 3,
    from: ['补齐 · 暗色与其余页面', '04 2D 回放与热力图'],
    note: '暗色侧栏、回放图层控制列',
  },
  {
    raw: 220,
    token: '--w-subnav',
    count: 1,
    from: ['12 设置与诊断'],
    note: '设置分节导航',
  },
  {
    raw: 270,
    token: '--w-subnav',
    count: 1,
    from: ['10 多轨编辑器'],
    note: '编辑器素材列；§3.5 明写吸收 270，是全表最宽的一次归并（80px），需在阶段 3f 复核素材名放不放得下',
  },
  {
    raw: 310,
    token: '--w-panel',
    count: 1,
    from: ['10 多轨编辑器'],
    note: '片段属性面板',
  },
  {
    raw: 320,
    token: '--w-panel',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    specSilent: true,
    note: '规格写了吸收 310/330/360，未列 320；同一带宽，一并归入',
  },
  {
    raw: 330,
    token: '--w-panel',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    note: '暗色 Inspector',
  },
  {
    raw: 340,
    token: '--w-panel',
    count: 2,
    from: ['补齐 · 规范与状态', '08 录制计划与镜头预览'],
    note: '片段列表、属性面板；§3.5 的基准值',
  },
  {
    raw: 360,
    token: '--w-panel',
    count: 1,
    from: ['08 录制计划与镜头预览'],
    note: '镜头预览 Inspector',
  },
  {
    raw: 380,
    token: '--w-inspector',
    count: 3,
    from: ['补齐 · 壳层规格', '03 比赛工作区', '04 2D 回放与热力图'],
    note: '标准 Inspector；也是 AgentRail 展开态宽度',
  },
  {
    raw: 400,
    token: '--w-inspector',
    count: 3,
    from: ['补齐 · 比赛工作区子视图', '02 Demo 资料库', '09 快速合辑'],
    note: '资料库 / 合辑 Inspector',
  },
  {
    raw: 420,
    token: '--w-inspector-wide',
    count: 2,
    from: ['05 证据检索', '07 Agent 创作面板'],
    note: '证据 Inspector、Agent 变更列',
  },
  {
    raw: 440,
    token: '--w-inspector-wide',
    count: 2,
    from: ['Agent 形态 · 第二轮', '01 工作台首页'],
    note: '宽 Inspector；§3.5 的基准值',
  },
  {
    raw: 460,
    token: '--w-inspector-wide',
    count: 3,
    from: ['补齐 · Agent 会话历史与设置', 'Agent 形态 · 第二轮', '06 玩家目录'],
    note: '玩家档案 Inspector、Agent 对话列',
  },
  {
    raw: 470,
    token: '--w-inspector-wide',
    count: 1,
    from: ['补齐 · Agent 会话历史与设置'],
    specSilent: true,
    note: '会话抽屉浮层；与 420/460 同带宽',
  },
  {
    raw: 520,
    token: '--w-split',
    count: 2,
    from: ['Agent 形态 · 第二轮', '11 输出与任务记录'],
    note: '交付页任务记录栏（对半分栏）',
  },
  {
    raw: 132,
    token: '--w-track-head',
    count: 1,
    from: ['10 多轨编辑器'],
    specSilent: true,
    note: '旧多轨时间轴轨道头；统一 Project review 设计将语义 token 更新为 190px',
  },
  {
    raw: 110,
    token: '--w-track-head',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    specSilent: true,
    note: '旧暗色轨道头；统一 Project review 设计将语义 token 更新为 190px',
  },
];

/**
 * Two §3.5 tokens have no rendered instance in the reference: the artboards
 * always draw the shell already collapsed or cropped at the frame edge. Their
 * values come from the design's own spec prose on the 壳层规格 artboard, which
 * is authoritative for the same document.
 */
export const PANEL_WIDTH_FROM_PROSE: readonly {
  readonly token: PanelWidthToken;
  readonly px: number;
  readonly quote: string;
  readonly from: DesignArtboard;
}[] = [
  {
    token: '--w-nav',
    px: 216,
    quote: '侧栏 216px → 56px 图标条，分组标题只在悬停展开时出现',
    from: '补齐 · 壳层规格',
  },
  {
    token: '--w-agent-rail',
    px: 46,
    quote: '左侧 216px 文字侧栏，右侧 46px Agent 条，默认收起',
    from: '补齐 · 壳层规格',
  },
];

/* ══════════════════════════════════════════════════════════════════════════
   §3.1 Colour
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Industry's `--color-*` set, verbatim from
 * `_ds/industry-b4e06d61-0931-4793-87cc-159aa55ad936/styles.css`. All of it
 * goes into `@theme` unchanged; the design reference references these by
 * `var()` rather than by hex, so most of them never appear in the merge table.
 */
export const INDUSTRY_COLORS = {
  '--color-bg': '#f2f2f3',
  '--color-surface': '#e9e9ea',
  '--color-text': '#1d1f20',
  '--color-accent': '#5980a6',
  '--color-accent-2': '#728fab',
  '--color-divider': 'color-mix(in srgb, #1d1f20 16%, transparent)',
  '--color-neutral-100': '#f5f5f8',
  '--color-neutral-200': '#e7e7ea',
  '--color-neutral-300': '#d4d4d7',
  '--color-neutral-400': '#b7b7ba',
  '--color-neutral-500': '#98989b',
  '--color-neutral-600': '#7a7a7d',
  '--color-neutral-700': '#5d5d60',
  '--color-neutral-800': '#424244',
  '--color-neutral-900': '#2b2b2d',
  '--color-accent-100': '#eef6ff',
  '--color-accent-200': '#d6ebff',
  '--color-accent-300': '#b5d9fd',
  '--color-accent-400': '#94bce3',
  '--color-accent-500': '#749dc4',
  '--color-accent-600': '#597ea3',
  '--color-accent-700': '#416180',
  '--color-accent-800': '#2c455d',
  '--color-accent-900': '#1d2d3d',
  '--color-accent-2-100': '#eef6ff',
  '--color-accent-2-200': '#d6ebff',
  '--color-accent-2-300': '#bdd8f2',
  '--color-accent-2-400': '#9ebbd8',
  '--color-accent-2-500': '#7e9cb8',
  '--color-accent-2-600': '#627d98',
  '--color-accent-2-700': '#486077',
  '--color-accent-2-800': '#314457',
  '--color-accent-2-900': '#1f2d3a',
} as const;

export type IndustryColorToken = keyof typeof INDUSTRY_COLORS;

export type StatusColorToken =
  | '--color-ok'
  | '--color-warn'
  | '--color-fail'
  | '--color-ok-surface'
  | '--color-warn-surface'
  | '--color-fail-surface'
  | '--color-warn-border'
  | '--color-fail-border'
  | '--color-team-b';

/**
 * §3.1's nine status tokens. `'derive'` means the spec fixes the light value
 * and requires the dark value to come from the same derivation algorithm as
 * its semantic parent rather than being hand-picked.
 */
export const STATUS_COLORS: Record<StatusColorToken, { readonly light: string; readonly dark: string | 'derive' }> = {
  '--color-ok': { light: '#4d7a5a', dark: '#6ea87f' },
  '--color-warn': { light: '#a8792f', dark: '#d3a85f' },
  '--color-fail': { light: '#a3453c', dark: '#cf7a72' },
  '--color-ok-surface': { light: '#eef4ee', dark: 'derive' },
  '--color-warn-surface': { light: '#f7efdd', dark: 'derive' },
  '--color-fail-surface': { light: '#f7ecea', dark: 'derive' },
  '--color-warn-border': { light: '#d8bb86', dark: 'derive' },
  '--color-fail-border': { light: '#c9a8a3', dark: 'derive' },
  '--color-team-b': { light: '#c9a55a', dark: 'derive' },
};

export type ColorMode = 'light' | 'dark';

export interface ColorMergeEntry {
  readonly hex: string;
  readonly token: StatusColorToken | IndustryColorToken;
  readonly mode: ColorMode;
  readonly count: number;
  readonly from: readonly DesignArtboard[];
  readonly note?: string;
}

/**
 * Every bare hex in the design reference that reaches a token. 49 distinct
 * hexes appear in the file; the ones missing from this table are either in
 * `DARK_DERIVATION_EVIDENCE` or in `UNMAPPED_VALUES` with the reason.
 */
export const COLOR_MERGE: readonly ColorMergeEntry[] = [
  // Light — status
  {
    hex: '#4d7a5a',
    token: '--color-ok',
    mode: 'light',
    count: 43,
    from: ['补齐 · 规范与状态', '08 录制计划与镜头预览', '11 输出与任务记录', '12 设置与诊断'],
    note: '宿主已验证完成、校验通过；设计稿最常用的裸色',
  },
  {
    hex: '#a8792f',
    token: '--color-warn',
    mode: 'light',
    count: 14,
    from: ['补齐 · 规范与状态', '补齐 · 暗色与其余页面', 'Agent 形态 · 第二轮', '10 多轨编辑器'],
    note: '等待确认、穿墙风险、生命周期不完整；用在边框与状态点上',
  },
  {
    hex: '#a3453c',
    token: '--color-fail',
    mode: 'light',
    count: 25,
    from: ['Agent 形态 · 第二轮', '04 2D 回放与热力图', '补齐 · 规范与状态', '页面状态机'],
    note: '失败、文件缺失、服务离线',
  },
  {
    hex: '#eef4ee',
    token: '--color-ok-surface',
    mode: 'light',
    count: 1,
    from: ['补齐 · 规范与状态'],
    note: '成功 Notice 底',
  },
  {
    hex: '#f7efdd',
    token: '--color-warn-surface',
    mode: 'light',
    count: 5,
    from: ['Agent 形态 · 第二轮', '补齐 · 手动编辑与编辑感知', '补齐 · 规范与状态', '07 Agent 创作面板'],
    note: '警告 Notice 底',
  },
  {
    hex: '#f7ecea',
    token: '--color-fail-surface',
    mode: 'light',
    count: 2,
    from: ['补齐 · 规范与状态', '补齐 · 壳层规格'],
    note: '失败 Notice 底',
  },
  {
    hex: '#d8bb86',
    token: '--color-warn-border',
    mode: 'light',
    count: 4,
    from: ['补齐 · 手动编辑与编辑感知', '补齐 · Agent 会话历史与设置', '补齐 · 规范与状态', '07 Agent 创作面板'],
    note: '警告镜头卡边框',
  },
  {
    hex: '#c9a8a3',
    token: '--color-fail-border',
    mode: 'light',
    count: 12,
    from: ['补齐 · 规范与状态', '11 输出与任务记录', '10 多轨编辑器', '补齐 · 壳层规格'],
    note: '失败卡边框',
  },
  {
    hex: '#c9a55a',
    token: '--color-team-b',
    mode: 'light',
    count: 29,
    from: ['03 比赛工作区', '补齐 · 比赛工作区子视图', '04 2D 回放与热力图', '05 证据检索'],
    note: '对方阵营：回合时间线、雷达标记、选手名牌边框',
  },

  // Light — Industry values the design writes out as hex instead of var()
  {
    hex: '#f2f2f3',
    token: '--color-bg',
    mode: 'light',
    count: 2,
    from: ['补齐 · 暗色与其余页面', '04 2D 回放与热力图'],
    note: '暗色映射表的浅色列，以及雷达 SVG 的 fill',
  },
  {
    hex: '#1d1f20',
    token: '--color-text',
    mode: 'light',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    note: '暗色映射表的浅色列',
  },
  {
    hex: '#5980a6',
    token: '--color-accent',
    mode: 'light',
    count: 6,
    from: ['补齐 · 暗色与其余页面'],
    note: '主按钮实底；映射表明写「浅暗两色共用同一个 accent」',
  },
  {
    hex: '#eef6ff',
    token: '--color-accent-100',
    mode: 'light',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    note: '选中底（映射表浅色列）',
  },
  {
    hex: '#416180',
    token: '--color-accent-700',
    mode: 'light',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    note: '可点击的钢蓝（映射表浅色列）',
  },

  // Dark — the reversal table's right-hand column
  {
    hex: '#16181a',
    token: '--color-bg',
    mode: 'dark',
    count: 3,
    from: ['补齐 · 暗色与其余页面'],
    note: '画布',
  },
  {
    hex: '#33363a',
    token: '--color-divider',
    mode: 'dark',
    count: 30,
    from: ['补齐 · 暗色与其余页面'],
    note: '分隔线由「比背景深」翻成「比背景亮」；暗色画板最常用的裸色',
  },
  {
    hex: '#eceded',
    token: '--color-text',
    mode: 'dark',
    count: 8,
    from: ['补齐 · 暗色与其余页面'],
    note: '主文字',
  },
  {
    hex: '#a8abae',
    token: '--color-neutral-600',
    mode: 'dark',
    count: 18,
    from: ['补齐 · 暗色与其余页面'],
    note: '次文字，对应浅色侧的「文字 70%」',
  },
  {
    hex: '#94bce3',
    token: '--color-accent-400',
    mode: 'dark',
    count: 16,
    from: ['补齐 · 暗色与其余页面'],
    note: '可点击的钢蓝，深底上提亮到 accent-400；与 Industry 的 accent-400 完全同值',
  },
  {
    hex: '#1d2d3d',
    token: '--color-accent-900',
    mode: 'dark',
    count: 4,
    from: ['补齐 · 暗色与其余页面'],
    note: '选中底；与 Industry 的 accent-900 完全同值',
  },
  {
    hex: '#6ea87f',
    token: '--color-ok',
    mode: 'dark',
    count: 2,
    from: ['补齐 · 暗色与其余页面'],
  },
  {
    hex: '#d3a85f',
    token: '--color-warn',
    mode: 'dark',
    count: 1,
    from: ['补齐 · 暗色与其余页面'],
    note: '只在映射表里出现过一次，暗色画板本身没有用到它',
  },
  {
    hex: '#cf7a72',
    token: '--color-fail',
    mode: 'dark',
    count: 2,
    from: ['补齐 · 暗色与其余页面'],
  },
];

/**
 * The "Token 反转规则" table drawn on the 暗色 artboard. It is the authority
 * for deriving the dark theme (spec decision 2), including the two rows that
 * are rules rather than values.
 */
export const DARK_REVERSAL_TABLE: readonly {
  readonly role: string;
  readonly light: string;
  readonly dark: string;
}[] = [
  { role: '画布', light: '#f2f2f3', dark: '#16181a' },
  { role: '侧栏 / 次级面', light: '#ededee', dark: '#1d1f21' },
  { role: '分隔线', light: '文字 16%', dark: '#33363a（比背景亮）' },
  { role: '主文字 / 次文字', light: '#1d1f20 / 70%', dark: '#eceded / #a8abae' },
  { role: '可点击的钢蓝', light: 'accent-700 #416180', dark: 'accent-400 #94bce3' },
  { role: '主按钮', light: '#5980a6 / 纸色字', dark: '#5980a6 / #0f1113 字' },
  { role: '选中底', light: 'accent-100 #eef6ff', dark: 'accent-900 #1d2d3d' },
  { role: '成功 / 警告 / 失败', light: '#4d7a5a #a8792f #a3453c', dark: '#6ea87f #d3a85f #cf7a72' },
  { role: '阴影', light: '墨色投影', dark: '发丝亮边 ＋ 环境暗' },
];

/**
 * Dark hexes the reversal table does not name but that the dark artboard uses.
 * They are evidence for the derivation algorithm (§3.1: "surface / border 由
 * 对应语义色按同一算法派生"), not tokens of their own. All 19 come from the
 * single 暗色 artboard.
 */
export const DARK_DERIVATION_EVIDENCE: readonly {
  readonly hex: string;
  /** The role the dark artboard gives this hex. Free text where the ramp step is a guess. */
  readonly role: string;
  readonly kind: 'surface' | 'border' | 'text' | 'ramp';
  readonly count: number;
}[] = [
  { hex: '#241a19', role: '--color-fail-surface 的暗色派生', kind: 'surface', count: 1 },
  { hex: '#6b3b36', role: '--color-fail-border 的暗色派生', kind: 'border', count: 1 },
  { hex: '#e5a49d', role: '--color-fail 在暗色 surface 上的文字态', kind: 'text', count: 1 },
  { hex: '#22303d', role: 'accent-900 之上的时间轴片段底', kind: 'surface', count: 5 },
  { hex: '#1a2229', role: '选中轨道底', kind: 'surface', count: 1 },
  { hex: '#2a3d4e', role: '选中片段底', kind: 'surface', count: 1 },
  { hex: '#3f5f7d', role: '钢蓝边框（暗）', kind: 'border', count: 3 },
  { hex: '#4a7396', role: '片段边框（暗）', kind: 'border', count: 1 },
  { hex: '#a8c6e0', role: '钢蓝次级文字（暗）', kind: 'text', count: 2 },
  { hex: '#cfe2f4', role: '选中导航项文字（暗）', kind: 'text', count: 1 },
  { hex: '#b9c6d2', role: '卡内次级文字（暗）', kind: 'text', count: 1 },
  { hex: '#0f1113', role: '主按钮上的字（暗，映射表明写）', kind: 'ramp', count: 3 },
  { hex: '#26292c', role: '比 --color-divider 更弱的分隔线 / 次级面（暗）', kind: 'ramp', count: 8 },
  { hex: '#2a2d31', role: '中性面 3（暗）', kind: 'ramp', count: 2 },
  { hex: '#303438', role: '中性面 4（暗）', kind: 'ramp', count: 2 },
  { hex: '#3a3d41', role: '中性面 5 / 时间轴刻度线（暗）', kind: 'ramp', count: 2 },
  { hex: '#4a4e53', role: '中性边框（暗）', kind: 'ramp', count: 4 },
  { hex: '#7d8083', role: '三级文字 / 分组标题（暗）', kind: 'ramp', count: 8 },
  { hex: '#d6d8da', role: '导航项文字（暗，介于主文字与次文字之间）', kind: 'ramp', count: 9 },
];

/* ══════════════════════════════════════════════════════════════════════════
   §3.6 Spacing and radius
   ══════════════════════════════════════════════════════════════════════ */

/** Industry's 0.85× density base. Tailwind 4 derives its numeric scale from it. */
export const SPACING_BASE_PX = 3.4;

/** Largest rounding error any spacing value is allowed to absorb. */
export const SPACING_MAX_DELTA_PX = 0.8;

/**
 * The design reference writes spacing as whole pixels, which do not sit on the
 * 3.4px grid. Each raw value below is snapped to the nearest half step of that
 * grid; `deltaPx` is the resulting rounding error, and none exceeds 0.8px.
 * Six of the steps land on an Industry `--space-*` exactly: 1→space-1, 2→space-2,
 * 3→space-3, 4→space-4, 6→space-6, 8→space-8.
 */
export const SPACING_MERGE: readonly {
  readonly raw: number;
  readonly step: number;
  readonly px: number;
  readonly deltaPx: number;
  readonly count: number;
}[] = [
  { raw: 0, step: 0, px: 0, deltaPx: 0, count: 286 },
  { raw: 1, step: 0.5, px: 1.7, deltaPx: 0.7, count: 12 },
  { raw: 2, step: 0.5, px: 1.7, deltaPx: 0.3, count: 14 },
  { raw: 3, step: 1, px: 3.4, deltaPx: 0.4, count: 11 },
  { raw: 4, step: 1, px: 3.4, deltaPx: 0.6, count: 39 },
  { raw: 5, step: 1.5, px: 5.1, deltaPx: 0.1, count: 42 },
  { raw: 6, step: 2, px: 6.8, deltaPx: 0.8, count: 63 },
  { raw: 7, step: 2, px: 6.8, deltaPx: 0.2, count: 42 },
  { raw: 8, step: 2.5, px: 8.5, deltaPx: 0.5, count: 237 },
  { raw: 9, step: 2.5, px: 8.5, deltaPx: 0.5, count: 77 },
  { raw: 10, step: 3, px: 10.2, deltaPx: 0.2, count: 280 },
  { raw: 11, step: 3, px: 10.2, deltaPx: 0.8, count: 27 },
  { raw: 12, step: 3.5, px: 11.9, deltaPx: 0.1, count: 333 },
  { raw: 13, step: 4, px: 13.6, deltaPx: 0.6, count: 9 },
  { raw: 14, step: 4, px: 13.6, deltaPx: 0.4, count: 238 },
  { raw: 16, step: 4.5, px: 15.3, deltaPx: 0.7, count: 140 },
  { raw: 18, step: 5.5, px: 18.7, deltaPx: 0.7, count: 39 },
  { raw: 20, step: 6, px: 20.4, deltaPx: 0.4, count: 33 },
  { raw: 22, step: 6.5, px: 22.1, deltaPx: 0.1, count: 6 },
  { raw: 24, step: 7, px: 23.8, deltaPx: 0.2, count: 59 },
  { raw: 26, step: 7.5, px: 25.5, deltaPx: 0.5, count: 1 },
  { raw: 28, step: 8, px: 27.2, deltaPx: 0.8, count: 1 },
  { raw: 32, step: 9.5, px: 32.3, deltaPx: 0.3, count: 8 },
  { raw: 40, step: 12, px: 40.8, deltaPx: 0.8, count: 16 },
  { raw: 64, step: 19, px: 64.6, deltaPx: 0.6, count: 6 },
  { raw: 94, step: 27.5, px: 93.5, deltaPx: 0.5, count: 1 },
];

/**
 * The selected Project review language uses compact 3–6px corners and circular
 * status marks. These are the only radius values exposed to callers.
 */
export const RADIUS_PX = {
  '--radius-sm': 3,
  '--radius-md': 4,
  '--radius-lg': 6,
  '--radius-full': 999,
} as const;

export const DESIGN_BORDER_RADIUS_DECLARATIONS = 4;

/* ══════════════════════════════════════════════════════════════════════════
   Values that reach no token
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Bare values from the design reference with no token to land on. This list is
 * the allowlist the architecture-constraint test checks against, and it is also
 * the decision queue: each entry is either a token §3 is missing, or a value
 * that is legitimately content-sized and should never become a token.
 *
 * Nothing here was folded to make the coverage number look better. A value is
 * on this list precisely when folding it would have moved it further than any
 * fold the spec itself performs.
 */
export const UNMAPPED_VALUES: readonly UnmappedValue[] = [
  // — type —
  {
    property: 'font-size',
    raw: '56px',
    count: 1,
    from: ['Agent 形态 · 第二轮'],
    reason:
      '设计稿自身的封面 h1（「本地 AI 制作工作台」）。§3.2 明写 42/56 只在说明层，不进产品，所以不给 token。产品内最大字号是 --text-4xl 40。',
  },

  // — bar and row heights —
  //
  // 64 / 66 / 80 / 92 / 96 曾经在这里，现在落到 --h-row-task 64、--h-composer 80、
  // --h-actionbar 92。三条定值依据：
  //   · 64 无处可归，离最近的 --h-row-evidence 52 有 12px，超过 §3.4 任何一次归并
  //     （最大 4px），所以给它自己的 token 而不是硬折。
  //   · 输入区的 66 与 80 里，80 出自 07 Agent 创作面板的正稿，66 出自
  //     「Agent 形态 · 第二轮」的探索小样；正稿优先。
  //   · 动作条的 92 与 96 各出现两次，差别只在竖直 padding（0 对 12–14px），
  //     是一次 4px 归并 —— 与 --h-panel-head 吸收 38/44 同幅度。
  {
    property: 'height',
    raw: '172px',
    count: 6,
    from: ['补齐 · 规范与状态'],
    reason:
      '空态卡与失败卡的固定高度（这场还没分析 / 没有命中的证据 / 还没有输出 / 加载骨架 / 这个页面没能打开）。它是内容盒不是栏，所以不在 §3.4 的栏高清单里；但设计稿把它当常量用了 6 次，应在 design/feedback/EmptyState 里固化为组件常量，而不是全局 token，也不是每处重写。',
  },

  // — panel widths —
  //
  // 旧画板的 110 / 132 归并已由统一 Project review 设计的 190px 轨道头取代。

  // — colour —
  {
    property: 'color',
    raw: '#ededee / #1d1f21',
    count: 23,
    from: ['补齐 · 壳层规格', '补齐 · 暗色与其余页面', 'Agent 形态 · 第二轮', '11 输出与任务记录'],
    reason:
      '暗色映射表把这一对写成「侧栏 / 次级面」（浅 #ededee ×19，暗 #1d1f21 ×4），即 SideNav / AgentRail / 底部选择条 / 页脚的底色。Industry 的 --color-surface 是 #e9e9ea，不等值；§3.1 的 9 个状态色也不含它。这是设计稿用得第五多的裸色，缺 token 会直接退回今天的裸值状态。建议补 --color-surface-chrome，暗色取 #1d1f21。',
  },
  {
    property: 'color',
    raw: '#a8c3a9',
    count: 1,
    from: ['补齐 · 规范与状态'],
    reason:
      '成功 Notice 的边框，与 --color-ok-surface #eef4ee 成对出现。§3.1 定义了 --color-warn-border 与 --color-fail-border，唯独没有 ok-border。三个语义色应当对称，建议补 --color-ok-border。只出现 1 次是因为成功态 Notice 在设计稿里只画了一处，不代表它不需要。',
  },
  {
    property: 'color',
    raw: '#7d332c / #7a5a16 / #8a6f2c',
    count: 31,
    from: ['补齐 · 规范与状态', '11 输出与任务记录', 'Agent 形态 · 第二轮', '04 2D 回放与热力图'],
    reason:
      '语义色各自的「文字色」——比语义主色更深，专门用在对应 surface 上（失败 #7d332c ×17、警告 #7a5a16 ×11 与 #8a6f2c ×3）。§3.1 只给了主色 / surface / border 三档，没有 on-surface 文字档；直接用主色在 #f7ecea / #f7efdd 上对比度不足。建议补 --color-fail-text / --color-warn-text（以及对称的 --color-ok-text），或规定由主色按固定算法压暗。#7a5a16 与 #8a6f2c 是同一角色的两次手调，需先合并成一个值。',
  },
  {
    property: 'color',
    raw: '#e6e6e7',
    count: 2,
    from: ['08 录制计划与镜头预览', '10 多轨编辑器'],
    reason:
      '预览画面周围的信箱底色。与 Industry --color-neutral-200 #e7e7ea 只差 1/255 的三个分量，几乎肯定是手调偏差；建议直接用 --color-neutral-200，不新增 token。',
  },

  // — families §3 defines no token for at all —
  {
    property: 'letter-spacing',
    raw: '.02em / .04em / .06em / .08em / .1em / .12em / .14em / .16em / .24em',
    count: 140,
    from: ['补齐 · 手动编辑与编辑感知', '补齐 · 壳层规格', '03 比赛工作区', '10 多轨编辑器'],
    reason:
      '§3.2 只顺带提了分组标题用 .16em，§3 没有字距 token 族。9 个非零取值里 .16em(33) / .08em(32) / .1em(27) / .14em(16) 是主力，其余是零星微调。theme.css 至少需要 --tracking-caps(.16em) 与 --tracking-wide(.08em) 两级，否则页面又会写裸值，而 §2.1 的 lint 只拦 hex 与字号，拦不住字距。',
  },
  {
    property: 'line-height',
    raw: '1.5 / 1.6 / 1.65 / 1.7 / 1.75 / 1.8 / 1.9',
    count: 111,
    from: ['补齐 · 手动编辑与编辑感知', '补齐 · 规范与状态', '页面状态机'],
    reason:
      '§3 没有行高 token 族。1.6(59) 与 1.7(33) 是正文主力，1.8(6) / 1.5(6) / 1.9(5) 次之，1.65 与 1.75 各一次是手滑级别的差异。建议归成 --leading-tight(1.2，标题，与 Industry h1–h6 的 1.12 对齐) / --leading-normal(1.6) / --leading-relaxed(1.8) 三级。',
  },
  {
    property: 'font-weight',
    raw: '（无内联声明）',
    count: 0,
    from: [],
    reason:
      '设计稿一次都没有内联 font-weight，全靠 Industry 的 --font-heading-weight: 600 与 body 的 400。记在这里是为了说明「没有找到」不等于「没查」——字重不需要新 token。',
  },
];

/* ══════════════════════════════════════════════════════════════════════════
   Aggregate counts — what the extraction actually found
   ══════════════════════════════════════════════════════════════════════ */

/** Distinct raw values found per property under `EXTRACTION_RULES`, before merging. */
export const DESIGN_DISTINCT_VALUE_COUNTS = {
  fontSize: 17,
  controlHeight: 9,
  barOrRowHeight: 20,
  panelWidth: 20,
  hexColor: 49,
  spacing: 26,
  letterSpacing: 10,
  lineHeight: 7,
  borderRadius: 4,
} as const;

/**
 * Where the spec's own arithmetic differs from what the file contains. Kept as
 * data so the divergence is visible rather than silently corrected. None of
 * these changes a token value; they change what the spec can claim to cover.
 */
export const SPEC_COUNT_DISCREPANCIES: readonly {
  readonly section: string;
  readonly claim: string;
  readonly found: string;
}[] = [
  {
    section: '§3.2',
    claim: '设计稿出现 21 种字号（9–56）',
    found: '17 种，范围 10–56。规格提到被吸收的 9 / 25 / 32 / 42 px 在文件里一次都没有出现，应是早几轮画板的残留',
  },
  {
    section: '§3.3',
    claim: '设计稿出现 28/30/32/34/36/38/40/42 八种控件高度',
    found: '九种：还有 26px（第六轮补齐画板的「发送 / 接受」×2）。同样抬到 32，不构成例外',
  },
  {
    section: '§3.4',
    claim: '八个栏高 token 覆盖 32–56',
    found: '栏高实际用到 26–96 共 20 种。48 / 50 规格没提（已按角色归入）；64 / 66 / 80 / 92 / 96 无处可归，见 UNMAPPED_VALUES',
  },
  {
    section: '§3.5',
    claim: '设计稿出现 17 种（132–520），归并为 6 级',
    found:
      '按「布局列」判据是 20 种（56–520），归并表实际写了 7 个 token（含行内提到的 --w-nav-collapsed 共 8 个）。--w-nav 216 与 --w-agent-rail 46 在画板上一次都没画出来，只在壳层规格的说明文字里，见 PANEL_WIDTH_FROM_PROSE',
  },
];

/* ══════════════════════════════════════════════════════════════════════════
   Lookup helpers — used by theme.css generation and by the constraint test
   ══════════════════════════════════════════════════════════════════════ */

export function lookupFontSizeToken(raw: number): FontSizeToken | undefined {
  return FONT_SIZE_MERGE.find((entry) => entry.raw === raw)?.token;
}

export function lookupControlHeightToken(raw: number): ControlHeightToken | undefined {
  const entry =
    CONTROL_HEIGHT_MERGE.find((item) => item.raw === raw) ?? CONTROL_LOOKALIKE_HEIGHTS.find((item) => item.raw === raw);
  return entry?.token;
}

export function lookupBarHeightTokens(raw: number): readonly BarHeightToken[] {
  const entry = BAR_HEIGHT_MERGE.find((item) => item.raw === raw);
  if (!entry) {
    return [];
  }
  return 'tokens' in entry ? entry.tokens : [entry.token];
}

export function lookupPanelWidthToken(raw: number): PanelWidthToken | undefined {
  return PANEL_WIDTH_MERGE.find((entry) => entry.raw === raw)?.token;
}

export function lookupColorToken(hex: string): ColorMergeEntry | undefined {
  const needle = hex.toLowerCase();
  return COLOR_MERGE.find((entry) => entry.hex === needle);
}

export function lookupSpacingStep(raw: number): number | undefined {
  return SPACING_MERGE.find((entry) => entry.raw === raw)?.step;
}

/** True when the value is on the unmapped allowlist for that property. */
export function isAllowlistedUnmapped(property: string, raw: string): boolean {
  return UNMAPPED_VALUES.some((entry) => entry.property === property && entry.raw.split(' / ').includes(raw));
}
