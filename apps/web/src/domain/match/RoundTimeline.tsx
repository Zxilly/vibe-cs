/*
 * Domain layer, 2 of 3 — match/RoundTimeline.
 *
 * The 「回合时间线」 panel of 「03 比赛工作区」: one cell per round, click a cell
 * to open that round's 逐回合复盘, with the current round outlined.
 *
 * ── What a cell has to say ──────────────────────────────────────────────
 *
 * Four things, and the reference's own cell only carries one and a half:
 *
 *   who won      the reference's only channel is the fill hue (accent vs
 *                `--color-team-b`). Colour alone fails §6.2, so the cell adds a
 *                **position**: the winner rule is pinned to the top edge for
 *                team A and to the bottom edge for team B. Across a strip that
 *                reads as a two-level waveform, which is legible in greyscale
 *                and at a glance.
 *   how it ended a glyph from `ROUND_END_REASON` — skull / bomb / shield /
 *                timer / question mark. Five different outlines, no shared
 *                silhouette.
 *   key round    a second rule on the *opposite* edge, in ink. A key round is
 *                therefore the only cell with two rules, which is a shape
 *                difference rather than a hue difference.
 *   which round  the number, when it fits. See `roundTimelineLayout.ts`.
 *
 * Everything above is also in the cell's accessible name, in words, so nothing
 * depends on any of the three visual channels.
 *
 * ── Density ─────────────────────────────────────────────────────────────
 *
 * The packing decision is `planRoundStrip`, a pure function tested in the node
 * project — 30 cells at the §8 fold, 58 in a long overtime. This file only
 * turns its answer into `grid-template-columns`.
 *
 * ── Selection ───────────────────────────────────────────────────────────
 *
 * Controlled: `selectedRound` in, `onSelectRound` out. The workspace keeps the
 * round in the URL (spec §4.4, 「URL 是唯一真值」), so this component must not
 * hold a copy of it. Keyboard follows the roving-tabindex pattern — one tab
 * stop for the strip, arrows to move, so a 58-cell strip is not 58 tab stops.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { EmptyState, Skeleton } from '../../design/data';
import { Notice } from '../../design/feedback';
import { cx } from '../../design/primitives';
import { KEY_ROUND, ROUND_END_REASON } from './matchEnums';
import { planRoundStrip } from './roundTimelineLayout';
import type { LoadFailure, RoundSummary } from './types';

export interface RoundTimelineProps {
  readonly rounds: readonly RoundSummary[];
  /** Team A's name, for the legend and for every cell's accessible name. */
  readonly teamAName: ReactNode;
  readonly teamBName: ReactNode;
  /** The round the workspace is showing. `null` while nothing is selected. */
  readonly selectedRound?: number | null | undefined;
  readonly onSelectRound?: ((round: number) => void) | undefined;
  /** Measured content width. Omitted, the §8 worst case is planned against. */
  readonly availableWidthPx?: number | undefined;
  /** True while the analysis is still loading; draws the artboard's skeleton. */
  readonly loading?: boolean | undefined;
  /** A failed load. Renders the §4.1 in-place Notice instead of the strip. */
  readonly failure?: LoadFailure | undefined;
  /** The recovery offered when there are no rounds — 「开始分析」. */
  readonly emptyActions?: ReactNode | undefined;
  readonly className?: string | undefined;
}

/* Cell geometry. The reference draws 44px tall; `--h-row` (42) is the §3.4 step
   it folds onto, and the strip is a row of cells like any other row. */
const CELL_CLASS =
  'relative flex h-[var(--h-row)] min-w-0 flex-col items-stretch justify-center overflow-hidden ' +
  'border border-transparent text-2xs focus-visible:z-10';

const WINNER_FILL = {
  a: 'bg-accent-100 text-accent-900',
  b: 'bg-neutral-100 text-neutral-900',
} as const;

const WINNER_RULE = {
  a: 'bg-accent',
  b: 'bg-team-b',
} as const;

const SELECTED_CLASS = 'outline-2 outline-offset-[-3px] outline-accent-900';

/*
 * `min-h`, not `h`: the header is `flex-wrap`, and a wrapping row inside a fixed
 * height leaves the box instead of growing it. It wraps for real — at the §8
 * fold the title, the hint and the two legend entries want ~445px and the strip
 * panel has 968px, but the same panel inside a 380px Inspector does not. The
 * artboard's 40px is kept as the floor, so the common case is unchanged.
 */
const HEADER_CLASS =
  'flex min-h-[var(--h-panel-head)] flex-none flex-wrap items-center gap-3 border-b border-divider px-3.5 py-1';

