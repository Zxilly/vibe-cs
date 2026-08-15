/*
 * Test-only fixtures for 玩家 / 对位 / 道具与经济.
 *
 * `pages/match/test/fixtures.ts` is the *shell's* match — it has two players
 * and rounds with empty event lists, which is exactly what a test of the frame
 * needs and exactly what a test of these three views cannot use: every number
 * they draw comes from `rounds[].events` or from `insights`, and neither is in
 * that fixture. So this is the same match, filled in.
 *
 * Under `test/` so `lingui.config.ts` keeps these strings out of the catalogue
 * and vitest does not mistake the file for a suite. Plain literals only — no
 * Lingui macro — following `domain/densityFixtures.ts`.
 *
 * The numbers are internally consistent on purpose: the matchups below are the
 * ones the events would produce, so a test may assert either against the other.
 */

import type {
  AnalysisInsightsRecord,
  AnalysisWorkspace,
  Highlight,
  RoundSummary,
  TimelineEvent,
} from '../../../../shared/desktop/dto';

export const DEMO_ID = 'aurora-vs-meridian';

/* ── events ──────────────────────────────────────────────────────────────── */

interface KillSpec {
  readonly tick: number;
  readonly actor: string;
  readonly target: string;
  readonly weapon: string;
  readonly headshot?: boolean;
  readonly penetrated?: boolean;
}

function kill(spec: KillSpec): TimelineEvent {
  return {
    id: `player_death-${String(spec.tick)}`,
    tick: spec.tick,
    seconds: spec.tick / 64,
    kind: 'kill',
    actor: spec.actor,
    target: spec.target,
    weapon: spec.weapon,
    headshot: spec.headshot ?? false,
    penetrated: spec.penetrated ?? false,
    position: null,
    detail: null,
  };
}

/** A kill the parser could not attribute — skipped by every derivation here. */
function orphanKill(tick: number): TimelineEvent {
  return {
    id: `player_death-${String(tick)}`,
    tick,
    seconds: tick / 64,
    kind: 'kill',
    actor: null,
    target: null,
    weapon: null,
    headshot: false,
    penetrated: false,
    position: null,
    detail: null,
  };
}

function round(
  number: number,
  winner: 'A' | 'B',
  events: readonly TimelineEvent[],
): RoundSummary {
  const start = 10_000 * number;
  return {
    number,
    winner,
    reason: winner === 'A' ? 'ct_killed' : 'target_bombed',
    start_tick: start,
    end_tick: start + 5_400,
    team_a_score: winner === 'A' ? number : number - 1,
    team_b_score: winner === 'A' ? 0 : 1,
    events: [...events],
  };
}

export const ROUNDS: readonly RoundSummary[] = [
  round(1, 'A', [
    // The round's first attributed kill is not its first event.
    orphanKill(10_050),
    kill({ tick: 10_100, actor: 'kael', target: 'sable', weapon: 'ak47', headshot: true }),
    kill({ tick: 10_200, actor: 'rhea', target: 'corvin', weapon: 'm4a1' }),
  ]),
  round(2, 'B', [
    kill({ tick: 20_100, actor: 'sable', target: 'kael', weapon: 'awp' }),
    kill({ tick: 20_200, actor: 'rhea', target: 'sable', weapon: 'ak47', penetrated: true }),
  ]),
  round(3, 'A', [
    kill({ tick: 30_100, actor: 'kael', target: 'corvin', weapon: 'ak47', penetrated: true }),
    kill({ tick: 30_150, actor: 'kael', target: 'sable', weapon: 'ak47', headshot: true }),
  ]),
];

/* ── highlights ──────────────────────────────────────────────────────────── */

function highlight(
  id: string,
  playerId: string,
  round_: number,
  kind: Highlight['kind'],
  label: string,
): Highlight {
  return {
    id,
    label,
    category: kind === 'clutch' ? 'clutch' : 'multi-kill',
    kind,
    description: '三杀后拆包，剩余 1.8 秒',
    tags: ['clutch'],
    victims: ['Sable'],
    player_id: playerId,
    round: round_,
    start_tick: round_ * 10_000 + 100,
    end_tick: round_ * 10_000 + 1_600,
    confidence: 0.9,
  };
}

export const HIGHLIGHTS: readonly Highlight[] = [
  highlight('h-3-clutch', 'kael', 3, 'clutch', '1v3 残局'),
  highlight('h-1-multi', 'kael', 1, 'multi_kill', '三杀'),
  highlight('h-2-sable', 'sable', 2, 'one_tap', '一枪爆头'),
];

/* ── insights ────────────────────────────────────────────────────────────── */

