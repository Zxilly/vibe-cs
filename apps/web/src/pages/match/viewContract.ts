/*
 * pages/match — the contract every one of the nine §7 views is built against.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  READ THIS FIRST if you are filling in one of the nine views
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A view is a `MatchViewModule`: a `Body` component, and optionally an
 * `Inspector` component. Both receive the same `MatchViewProps`. The shell
 * (`MatchWorkspacePage`) renders the body in the content column and the
 * inspector inside `design/layout/Inspector`, docked at ≥1101px and folded into
 * a 46px summary strip plus a drawer at ≤1100px (§8 rule 2). **You never decide
 * where the inspector goes** — you decide what is in it.
 *
 * ── Where your data comes from ────────────────────────────────────────────
 *
 * All of it through `data/match.ts`. Its header lists hook → view; the short
 * version:
 *
 *   概览 overview      `useMatchAnalysis`
 *   回合 rounds        `useMatchAnalysis` (rounds carry their events inline)
 *                      + `useRoundReview` / `useUpdateRoundReview`
 *   玩家 players       `useMatchAnalysis` (`players`, and `rounds[].events`
 *                      for the per-weapon kill counts)
 *   对位 duels         `useMatchAnalysis` (`insights.matchups`)
 *   道具与经济 utility  `useMatchAnalysis` (`insights.player_utility`,
 *                      `insights.round_economy`)
 *   回放 replay        `useMatchReplay({ enabled: true })` + `useMatchHeatPoints`
 *                      + `useMapRadarOverview` + `useMatchAnalysis` for the
 *                      round boundaries the frame stream is sliced on
 *   高光 highlights    `useMatchAnalysis` (`highlights`)
 *   Review review      `useMatchAnalysis` (`insights.availability`) +
 *                      `useMatchAnnotations` + `useGenerateMatchReview`
 *   队伍 teams         `useMatchAnalysis` (`teams`, `insights.round_economy`)
 *
 * Eight of the nine share one query, so mounting your view costs nothing after
 * the first. Do not add a hook of your own: `data/match.ts` is closed for this
 * round, and a read it does not have is a read the backend cannot serve — the
 * gaps are named in its header, and the rule from the previous phases stands,
 * **a field the backend does not have is omitted, never rendered as 0**.
 *
 * ── How the Inspector is wired ────────────────────────────────────────────
 *
 * Export an `Inspector` component and render `MatchInspectorPanel`
 * (`./MatchInspectorPanel`) from it. That wrapper carries the workspace-wide
 * parts — the panel title, the 「把这个回合加入视频」 main action with its
 * disabled reason, the folded-strip summary — so the nine panels cannot drift
 * apart. Omit `Inspector` entirely and the shell shows the empty panel with the
 * view's own hint; do not render `design/layout/Inspector` yourself.
 *
 * The selection your Inspector shows is `props.context`, not local state. Which
 * brings us to:
 *
 * ── How a selection is written back ───────────────────────────────────────
 *
 * `props.updateContext(patch)`. It writes the URL (§4.4, 「URL 是唯一真值」), so
 * the back button, a copied link and the Agent's 「定位」 all keep working.
 *
 *   updateContext({ round: 21 })                 select a round
 *   updateContext({ evidence: id, tick: 149380 })  select one fact
 *   updateContext({ player: 'STEAM_…' })         focus a player
 *   updateContext({ round: null })               clear the selection
 *
 * Two rules the shell enforces so you do not have to: moving to a *different*
 * round drops a stale `tick` and `evidence` (`workspaceContext.ts`), and
 * changing the view clears nothing. Pass `{ replace: true }` for a change that
 * should not add a history entry — a playhead scrub, not a click on a round.
 *
 * ── Three states, always ──────────────────────────────────────────────────
 *
 * Loading → `design/data`'s `Skeleton` (never an invented percentage). Empty →
 * `Empty` with a real recovery action. Failed → an in-place
 * `design/feedback` `Notice` carrying a retry (§4.1 sets `throwOnError: false`
 * precisely so the error lands next to the thing that failed).
 *
 * ── The lint will stop you ────────────────────────────────────────────────
 *
 * `pages/**` may not import `app/**`, may not write a bare hex (comments
 * included), may not put a font size or a colour in a Tailwind arbitrary value,
 * and may not import `shared/desktop/client`. Run
 * `node scripts/check-web-layers.mjs`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## Why `MatchViewProps` has these five fields and not others
 *
 * `demoId` — the §7 path segment. Every hook takes it; a view that had to dig
 * it out of `useParams` again could disagree with the shell about which match
 * is open.
 *
 * `context` — the §4.4 state, already parsed. Handing views the raw
 * `URLSearchParams` would put nine copies of 「what does `?round=abc` mean」 in
 * the tree, and they would not agree.
 *
 * `updateContext` — the only way to change it. There is no `onSelectRound`,
 * `onSelectPlayer`, `onSeek` triple: those are the same operation with
 * different fields, the invariant between them lives in one place, and every
 * new selectable thing would otherwise add a prop to all nine views.
 *
 * `addToVideo` — 「加入视频」 appears on the scoreboard rows, on the highlight
 * rows, on the round Inspector and on the selection bar. It is one product
 * action, and this round it is one *disabled* product action (`data/match.ts`
 * gap 2: the recording queue is not server state). Passing its state down means
 * the nine views state the same reason instead of nine sentences that drift —
 * and when the queue lands, it is enabled in the shell and everywhere at once.
 *
 * `collapsed` — the §8 observation, made once. `design/layout`'s `useCollapsed`
 * is cheap but not free of consequence: nine independent subscriptions can be
 * observed mid-transition in different states, and the whole point of rule 2
 * and rule 3 is that the rail and the panel fold *together*. No view writes a
 * media query of its own.
 *
 * ## What is deliberately **not** in the props
 *
 * *The analysis data.* Views call `useMatchAnalysis` themselves. Threading the
 * document through props would make the shell re-render every view on every
 * refetch, would force the shell to know which views need `insights` and which
 * do not, and would hide the loading and error states the views have to render
 * anyway. TanStack already deduplicates the read by key.
 *
 * *A `selection` object separate from `context`.* There is exactly one
 * selection in this workspace and it lives in the URL. A second one would be
 * the thing §4.4 was written to prevent.
 *
 * *Anything to do with the context bar.* It is the shell's, constant across all
 * nine views by definition (see `domain/match/MatchContextBar`).
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import {
  ClipboardList,
  Flame,
  Gauge,
  ListOrdered,
  Map as MapIcon,
  Shield,
  Sparkles,
  Swords,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import type { MatchContextPatch, MatchWorkspaceContext } from './workspaceContext';
import { DuelsView } from './views/DuelsView';
import { HighlightsView } from './views/HighlightsView';
import { OverviewView } from './views/OverviewView';
import { PlayersView } from './views/PlayersView';
import { ReplayView } from './views/ReplayView';
import { ReviewView } from './views/ReviewView';
import { RoundsView } from './views/RoundsView';
import { TeamsView } from './views/TeamsView';
import { UtilityView } from './views/UtilityView';

/* ── the nine ids ────────────────────────────────────────────────────────── */

