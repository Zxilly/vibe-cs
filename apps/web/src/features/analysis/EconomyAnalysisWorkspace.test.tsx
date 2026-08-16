import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { EconomyAnalysisWorkspace } from './EconomyAnalysisWorkspace';

const purchase = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'item_purchase-100-1',
  tick: 100,
  seconds: 1.5625,
  kind: 'purchase',
  actor: 'fallen-id',
  target: null,
  weapon: 'weapon_ak47',
  headshot: false,
  penetrated: false,
  position: null,
  detail: { team: 2, price: 2_700 },
  ...overrides,
});

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 1, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 1, adr: 80 },
    { id: 'karrigan-id', name: 'karrigan', team: 'B', kills: 1, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 1, adr: 80 },
  ],
  rounds: [{
    number: 1,
    winner: 'A',
    reason: 'elimination',
    start_tick: 1,
    end_tick: 1_000,
    team_a_score: 1,
    team_b_score: 0,
    events: [
      purchase({ id: 'item_purchase-100-1' }),
      purchase({
        id: 'item_purchase-110-2',
        tick: 110,
        actor: 'karrigan-id',
        weapon: 'weapon_deagle',
        detail: { team: 'T', price: 700 },
      }),
    ],
  }],
  highlights: [],
  insights: {
    round_economy: [{
      round: 1,
      teams: [
        { team: 'T', purchase_count: 2, items: [{ name: 'ak47', count: 1 }, { name: 'deagle', count: 1 }], spend: 3_400 },
        { team: 'CT', purchase_count: 0, items: [], spend: null },
      ],
      unattributed_purchase_count: 0,
    }],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: { available: true, reason: null },
      purchase_spend: { available: true, reason: null },
      utility_events: { available: false, reason: 'not requested' },
      utility_damage: { available: false, reason: 'not requested' },
      flash_effects: { available: false, reason: 'not requested' },
      matchups: { available: false, reason: 'not requested' },
    },
  },
};

describe('EconomyAnalysisWorkspace', () => {
  it('renders a dense round-side table and atomic purchase inspector without inferred economy fields', () => {
    const markup = renderToStaticMarkup(
      <EconomyAnalysisWorkspace
        workspace={workspace}
        serviceAvailable={false}
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="economy-evidence-workspace"');
    expect(markup).toContain('data-testid="economy-filter-player"');
    expect(markup).toContain('data-testid="economy-filter-round"');
    expect(markup.match(/data-testid="economy-round-row"/g)).toHaveLength(1);
    expect(markup.match(/data-aggregate-scope="round-side"/g)).toHaveLength(4);
    expect(markup).toContain('data-testid="economy-evidence-inspector"');
    expect(markup.match(/data-testid="economy-purchase-row"/g)).toHaveLength(2);
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(2);
    }
    expect(markup).toMatch(/data-action="watch" disabled=""[^>]*title="Watch requires an analyzed local demo\."/);
    for (const metric of ['equipment-value', 'economy-type', 'advantage', 'money-snapshot']) {
      expect(markup).toContain(`data-capability="${metric}" data-state="unavailable"`);
    }
    expect(markup).not.toContain('Full buy');
    expect(markup).not.toContain('TEAM A');
    expect(markup).not.toContain('TEAM B');
  });
});
