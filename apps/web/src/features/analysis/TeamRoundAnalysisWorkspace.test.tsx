import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace, PlayerAnalysis } from '../../shared/desktop/viewModels';
import { TeamRoundAnalysisWorkspace } from './TeamRoundAnalysisWorkspace';

const teamA = ['a1', 'a2', 'a3', 'a4', 'a5'];
const teamB = ['b1', 'b2', 'b3', 'b4', 'b5'];

const player = (id: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id,
  name: id.toLocaleUpperCase(),
  team,
  kills: 0,
  deaths: 0,
  assists: 0,
  headshot_rate: 0,
  kill_death_ratio: 0,
  adr: 0,
});

const timeline = (
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
        timeline('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster } }),
        timeline('kill-r1', 1_400, 'kill', {
          actor: 'a1',
          target: 'b1',
          weapon: 'ak47',
          headshot: true,
        }),
        timeline('end-r1', 2_000, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('TeamRoundAnalysisWorkspace', () => {
  it('renders a dense truthful team-side matrix, atomic evidence, and one inspector action set', () => {
    const markup = renderToStaticMarkup(
      <TeamRoundAnalysisWorkspace
        workspace={workspace()}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="team-round-workspace"');
    expect(markup).toContain('data-testid="team-round-matrix"');
    expect(markup.match(/data-testid="team-round-cell"/g)).toHaveLength(4);
    expect(markup).toMatch(/data-team="A" data-side="T"[^>]*aria-pressed="true"/);
    expect(markup).toContain('data-testid="team-round-evidence"');
    expect(markup.match(/data-testid="team-round-evidence-row"/g)).toHaveLength(2);
    expect(markup).toContain('data-evidence-id="demo:major-m1/event:kill-r1"');
    expect(markup).toContain('data-evidence-id="demo:major-m1/event:end-r1"');
    expect(markup).toContain('data-testid="team-round-inspector"');
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(1);
    }
    expect(markup).toContain('本场稳定阵容，不代表组织队身份');
    expect(markup).not.toContain('胜率');
    expect(markup).not.toContain('KAST');
    expect(markup).not.toContain('Rating');
    expect(markup).not.toContain('Trade');
  });
});