/**
 * §7's merge table, in the order the 03 artboard draws the rail.
 *
 * Exactly nine, and the spelling is the spec's: `advantage` / `objective` were
 * merged into `rounds`, `clutches` into `highlights`, `insights` into `review`,
 * `teams` is new and takes over `/lineups`, `cosmetics` moved to the library
 * Inspector. `matchWorkspace.test.tsx` pins this array against §7 so a tenth
 * entry or a rename is a red test, not a silent divergence from the router.
 */
export const MATCH_VIEW_IDS = [
  'overview',
  'rounds',
  'players',
  'duels',
  'utility',
  'replay',
  'highlights',
  'review',
  'teams',
] as const;

export type MatchViewId = (typeof MATCH_VIEW_IDS)[number];

/* ── labels and icons ────────────────────────────────────────────────────── */

export interface MatchViewMeta {
  readonly id: MatchViewId;
  readonly label: MessageDescriptor;
  readonly icon: LucideIcon;
}

/**
 * A `Record`, not a switch: adding a tenth id fails to compile here instead of
 * rendering a rail item with no label.
 *
 * Every entry carries `context: 'match-view'`, including the ones that collide
 * with nothing today. 「回合」 already means two things in this product — the
 * plural nav label and the singular evidence kind, which
 * `domain/match/matchEnums` tags `evidence-kind` — and the lesson recorded in
 * §10.4 deviation 3 is that a vocabulary is tagged **as a set**, or the next
 * member added to it silently inherits another screen's translation.
 *
 * 「队伍」 rather than 「阵容」 for `teams`: the supplement artboard's merge table
 * names the destination 「队伍（阵营 · 经济 · 回合）」, and 阵容 was the label of
 * the retired `/lineups` page, which this view only partly absorbs (see
 * `data/match.ts` gap 4).
 */
