import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { PlayerEvidenceWorkspace } from './PlayerEvidenceWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'kill-100',
  tick: 100,
  seconds: 1.5625,
  kind: 'kill',
  actor: 'fallen-id',
  target: 'niko-id',
  weapon: 'awp',
  headshot: false,
  penetrated: false,
  position: null,
  detail: {},
  ...overrides,
});

function workspace(roundEvents: TimelineEvent[] = []): AnalysisWorkspace {
  return {
    demo_id: 'major-final-map-1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 2_958,
    teams: [],
    players: [
      { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 2, deaths: 1, assists: 3, headshot_rate: 0.5, kill_death_ratio: 2, adr: 78 },
      { id: 'niko-id', name: 'NiKo', team: 'B', kills: 1, deaths: 2, assists: 0, headshot_rate: 1, kill_death_ratio: 0.5, adr: 90 },
    ],
    rounds: [{
      number: 5,
      winner: 'A',
      reason: 'elimination',
      start_tick: 20_000,
      end_tick: 30_000,
      team_a_score: 2,
      team_b_score: 3,
      events: roundEvents,
    }],
    highlights: [],
  };
}

function render(value = workspace()) {
  return renderToStaticMarkup(
    <PlayerEvidenceWorkspace
      workspace={value}
      playerId="fallen-id"
      onWatch={() => undefined}
      onOpenReplay={() => undefined}
      onAddProduction={() => undefined}
    />,
  );
}

