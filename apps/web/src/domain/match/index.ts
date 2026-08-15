/*
 * Domain layer, 2 of 3 — match/ barrel (spec §2, `domain/match/`).
 *
 * The five components the workspace is built from, plus the two pure modules
 * they and the pages share.
 *
 *   MatchContextBar  the workspace's identity, constant across all nine views
 *   Scoreboard       two teams, a score, the halves and the side swap
 *   RoundTimeline    one cell per round; who won, how, whether it mattered
 *   EvidenceRow      one tick-stamped fact, at three densities
 *   HighlightRow     one candidate clip — a tick *range*, not a point
 *
 *   matchTime            tick ⇄ second ⇄ timecode, pure, node-testable
 *   roundTimelineLayout  how 24 / 30 / 58 cells pack into 996px, likewise pure
 *
 * Every component here is pure presentation: props in, markup out. None of them
 * imports `data/**` or a store — spec §2.1 rule 6 keeps every server read in
 * `data/**` so cache invalidation cannot be routed around, and it is what lets
 * the markup tests render each one with no backend at all.
 */

export { MatchContextBar, type FocusedPlayer, type MatchContextBarProps } from './MatchContextBar';
export { Scoreboard, type ScoreboardProps, type ScoreboardSize } from './Scoreboard';
export { RoundTimeline, type RoundTimelineProps } from './RoundTimeline';
export { EvidenceRow, EvidenceRowSkeleton, type EvidenceDensity, type EvidenceRowProps } from './EvidenceRow';
export {
  HighlightRow,
  HighlightRowSkeleton,
  type HighlightDensity,
  type HighlightRowProps,
} from './HighlightRow';

export {
  EVIDENCE_KIND,
  EVIDENCE_KINDS,
  HIGHLIGHT_KIND,
  HIGHLIGHT_KINDS,
  KEY_ROUND,
  normaliseRoundEndReason,
  ROUND_END_REASON,
  ROUND_END_REASONS,
  TEAM_SIDE,
  TEAM_SIDES,
  type EvidenceKind,
  type EvidenceKindMeta,
  type HighlightKind,
  type HighlightKindMeta,
  type RoundEndReason,
  type RoundEndReasonMeta,
  type RoundWinner,
  type TeamSide,
  type TeamSideMeta,
} from './matchEnums';

export {
  CS2_TICK_RATE,
  formatSeconds,
  formatTickClock,
  formatTickCount,
  formatTickRange,
  formatTickRangeSeconds,
  formatTickTimecode,
  resolveTickRate,
  secondsToTick,
  tickRangeSeconds,
  tickToSeconds,
  TICK_GROUP_SEPARATOR,
  TICK_RANGE_DASH,
} from './matchTime';

export {
  planRoundStrip,
  ROUND_CELL_GAP_PX,
  ROUND_CELL_LABEL_MIN_PX,
  ROUND_CELL_MIN_PX,
  ROUND_STRIP_NARROW_WIDTH_PX,
  type RoundStripPlan,
  type RoundStripPlanInput,
} from './roundTimelineLayout';

export type {
  EvidenceAnnotation,
  EvidenceItem,
  HighlightCandidate,
  LoadFailure,
  MatchIdentity,
  MatchPeriod,
  RoundSummary,
  TeamScore,
} from './types';
