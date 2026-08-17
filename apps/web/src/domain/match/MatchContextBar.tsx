/*
 * Domain layer, 2 of 3 — match/MatchContextBar.
 *
 * The bar 「03 比赛工作区」 pins to the top of the workspace:
 *
 *   ‹ 资料库 │ [MRG] Aurora 13 : 11 Meridian │ Mirage · 2026-08-14 · 24 回合 ·
 *   64 tick … 聚焦选手 [Kael] [Rhea] ＋ · [AI 点评] [用 Agent 制作视频]
 *
 * It lives in `domain/` and not in `pages/match/` because it is the identity of
 * the workspace and must be *the same object* across all nine sub-views (spec
 * §7). A page-local header would be nine headers that happen to agree today.
 *
 * Height is `--h-topbar` (56) — §3.4 names it 「页面顶栏 / 比赛上下文栏」, which
 * is this bar by name.
 *
 * ── The fold (spec §8) ──────────────────────────────────────────────────
 *
 * At 1100px the bar cannot hold identity + metadata + focus players + two
 * actions. What it may *not* do is drop any of them: 「不隐藏、不静默失败」, and
 * §8's non-negotiable line keeps the primary action (「用 Agent 制作视频」) out of
 * any overflow at every width. So the fold is:
 *
 *   keep   ‹ 资料库, the map plate, the scoreboard, the whole `actions` slot
 *   move   the metadata line and the focus players, into a disclosure that
 *          opens a panel directly under the bar
 *
 * A disclosure rather than an overflow menu because none of what moves is an
 * action — an 「更多 ▾」 menu of facts you cannot click is a menu that lies. The
 * button says how many focus players are inside, so the fold announces what it
 * took rather than swallowing it.
 *
 * ── The 1100 × 700 density review (spec §9 risk 6) ──────────────────────
 *
 * Three things were wrong when a real match was put through this bar and are
 * fixed here. All three have the same shape: a slot with no ceiling inside a box
 * with a fixed height.
 *
 *   1. **聚焦选手 had no ceiling.** A focus set can name the whole roster (ten
 *      players), and ten `Tag`s are ~600px. The bar is `h-[var(--h-topbar)]`, so
 *      the chips could neither shrink (they are `flex-none`) nor wrap (wrapping
 *      inside a fixed height overflows the box) — they pushed the actions off
 *      the window. The expanded bar now keeps `FOCUS_INLINE_MAX` of them and the
 *      rest go into the same disclosure, counted on its badge.
 *   2. **The two folded blocks were `flex-wrap` while inside the 56px bar.**
 *      Wrapping is right in the disclosure panel and wrong in the bar, so the
 *      wrap is now a parameter of the two builders rather than a constant.
 *   3. **`periods` reached the bar's `Scoreboard`.** A match with overtime has
 *      four or more periods and `Scoreboard` prints them as a second, wrapping
 *      line — inside a `flex-none` box, so it widened the scoreboard to ~450px
 *      instead of wrapping. The period breakdown now lives in the disclosure at
 *      every width, which is also what the artboard's bar draws: 「13 : 11」 and
 *      nothing else.
 *
 * The fourth finding was that §8's own breakpoint is the wrong one for this
 * bar. Crossing 1100 upward *narrows* the content column — the nav goes 56 →
 * 216 and the Agent rail appears — so a 1101px window gives the page ~790px
 * where 1100px gave it ~996. Unfolded, this bar needs about 1300px. It
 * therefore folds at `CONTEXT_BAR_BREAKPOINT_PX` (1600 ≈ 1300 + 216 + 46 + 48)
 * rather than at 1100, which is what `useCollapsed`'s second argument is for.
 * The shell still has exactly one fold; this is a component-level one, and it
 * re-parents nothing outside this file.
 *
 * ── States ──────────────────────────────────────────────────────────────
 *
 * loading  the bar keeps its height and its actions, with skeletons where the
 *          identity will be. A workspace whose header jumps 56px into existence
 *          reflows everything under it.
 * failure  the bar renders whatever identity it does have and a `Notice`
 *          underneath it, per spec §4.1 (「错误就地渲染成 Notice」). It does not
 *          disappear: the ‹ 资料库 escape hatch is exactly what a user whose
 *          workspace failed to load needs.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Plural, Trans } from '@lingui/react/macro';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { Skeleton } from '../../design/data';
import { Notice } from '../../design/feedback';
import { CONTEXT_BAR_BREAKPOINT_PX, useCollapsed } from '../../design/layout';
import { cn, Tag } from '../../design/primitives';
import { CS2_TICK_RATE } from './matchTime';
import { Scoreboard } from './Scoreboard';
import type { LoadFailure, MatchIdentity, MatchPeriod, TeamScore } from './types';

/** One entry of 「聚焦选手」. */
export interface FocusedPlayer {
  readonly id: string;
  readonly name: ReactNode;
  /** The accent chip of the artboard; the rest are neutral. */
  readonly primary?: boolean | undefined;
  /** Removing the focus. Omitted, the chip is inert text. */
  readonly onRemove?: ((id: string) => void) | undefined;
}

