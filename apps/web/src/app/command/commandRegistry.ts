/*
 * App shell — the command palette's registry.
 *
 * Pure data and pure functions: no React, no router, no `data/**` query. The
 * palette component is the only thing that renders it, and the search algorithm
 * (`./commandSearch.ts`) never sees anything but strings. That split is what
 * lets spec §6.2's `unit` project cover the interesting half of this feature
 * without a DOM.
 *
 * WHAT IS REGISTERED IN THIS ROUND
 * --------------------------------
 * Every static destination of the spec §7 route table, as one `page` command
 * each. Two §7 routes are deliberately absent:
 *
 *   · `/match/:demoId` — a demo id is required, so it cannot be a static entry.
 *     It becomes a `match` group command fed from `data/demos.ts`, which is
 *     exactly what the 壳层规格 artboard draws ("Aurora vs Meridian · Mirage →
 *     打开工作区").
 *   · `/delivery/task/:taskId` — same reason; a `task` id has to come from a
 *     query.
 *
 * `/recording/:taskId?`, `/montage/:projectId?` and `/editor/:projectId?` have
 * optional params, so their bare paths are real destinations and are listed.
 *
 * THE EXTENSION POINT (later phases)
 * ----------------------------------
 * `buildCommandList(extensions)` takes any number of extra definitions and
 * appends them, letting an id already present override the built-in entry. The
 * three kinds of extension the design reference calls for:
 *
 *   1. Action commands — 「导入 Demo · CTRL I」and 「用 Agent 制作视频 · CTRL G」
 *      are drawn in the 动作 group of the 壳层规格 artboard. They are NOT
 *      registered here because their `run` needs a file dialog and the Agent
 *      route's session state, neither of which exists before phases 3b / 3e.
 *      When they land, build them where their dependencies live and pass them
 *      in: `buildCommandList([importDemoCommand(dialog), agentVideoCommand()])`.
 *      Note `shortcut` is display-only — see the field's doc comment.
 *   2. Object commands — 比赛 / 选手 / 证据 rows come from server data, so they
 *      are produced per keystroke by the palette's host from a TanStack Query
 *      result and passed in the same way. `CommandDefinition.title` is a
 *      `MessageDescriptor`, but a match title ("Aurora vs Meridian · Mirage")
 *      is data, not copy — wrap it with `msg` at the call site only if it is
 *      really translatable, otherwise pass `{ id: value, message: value }`.
 *   3. Overrides — an extension reusing a built-in id replaces it, so phase 3e
 *      can swap `page.agent` for a session-aware version without editing this
 *      table.
 *
 * RELATION TO `app/shell/navigation.tsx`
 * -------------------------------------
 * That file holds the SideNav table, which is a *subset* of these destinations
 * (it has no 恢复中心, and it splits `/delivery` into two entries because Frame
 * draws it that way). The two tables agree on labels today but are written
 * separately: the nav table is sourced from `Frame.dc.html`, this one from spec
 * §7, and they were built in parallel. Reconciling them onto one table is an
 * assembly-step job — see the report accompanying this directory.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

/**
 * The 壳层规格 artboard groups results by object type — 比赛 / 选手 / 证据 /
 * 动作 — and the palette's own footer names the full set in display order:
 * 「搜索比赛、选手、证据、页面和动作」.
 */
export type CommandGroupId = 'match' | 'player' | 'evidence' | 'page' | 'action';

/** Display order. Fixed, so 「回车执行首条」 is predictable across keystrokes. */
export const COMMAND_GROUP_ORDER: readonly CommandGroupId[] = [
  'match',
  'player',
  'evidence',
  'page',
  'action',
];

/*
 * `context: 'palette-group'` on every entry. These are collection headings —
 * English wants Matches / Players — while the same characters are singular
 * column headers elsewhere (比赛 = Match in the library table, 选手 = Player in
 * an evidence filter). The whole record is tagged for the same reason the
 * evidence-kind vocabulary is: so a later group cannot pick up a column's
 * translation by accident. Written out per entry because `msg` is a
 * compile-time macro — a helper function would extract nothing.
 */
export const COMMAND_GROUP_LABEL: Record<CommandGroupId, MessageDescriptor> = {
  match: msg({ message: '比赛', context: 'palette-group' }),
  player: msg({ message: '选手', context: 'palette-group' }),
  evidence: msg({ message: '证据', context: 'palette-group' }),
  page: msg({ message: '页面', context: 'palette-group' }),
  action: msg({ message: '动作', context: 'palette-group' }),
};

/**
 * What a command is handed when it runs. Deliberately tiny: the palette itself
 * closes, so a command never needs to. `navigate` receives a router path with
 * its query attached (`/delivery?view=tasks`), never a hash — the router is in
 * hash mode (spec §1.1) and react-router builds the `#` prefix itself.
 */
export interface CommandContext {
  readonly navigate: (to: string) => void;
}

export interface CommandDefinition {
  /** Stable and unique. `buildCommandList` treats a repeat as an override. */
  readonly id: string;
  readonly group: CommandGroupId;
  /** The row's main text. Matched against first, and with the highest weight. */
  readonly title: MessageDescriptor;
  /**
   * The muted right-hand text: 「打开工作区」「玩家档案」. Names what running
   * the command does when the title alone does not say it.
   */
  readonly hint?: MessageDescriptor | undefined;
  /**
   * Extra match terms that are not in the title — route paths, latin names,
   * synonyms. Not localized: they are aliases, so they keep working when the
   * UI is switched to en-US and the user still types 「资料库」, and vice versa.
   * Lower-cased here; `commandSearch` lower-cases again defensively.
   */
  readonly keywords: readonly string[];
  /**
   * Display only — the chip on the right of the row (「CTRL I」). Binding a
   * global accelerator is the shell's business, not the registry's; this field
   * exists so the palette can advertise a binding that already exists
   * elsewhere. Nothing in this directory reads it as a key spec.
   */
  readonly shortcut?: string | undefined;
  readonly run: (context: CommandContext) => void;
}

