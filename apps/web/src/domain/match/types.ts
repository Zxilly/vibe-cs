/*
 * Domain layer, 2 of 3 — match/, the presentation models.
 *
 * These are *display* models, not transport models. They are deliberately not
 * `shared/desktop/dto` types re-exported: a DTO is what the IPC boundary
 * happens to send today (snake_case, nullable everywhere, `events: TimelineEvent[]`
 * inline on every round), and binding a component to it would make a backend
 * rename a UI change. What is copied on purpose is the *field naming*, so the
 * page layer's mapping stays a rename and never a computation:
 *
 *   RoundSummary   number / winner / reason / start_tick / end_tick /
 *                  team_a_score / team_b_score   →  dto.ts `RoundSummary`
 *   HighlightCandidate  id / round / kind / description / tags / victims /
 *                  player_id / start_tick / end_tick →  dto.ts `Highlight`
 *   EvidenceItem   id / tick / kind / actor / target / weapon →  dto.ts
 *                  `TimelineEvent`
 *
 * Two differences from the DTOs are intentional and are the reason these types
 * exist at all:
 *
 *   1. camelCase, because everything else in `apps/web/src` is camelCase.
 *   2. free text is `ReactNode`, not `string`. Every visible sentence in this
 *      product goes through a Lingui macro (spec §5.1), and a macro yields an
 *      element. A page that has a plain string can still pass it — a string is
 *      a `ReactNode`.
 *
 * Nothing here imports `data/**` or a store: the §2.1 rule 6 contract is that
 * these components are handed their data and can be rendered with no backend at
 * all, which is exactly what the markup tests assert.
 */

import type { ReactNode } from 'react';

import type { EvidenceKind, HighlightKind, RoundEndReason, RoundWinner, TeamSide } from './matchEnums';

/* ── identity ────────────────────────────────────────────────────────────── */

/** One team's line on the scoreboard, for the period being shown. */
export interface TeamScore {
  /** Stable id, so a selection or a filter can name a team without its label. */
  readonly id: string;
  readonly name: ReactNode;
  /**
   * Which side this team is on *right now*. Sides swap at the half, so this
   * moves; `Scoreboard` prints it as a badge with both a glyph and the two
   * letters, never as a hue on its own.
   */
  readonly side?: TeamSide | undefined;
  /**
   * Rounds won. `null` means 「分析后才有比分」 — the reference's own copy for an
   * unanalysed demo — and renders as an em dash rather than as a zero.
   */
  readonly score: number | null;
}

/** One half, or one overtime period. */
export interface MatchPeriod {
  readonly id: string;
  /** 「上半」「下半」「加时 1」 */
  readonly label: ReactNode;
  readonly teamAScore: number;
  readonly teamBScore: number;
  /** True for an overtime period, which the scoreboard sets apart. */
  readonly overtime?: boolean | undefined;
}

/** Everything the context bar states about the match it is the header of. */
export interface MatchIdentity {
  readonly demoId: string;
  /** 「Mirage」 */
  readonly mapName: ReactNode;
  /**
   * The three-letter plate the reference draws to the left of the teams
   * (「MRG」). Optional: a map with no known abbreviation shows no plate rather
   * than a truncation of its name.
   */
  readonly mapCode?: string | undefined;
  /** Already formatted by the page — date formats are locale policy, not ours. */
  readonly playedAt?: ReactNode | undefined;
  readonly roundCount?: number | undefined;
  /** Ticks per second, for the 「64 tick」 field and for every conversion. */
  readonly tickRate?: number | undefined;
}

/* ── rounds ──────────────────────────────────────────────────────────────── */