export interface MatchContextBarProps {
  readonly match: MatchIdentity;
  readonly teamA: TeamScore;
  readonly teamB: TeamScore;
  readonly periods?: readonly MatchPeriod[] | undefined;
  readonly sidesSwapped?: boolean | undefined;
  /** The round range the workspace is looking at — 「当前 R21」, 「R1–R24」. */
  readonly roundRange?: ReactNode | undefined;
  readonly focusedPlayers?: readonly FocusedPlayer[] | undefined;
  /** 「＋」 — opens the focus picker. Omitted, no add affordance is drawn. */
  readonly onAddFocusedPlayer?: (() => void) | undefined;
  /** ‹ 资料库. A node so the page can hand in a router `<Link>`. */
  readonly backLink?: ReactNode | undefined;
  /** Never folds (§8). 「AI 点评」「用 Agent 制作视频」 */
  readonly actions?: ReactNode | undefined;
  readonly loading?: boolean | undefined;
  readonly failure?: LoadFailure | undefined;
  /** Pins the fold; omitted, it follows `CONTEXT_BAR_BREAKPOINT_PX`. */
  readonly collapsed?: boolean | undefined;
  readonly className?: string | undefined;
}

const BAR_CLASS =
  'flex h-[var(--h-topbar)] flex-none items-center gap-3.5 border-b border-divider ' +
  'bg-surface-chrome px-4';

const DIVIDER_CLASS = 'h-[26px] w-px flex-none bg-divider';

const MORE_LABEL = msg`比赛信息`;
const FOCUS_LABEL = msg`聚焦选手`;

/**
 * How many 聚焦选手 chips the expanded bar keeps inline.
 *
 * The artboard draws two plus the 「＋」, and a `Tag` of a five-character player
 * name is about 60px, so four chips and the add affordance are ~300px — the
 * widest the focus block can be without crowding the metadata line beside it at
 * the reference's own 1920. Anything past four is counted on the disclosure.
 */
export const FOCUS_INLINE_MAX = 4;

