/*
 * Test-only fixture for 概览 / 回合 / 队伍.
 *
 * `pages/match/test/fixtures.ts` holds the shell's three-round sample; the three
 * views need a match at the density `domain/densityFixtures.ts` records — 24
 * rounds ([规则] MR12), a ten-player roster, kills and bomb events on every
 * round, 18 highlight candidates ([画板] 「高光 18」) and a full `insights` block.
 * A view that is only ever tested against three rounds and two players is a view
 * whose density nobody has checked.
 *
 * Under `test/` so `lingui.config.ts` keeps these strings out of the catalogue
 * (`exclude: ['**\/test\/**']`) and vitest does not mistake the file for a suite.
 *
 * Deliberate properties the tests lean on:
 *
 *   · kills name their actor by **id** except round 3, which names one by
 *     **name**, so the two-key directory is exercised;
 *   · round 5 carries a kill whose target is a stranger, so the unattributed
 *     path has something to report;
 *   · every second round has a bomb plant and every fourth a defuse, so the
 *     objective markers are never all-or-nothing;
 *   · round 24's economy carries no price, so a spend total has to come out
 *     `null` rather than low.
 */

import type { AnalysisInsightsRecord, TimelineEvent } from '../../../../shared/desktop/dto';
import type {
  AnalysisWorkspace,
  Highlight,
  PlayerAnalysis,
  RoundSummary,
} from '../../../../shared/desktop/viewModels';

export const DEMO_ID = 'aurora-vs-meridian';

const TEAM_A = ['Kael', 'Rhea', 'Odin', 'Vex', 'Nim'];
const TEAM_B = ['Sable', 'Corvin', 'Thorne', 'Iris', 'Bram'];

const idOf = (name: string): string => name.toLowerCase();

function player(name: string, team: 'A' | 'B', index: number): PlayerAnalysis {
  const kills = 27 - index * 3 - (team === 'B' ? 3 : 0);
  const deaths = 14 + index * 2;
  return {
    id: idOf(name),
    name,
    team,
    kills,
    deaths,
    assists: 5 + index,
    headshot_rate: 0.62 - index * 0.05,
    kill_death_ratio: Number((kills / deaths).toFixed(2)),
    adr: 98.4 - index * 8.2,
  };
}

export const PLAYERS: PlayerAnalysis[] = [
  ...TEAM_A.map((name, index) => player(name, 'A', index)),
  ...TEAM_B.map((name, index) => player(name, 'B', index)),
];

/** 24 rounds, Aurora 13 : 11 Meridian — the artboard's own match. */
const WINNERS: readonly ('A' | 'B')[] = [
  'A', 'B', 'A', 'A', 'B', 'A', 'B', 'B', 'A', 'A', 'B', 'A',
  'B', 'A', 'A', 'B', 'A', 'B', 'B', 'A', 'A', 'B', 'A', 'B',
];

const REASONS = ['ct_killed', 'target_bombed', 'bomb_defused', 'time_ran_out'];

function event(
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  fields: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    id,
    tick,
    seconds: tick / 64,
    kind,
    actor: null,
    target: null,
    weapon: null,
    headshot: false,
    penetrated: false,
    position: null,
    detail: {},
    ...fields,
  };
}

function roundEvents(number: number, startTick: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const killCount = 4 + (number % 3);

  for (let index = 0; index < killCount; index += 1) {
    const attacker = TEAM_A[index % TEAM_A.length] ?? 'Kael';
    const victim = TEAM_B[index % TEAM_B.length] ?? 'Sable';
    const aVictim = TEAM_A[(index + 1) % TEAM_A.length] ?? 'Rhea';
    // Alternate which side takes the death so the survivor curve moves on both
    // lines rather than draining one of them.
    const targetName = index % 2 === 0 ? victim : aVictim;

    events.push(
      event(`r${number}-kill-${index}`, startTick + 500 + index * 700, 'kill', {
        // Round 3 names its actor by display name; every other round uses the
        // id. Both have to resolve.
        actor: number === 3 ? attacker : idOf(attacker),
        target: number === 5 && index === 0 ? 'a-player-who-left' : idOf(targetName),
        weapon: index % 2 === 0 ? 'AK-47' : 'M4A1-S',
        headshot: index === 0,
        penetrated: index === 2,
        position: index % 2 === 0 ? [512, -1024, 96] : null,
      }),
    );
  }

  if (number % 2 === 0) {
    events.push(event(`r${number}-plant`, startTick + 2_000, 'bomb_plant', { actor: idOf('Sable') }));
  }
  if (number % 4 === 0) {
    events.push(event(`r${number}-defuse`, startTick + 4_400, 'bomb_defuse', { actor: idOf('Kael') }));
  }
  // Noise the round-event table deliberately leaves out, so its 「共 N 条事件」
  // line has something to be honest about.
  events.push(event(`r${number}-purchase`, startTick + 60, 'purchase', { actor: idOf('Kael') }));
  events.push(event(`r${number}-damage`, startTick + 900, 'damage', { actor: idOf('Rhea') }));

  return events;
}

