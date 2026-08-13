import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { UtilityAnalysisWorkspace } from './UtilityAnalysisWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'grenade_thrown-100-1',
  tick: 100,
  seconds: 1.5625,
  kind: 'grenade',
  actor: 'alice-id',
  target: null,
  weapon: 'weapon_smokegrenade',
  headshot: false,
  penetrated: false,
  position: [10, 20, 30],
  detail: {},
  ...overrides,
});

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_900,
  teams: [],
  players: [
    { id: 'alice-id', name: 'Alice', team: 'A', kills: 1, deaths: 0, assists: 0, headshot_rate: 1, kill_death_ratio: 1, adr: 82 },
    { id: 'bob-id', name: 'Bob', team: 'B', kills: 0, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 0, adr: 40 },
  ],
  rounds: [{
    number: 20,
    winner: 'A',
    reason: 'elimination',
    start_tick: 100,
    end_tick: 200,
    team_a_score: 12,
    team_b_score: 8,
    events: [
      event({ id: 'grenade_thrown-100-1' }),
      event({ id: 'player_blind-120-2', tick: 120, target: 'bob-id', weapon: null, detail: { blind_duration: 2.25 } }),
      event({ id: 'player_hurt-130-3', tick: 130, kind: 'damage', target: 'bob-id', weapon: 'hegrenade', detail: { dmg_health: 41 } }),
      event({ id: 'player_hurt-135-4', tick: 135, kind: 'damage', target: 'bob-id', weapon: 'inferno', detail: {} }),
    ],
  }],
  highlights: [],
  insights: {
    round_economy: [],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: { available: false, reason: 'not requested' },
      purchase_spend: { available: false, reason: 'not requested' },
      utility_events: { available: true, reason: null },
      utility_damage: { available: true, reason: null },
      flash_effects: { available: true, reason: null },
      matchups: { available: false, reason: 'not requested' },
    },
  },
};

describe('UtilityAnalysisWorkspace', () => {
  it('renders dense real-event filters, canonical evidence, an inspector, and four actions per row', () => {
    const markup = renderToStaticMarkup(
      <UtilityAnalysisWorkspace
        workspace={workspace}
        serviceAvailable={false}
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="utility-evidence-workspace"');
    expect(markup).toContain('data-testid="utility-filter-player"');
    expect(markup).toContain('data-testid="utility-filter-round"');
    expect(markup).toContain('data-testid="utility-filter-type"');
    expect(markup).toContain('data-testid="utility-evidence-inspector"');
    expect(markup).toContain('data-evidence-id="demo:major-final-map-1/event:grenade_thrown-100-1"');
    expect(markup).toContain('<code>demo:major-final-map-1/event:grenade_thrown-100-1</code>');
    const rows = markup.match(/data-testid="utility-evidence-row"/g)?.length ?? 0;
    expect(rows).toBe(4);
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(rows);
    }
    expect(markup).toMatch(/data-action="watch" disabled=""[^>]*title="Watch requires an analyzed local demo\."/);
  });

  it('renders explicit partial reasons and never labels event counts as throws or hits', () => {
    const markup = renderToStaticMarkup(
      <UtilityAnalysisWorkspace
        workspace={workspace}
        selectedPlayerId="alice-id"
        selectedRound={20}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-capability="utility-damage"');
    expect(markup).toContain('1 of 2 matching utility damage events has no numeric damage amount.');
    expect(markup).toContain('data-capability="flash-effects"');
    expect(markup).not.toMatch(/>Throws?</i);
    expect(markup).not.toMatch(/>Hits?</i);
    expect(markup).not.toMatch(/lineup|callout|coverage/i);
  });

  it('preserves unknown atomic values as em dashes instead of inferred labels', () => {
    const unknownWorkspace: AnalysisWorkspace = {
      ...workspace,
      rounds: [{
        ...workspace.rounds[0]!,
        events: [event({
          id: 'grenade-unknown',
          actor: null,
          target: null,
          weapon: null,
          position: null,
        })],
      }],
    };
    const markup = renderToStaticMarkup(
      <UtilityAnalysisWorkspace
        workspace={unknownWorkspace}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-utility-type="other"');
    expect(markup).toContain('—');
    expect(markup).toMatch(/data-action="add" disabled=""[^>]*title="A verified utility actor is required/);
  });
});