export function MatchContextBar({
  match,
  teamA,
  teamB,
  periods,
  sidesSwapped,
  roundRange,
  focusedPlayers,
  onAddFocusedPlayer,
  backLink,
  actions,
  loading = false,
  failure,
  collapsed,
  className,
}: MatchContextBarProps) {
  const { i18n } = useLingui();
  const isCollapsed = useCollapsed(collapsed, CONTEXT_BAR_BREAKPOINT_PX);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();

  const players = focusedPlayers ?? [];
  const tickRate = match.tickRate ?? CS2_TICK_RATE;
  const hasPeriods = periods !== undefined && periods.length > 0;

  /* What the expanded bar can hold, and what it has to hand to the disclosure.
     Collapsed, the whole block moves and the inline count is zero. */
  const inlineFocus = isCollapsed ? [] : players.slice(0, FOCUS_INLINE_MAX);
  const hiddenFocusCount = players.length - inlineFocus.length;
  /* The disclosure exists whenever something is not on the bar. At the
     reference's 1920 with two focus players and no period breakdown, that is
     nothing, and the button is not drawn — which is what the artboard shows. */
  const showDisclosure = isCollapsed || hiddenFocusCount > 0 || hasPeriods;

  const renderMetadata = (wrap: boolean) => (
    <p
      data-match-metadata=""
      className={cn(
        'flex items-center gap-2 text-sm text-neutral-700',
        /* In the bar: one line, clipped if it must be, because the box is
           `--h-topbar` tall and a second line would leave it. In the panel:
           wrapped, because the panel has no height to overflow. */
        wrap ? 'flex-wrap' : 'min-w-0 flex-nowrap overflow-hidden whitespace-nowrap',
      )}
    >
      <span>{match.mapName}</span>
      {match.playedAt === undefined ? null : (
        <>
          <Separator />
          <span>{match.playedAt}</span>
        </>
      )}
      {match.roundCount === undefined ? null : (
        <>
          <Separator />
          <span>
            <Plural value={match.roundCount} other="# 回合" />
          </span>
        </>
      )}
      <Separator />
      {/* The rate is stated, not assumed: a 128-tick demo prints 128 and every
          timecode in the workspace is derived from the same number. */}
      <span className="font-mono">
        <Trans>{tickRate} tick</Trans>
      </span>
      {roundRange === undefined ? null : (
        <>
          <Separator />
          <span data-match-round-range="">{roundRange}</span>
        </>
      )}
    </p>
  );

  const renderFocus = (wrap: boolean, shown: readonly FocusedPlayer[]) =>
    shown.length === 0 && onAddFocusedPlayer === undefined ? null : (
      <div
        data-match-focus=""
        data-focus-shown={shown.length}
        className={cn('flex items-center gap-2 text-sm', wrap ? 'flex-wrap' : 'flex-none flex-nowrap')}
      >
        <span className="flex-none text-neutral-600">{i18n._(FOCUS_LABEL)}</span>
        {shown.map((player) =>
          player.onRemove === undefined ? (
            <Tag key={player.id} tone={player.primary === true ? 'accent' : 'neutral'}>
              {player.name}
            </Tag>
          ) : (
            <Tag
              key={player.id}
              as="button"
              tone={player.primary === true ? 'accent' : 'neutral'}
              onClick={() => player.onRemove?.(player.id)}
            >
              {player.name}
            </Tag>
          ),
        )}
        {onAddFocusedPlayer === undefined ? null : (
          <Tag as="button" tone="outline" onClick={onAddFocusedPlayer}>
            <Trans>＋ 添加选手</Trans>
          </Tag>
        )}
      </div>
    );

  return (
    <div data-match-context-bar={isCollapsed ? 'collapsed' : 'expanded'} className={cn('flex-none', className)}>
      <header className={BAR_CLASS}>
        {backLink === undefined ? null : (
          <>
            <span data-match-back="" className="flex flex-none items-center gap-1 text-sm">
              <ChevronLeft size={13} strokeWidth={1.5} aria-hidden="true" />
              {backLink}
            </span>
            <span aria-hidden="true" className={DIVIDER_CLASS} />
          </>
        )}

        {match.mapCode === undefined ? null : (
          <span
            data-match-map-code=""
            aria-hidden="true"
            className="grid h-[var(--h-ctl-sm)] w-[52px] flex-none place-items-center border border-divider font-heading text-xs tracking-caps"
          >
            {match.mapCode}
          </span>
        )}

        {loading ? (
          <div data-match-context-state="loading" className="flex min-w-0 flex-1 items-center gap-3">
            <Skeleton width="180px" className="h-3.5" />
            <Skeleton width="220px" />
          </div>
        ) : (
          <>
            {/* No `periods` here on purpose — see note 3 in the header. The
                bar shows 「13 : 11」, the breakdown is in the disclosure. */}
            <Scoreboard teamA={teamA} teamB={teamB} size="md" className="flex-none" />
            <span aria-hidden="true" className={DIVIDER_CLASS} />

            {isCollapsed ? null : (
              <>
                {renderMetadata(false)}
                <span className="flex-1" />
                {renderFocus(false, inlineFocus)}
              </>
            )}

            {showDisclosure ? (
              <button
                type="button"
                data-match-details-toggle=""
                data-hidden-focus={hiddenFocusCount}
                aria-expanded={detailsOpen}
                aria-controls={detailsId}
                onClick={() => setDetailsOpen((open) => !open)}
                className="flex h-[var(--h-ctl-sm)] flex-none items-center gap-1.5 border border-divider px-2 text-sm text-neutral-800"
              >
                {i18n._(MORE_LABEL)}
                {/* The badge counts what is *inside*, not what exists: collapsed
                    that is every focus player, expanded it is the tail that did
                    not fit. A count of what is already visible would be a lie. */}
                {hiddenFocusCount === 0 ? null : (
                  <span className="border border-accent-300 px-1 text-2xs text-accent-700">
                    <Plural value={hiddenFocusCount} other="聚焦 #" />
                  </span>
                )}
                <ChevronDown
                  size={13}
                  strokeWidth={1.5}
                  aria-hidden="true"
                  className={detailsOpen ? 'rotate-180' : undefined}
                />
              </button>
            ) : null}
          </>
        )}

        {isCollapsed ? <span className="flex-1" /> : null}
        {actions === undefined ? null : (
          <div data-match-actions="" className="flex flex-none items-center gap-2">
            {actions}
          </div>
        )}
      </header>

      {/* The folded half, in full. Nothing that left the bar is unreachable:
          the metadata line when it was folded whole, the *complete* focus set
          whenever any of it was held back, and the period breakdown, which the
          bar never shows. Wrapping is allowed here — the panel grows. */}
      {showDisclosure && detailsOpen && !loading ? (
        <div
          id={detailsId}
          data-match-details=""
          className="flex flex-col gap-2 border-b border-divider bg-surface-chrome px-4 py-2.5"
        >
          {isCollapsed ? renderMetadata(true) : null}
          {hiddenFocusCount === 0 ? null : renderFocus(true, players)}
          {hasPeriods ? (
            <Scoreboard
              teamA={teamA}
              teamB={teamB}
              {...(periods === undefined ? {} : { periods })}
              {...(sidesSwapped === undefined ? {} : { sidesSwapped })}
              size="sm"
            />
          ) : null}
        </div>
      ) : null}

      {failure === undefined ? null : (
        <div className="px-4 py-2.5">
          <Notice
            tone="danger"
            action={{ label: failure.retryLabel ?? <Trans>重试</Trans>, onAction: failure.onRetry }}
          >
            {failure.message}
          </Notice>
        </div>
      )}
    </div>
  );
}

function Separator() {
  return (
    <span aria-hidden="true" className="text-neutral-500">
      ·
    </span>
  );
}