function round(number: number): RoundSummary {
  const startTick = 10_000 + (number - 1) * 7_000;
  const winner = WINNERS[number - 1] ?? 'A';
  let a = 0;
  let b = 0;
  for (let index = 0; index < number; index += 1) {
    if (WINNERS[index] === 'A') a += 1;
    else b += 1;
  }

  return {
    number,
    winner,
    reason: REASONS[number % REASONS.length] ?? 'ct_killed',
    start_tick: startTick,
    end_tick: startTick + 6_000,
    team_a_score: a,
    team_b_score: b,
    events: roundEvents(number, startTick),
  };
}

export const ROUNDS: RoundSummary[] = Array.from({ length: 24 }, (_, index) =>
  round(index + 1),
);

/* ── highlights ──────────────────────────────────────────────────────────── */

const HIGHLIGHT_KINDS: readonly Highlight['kind'][] = [
  'clutch',
  'multi_kill',
  'wallbang',
  'one_tap',
  'no_scope',
  'fail',
];

function highlight(index: number): Highlight {
  const kind = HIGHLIGHT_KINDS[index % HIGHLIGHT_KINDS.length] ?? 'clutch';
  const owner = [...TEAM_A, ...TEAM_B][index % 10] ?? 'Kael';
  const roundNumber = 24 - index;
  const startTick = 10_000 + (roundNumber - 1) * 7_000 + 1_200;

  return {
    id: `h-${index}`,
    label: index === 0 ? '1v3 残局' : '',
    category: kind === 'clutch' ? 'clutch' : 'multi-kill',
    kind,
    description: index === 0 ? '三杀后拆包，剩余 1.8 秒' : '',
    tags: [kind],
    victims: [idOf('Sable')],
    player_id: idOf(owner),
    round: roundNumber,
    start_tick: startTick,
    end_tick: startTick + 1_520,
    confidence: 0.99 - index * 0.03,
  };
}

/** [画板] 「高光 18」. */
export const HIGHLIGHTS: Highlight[] = Array.from({ length: 18 }, (_, index) =>
  highlight(index),
);

/* ── insights ────────────────────────────────────────────────────────────── */

const ABLE = { available: true, reason: null };

export const INSIGHTS: AnalysisInsightsRecord = {
  round_economy: ROUNDS.map((entry) => ({
    round: entry.number,
    teams: [
      {
        team: 'CT',
        purchase_count: 4 + (entry.number % 3),
        items: [{ name: 'ak47', count: 2 }],
        // The last round has no price at all, so a total spend has to be null.
        spend: entry.number === 24 ? null : 12_000 + entry.number * 250,
      },
      {
        team: 'T',
        purchase_count: 3 + (entry.number % 4),
        items: [{ name: 'm4a1', count: 1 }],
        spend: entry.number === 24 ? null : 11_400 + entry.number * 210,
      },
    ],
    unattributed_purchase_count: entry.number === 7 ? 2 : 0,
  })),
  player_utility: [],
  matchups: [],
  availability: {
    purchase_events: ABLE,
    purchase_spend: ABLE,
    utility_events: ABLE,
    utility_damage: ABLE,
    flash_effects: ABLE,
    matchups: ABLE,
  },
};

/* ── the document ────────────────────────────────────────────────────────── */

export const ANALYSIS: AnalysisWorkspace = {
  demo_id: DEMO_ID,
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_412,
  teams: [
    { name: 'Aurora', side: 'CT', score: 13, players: TEAM_A.map(idOf) },
    { name: 'Meridian', side: 'T', score: 11, players: TEAM_B.map(idOf) },
  ],
  players: PLAYERS,
  rounds: ROUNDS,
  highlights: HIGHLIGHTS,
  insights: INSIGHTS,
};

/**
 * A parse that produced rounds and nothing else: no highlights, no insights, no
 * events. Every 「省略而不是渲染 0」 rule has to hold against this one.
 */
export const BARE_ANALYSIS: AnalysisWorkspace = {
  demo_id: DEMO_ID,
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_412,
  teams: [
    { name: 'Aurora', side: '', score: 13, players: [] },
    { name: 'Meridian', side: '', score: 11, players: [] },
  ],
  players: PLAYERS,
  rounds: ROUNDS.map((entry) => ({ ...entry, events: [] })),
  highlights: [],
};
