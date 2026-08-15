/*
 * Domain layer, 2 of 3 — match/Scoreboard.
 *
 * 「03 比赛工作区」 draws it as three spans in the context bar:
 *
 *     <span font-heading 18px>Aurora</span>
 *     <span mono 18px accent-800>13 : 11</span>
 *     <span font-heading 18px>Meridian</span>
 *
 * §3.2 folds 18 onto `--text-lg` (17). Everything else here is what that one
 * line cannot say and the product needs anyway.
 *
 * ── Sides are not a colour ───────────────────────────────────────────────
 *
 * A team's side is printed as a badge carrying **both** the two-letter word
 * (CT / T) and a distinct glyph — shield versus bomb — from the `TEAM_SIDE`
 * table. The reference paints team A accent and team B `--color-team-b`, and
 * that hue stays a redundant third channel: strip the colour and the badge
 * still says which side each team is on. This is spec §6.2's accessibility
 * requirement taken literally.
 *
 * Sides swap at the half, so `side` belongs to the team *now*, and `periods`
 * carries the per-half history. `sidesSwapped` states the swap in words rather
 * than leaving the reader to infer it from two badges having changed — the
 * design system's 「不隐藏」 rule applies to facts as well as to controls.
 *
 * ── An unanalysed match ──────────────────────────────────────────────────
 *
 * 「02 Demo 资料库」 draws an unanalysed demo with 「—」 where the score would be
 * and the line 「分析后才有比分与高光」. So `score: null` is a first-class state,
 * not an error: the em dash renders, the accessible name says 比分未知, and no
 * zero is invented.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { ArrowLeftRight } from 'lucide-react';

import { cx } from '../../design/primitives';
import { TEAM_SIDE, type TeamSide } from './matchEnums';
import type { MatchPeriod, TeamScore } from './types';

/* Not a member of any union, so it stays here rather than in `matchEnums`. */
const UNKNOWN_SCORE = msg`未知`;

export type ScoreboardSize = 'sm' | 'md';

export interface ScoreboardProps {
  readonly teamA: TeamScore;
  readonly teamB: TeamScore;
  /** Halves and overtimes, in order. Omitted, only the aggregate shows. */
  readonly periods?: readonly MatchPeriod[] | undefined;
  /**
   * True once the two teams have changed ends. Stated in words next to the
   * score; the page derives it by comparing `periods` to the current sides.
   */
  readonly sidesSwapped?: boolean | undefined;
  /** `md` is the context bar's size; `sm` is for a row or a card. */
  readonly size?: ScoreboardSize | undefined;
  readonly className?: string | undefined;
}

/** 「—」: the reference's own stand-in for a score that does not exist yet. */
const NO_SCORE = '—';

const NAME_CLASS: Readonly<Record<ScoreboardSize, string>> = {
  sm: 'font-heading text-base',
  md: 'font-heading text-lg',
};

const SCORE_CLASS: Readonly<Record<ScoreboardSize, string>> = {
  sm: 'font-mono text-base text-accent-800',
  md: 'font-mono text-lg text-accent-800',
};

export function Scoreboard({
  teamA,
  teamB,
  periods,
  sidesSwapped = false,
  size = 'md',
  className,
}: ScoreboardProps) {
  const { i18n } = useLingui();

  const scoreText = (score: number | null): string => (score === null ? NO_SCORE : String(score));
  const spoken = (team: TeamScore): string =>
    team.score === null ? i18n._(UNKNOWN_SCORE) : String(team.score);

  return (
    <div
      data-scoreboard=""
      data-size={size}
      className={cx('flex min-w-0 flex-col justify-center gap-0.5', className)}
    >
      <div className="flex min-w-0 items-center gap-3">
        <SideBadge side={teamA.side} />
        <span data-scoreboard-team="a" className={cx('min-w-0 truncate', NAME_CLASS[size])}>
          {teamA.name}
        </span>
        {/* One readable sentence for assistive technology; the three visual
            spans are hidden from it so the score is not read as a bare colon. */}
        <span className="sr-only">
          <Trans>
            比分 {spoken(teamA)} 比 {spoken(teamB)}
          </Trans>
        </span>
        <span data-scoreboard-score="" aria-hidden="true" className={cx('flex-none', SCORE_CLASS[size])}>
          {scoreText(teamA.score)} : {scoreText(teamB.score)}
        </span>
        <span data-scoreboard-team="b" className={cx('min-w-0 truncate', NAME_CLASS[size])}>
          {teamB.name}
        </span>
        <SideBadge side={teamB.side} />
      </div>

      {periods === undefined || periods.length === 0 ? null : (
        <ul data-scoreboard-periods="" className="flex flex-wrap items-center gap-2.5 text-2xs text-neutral-700">
          {periods.map((period) => (
            <li key={period.id} data-scoreboard-period={period.id} className="flex items-center gap-1.5">
              <span className={period.overtime === true ? 'text-accent-700' : undefined}>{period.label}</span>
              <span className="font-mono">
                {period.teamAScore}:{period.teamBScore}
              </span>
            </li>
          ))}
          {sidesSwapped ? (
            <li data-scoreboard-swapped="" className="flex items-center gap-1.5">
              <ArrowLeftRight size={11} strokeWidth={1.5} aria-hidden="true" className="flex-none" />
              <Trans>攻守已交换</Trans>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

/**
 * The side badge. Glyph plus word, in that order, so the two channels sit
 * together and neither is decorative: a reader who cannot tell shield from bomb
 * reads CT / T, and a reader skimming shapes gets the glyph.
 */
function SideBadge({ side }: { readonly side: TeamSide | undefined }) {
  const { i18n } = useLingui();
  if (side === undefined) return null;

  const meta = TEAM_SIDE[side];
  const Icon = meta.icon;

  return (
    <span
      data-team-side={side}
      title={i18n._(meta.label)}
      className="flex flex-none items-center gap-1 border border-divider px-1.5 py-0.5 font-heading text-2xs tracking-wide text-neutral-800"
    >
      <Icon size={11} strokeWidth={1.5} aria-hidden="true" />
      <span className="sr-only">{i18n._(meta.label)}</span>
      <span aria-hidden="true">{meta.abbreviation}</span>
    </span>
  );
}
