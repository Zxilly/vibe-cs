/*
 * pages/match — turning the wire into the presentation models `domain/match`
 * declares.
 *
 * `domain/match/types.ts` states why those models exist and not the DTOs: the
 * component tree must not move when the backend renames a field. This file is
 * the rename, and it is pure so `matchModel.test.ts` walks it in the `unit`
 * project with no React and no client.
 *
 * Everything here is used by the *shell* (the context bar and the round strip
 * it feeds), which is why it is shared rather than living in a view. A view
 * that needs a derivation only it uses should keep that derivation next to
 * itself.
 *
 * ── Two sources for one identity ──────────────────────────────────────────
 *
 * The workspace can be opened on a demo that has never been analysed, and the
 * context bar has to say something true in that state. `DemoSummary` (the
 * library record) carries the map, the date, both team names and the final
 * score; `AnalysisWorkspace` carries the parsed truth. So the analysis wins
 * where it has an answer and the demo fills the rest — and the score is `null`
 * rather than `0` when neither has one, which `Scoreboard` renders as an em
 * dash: 「分析后才有比分」, not 「0 : 0」.
 */

import type { TeamSummary } from '../../shared/desktop/dto';
import type { AnalysisWorkspace, DemoSummary } from '../../shared/desktop/viewModels';
import type {
  FocusedPlayer,
  MatchIdentity,
  RoundSummary,
  TeamScore,
} from '../../domain/match';
import { normaliseRoundEndReason } from '../../domain/match';

/* ── the map plate ───────────────────────────────────────────────────────── */

/**
 * 「MRG」 — the three-letter plate the 03 artboard draws left of the teams.
 *
 * There is no such field on the wire and no rule that derives one: 「de_mirage」
 * → 「MRG」 is a community abbreviation, not a truncation (「DE_」 would be the
 * truncation). So this is a table of the maps that have one, and anything else
 * yields `undefined`, which makes `MatchContextBar` draw no plate at all rather
 * than a three-letter guess. A wrong plate on a workshop map is worse than no
 * plate: it is the identity of the match, printed confidently and wrong.
 */
const MAP_CODE: Readonly<Record<string, string>> = {
  de_ancient: 'ANC',
  de_anubis: 'ANB',
  de_dust2: 'D2',
  de_inferno: 'INF',
  de_mirage: 'MRG',
  de_nuke: 'NUK',
  de_overpass: 'OVP',
  de_train: 'TRN',
  de_vertigo: 'VTG',
};

export function mapCode(mapName: string | null | undefined): string | undefined {
  if (mapName === null || mapName === undefined) return undefined;
  return MAP_CODE[mapName.trim().toLowerCase()];
}

/**
 * 「Mirage」 — the map without its `de_` prefix and with a capital, which is what
 * every artboard prints. The prefix is a file-name convention, not a name.
 */