/** A page jump. Every §7 destination in this file is built through it. */
function pageCommand(input: {
  readonly id: string;
  readonly title: MessageDescriptor;
  readonly to: string;
  readonly keywords: readonly string[];
}): CommandDefinition {
  return {
    id: `page.${input.id}`,
    group: 'page',
    title: input.title,
    /* `context` because `design/feedback/StageBar` writes the same two
       characters for the recording pipeline's seek stage. One msgid would give
       both one English word; they need Go to and Seek. */
    hint: msg({ message: '跳转', context: 'palette-hint' }),
    // The path itself is always a term, so typing `/set` or `delivery` finds
    // the page even when the user thinks in routes rather than in labels.
    keywords: [input.to, ...input.keywords].map((keyword) => keyword.toLowerCase()),
    run: (context) => {
      context.navigate(input.to);
    },
  };
}

/**
 * Spec §7's route table, in the order the SideNav lists it (工作台 · 资料库 ·
 * 制作 · 交付 · 设置), with 恢复中心 last — Frame gives it no rail entry, so the
 * palette is the only way to reach it by keyboard, which is precisely the
 * 页面状态机 board's 「可直达任意页面」.
 */
export const PAGE_COMMANDS: readonly CommandDefinition[] = [
  pageCommand({ id: 'home', title: msg`工作台`, to: '/', keywords: ['home', 'dashboard', '首页', '工作台'] }),
  pageCommand({
    id: 'library',
    title: msg`Demo 资料库`,
    to: '/library',
    keywords: ['library', 'demo', '资料库', '比赛列表'],
  }),
  pageCommand({
    id: 'history',
    title: msg`比赛历史`,
    to: '/history',
    keywords: ['history', 'steam', '下载', '历史'],
  }),
  pageCommand({ id: 'players', title: msg`玩家目录`, to: '/players', keywords: ['players', '玩家', '选手'] }),
  pageCommand({
    id: 'evidence',
    title: msg`证据检索`,
    to: '/evidence',
    keywords: ['evidence', '证据', '检索', '标注'],
  }),
  pageCommand({
    id: 'agent',
    title: msg`Agent 创作`,
    to: '/agent',
    keywords: ['agent', 'ai', '创作', '方案', '会话'],
  }),
  pageCommand({
    id: 'recording',
    title: msg`录制计划`,
    to: '/recording',
    keywords: ['recording', '录制', '镜头', '计划'],
  }),
  pageCommand({ id: 'montage', title: msg`快速合辑`, to: '/montage', keywords: ['montage', '合辑', '快速'] }),
  pageCommand({
    id: 'editor',
    title: msg`多轨编辑器`,
    to: '/editor',
    keywords: ['editor', '编辑', '时间轴', '剪辑'],
  }),
  // §7 gives /delivery a `?view=outputs|tasks` query and Frame lists the two
  // views as separate rail entries, so they are two commands here as well —
  // 「跳到任务记录」is a distinct intent from 「跳到输出」.
  pageCommand({
    id: 'delivery-outputs',
    title: msg`输出`,
    to: '/delivery?view=outputs',
    keywords: ['delivery', 'outputs', '输出', '成片', '交付'],
  }),
  pageCommand({
    id: 'delivery-tasks',
    title: msg`任务记录`,
    to: '/delivery?view=tasks',
    keywords: ['delivery', 'tasks', '任务', '记录', '交付'],
  }),
  pageCommand({
    id: 'settings',
    title: msg`设置与诊断`,
    to: '/settings',
    keywords: ['settings', '设置', '诊断', '偏好'],
  }),
  pageCommand({
    id: 'recovery',
    title: msg`恢复中心`,
    to: '/recovery',
    keywords: ['recovery', '恢复', '损坏', '修复'],
  }),
];

/**
 * The list the palette renders. `extensions` are appended in the order given;
 * a definition whose id is already present replaces the earlier one in place,
 * keeping the built-in position rather than jumping to the end.
 */
export function buildCommandList(
  extensions: readonly CommandDefinition[] = [],
): readonly CommandDefinition[] {
  const commands = [...PAGE_COMMANDS];
  for (const extension of extensions) {
    const existing = commands.findIndex((command) => command.id === extension.id);
    if (existing === -1) commands.push(extension);
    else commands[existing] = extension;
  }
  return commands;
}

/**
 * A command with its copy resolved to strings — what the search and the rows
 * both consume. `hint` and `shortcut` become `null` rather than staying
 * optional so that `exactOptionalPropertyTypes` never forces a conditional
 * spread at a call site.
 */
export interface ResolvedCommand {
  readonly id: string;
  readonly group: CommandGroupId;
  readonly title: string;
  readonly hint: string | null;
  readonly keywords: readonly string[];
  readonly shortcut: string | null;
  readonly run: (context: CommandContext) => void;
}

/**
 * Resolves every descriptor through `translate` (in the app: `i18n._`). Pure,
 * so a test can pass a fake translator and assert on ranking without a locale.
 */
export function resolveCommands(
  commands: readonly CommandDefinition[],
  translate: (descriptor: MessageDescriptor) => string,
): readonly ResolvedCommand[] {
  return commands.map((command) => ({
    id: command.id,
    group: command.group,
    title: translate(command.title),
    hint: command.hint === undefined ? null : translate(command.hint),
    keywords: command.keywords,
    shortcut: command.shortcut ?? null,
    run: command.run,
  }));
}
