/**
 * Shapes this application derives, not shapes the service sends.
 *
 * Everything here is produced by a `normalize*` function in `./client.ts` out
 * of a wire document from `./dto`. None of it has — or should have — a Rust
 * counterpart: `dto.ts` is the mirror of the contract and is generated from
 * `crates/**`, so a view model living beside it would be a hand-written type
 * pretending to be part of the wire.
 *
 * They sit in `shared/desktop/` rather than in `data/` because
 * `shared/desktop/client.ts` is what builds them, and `shared/desktop` is the
 * bottom layer — it cannot reach up into `data/`.
 */

import type {
  ActivityAction,
  ActivityFeed as WireActivityFeed,
  ActivityItem as WireActivityItem,
  ActivityKind,
  ActivityStatus,
  AnalysisHighlightRecord,
  AnalysisInsightsRecord,
  DemoLifecycleStatus,
  EntityId,
  TeamSummary,
  TimelineEvent,
} from './dto';

/**
 * A scoreboard row.
 *
 * `headshot_rate` is computed here (`headshots / kills`); the wire
 * `PlayerStats` carries the two counts and no ratio. `team` is the normalized
 * A/B side rather than the raw parser string.
 */
export type PlayerAnalysis = {
  id: EntityId;
  name: string;
  team: 'A' | 'B';
  kills: number;
  deaths: number;
  assists: number;
  headshot_rate: number;
  kill_death_ratio: number;
  adr: number;
};

/**
 * A round, with its winner normalized to a stable A/B side.
 *
 * The wire `AnalysisRoundRecord.winner` is a plain string: normalization
 * succeeds only when team continuity could be derived, and `normalizeAnalysis`
 * rejects the response when it could not.
 */
export type RoundSummary = {
  number: number;
  winner: 'A' | 'B';
  reason: string;
  start_tick: number;
  end_tick: number;
  team_a_score: number;
  team_b_score: number;
  events: TimelineEvent[];
};

/**
 * A highlight with the two presentation facts the views need.
 *
 * `label` is the wire `title`, and `category` is a four-way grouping this
 * application folds the ten-member `HighlightKind` into. `confidence` has no
 * wire counterpart at all.
 */
export type Highlight = {
  id: EntityId;
  label: string;
  category: 'multi-kill' | 'clutch' | 'entry' | 'utility';
  kind: AnalysisHighlightRecord['kind'];
  description: string;
  tags: string[];
  victims: string[];
  player_id: EntityId;
  round: number;
  start_tick: number;
  end_tick: number;
  confidence: number;
};

/** The match workspace: one `MatchAnalysisRecord`, normalized. */
export type AnalysisWorkspace = {
  demo_id: EntityId;
  map_name: string;
  tick_rate: number;
  duration_seconds: number;
  teams: TeamSummary[];
  players: PlayerAnalysis[];
  rounds: RoundSummary[];
  highlights: Highlight[];
  /** Derived capability payload; absent only in in-memory loading/error workspaces. */
  insights?: AnalysisInsightsRecord;
};

/**
 * The four-state display status of a demo in the library.
 *
 * A fold of the six-member wire `DemoStatus`: `discovered`/`indexing` read as
 * `pending`, `analyzing` as `parsing`, `failed`/`missing` as `error`. The
 * lifecycle value itself is kept alongside it on `DemoSummary`.
 */
export type DemoDisplayStatus = 'pending' | 'parsing' | 'ready' | 'error';

/** A library row: the `/api/demos` record with its nulls resolved. */
export type DemoSummary = {
  id: EntityId;
  path: string;
  filename: string;
  display_name: string;
  map_name: string;
  match_date: string | null;
  cataloged_at: string;
  duration_seconds: number;
  total_rounds: number;
  score_team_a: number | null;
  score_team_b: number | null;
  team_a_name: string | null;
  team_b_name: string | null;
  status: DemoDisplayStatus;
  lifecycle_status: DemoLifecycleStatus;
  players: string[];
  source: 'watch' | 'upload' | 'local';
  remark: string;
  updated_at: string;
};

/** The reduced clip row the montage and studio pickers read. */
export type RecordedClip = {
  id: EntityId;
  title: string;
  player_name: string;
  map_name: string;
  duration_seconds: number;
  created_at: string;
  stream_url: string;
};

/**
 * A checked activity row.
 *
 * `crates/application/src/routes/activity.rs` writes `kind`, `status`, `unit`
 * and `available_actions` as `&'static str` from `match` arms, so the wire type
 * — `ActivityItem` in `./dto` — types all four as `string`, correctly.
 * `parseActivityItem` in `./activityContract` checks every one of them against
 * the closed set this application knows about and throws otherwise, so
 * everything downstream of that parse may rely on the narrowing. This type is
 * that guarantee written down; it is not something the server promises.
 */
export type ActivityItem = Omit<
  WireActivityItem,
  'kind' | 'status' | 'unit' | 'available_actions'
> & {
  kind: ActivityKind;
  status: ActivityStatus;
  unit: 'bytes' | 'stages' | null;
  available_actions: ActivityAction[];
};

/** A page of checked activity rows. See `ActivityItem`. */
export type ActivityFeed = Omit<WireActivityFeed, 'items'> & { items: ActivityItem[] };