/** One cell of the round strip. */
export interface RoundSummary {
  /** 1-based round number, as the product counts them. */
  readonly number: number;
  readonly winner: RoundWinner;
  readonly reason: RoundEndReason;
  readonly startTick?: number | undefined;
  readonly endTick?: number | undefined;
  /** Running score after this round, for the cell's accessible name. */
  readonly teamAScore?: number | undefined;
  readonly teamBScore?: number | undefined;
  /**
   * 「赛点」「1v3 残局」— a round the analysis marked as load-bearing. Drawn as a
   * second edge rule, not as a hue, so it survives greyscale.
   */
  readonly key?: boolean | undefined;
  /** The period this round belongs to, matching `MatchPeriod.id`. */
  readonly periodId?: string | undefined;
}

/* ── evidence ────────────────────────────────────────────────────────────── */

/** A note left on a piece of evidence: 「待处理」/「已处理」. */
export interface EvidenceAnnotation {
  readonly label: ReactNode;
  readonly resolved?: boolean | undefined;
}

/**
 * One normalised fact, stamped with the tick it happened at.
 *
 * The three places the reference draws this — the workspace Inspector's
 * 「回合内证据」, the 「05 证据检索」 results table and the Agent panel's citation
 * list — differ only in density and in which optional fields are present, which
 * is why `EvidenceRow` takes a `density` rather than there being three of it.
 */
export interface EvidenceItem {
  readonly id: string;
  /** The identity of the moment. Everything else is derived from it. */
  readonly tick: number;
  readonly kind: EvidenceKind;
  /** Who caused it. 「Kael」 */
  readonly actor?: ReactNode | undefined;
  /** Who it happened to. 「Sable」 — absent on a round or objective event. */
  readonly target?: ReactNode | undefined;
  /** 「AK-47」 */
  readonly weapon?: ReactNode | undefined;
  /**
   * The one-line description: 「爆头」「A 点连接处 · 距离 12.4m」. The reference
   * puts the qualifier on the first line and the context on the second, so this
   * is the first line and `context` is the second.
   */
  readonly description?: ReactNode | undefined;
  /** The second line: 「经击杀事件验证的交战轴」「低血量 · 剩余 11 HP」 */
  readonly context?: ReactNode | undefined;
  /** 1-based round number, when the row is shown outside a single round. */
  readonly round?: number | undefined;
  /** 「Aurora vs Meridian」 — only the cross-match search shows it. */
  readonly matchLabel?: ReactNode | undefined;
  readonly annotation?: EvidenceAnnotation | undefined;
  /** Overrides the match-level rate for this row's timecode. */
  readonly tickRate?: number | undefined;
}

/* ── highlights ──────────────────────────────────────────────────────────── */

/**
 * A candidate clip: a tick *range* that someone might put in a video.
 *
 * See the header of `HighlightRow.tsx` for why this is not `EvidenceItem` with
 * an end tick bolted on.
 */
export interface HighlightCandidate {
  readonly id: string;
  readonly kind: HighlightKind;
  /** Stable player identity used when this candidate becomes a Capture Intent. */
  readonly playerId?: string | undefined;
  /**
   * The type as the analysis phrased it: 「1v3 残局」 rather than the bare 「残局」
   * the `kind` table yields. Optional — without it the row prints the kind.
   */
  readonly label?: ReactNode | undefined;
  readonly round: number;
  /** 「Kael」, or a team name for a team-level moment (「Aurora」 经济翻盘). */
  readonly subject?: ReactNode | undefined;
  /** 「三杀后拆包，剩余 1.8 秒」 */
  readonly description?: ReactNode | undefined;
  readonly startTick: number;
  readonly endTick: number;
  /** Extra type filters this candidate also matches. */
  readonly tags?: readonly ReactNode[] | undefined;
  readonly tickRate?: number | undefined;
}

/* ── failure ─────────────────────────────────────────────────────────────── */

/**
 * A load that did not succeed. Spec §4.1 routes query errors to an in-place
 * `Notice` (`throwOnError: false`), and 「补齐 · 规范与状态」 requires every one
 * of them to carry a recovery action — so `onRetry` is required, not optional.
 */
export interface LoadFailure {
  readonly message: ReactNode;
  readonly onRetry: () => void;
  /** Defaults to 「重试」. */
  readonly retryLabel?: ReactNode | undefined;
}
