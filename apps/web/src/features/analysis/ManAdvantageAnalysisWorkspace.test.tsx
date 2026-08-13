import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import { ManAdvantageAnalysisWorkspace } from './ManAdvantageAnalysisWorkspace';

const teamA = ['a1', 'a2', 'a3', 'a4', 'a5'];
const teamB = ['b1', 'b2', 'b3', 'b4', 'b5'];

const player = (id: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id,
  name: id.toUpperCase(),
  team,
  kills: 0,
  deaths: 0,
  assists: 0,
  headshot_rate: 0,
  kill_death_ratio: 0,
  adr: 0,
});

const event = (
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent => ({
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
  ...overrides,
});

function workspace(): AnalysisWorkspace {
  const roster = Object.fromEntries([
    ...teamA.map((id) => [id, 'T']),
    ...teamB.map((id) => [id, 'CT']),
  ]);
  return {
    demo_id: 'major-m1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 60,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: teamA },
      { name: 'Team B', side: 'B', score: 0, players: teamB },
    ],
    players: [...teamA.map((id) => player(id, 'A')), ...teamB.map((id) => player(id, 'B'))],
    rounds: [{
      number: 1,
      winner: 'A',
      reason: 'elimination',
      start_tick: 1_000,
      end_tick: 2_000,
      team_a_score: 1,
      team_b_score: 0,
      events: [
        event('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster } }),
        event('kill-a1-b1', 1_200, 'kill', { actor: 'a1', target: 'b1', weapon: 'ak47' }),
        event('kill-b2-a1', 1_400, 'kill', { actor: 'b2', target: 'a1', weapon: 'm4a1' }),
        event('end-r1', 2_000, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('ManAdvantageAnalysisWorkspace component', () => {
  it('renders the exact matrix, round stream, inspector, and one canonical action set', () => {
    const markup = renderToStaticMarkup(
      <ManAdvantageAnalysisWorkspace
        workspace={workspace()}
        selectedRound={1}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="man-advantage-workspace"');
    expect(markup.match(/data-testid="man-advantage-matrix-cell"/g)).toHaveLength(4);
    expect(markup).toContain('data-verified-rounds="1/1"');
    expect(markup).toContain('无首次领先');
    expect(markup.match(/data-testid="man-advantage-round"/g)).toHaveLength(1);
    expect(markup.match(/data-testid="man-advantage-transition"/g)).toHaveLength(2);
    expect(markup).toContain('5v5');
    expect(markup).toContain('5v4');
    expect(markup).toContain('data-testid="man-advantage-inspector"');
    expect(markup).toContain('demo:major-m1/event:kill-a1-b1');
    expect(markup).toContain('demo:major-m1/event:end-r1');
    expect(markup).toContain('同 tick 死亡');
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(1);
    }
    for (const forbidden of ['win rate', 'probability', 'trade', 'KAST', 'rating']) {
      expect(markup.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('keeps same-tick deaths atomic and exposes complete matrix and transition names', () => {
    const sameTick = workspace();
    const firstDeath = sameTick.rounds[0]?.events.find((item) => item.id === 'kill-a1-b1');
    const secondDeath = sameTick.rounds[0]?.events.find((item) => item.id === 'kill-b2-a1');
    if (!firstDeath || !secondDeath) throw new Error('The fixture must contain both deaths.');
    firstDeath.actor = null;
    secondDeath.tick = firstDeath.tick;
    secondDeath.seconds = firstDeath.seconds;

    const markup = renderToStaticMarkup(
      <ManAdvantageAnalysisWorkspace
        workspace={sameTick}
        selectedRound={1}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup.match(/data-testid="man-advantage-transition"/g)).toHaveLength(1);
    expect(markup.match(/data-testid="man-advantage-death"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="回合 1, tick 1200, 5v5 → 4v4, 2 条死亡"');
    expect(markup).toContain('aria-label="首次非平局领先 Team A, 最终胜方 Team A, 0 回合"');
    expect(markup).toMatch(/data-action="add"[^>]*disabled/);
    expect(markup).toContain('击杀者不可用');
  });

  it('shows the verified-round denominator when the match roster fails closed', () => {
    const invalidRoster = workspace();
    invalidRoster.players.pop();

    const markup = renderToStaticMarkup(
      <ManAdvantageAnalysisWorkspace
        workspace={invalidRoster}
        selectedRound={1}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toMatch(/data-testid="man-advantage-availability">不完整回合已隔离 · 0\/1/);
    expect(markup).not.toContain('data-testid="man-advantage-matrix-cell"');
  });

  it('does not substitute another death when a deep-linked evidence ID is stale', () => {
    const markup = renderToStaticMarkup(
      <ManAdvantageAnalysisWorkspace
        workspace={workspace()}
        selectedRound={1}
        focusedEvidenceId="demo:major-m1/event:missing-death"
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('深链接死亡证据不可用');
    expect(markup).not.toContain('data-action="round"');
    expect(markup).not.toMatch(/data-testid="man-advantage-death"[^>]*aria-current="true"/);
  });
});