export const MATCH_VIEW: Readonly<Record<MatchViewId, MatchViewMeta>> = {
  overview: {
    id: 'overview',
    label: msg({ message: '概览', context: 'match-view' }),
    icon: Gauge,
  },
  rounds: {
    id: 'rounds',
    label: msg({ message: '回合', context: 'match-view' }),
    icon: ListOrdered,
  },
  players: {
    id: 'players',
    label: msg({ message: '玩家', context: 'match-view' }),
    icon: Users,
  },
  duels: {
    id: 'duels',
    label: msg({ message: '对位', context: 'match-view' }),
    icon: Swords,
  },
  utility: {
    id: 'utility',
    label: msg({ message: '道具与经济', context: 'match-view' }),
    icon: Flame,
  },
  replay: {
    id: 'replay',
    label: msg({ message: '回放与热力图', context: 'match-view' }),
    icon: MapIcon,
  },
  highlights: {
    id: 'highlights',
    label: msg({ message: '高光', context: 'match-view' }),
    icon: Sparkles,
  },
  review: {
    id: 'review',
    label: msg({ message: 'Review 与注释', context: 'match-view' }),
    icon: ClipboardList,
  },
  teams: {
    id: 'teams',
    label: msg({ message: '队伍', context: 'match-view' }),
    icon: Shield,
  },
};

/* ── what a view is handed ───────────────────────────────────────────────── */

/**
 * The workspace-wide 「加入作品」 action.
 *
 * `disabled` with a reason remains the product rule for unavailable states;
 * `onAdd` hands a concrete selection to the workspace-owned project picker.
 */
export interface MatchVideoAction {
  readonly disabled: boolean;
  /** Plain text, so it can go on `Button`'s `disabledReason`. */
  readonly disabledReason?: string | undefined;
  readonly onAdd?: ((selection: MatchVideoSelection) => void) | undefined;
  readonly onAddMany?: ((selections: readonly MatchVideoSelection[]) => void) | undefined;
}

/**
 * What a view is proposing to put in a video. Every field optional because the
 * four places that offer the action know different amounts: a highlight row has
 * a tick range, a scoreboard row has only a player.
 */
export interface MatchVideoSelection {
  readonly round?: number | undefined;
  readonly playerId?: string | undefined;
  readonly highlightId?: string | undefined;
  readonly evidenceId?: string | undefined;
  readonly label?: string | undefined;
  readonly startTick?: number | undefined;
  readonly endTick?: number | undefined;
  /** Tick rate of the Demo that owns the selected range. */
  readonly tickRate?: number | undefined;
}

export interface MatchContextUpdateOptions {
  /** Replace the history entry instead of pushing one. Use for a scrub. */
  readonly replace?: boolean | undefined;
}

export interface MatchViewProps {
  /** The §7 path segment. */
  readonly demoId: string;
  /** The §4.4 state, already parsed out of the query string. */
  readonly context: MatchWorkspaceContext;
  /** The only way to change it; it writes the URL. */
  readonly updateContext: (patch: MatchContextPatch, options?: MatchContextUpdateOptions) => void;
  /** 「加入作品」, in the state the shell decided. */
  readonly addToVideo: MatchVideoAction;
  /** The §8 fold, observed once by the shell. */
  readonly collapsed: boolean;
}

/**
 * Both halves of a view are ordinary components of `MatchViewProps`. Typed as a
 * function returning `ReactNode` rather than as `FC` so a view may return a
 * fragment, an array or `null` without a cast.
 */
export type MatchViewComponent = (props: MatchViewProps) => ReactNode;

/**
 * One view.
 *
 * Two components rather than one, because the content column and the Inspector
 * are in different places in the tree and move independently at the §8 fold —
 * the panel becomes a drawer, the body does not. The alternative (a single
 * component that renders both and the shell portals one of them) would make
 * every view own placement logic that is identical nine times over, and would
 * make the folded drawer a portal out of a component that is inside the
 * scrolling body.
 *
 * They cannot disagree about what is selected, because both read the same
 * `context` prop, which is the URL.
 */
export interface MatchViewModule {
  readonly id: MatchViewId;
  readonly Body: MatchViewComponent;
  /** Omitted when the view has nothing to inspect. */
  readonly Inspector?: MatchViewComponent | undefined;
}

/**
 * id → view. Exhaustive by type: a missing entry does not compile, so §7 and
 * the rail cannot drift apart.
 *
 * Each module lives in its own file under `./views/`, which is what let the nine
 * be built three at a time against this contract alone.
 */
export const MATCH_VIEWS: Readonly<Record<MatchViewId, MatchViewModule>> = {
  overview: OverviewView,
  rounds: RoundsView,
  players: PlayersView,
  duels: DuelsView,
  utility: UtilityView,
  replay: ReplayView,
  highlights: HighlightsView,
  review: ReviewView,
  teams: TeamsView,
};
