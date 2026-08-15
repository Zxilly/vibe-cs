/*
 * Domain layer, 2 of 3 — match/, the closed vocabularies.
 *
 * Four unions the workspace repeats everywhere — which side a team is on, how a
 * round ended, what kind of fact a piece of evidence is, what kind of moment a
 * highlight is — plus one `Record` per union mapping the member to its glyph and
 * its label.
 *
 * The tables exist so that no component ever grows an `if (reason === …)` chain.
 * A chain is where a new member silently renders as nothing; a `Record<Union, …>`
 * with no index signature fails to compile until the member is given a label, and
 * `matchEnums.test.ts` walks the union lists to prove every table is total.
 *
 * Labels are `MessageDescriptor`s (`msg` from `@lingui/core/macro`) rather than
 * `<Trans>` elements: half the uses are accessible names and `title` strings,
 * which need a `string`. A component reads one with `useLingui().i18n._(…)`,
 * the same pattern `app/shell/navigation.tsx` established for the side nav.
 *
 * Icons are Lucide components, chosen so that no two members of the same union
 * share an outline. Spec §6.2's accessibility line — 「不要用颜色单独承载含义」 —
 * is met at this layer: the meaning is in the glyph and the label, and colour is
 * only ever a second, redundant channel on top of them.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import {
  Bomb,
  CircleHelp,
  Crosshair,
  Flag,
  Flame,
  ShieldCheck,
  Skull,
  Star,
  Timer,
  type LucideIcon,
} from 'lucide-react';

/* ── team side ───────────────────────────────────────────────────────────── */

/**
 * CT or T. Sides swap at the half, so this is a property of a team *in a
 * period*, never of the team itself — see `types.ts`, `TeamScore.side`.
 */
export type TeamSide = 'ct' | 't';

export const TEAM_SIDES: readonly TeamSide[] = ['ct', 't'];

export interface TeamSideMeta {
  /** 「反恐精英」/「恐怖分子」 — the full name, for an accessible label. */
  readonly label: MessageDescriptor;
  /**
   * The two-letter badge the scoreboard prints. Not a `MessageDescriptor`:
   * CT and T are the in-game abbreviations and stay Latin in every locale.
   */
  readonly abbreviation: string;
  readonly icon: LucideIcon;
}

/**
 * Both sides carry a glyph *and* a two-letter word, so the badge survives being
 * read in greyscale — the reference paints the two teams accent / team-b, and
 * that hue is the one channel this table deliberately does not own.
 */
export const TEAM_SIDE: Readonly<Record<TeamSide, TeamSideMeta>> = {
  ct: { label: msg`反恐精英`, abbreviation: 'CT', icon: ShieldCheck },
  t: { label: msg`恐怖分子`, abbreviation: 'T', icon: Bomb },
};

/* ── round outcome ───────────────────────────────────────────────────────── */

/** Which of the two teams on the context bar took the round. */
export type RoundWinner = 'a' | 'b';

/**
 * How the round ended. The four ways CS2 can end one, plus the honest fifth for
 * a demo whose round-end message did not parse.
 *
 * The names match the analyser's canonical reasons
 * (`crates/demo/src/demoparser_backend.rs`, `canonical_round_reason`):
 * `t_killed` / `ct_killed` both mean elimination, and the other three map
 * one-to-one. `normaliseRoundEndReason` below is the only place that knows the
 * wire spellings.
 */
export type RoundEndReason = 'elimination' | 'bomb-exploded' | 'bomb-defused' | 'time-expired' | 'unknown';

export const ROUND_END_REASONS: readonly RoundEndReason[] = [
  'elimination',
  'bomb-exploded',
  'bomb-defused',
  'time-expired',
  'unknown',
];

export interface RoundEndReasonMeta {
  readonly label: MessageDescriptor;
  readonly icon: LucideIcon;
}

export const ROUND_END_REASON: Readonly<Record<RoundEndReason, RoundEndReasonMeta>> = {
  elimination: { label: msg`击杀清场`, icon: Skull },
  'bomb-exploded': { label: msg`炸弹引爆`, icon: Bomb },
  'bomb-defused': { label: msg`拆弹成功`, icon: ShieldCheck },
  'time-expired': { label: msg`时间耗尽`, icon: Timer },
  unknown: { label: msg`结束原因未知`, icon: CircleHelp },
};

/** The marker a 关键回合 carries; the strip draws it as a second edge rule. */
export const KEY_ROUND = { label: msg`关键回合`, icon: Star } as const;