function matchup(
  playerId: string,
  opponentId: string,
  kills: number,
  deaths: number,
  headshotKills: number,
  dealt: number,
  taken: number,
): AnalysisInsightsRecord['matchups'][number] {
  return {
    player_id: playerId,
    opponent_id: opponentId,
    kills,
    deaths,
    headshot_kills: headshotKills,
    damage_dealt: dealt,
    damage_taken: taken,
    damage_events: kills + deaths,
  };
}

export const INSIGHTS: AnalysisInsightsRecord = {
  round_economy: [
    {
      round: 1,
      teams: [
        { team: 'CT', purchase_count: 12, items: [{ name: 'ak47', count: 2 }], spend: 18_500 },
        { team: 'T', purchase_count: 10, items: [{ name: 'awp', count: 1 }], spend: 14_200 },
      ],
      unattributed_purchase_count: 0,
    },
    {
      round: 3,
      teams: [
        { team: 'CT', purchase_count: 12, items: [], spend: 22_400 },
        { team: 'T', purchase_count: 8, items: [], spend: 6_400 },
      ],
      unattributed_purchase_count: 0,
    },
    {
      round: 2,
      teams: [
        { team: 'CT', purchase_count: 9, items: [], spend: 9_800 },
        { team: 'T', purchase_count: 11, items: [], spend: 21_000 },
      ],
      unattributed_purchase_count: 1,
    },
  ],
  player_utility: [
    {
      player_id: 'kael',
      throws: 12,
      detonations: 10,
      items: [
        { name: 'flashbang', count: 5 },
        { name: 'smokegrenade', count: 4 },
        { name: 'hegrenade', count: 3 },
      ],
      damage: 128,
      damage_events: 6,
      flash_events: 7,
      players_flashed: 4,
      flash_duration_seconds: 9.4,
    },
    {
      player_id: 'rhea',
      throws: 9,
      detonations: 9,
      items: [
        { name: 'smokegrenade', count: 6 },
        { name: 'molotov', count: 3 },
      ],
      damage: 58,
      damage_events: 2,
      flash_events: 0,
      players_flashed: 0,
      flash_duration_seconds: null,
    },
    {
      player_id: 'sable',
      throws: 14,
      detonations: 11,
      items: [
        { name: 'flashbang', count: 8 },
        { name: 'hegrenade', count: 6 },
      ],
      damage: 210,
      damage_events: 9,
      flash_events: 11,
      players_flashed: 6,
      flash_duration_seconds: 15.2,
    },
    {
      player_id: 'corvin',
      throws: 6,
      detonations: 4,
      items: [
        { name: 'smokegrenade', count: 4 },
        { name: 'decoy', count: 2 },
      ],
      damage: 0,
      damage_events: 0,
      flash_events: 1,
      players_flashed: 1,
      flash_duration_seconds: 1.4,
    },
  ],
  matchups: [
    matchup('kael', 'sable', 2, 1, 2, 210, 100),
    matchup('kael', 'corvin', 1, 0, 0, 100, 0),
    matchup('sable', 'kael', 1, 2, 1, 100, 210),
    matchup('sable', 'rhea', 0, 1, 0, 40, 100),
    matchup('rhea', 'sable', 1, 0, 0, 100, 40),
    matchup('rhea', 'corvin', 1, 0, 0, 120, 0),
    matchup('corvin', 'kael', 0, 1, 0, 0, 100),
    matchup('corvin', 'rhea', 0, 1, 0, 0, 120),
    // Friendly fire produces a same-team pair; every view has to drop it.
    matchup('kael', 'rhea', 0, 0, 0, 12, 0),
  ],
  availability: {
    purchase_events: { available: true, reason: null },
    purchase_spend: { available: true, reason: null },
    utility_events: { available: true, reason: null },
    utility_damage: { available: true, reason: null },
    flash_effects: { available: true, reason: null },
    matchups: { available: true, reason: null },
  },
};

/* ── the workspace ───────────────────────────────────────────────────────── */

export const ANALYSIS: AnalysisWorkspace = {
  demo_id: DEMO_ID,
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_412,
  teams: [
    { name: 'Aurora', side: 'CT', score: 13, players: ['kael', 'rhea'] },
    { name: 'Meridian', side: 'T', score: 11, players: ['sable', 'corvin'] },
  ],
  players: [
    {
      id: 'kael',
      name: 'Kael',
      team: 'A',
      kills: 27,
      deaths: 14,
      assists: 5,
      headshot_rate: 0.62,
      kill_death_ratio: 1.93,
      adr: 98.4,
    },
    {
      id: 'rhea',
      name: 'Rhea',
      team: 'A',
      kills: 21,
      deaths: 16,
      assists: 8,
      headshot_rate: 0.41,
      kill_death_ratio: 1.31,
      adr: 84.1,
    },
    {
      id: 'sable',
      name: 'Sable',
      team: 'B',
      kills: 24,
      deaths: 17,
      assists: 7,
      headshot_rate: 0.58,
      kill_death_ratio: 1.41,
      adr: 91.2,
    },
    {
      id: 'corvin',
      name: 'Corvin',
      team: 'B',
      kills: 19,
      deaths: 18,
      assists: 9,
      headshot_rate: 0.33,
      kill_death_ratio: 1.06,
      adr: 79.4,
    },
  ],
  rounds: [...ROUNDS],
  highlights: [...HIGHLIGHTS],
  insights: INSIGHTS,
};

