import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { OpeningDuelAnalysisWorkspace } from './OpeningDuelAnalysisWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'opening-r1',
  tick: 1_100,
  seconds: 17.2,
  kind: 'kill',
  actor: 'fallen-id',
  target: 'niko-id',
  weapon: 'ak47',
  headshot: true,
  penetrated: false,
  position: [100, 200, 8],
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
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 1, deaths: 0, assists: 0, headshot_rate: 1, kill_death_ratio: 1, adr: 80 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 0, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 0, adr: 60 },
  ],
  rounds: [
    {
      number: 1,
      winner: 'A',
      reason: 'elimination',
      start_tick: 1_000,
      end_tick: 2_000,
      team_a_score: 1,
      team_b_score: 0,
      events: [event({ id: 'later-r1', tick: 1_300 }), event({ id: 'opening-r1' })],
    },
    {
      number: 2,
      winner: 'B',
      reason: 'time',
      start_tick: 3_000,
      end_tick: 4_000,
      team_a_score: 1,
      team_b_score: 1,
      events: [],
    },
  ],
  highlights: [],
};

describe('OpeningDuelAnalysisWorkspace', () => {
  it('renders dense atomic opening evidence, unavailable reasons, and one inspector action set', () => {
    const markup = renderToStaticMarkup(
      <OpeningDuelAnalysisWorkspace
        workspace={workspace}
        selectedPlayerId={null}
        selectedRound={null}
        serviceAvailable={false}
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="opening-duel-workspace"');
    expect(markup).toContain('data-testid="opening-filter-player"');
    expect(markup).toContain('data-testid="opening-filter-target"');
    expect(markup).toContain('data-testid="opening-filter-round"');
    expect(markup).toContain('data-testid="opening-filter-outcome"');
    expect(markup).toContain('data-testid="opening-player-aggregate"');
    expect(markup.match(/data-testid="opening-evidence-row"/g)).toHaveLength(1);
    expect(markup).toContain('data-evidence-id="demo:major-final-map-1/event:opening-r1"');
    expect(markup).toContain('data-testid="opening-unavailable-summary"');
    expect(markup).toContain('data-reason-code="no_kill_event"');
    expect(markup).toContain('data-testid="opening-inspector"');
    expect(markup).toContain('data-testid="opening-duel-matrix"');
    expect(markup.match(/data-testid="opening-matrix-cell"/g)).toHaveLength(2);
    expect(markup).toContain('击杀者 ↓ / 目标 →');
    expect(markup).toContain('行是击杀者，列是目标；只计每回合已验证的首个击杀。');
    expect(markup).toMatch(/data-actor-id="fallen-id" data-target-id="niko-id"[^>]*>1<\/button>/);
    expect(markup).toMatch(/data-actor-id="niko-id" data-target-id="fallen-id"[^>]*disabled=""[^>]*>0<\/button>/);
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(1);
    }
    expect(markup).toMatch(/data-action="watch" disabled=""[^>]*title="Watch requires an analyzed local demo\."/);
    expect(markup).not.toContain('later-r1');
    expect(markup).not.toContain('Trade');
    expect(markup).not.toContain('KAST');
    expect(markup).not.toContain('Success rate');
    expect(markup).not.toContain('Win impact');
  });

  it('restores player, round, and canonical evidence focus from navigation state', () => {
    const markup = renderToStaticMarkup(
      <OpeningDuelAnalysisWorkspace
        workspace={workspace}
        selectedPlayerId="fallen-id"
        selectedOpponentId="niko-id"
        selectedRound={1}
        focusedEvidenceId="demo:major-final-map-1/event:opening-r1"
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toMatch(/data-testid="opening-filter-player"[^>]*>.*<option value="fallen-id" selected=""/s);
    expect(markup).toMatch(/data-testid="opening-filter-target"[^>]*>.*<option value="niko-id" selected=""/s);
    expect(markup).toMatch(/data-testid="opening-filter-round"[^>]*>.*<option value="1" selected=""/s);
    expect(markup).toMatch(/data-testid="opening-filter-outcome" disabled=""[^>]*>.*<option value="opening_kill" selected=""/s);
    expect(markup).toMatch(/data-actor-id="fallen-id" data-target-id="niko-id"[^>]*aria-pressed="true"/);
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('demo:major-final-map-1/event:opening-r1');
  });
});