/**
 * Wire reason → union member. Accepts the analyser's canonical spellings, the
 * `#SFUI_Notice_*` messages the demo itself carries, and the loose forms
 * (`ct_win`, `defused`) that older records use. Anything else becomes
 * `unknown`, which renders as 「结束原因未知」 rather than as a blank cell.
 */
export function normaliseRoundEndReason(reason: string | null | undefined): RoundEndReason {
  if (reason === null || reason === undefined) return 'unknown';
  const key = reason.trim().toLowerCase().replace(/[\s_-]+/gu, '');

  if (key.includes('defus')) return 'bomb-defused';
  if (key.includes('bombed') || key.includes('exploded') || key.includes('detonat')) return 'bomb-exploded';
  if (key.includes('timeranout') || key.includes('targetsaved') || key.includes('timeexpired')) {
    return 'time-expired';
  }
  if (key.includes('killed') || key.includes('elimination') || key.includes('win')) return 'elimination';
  return 'unknown';
}

/* ── evidence ────────────────────────────────────────────────────────────── */

/**
 * What a row of evidence is a record of. The five the 「05 证据检索」 segmented
 * control offers (击杀 / 死亡 / 回合 / 目标事件 / 道具), which is also the set
 * `TimelineEvent.kind` collapses onto for display purposes.
 */
export type EvidenceKind = 'kill' | 'death' | 'round' | 'objective' | 'utility';

export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['kill', 'death', 'round', 'objective', 'utility'];

export interface EvidenceKindMeta {
  readonly label: MessageDescriptor;
  readonly icon: LucideIcon;
}

/*
 * Every member carries `context: 'evidence-kind'`, not just the ones that
 * collide today. Each label names *one event* and is singular in English —
 * Kill, Death, Round — while the same two or three characters elsewhere in the
 * app are a plural column header (击杀 = Kills on the player directory), a view
 * tab (回合 = Rounds) or a heatmap mode. Tagging the whole vocabulary keeps the
 * split from being a per-word accident, and stops the next added kind from
 * silently inheriting some other screen's translation. The call has to be
 * written out per member: `msg` is a compile-time macro, so wrapping it in a
 * helper leaves nothing for the extractor to read.
 */
export const EVIDENCE_KIND: Readonly<Record<EvidenceKind, EvidenceKindMeta>> = {
  kill: { label: msg({ message: '击杀', context: 'evidence-kind' }), icon: Crosshair },
  death: { label: msg({ message: '死亡', context: 'evidence-kind' }), icon: Skull },
  round: { label: msg({ message: '回合', context: 'evidence-kind' }), icon: Flag },
  objective: { label: msg({ message: '目标事件', context: 'evidence-kind' }), icon: Bomb },
  utility: { label: msg({ message: '道具', context: 'evidence-kind' }), icon: Flame },
};

/* ── highlight ───────────────────────────────────────────────────────────── */

/**
 * The type filter of the 「高光列表」 sub-view: 残局 / 多杀 / 穿墙 / 爆头 /
 * 赛点 / 经济翻盘, plus 盲狙 and 首杀 which the same list draws as rows, plus
 * `other` for a candidate the detector produced without a type.
 *
 * 「clutches 并入高光列表 · 类型筛选」 (spec §7) is why 残局 is a member of this
 * union and not a sub-view of its own.
 */
export type HighlightKind =
  | 'clutch'
  | 'multi-kill'
  | 'wallbang'
  | 'headshot'
  | 'no-scope'
  | 'opening-kill'
  | 'match-point'
  | 'eco-comeback'
  | 'other';

export const HIGHLIGHT_KINDS: readonly HighlightKind[] = [
  'clutch',
  'multi-kill',
  'wallbang',
  'headshot',
  'no-scope',
  'opening-kill',
  'match-point',
  'eco-comeback',
  'other',
];

export interface HighlightKindMeta {
  readonly label: MessageDescriptor;
}

/**
 * Labels only. The reference draws a highlight's type as a `Tag`, never as an
 * icon — the row already carries the round, the player and a sentence, and a
 * ninth glyph in that line would compete with the text rather than support it.
 */
export const HIGHLIGHT_KIND: Readonly<Record<HighlightKind, HighlightKindMeta>> = {
  clutch: { label: msg`残局` },
  'multi-kill': { label: msg`多杀` },
  wallbang: { label: msg`穿墙` },
  headshot: { label: msg`爆头` },
  'no-scope': { label: msg`盲狙` },
  'opening-kill': { label: msg`首杀` },
  'match-point': { label: msg`赛点` },
  'eco-comeback': { label: msg`经济翻盘` },
  other: { label: msg`其他` },
};