describe('player evidence workspace', () => {
  it('shows a compact, evidence-only player summary without fabricated metrics', () => {
    const markup = render();

    expect(markup).toContain('data-testid="player-evidence-summary"');
    expect(markup).toContain('FalleN');
    expect(markup).toContain('2 / 1 / 3');
    expect(markup).toContain('78.0');
    expect(markup).toContain('50%');
    expect(markup).not.toContain('Rating 2');
    expect(markup).not.toContain('KAST');
    expect(markup).not.toContain('Accuracy');
    expect(markup).not.toContain('Shots');
  });

  it('keeps every evidence family visible and gives each atomic row all three actions', () => {
    const value = workspace([
      event({ id: 'kill-100', tick: 25_100 }),
      event({ id: 'death-120', tick: 25_120, actor: 'niko-id', target: 'fallen-id', weapon: 'm4a1' }),
      event({ id: 'grenade_thrown-130-1', tick: 25_130, kind: 'grenade', target: null, weapon: 'flashbang' }),
      event({ id: 'utility-hurt', tick: 25_140, kind: 'damage', target: 'niko-id', weapon: 'hegrenade', detail: { dmg_health: 41 } }),
      event({ id: 'bomb-plant-150', tick: 25_150, kind: 'bomb_plant', target: null, weapon: null }),
    ]);
    value.highlights = [{
      id: 'highlight-1',
      label: 'Opening pick',
      category: 'entry',
      kind: 'one_tap',
      description: 'Exact parsed highlight',
      tags: ['one-tap'],
      victims: ['NiKo'],
      player_id: 'fallen-id',
      round: 5,
      start_tick: 25_100,
      end_tick: 25_120,
      confidence: 0.94,
    }];
    value.insights = {
      round_economy: [],
      player_utility: [{
        player_id: 'fallen-id',
        throws: 1,
        detonations: 0,
        items: [{ name: 'flashbang', count: 1 }],
        damage: 41,
        damage_events: 1,
        flash_events: 0,
        players_flashed: 0,
        flash_duration_seconds: null,
      }],
      matchups: [{
        player_id: 'fallen-id',
        opponent_id: 'niko-id',
        kills: 1,
        deaths: 1,
        headshot_kills: 0,
        damage_dealt: 41,
        damage_taken: 0,
        damage_events: 1,
      }],
      availability: {
        purchase_events: { available: false, reason: 'not requested' },
        purchase_spend: { available: false, reason: 'not requested' },
        utility_events: { available: true, reason: null },
        utility_damage: { available: true, reason: null },
        flash_effects: { available: false, reason: 'not decoded' },
        matchups: { available: true, reason: null },
      },
    };

    const markup = render(value);
    for (const section of ['kills', 'deaths', 'weapons', 'duels', 'utility', 'objectives', 'highlights']) {
      expect(markup).toContain(`data-testid="player-evidence-${section}"`);
    }
    const rowCount = markup.match(/data-testid="player-evidence-row"/g)?.length ?? 0;
    expect(rowCount).toBeGreaterThan(0);
    expect(markup.match(/data-action="watch"/g)).toHaveLength(rowCount);
    expect(markup.match(/data-action="replay"/g)).toHaveLength(rowCount);
    expect(markup.match(/data-action="add"/g)).toHaveLength(rowCount);
    expect(markup).toContain('data-evidence-id="demo:major-final-map-1/event:kill-100"');
    expect(markup).toContain('data-evidence-id="demo:major-final-map-1/highlight:highlight-1"');
  });

  it('labels partial utility capabilities instead of presenting unavailable zeros as facts', () => {
    const value = workspace([
      event({ id: 'grenade_thrown-130-1', tick: 25_130, kind: 'grenade', target: null, weapon: 'flashbang' }),
    ]);
    value.insights = {
      round_economy: [],
      player_utility: [{
        player_id: 'fallen-id',
        throws: 1,
        detonations: 0,
        items: [{ name: 'flashbang', count: 1 }],
        damage: 0,
        damage_events: 0,
        flash_events: 0,
        players_flashed: 0,
        flash_duration_seconds: null,
      }],
      matchups: [],
      availability: {
        purchase_events: { available: false, reason: 'not requested' },
        purchase_spend: { available: false, reason: 'not requested' },
        utility_events: { available: true, reason: null },
        utility_damage: { available: false, reason: 'utility damage unavailable' },
        flash_effects: { available: false, reason: 'no player_blind events were decoded' },
        matchups: { available: false, reason: 'not requested' },
      },
    };

    const markup = render(value);
    expect(markup).toContain('data-capability="utility-damage"');
    expect(markup).toContain('utility damage unavailable');
    expect(markup).toContain('data-capability="flash-effects"');
    expect(markup).toContain('no player_blind events were decoded');
    expect(markup).not.toContain('<dt>FLASHED</dt><dd>0</dd>');
    expect(markup).not.toContain('<dt>UTILITY DMG</dt><dd>0</dd>');
  });

  it('keeps replay and production available when game launch is explicitly unavailable', () => {
    const value = workspace([event({ id: 'kill-100', tick: 25_100 })]);
    const markup = renderToStaticMarkup(
      <PlayerEvidenceWorkspace
        workspace={value}
        playerId="fallen-id"
        watchEnabled={false}
        watchUnavailableReason="local Demo launch unavailable"
        onWatch={() => undefined}
        onOpenReplay={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toMatch(/data-action="watch" disabled=""[^>]*title="local Demo launch unavailable"/);
    expect(markup).toMatch(/data-action="replay"[^>]*aria-label=/);
    expect(markup).toMatch(/data-action="add"[^>]*aria-label=/);
  });

  it('gives every compact evidence action a mouse-discoverable label', () => {
    const value = workspace([event({ id: 'kill-100', tick: 25_100 })]);
    const markup = render(value);
    const actionTags = markup.match(/<button[^>]*data-action="(?:watch|replay|add)"[^>]*>/g) ?? [];

    expect(actionTags.length).toBeGreaterThan(0);
    expect(actionTags.length % 3).toBe(0);
    for (const actionTag of actionTags) {
      expect(actionTag).toMatch(/title="[^"]+"/);
    }
  });

  it('marks an evidence deep link as the current atomic row', () => {
    const value = workspace([event({ id: 'kill-100', tick: 25_100 })]);
    const markup = renderToStaticMarkup(
      <PlayerEvidenceWorkspace
        workspace={value}
        playerId="fallen-id"
        focusedEvidenceId="demo:major-final-map-1/event:kill-100"
        onWatch={() => undefined}
        onOpenReplay={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toMatch(/class="player-evidence-row is-focused"[^>]*data-evidence-id="demo:major-final-map-1\/event:kill-100"[^>]*aria-current="true"/);
  });
});