/**
 * The same match as a parse that produced neither an event stream nor insights.
 *
 * This is the state every 「后端没有的字段一律省略」 assertion is written
 * against: the scoreboard still has to render, and 首杀 / 武器 / 对位 / 道具 all
 * have to say so rather than print zeros.
 */
export const BARE_ANALYSIS: AnalysisWorkspace = {
  ...ANALYSIS,
  rounds: ANALYSIS.rounds.map((entry) => ({ ...entry, events: [] })),
  highlights: [],
  insights: {
    round_economy: [],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: { available: false, reason: 'no item_purchase events were decoded' },
      purchase_spend: { available: false, reason: 'no explicit price field' },
      utility_events: { available: false, reason: 'no grenade lifecycle events were decoded' },
      utility_damage: { available: false, reason: 'no utility-attributed player_hurt events' },
      flash_effects: { available: false, reason: 'no player_blind events were decoded' },
      matchups: { available: false, reason: 'no identified attacker-target combat pairs' },
    },
  },
};

/* ── a full-size match, for the density assertions ───────────────────────── */

const DENSITY_NAMES = [
  'Kael',
  'Rhea',
  'Odin',
  'Vex',
  'Nim',
  'Sable',
  'Corvin',
  'Thorne',
  'Iris',
  'Bram',
] as const;

/**
 * Ten players and thirty rounds — `MATCH_ROSTER_SIZE` and `OVERTIME_ROUNDS` of
 * `domain/densityFixtures.ts`. Four kills a round is the low end of a real
 * match and is enough to make every table in these three views as long as it
 * can get.
 */
export function densityAnalysis(rounds: number, kills: number): AnalysisWorkspace {
  const players = DENSITY_NAMES.map((name, index) => ({
    id: name.toLowerCase(),
    name,
    team: (index < 5 ? 'A' : 'B') as 'A' | 'B',
    kills: 30 - index,
    deaths: 12 + index,
    assists: index,
    headshot_rate: 0.6 - index * 0.03,
    kill_death_ratio: 2 - index * 0.1,
    adr: 100 - index * 4,
  }));

  const roundList: RoundSummary[] = [];
  for (let number = 1; number <= rounds; number += 1) {
    const events: TimelineEvent[] = [];
    for (let step = 0; step < kills; step += 1) {
      const attacker = DENSITY_NAMES[(number + step) % 5] ?? 'Kael';
      const victim = DENSITY_NAMES[5 + ((number + step) % 5)] ?? 'Sable';
      events.push(
        kill({
          tick: number * 10_000 + step * 100,
          actor: attacker.toLowerCase(),
          target: victim.toLowerCase(),
          weapon: step % 2 === 0 ? 'ak47' : 'm4a1',
          headshot: step % 3 === 0,
        }),
      );
    }
    roundList.push(round(number, number % 2 === 0 ? 'B' : 'A', events));
  }

  const matchups: AnalysisInsightsRecord['matchups'] = [];
  for (let left = 0; left < 5; left += 1) {
    for (let right = 5; right < 10; right += 1) {
      const a = DENSITY_NAMES[left] ?? 'Kael';
      const b = DENSITY_NAMES[right] ?? 'Sable';
      matchups.push(matchup(a.toLowerCase(), b.toLowerCase(), (left + right) % 8, right % 5, 1, 100, 90));
      matchups.push(matchup(b.toLowerCase(), a.toLowerCase(), right % 5, (left + right) % 8, 0, 90, 100));
    }
  }

  return {
    ...ANALYSIS,
    players,
    rounds: roundList,
    highlights: [],
    insights: {
      ...INSIGHTS,
      matchups,
      player_utility: players.map((player) => ({
        player_id: player.id,
        throws: 12,
        detonations: 10,
        items: [
          { name: 'flashbang', count: 5 },
          { name: 'smokegrenade', count: 4 },
        ],
        damage: 128,
        damage_events: 6,
        flash_events: 7,
        players_flashed: 4,
        flash_duration_seconds: 9.4,
      })),
      round_economy: roundList.map((entry) => ({
        round: entry.number,
        teams: [
          { team: 'CT', purchase_count: 12, items: [], spend: 18_500 },
          { team: 'T', purchase_count: 10, items: [], spend: 14_200 },
        ],
        unattributed_purchase_count: 0,
      })),
    },
  };
}