export function RoundTimeline({
  rounds,
  teamAName,
  teamBName,
  selectedRound = null,
  onSelectRound,
  availableWidthPx,
  loading = false,
  failure,
  emptyActions,
  className,
}: RoundTimelineProps) {
  const { i18n } = useLingui();
  const stripRef = useRef<HTMLDivElement>(null);

  const plan = planRoundStrip({
    roundCount: rounds.length,
    ...(availableWidthPx === undefined ? {} : { availableWidthPx }),
  });

  /* One tab stop for the whole strip. It lands on the selected cell when there
     is one, otherwise on the first — never nowhere. */
  const focusIndex = Math.max(
    0,
    rounds.findIndex((round) => round.number === selectedRound),
  );

  const moveFocus = (from: number, delta: number) => {
    const next = Math.min(rounds.length - 1, Math.max(0, from + delta));
    const cells = stripRef.current?.querySelectorAll<HTMLButtonElement>('[data-round-cell]');
    cells?.item(next)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;

    if (step !== 0) {
      event.preventDefault();
      moveFocus(index, step);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      moveFocus(0, 0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      moveFocus(rounds.length - 1, 0);
    }
  };

  return (
    <section data-round-timeline="" className={cx('flex flex-col border border-divider', className)}>
      <header className={HEADER_CLASS}>
        <h3 className="font-heading text-base tracking-wide">
          <Trans>回合时间线</Trans>
        </h3>
        <p className="text-xs text-neutral-600">
          <Trans>点击回合进入逐回合复盘</Trans>
        </p>
        <span className="flex-1" />
        <LegendEntry ruleClass={WINNER_RULE.a} position="top">
          <Trans>{teamAName} 胜</Trans>
        </LegendEntry>
        <LegendEntry ruleClass={WINNER_RULE.b} position="bottom">
          <Trans>{teamBName} 胜</Trans>
        </LegendEntry>
      </header>

      {failure !== undefined ? (
        <div className="p-3.5">
          <Notice
            tone="danger"
            action={{ label: failure.retryLabel ?? <Trans>重试</Trans>, onAction: failure.onRetry }}
          >
            {failure.message}
          </Notice>
        </div>
      ) : loading ? (
        <div
          data-round-timeline-state="loading"
          role="status"
          aria-busy="true"
          aria-label={i18n._(LOADING)}
          className="flex gap-1 p-3.5"
        >
          {Array.from({ length: SKELETON_CELLS }, (_, index) => (
            <Skeleton key={index} className="h-[var(--h-row)] flex-1" />
          ))}
        </div>
      ) : rounds.length === 0 ? (
        <div data-round-timeline-state="empty">
          <EmptyState preset="not-analysed" actions={emptyActions ?? null} headingLevel={4} className="border-0" />
        </div>
      ) : (
        <div
          ref={stripRef}
          data-round-timeline-state="ready"
          data-round-strip-rows={plan.rows}
          role="group"
          aria-label={i18n._(STRIP_LABEL)}
          className="grid gap-1 p-3.5"
          style={{ gridTemplateColumns: `repeat(${plan.perRow}, minmax(0, 1fr))` }}
        >
          {rounds.map((round, index) => {
            const reason = ROUND_END_REASON[round.reason];
            const Icon = reason.icon;
            const selected = round.number === selectedRound;
            const winnerName = round.winner === 'a' ? teamAName : teamBName;

            return (
              <button
                key={round.number}
                type="button"
                data-round-cell={round.number}
                data-winner={round.winner}
                data-reason={round.reason}
                data-key-round={round.key === true ? '' : undefined}
                aria-current={selected ? true : undefined}
                tabIndex={index === focusIndex ? 0 : -1}
                onClick={() => onSelectRound?.(round.number)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cx(CELL_CLASS, WINNER_FILL[round.winner], selected ? SELECTED_CLASS : null)}
              >
                {/* Winner rule: top edge for A, bottom edge for B. `order` puts
                    it on the right edge without two branches of markup. */}
                <span
                  aria-hidden="true"
                  className={cx(
                    'h-[3px] flex-none',
                    WINNER_RULE[round.winner],
                    round.winner === 'b' ? 'order-3' : 'order-1',
                  )}
                />
                <span className="order-2 flex min-h-0 flex-1 flex-col items-center justify-center gap-0.5">
                  <Icon size={11} strokeWidth={1.5} aria-hidden="true" className="flex-none" />
                  {plan.showLabels ? (
                    <span aria-hidden="true" className="font-mono leading-tight">
                      {round.number}
                    </span>
                  ) : null}
                </span>
                {/* The key-round rule takes the edge the winner rule left free,
                    so a key round is the cell with two rules rather than the
                    cell with a different hue. */}
                {round.key === true ? (
                  <span
                    aria-hidden="true"
                    className={cx('h-[3px] flex-none bg-text', round.winner === 'b' ? 'order-1' : 'order-3')}
                  />
                ) : null}
                <span className="sr-only">
                  <Trans>第 {round.number} 回合</Trans>
                  {' · '}
                  <Trans>{winnerName} 胜</Trans>
                  {' · '}
                  {i18n._(reason.label)}
                  {round.key === true ? ` · ${i18n._(KEY_ROUND.label)}` : ''}
                  {round.teamAScore === undefined || round.teamBScore === undefined
                    ? ''
                    : ` · ${round.teamAScore}:${round.teamBScore}`}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The artboard draws four skeleton bars; a strip is wider, so it draws eight. */
const SKELETON_CELLS = 8;

const LOADING = msg`回合时间线加载中`;
const STRIP_LABEL = msg`回合时间线`;

function LegendEntry({
  ruleClass,
  position,
  children,
}: {
  readonly ruleClass: string;
  readonly position: 'top' | 'bottom';
  readonly children: ReactNode;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-neutral-700">
      {/* The legend swatch is drawn the way the cell is: a rule pinned to the
          same edge, so the legend teaches the position and not only the hue. */}
      <span
        aria-hidden="true"
        data-legend-position={position}
        className={cx(
          'flex h-3 w-3 flex-none flex-col border border-divider',
          position === 'bottom' ? 'justify-end' : 'justify-start',
        )}
      >
        <span className={cx('h-[3px]', ruleClass)} />
      </span>
      {children}
    </span>
  );
}
