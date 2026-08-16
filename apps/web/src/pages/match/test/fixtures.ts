/*
 * Test-only fixtures for the match workspace.
 *
 * The match of the artboards — Aurora 13 : 11 Meridian on Mirage — in the wire
 * shapes the workspace actually receives, so a test that renders the shell is
 * rendering the same numbers the reference draws.
 *
 * Under `test/` so `lingui.config.ts` keeps these strings out of the catalogue
 * and vitest does not mistake the file for a suite.
 */

import type {
  AnalysisWorkspace,
  DemoSummary,
  Highlight,
  RoundSummary,
} from '../../../shared/desktop/viewModels';

export const DEMO_ID = 'aurora-vs-meridian';

export const DEMO: DemoSummary = {
  id: DEMO_ID,
  path: 'C:/demos/aurora-vs-meridian.dem',
  filename: 'aurora-vs-meridian.dem',
  display_name: 'Aurora vs Meridian',
  map_name: 'de_mirage',
  match_date: '2026-08-14T20:11:00.000Z',
  cataloged_at: '2026-08-14T21:00:00.000Z',
  duration_seconds: 2_412,
  total_rounds: 24,
  score_team_a: 13,
  score_team_b: 11,
  team_a_name: 'Aurora',
  team_b_name: 'Meridian',
  status: 'ready',
  lifecycle_status: 'ready',
  players: ['Kael', 'Rhea', 'Odin', 'Vex', 'Nim'],
  source: 'watch',
  remark: '',
  updated_at: '2026-08-14T21:00:00.000Z',
};

function round(number: number, winner: 'A' | 'B'): RoundSummary {
  const start = 10_000 + number * 6_000;
  return {
    number,
    winner,
    reason: winner === 'A' ? 'ct_killed' : 'target_bombed',
    start_tick: start,
    end_tick: start + 5_400,
    team_a_score: number,
    team_b_score: 0,
    events: [],
  };
}

const HIGHLIGHT: Highlight = {
  id: 'h-21-clutch',
  label: '1v3 残局',
  category: 'clutch',
  kind: 'clutch',
  description: '三杀后拆包，剩余 1.8 秒',
  tags: ['clutch'],
  victims: ['Sable'],
  player_id: 'kael',
  round: 21,
  start_tick: 148_920,
  end_tick: 150_440,
  confidence: 0.9,
};

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
  ],
  rounds: [round(1, 'A'), round(2, 'B'), round(3, 'A')],
  highlights: [HIGHLIGHT, { ...HIGHLIGHT, id: 'h-13-triple', round: 13 }],
};
