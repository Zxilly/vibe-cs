import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { WeaponAnalysisWorkspace } from './WeaponAnalysisWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'kill-ak',
  tick: 161_114,
  seconds: 2_517.4,
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
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 2, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 2, adr: 78 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 1, deaths: 2, assists: 0, headshot_rate: 1, kill_death_ratio: 0.5, adr: 90 },
  ],
  rounds: [{
    number: 20,
    winner: 'A',
    reason: 'elimination',
    start_tick: 160_000,
    end_tick: 162_000,
    team_a_score: 12,
    team_b_score: 8,
    events: [
      event({ id: 'hurt-ak', kind: 'damage', tick: 161_100, detail: { dmg_health: 37 } }),
      event({ id: 'kill-ak' }),
      event({ id: 'kill-awp', actor: 'niko-id', target: 'fallen-id', weapon: 'awp', tick: 161_300, headshot: false }),
    ],
  }],
  highlights: [],
};

describe('WeaponEvidenceWorkspace', () => {
  it('renders dense player/round filters, truthful metrics, and four actions on every atomic row', () => {
    const markup = renderToStaticMarkup(
      <WeaponAnalysisWorkspace
        workspace={workspace}
        serviceAvailable={false}
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="weapon-evidence-workspace"');
    expect(markup).toContain('data-testid="weapon-filter-player"');
    expect(markup).toContain('data-testid="weapon-filter-round"');
    expect(markup).toContain('data-weapon-name="ak47"');
    expect(markup).toContain('37');
    expect(markup).toContain('Damage events do not prove individual bullet or pellet hits.');
    const evidenceRows = markup.match(/data-testid="weapon-evidence-row"/g)?.length ?? 0;
    expect(evidenceRows).toBe(3);
    expect(markup).toContain('data-weapon-name="all"');
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(evidenceRows);
    }
    expect(markup).toMatch(/data-action="watch" disabled=""[^>]*title="Watch requires an analyzed local demo\."/);
    expect(markup).not.toContain('Accuracy');
    expect(markup).not.toContain('Shots');
  });

  it('uses URL-owned player and round filters so the workspace can be restored from a deep link', () => {
    const markup = renderToStaticMarkup(
      <WeaponAnalysisWorkspace
        workspace={workspace}
        selectedPlayerId="fallen-id"
        selectedRound={20}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toMatch(/data-testid="weapon-filter-player"[^>]*><option value="">[^<]+<\/option><option value="fallen-id" selected=""/);
    expect(markup).toMatch(/data-testid="weapon-filter-round"[^>]*><option value="">[^<]+<\/option><option value="20" selected=""/);
    expect(markup).toContain('data-weapon-name="ak47"');
    expect(markup).not.toContain('data-weapon-name="awp"');
    expect(markup.match(/data-testid="weapon-evidence-row"/g)).toHaveLength(2);
  });
});
