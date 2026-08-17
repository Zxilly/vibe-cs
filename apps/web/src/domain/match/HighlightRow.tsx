/*
 * Domain layer, 2 of 3 — match/HighlightRow.
 *
 * ── Why this is not `EvidenceRow` with an end tick ──────────────────────
 *
 * The brief asked me to read the artboards and decide whether the two should be
 * one component. They should not, and the reason is not styling — the two rows
 * answer different questions and are operated differently:
 *
 *   1. **A point versus an interval.** Evidence is stamped with one tick
 *      (「149380」) and its action is 「定位」 — seek there. A highlight owns a
 *      range (「148 920–150 440」) and its action is 「加入视频」 — hand that range
 *      to the recorder. Merging makes `endTick` optional and every consumer has
 *      to branch on it; the range is not an embellishment of a point, it is the
 *      thing being selected.
 *   2. **Selection is a different mechanism.** 「高光列表」 draws a checkbox in
 *      its first column and closes with 「已选 2 条 · 加入录制队列 · 用 Agent 制作
 *      视频」 — multi-select feeding a batch action. Evidence rows are
 *      single-select: picking one fills the Inspector. A merged row would carry
 *      both a checkbox and a current-row state, of which exactly one is ever
 *      live, which is the signature of two components wearing one name.
 *   3. **Different vocabularies.** A highlight has a `kind` from a type filter
 *      (残局 / 多杀 / 穿墙 / 赛点 / 经济翻盘) and a subject that may be a *team*
 *      (「Aurora · 经济翻盘」). Evidence has actor / target / weapon and an
 *      annotation state. The overlap is round + ticks, which is what
 *      `matchTime` and `types.ts` already share between them.
 *
 * The reference draws it in two shapes and both are here:
 *
 *   default  「高光列表」 sub-view — checkbox / 回合 / 类型 / 选手 / 说明 /
 *            tick 区间 / 加入视频, at 40px, which §3.4 folds onto `--h-row` (42)
 *   compact  「玩家单场分析 · 这一场的高光」 — 类型标签 + R21 + 加入视频 at 38px
 *            (`--h-row-compact`), no description column
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Skeleton } from '../../design/data';
import { Checkbox, cn, Tag } from '../../design/primitives';
import { HIGHLIGHT_KIND } from './matchEnums';
import { CS2_TICK_RATE, formatTickRange, formatTickRangeSeconds } from './matchTime';
import type { HighlightCandidate } from './types';

export type HighlightDensity = 'default' | 'compact';

export interface HighlightRowProps {
  readonly highlight: HighlightCandidate;
  readonly density?: HighlightDensity | undefined;
  readonly tickRate?: number | undefined;
  /**
   * Multi-select state. `undefined` renders no checkbox at all — the compact
   * form of the artboard has none, and an always-present control that does
   * nothing is worse than an absent one.
   */
  readonly selected?: boolean | undefined;
  readonly onSelectedChange?: ((selected: boolean, highlight: HighlightCandidate) => void) | undefined;
  /** The row this list is currently pointing at, if the page tracks one. */
  readonly current?: boolean | undefined;
  /** 「加入视频」 / 「加入录制队列」 — supplied by the page, which owns the queue. */
  readonly action?: ReactNode | undefined;
  readonly className?: string | undefined;
}

const HEIGHT_CLASS: Readonly<Record<HighlightDensity, string>> = {
  default: 'min-h-[var(--h-row)]',
  compact: 'min-h-[var(--h-row-compact)]',
};

const CURRENT_CLASS = 'bg-accent-100 shadow-[inset_2px_0_0_var(--color-accent)]';

const SELECT_LABEL = msg`选择这条高光`;

export function HighlightRow({
  highlight,
  density = 'default',
  tickRate,
  selected,
  onSelectedChange,
  current = false,
  action,
  className,
}: HighlightRowProps) {
  const { i18n } = useLingui();
  const rate = highlight.tickRate ?? tickRate ?? CS2_TICK_RATE;
  const kind = HIGHLIGHT_KIND[highlight.kind];
  const seconds = formatTickRangeSeconds(highlight.startTick, highlight.endTick, rate);

  return (
    <article
      data-highlight-row={highlight.id}
      data-density={density}
      data-kind={highlight.kind}
      aria-current={current ? true : undefined}
      className={cn(
        'flex items-center gap-3 border-b border-divider px-3.5 text-sm',
        HEIGHT_CLASS[density],
        current ? CURRENT_CLASS : null,
        className,
      )}
    >
      {selected === undefined ? null : (
        <span data-highlight-select="" className="flex-none">
          <Checkbox
            size="sm"
            checked={selected}
            aria-label={i18n._(SELECT_LABEL)}
            onChange={(next) => onSelectedChange?.(next, highlight)}
          />
        </span>
      )}

      <span data-highlight-round={highlight.round} className="flex-none font-mono text-xs text-neutral-700">
        <Trans>R{highlight.round}</Trans>
      </span>

      {/* The type is a Tag because that is what the artboard draws, and it
          carries the word itself — the tone is decoration on top of it. */}
      <span className="flex-none">
        <Tag tone={current ? 'accent' : 'neutral'}>{highlight.label ?? i18n._(kind.label)}</Tag>
      </span>

      {highlight.subject === undefined ? null : (
        <span data-highlight-subject="" className="min-w-0 flex-none truncate">
          {highlight.subject}
        </span>
      )}

      {density === 'compact' || highlight.description === undefined ? (
        <span className="min-w-0 flex-1" />
      ) : (
        <span className="min-w-0 flex-1 truncate text-neutral-700">{highlight.description}</span>
      )}

      {highlight.tags === undefined || highlight.tags.length === 0 || density === 'compact' ? null : (
        <span data-highlight-tags="" className="flex flex-none items-center gap-1.5">
          {highlight.tags.map((tag, index) => (
            <Tag key={index} tone="neutral">
              {tag}
            </Tag>
          ))}
        </span>
      )}

      {/* The interval, in both readings: the ticks are what the recorder is
          handed, the seconds are what a person can judge a clip length by. */}
      <span
        data-highlight-range=""
        className="flex flex-none flex-col items-end font-mono text-xs text-neutral-600"
      >
        <span>{formatTickRange(highlight.startTick, highlight.endTick)}</span>
        {density === 'compact' ? null : (
          <span>
            <Trans>{seconds} 秒</Trans>
          </span>
        )}
      </span>

      {action === undefined ? null : (
        <span data-highlight-action="" className="flex-none">
          {action}
        </span>
      )}
    </article>
  );
}

/** The loading form. Same box, no fabricated progress — see `Skeleton.tsx`. */
export function HighlightRowSkeleton({ density = 'default' }: { readonly density?: HighlightDensity }) {
  return (
    <div
      data-highlight-row-skeleton=""
      className={cn('flex items-center gap-3 border-b border-divider px-3.5', HEIGHT_CLASS[density])}
    >
      <Skeleton width="24px" />
      <Skeleton width="48%" />
      <Skeleton width="20%" />
    </div>
  );
}