export function mapDisplayName(mapName: string | null | undefined): string | null {
  if (mapName === null || mapName === undefined) return null;
  const trimmed = mapName.trim();
  if (trimmed === '') return null;
  const bare = trimmed.replace(/^(?:de|cs|ar|dz)_/iu, '');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/**
 * 「2026-08-14」 — the artboard's date, ISO order, no clock.
 *
 * Hand-formatted rather than `Intl.DateTimeFormat` for the reason
 * `pages/library/libraryFormat.ts` already records: the field sits in a fixed
 * 56px bar beside three others, and `Intl` changes both separator and field
 * order with the locale, which would make the bar reflow between zh-CN and
 * en-US. A day is also the whole of what the bar shows — the clock belongs to
 * the library's 「导入时间」, not to a match's identity.
 */
export function formatMatchDay(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined || iso.trim() === '') return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/* ── identity ────────────────────────────────────────────────────────────── */

export interface MatchSources {
  readonly demo?: DemoSummary | undefined;
  readonly analysis?: AnalysisWorkspace | undefined;
}

/**
 * What the context bar states about the match.
 *
 * `tickRate` is only ever the analysis's: the demo record does not carry one,
 * and `MatchContextBar` falls back to `CS2_TICK_RATE` (64) with the number
 * printed, so a 128-tick demo says 128 the moment the analysis lands rather
 * than being silently converted at the wrong rate.
 *
 * `roundCount` prefers the analysis's actual round list over the library's
 * `total_rounds`: the two disagree on an interrupted parse, and the strip below
 * is drawn from the list.
 */
export function matchIdentity(demoId: string, { demo, analysis }: MatchSources): MatchIdentity {
  const rawMap = analysis?.map_name ?? demo?.map_name ?? null;
  const name = mapDisplayName(rawMap);
  const code = mapCode(rawMap);
  const day = formatMatchDay(demo?.match_date);
  const rounds = analysis === undefined ? demo?.total_rounds : analysis.rounds.length;

  return {
    demoId,
    // An unknown map prints the id rather than an empty slot — the bar is the
    // only thing on screen that says which match this is.
    mapName: name ?? demo?.display_name ?? demoId,
    ...(code === undefined ? {} : { mapCode: code }),
    ...(day === null ? {} : { playedAt: day }),
    ...(rounds === undefined || rounds === null ? {} : { roundCount: rounds }),
    ...(analysis === undefined ? {} : { tickRate: analysis.tick_rate }),
  };
}

/**
 * The two lines of the scoreboard.
 *
 * `TeamSummary.side` is a free-text field on the wire (「CT」/「T」/「」), so it is
 * normalised here and dropped when it is anything else rather than guessed.
 * Sides swap at the half, which is why `TeamScore.side` is a property of the
 * team *now* and not of the team.
 */
export function matchTeams(
  { demo, analysis }: MatchSources,
): { readonly teamA: TeamScore; readonly teamB: TeamScore } {
  const [a, b] = analysis?.teams ?? [];

  return {
    teamA: teamScore('a', a, demo?.team_a_name ?? null, demo?.score_team_a ?? null),
    teamB: teamScore('b', b, demo?.team_b_name ?? null, demo?.score_team_b ?? null),
  };
}

function teamScore(
  id: 'a' | 'b',
  summary: TeamSummary | undefined,
  fallbackName: string | null,
  fallbackScore: number | null,
): TeamScore {
  const side = normaliseSide(summary?.side);
  const name = summary?.name.trim() ?? '';
  return {
    id,
    // 「队伍 A」 is not invented here: an unnamed team keeps the demo's name, and
    // if that is missing too the caller gets an empty string it can label.
    name: name !== '' ? name : (fallbackName ?? ''),
    ...(side === undefined ? {} : { side }),
    score: summary?.score ?? fallbackScore,
  };
}

function normaliseSide(side: string | undefined): 'ct' | 't' | undefined {
  if (side === undefined) return undefined;
  const key = side.trim().toLowerCase();
  if (key === 'ct') return 'ct';
  if (key === 't') return 't';
  return undefined;
}

/* ── rounds ──────────────────────────────────────────────────────────────── */

/**
 * The round strip's cells.
 *
 * `winner` is `'A' | 'B'` on the wire and `'a' | 'b'` in the domain model, and
 * `reason` is free text the analyser canonicalises differently across versions,
 * which is what `normaliseRoundEndReason` is for — it is the only place that
 * knows the wire spellings.
 *
 * No `key` flag is set. `RoundSummary.key` marks 「关键回合」 and the analysis has
 * no such field: a round is not marked load-bearing anywhere on the wire, and
 * inferring it from the score would be this layer inventing an analysis result.
 */
export function roundSummaries(analysis: AnalysisWorkspace | undefined): readonly RoundSummary[] {
  if (analysis === undefined) return [];
  return analysis.rounds.map((round) => ({
    number: round.number,
    winner: round.winner === 'A' ? 'a' : 'b',
    reason: normaliseRoundEndReason(round.reason),
    startTick: round.start_tick,
    endTick: round.end_tick,
    teamAScore: round.team_a_score,
    teamBScore: round.team_b_score,
  }));
}

/** The round the context bar names — 「当前 R21」. `null` when nothing is picked. */
export function roundLabel(round: number | null): string | null {
  return round === null ? null : `R${round}`;
}

/* ── focus ───────────────────────────────────────────────────────────────── */

/**
 * 「聚焦选手」 — this round, the single player the URL carries.
 *
 * §4.4 gives the address one `player` parameter, so the focus set has at most
 * one member. The bar accepts a list because the reference draws two chips and
 * a 「＋」; widening the URL to a multi-player focus is a change to
 * `workspaceContext.ts` and to nothing else, and this function is where the
 * list is built either way.
 *
 * The chip shows the player's name when the analysis knows it and the raw id
 * when it does not — an id is ugly and true, and a chip with no text would make
 * the focus invisible while it is still in effect.
 */
export function focusedPlayers(
  analysis: AnalysisWorkspace | undefined,
  playerId: string | null,
): readonly FocusedPlayer[] {
  if (playerId === null) return [];
  const player = analysis?.players.find((entry) => entry.id === playerId);
  return [{ id: playerId, name: player?.name ?? playerId, primary: true }];
}
