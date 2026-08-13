import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { DuelAnalysisWorkspace } from './DuelAnalysisWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'kill-1',
  tick: 1_100,
  seconds: 17.2,
  kind: 'kill',
  actor: 'fallen-id',
  target: 'niko-id',
  weapon: 'ak47',
  headshot: true,
  penetrated: false,
  position: null,
  detail: {},
  ...overrides,
});

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 4, deaths: 3, assists: 1, headshot_rate: 0.5, kill_death_ratio: 4 / 3, adr: 78 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 3, deaths: 4, assists: 2, headshot_rate: 0.5, kill_death_ratio: 0.75, adr: 90 },
  ],
  rounds: [{
    number: 20,
    winner: 'A',
    reason: 'elimination',
    start_tick: 1_000,
    end_tick: 2_000,
    team_a_score: 12,
    team_b_score: 8,
    events: [
      event({ id: 'damage-1', kind: 'damage', tick: 1_050, detail: { dmg_health: 64 } }),
      event({ id: 'kill-1' }),
      event({ id: 'death-1', actor: 'niko-id', target: 'fallen-id', weapon: 'awp', tick: 1_300, headshot: false }),
    ],
  }],
  highlights: [],
  insights: {
    round_economy: [],
    player_utility: [],
    matchups: [{
      player_id: 'fallen-id',
      opponent_id: 'niko-id',
      kills: 4,
      deaths: 3,
      headshot_kills: 2,
      damage_dealt: 311,
      damage_taken: 288,
      damage_events: 8,
    }],
    availability: {
      purchase_events: { available: false, reason: 'Not decoded.' },
      purchase_spend: { available: false, reason: 'Not decoded.' },
      utility_events: { available: false, reason: 'Not decoded.' },
      utility_damage: { available: false, reason: 'Not decoded.' },
      flash_effects: { available: false, reason: 'Not decoded.' },
      matchups: { available: true, reason: null },
    },
  },
};

describe('DuelAnalysisWorkspace', () => {
  it('renders matchup aggregates separately from atomic engagement rows with four evidence actions', () => {
    const markup = renderToStaticMarkup(
      <DuelAnalysisWorkspace
        workspace={workspace}
        selectedPlayerId="fallen-id"
        selectedRound={20}
        serviceAvailable={false}
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="duel-evidence-workspace"');
    expect(markup).toContain('data-testid="duel-filter-player"');
    expect(markup).toContain('data-testid="duel-filter-opponent"');
    expect(markup).toContain('data-testid="duel-filter-round"');
    expect(markup).toContain('data-testid="duel-matchup-row"');
    expect(markup).toContain('data-aggregate-scope="match"');
    expect(markup).toContain('4–3');
    expect(markup).toContain('data-testid="duel-engagement-row"');
    expect(markup.match(/data-testid="duel-engagement-row"/g)).toHaveLength(3);
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(3);
    }
    expect(markup).toMatch(/data-action="watch" disabled=""[^>]*title="Watch requires an analyzed local demo\."/);
    expect(markup).not.toContain('Trade');
    expect(markup).not.toContain('Shots');
    expect(markup).not.toContain('Accuracy');
    expect(markup).not.toContain('KAST');
    expect(markup).not.toContain('<dt>Rating</dt>');
  });

  it('keeps the opponent filter controlled so URL-owned round changes do not clear it', () => {
    const markup = renderToStaticMarkup(
      <DuelAnalysisWorkspace
        workspace={workspace}
        selectedPlayerId="fallen-id"
        selectedOpponentId="niko-id"
        selectedRound={20}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toMatch(/data-testid="duel-filter-opponent"[^>]*>.*<option value="niko-id" selected=""/s);
    expect(markup).toContain('<h3>FalleN vs NiKo</h3>');
    expect(markup.match(/data-testid="duel-engagement-row"/g)).toHaveLength(3);
  });
});
