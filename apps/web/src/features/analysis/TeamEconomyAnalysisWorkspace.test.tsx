import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, PlayerAnalysis, TimelineEvent } from '../../shared/desktop/dto';
import { currentLocale, translate } from '../../shared/i18n';
import { TeamEconomyAnalysisWorkspace } from './TeamEconomyAnalysisWorkspace';

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
        event('buy-a1-r1', 1_100, 'purchase', {
          actor: 'a1',
          weapon: 'weapon_ak47',
          detail: { cost: 2_700, userteam: 2 },
        }),
        event('buy-a2-r1', 1_110, 'purchase', {
          actor: 'a2',
          weapon: 'weapon_flashbang',
          detail: { cost: 200, userteam: 2 },
        }),
      ],
    }],
    highlights: [],
  };
}

describe('TeamEconomyAnalysisWorkspace', () => {
  it('renders one bounded purchase page with a truthful matrix and canonical inspector actions', () => {
    const markup = renderToStaticMarkup(
      <TeamEconomyAnalysisWorkspace
        workspace={workspace()}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="team-economy-workspace"');
    expect(markup).toContain('data-testid="team-economy-matrix"');
    expect(markup.match(/data-testid="team-economy-cell"/g)).toHaveLength(4);
    expect(markup).toContain('data-page-size="50"');
    expect(markup).toContain('data-total="2"');
    expect(markup.match(/data-testid="team-economy-evidence-row"/g)).toHaveLength(2);
    expect(markup).toContain('data-testid="team-economy-inspector"');
    expect(markup).toContain('data-metric="decoded-purchase-cost"');
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp(`data-action="${action}"`, 'g'))).toHaveLength(1);
    }
    expect(markup).not.toMatch(/equipment value|economy type|win rate|真实花费/iu);
  });

  it('renders at most three item counts per cell and one distinct-type remainder', () => {
    const itemBreakdown = workspace();
    const purchases = [
      ['buy-flash-2', 1_120, 'a3', 'weapon_flashbang'],
      ['buy-flash-3', 1_130, 'a4', 'weapon_flashbang'],
      ['buy-smoke-1', 1_140, 'a3', 'weapon_smokegrenade'],
      ['buy-smoke-2', 1_150, 'a4', 'weapon_smokegrenade'],
      ['buy-he-1', 1_160, 'a5', 'weapon_hegrenade'],
      ['buy-vest-1', 1_170, 'a5', 'weapon_vest'],
    ] as const;
    for (const [id, tick, actor, item] of purchases) {
      itemBreakdown.rounds[0]?.events.push(event(id, tick, 'purchase', {
        actor,
        weapon: item,
        detail: { cost: 100, userteam: 2 },
      }));
    }

    const markup = renderToStaticMarkup(
      <TeamEconomyAnalysisWorkspace
        workspace={itemBreakdown}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup.match(/data-testid="team-economy-cell-item"/g)).toHaveLength(3);
    expect(markup).toMatch(/data-item-name="flashbang"[^>]*data-item-count="3"/);
    expect(markup).toMatch(/data-item-name="smokegrenade"[^>]*data-item-count="2"/);
    expect(markup).toMatch(/data-item-name="ak47"[^>]*data-item-count="1"/);
    expect(markup).toContain('data-testid="team-economy-cell-item-remainder"');
    expect(markup).toContain('data-item-remainder="2"');
  });

  it('never mounts more than the fixed fifty purchase atoms for one cell page', () => {
    const manyPurchases = workspace();
    for (let index = 0; index < 53; index += 1) {
      const actor = teamA[index % teamA.length];
      if (!actor) throw new Error('The Team A fixture must contain five actors.');
      manyPurchases.rounds[0]?.events.push(event(
        `buy-extra-${index}`,
        1_200 + index,
        'purchase',
        {
          actor,
          weapon: 'weapon_flashbang',
          detail: { cost: 200, userteam: 2 },
        },
      ));
    }

    const markup = renderToStaticMarkup(
      <TeamEconomyAnalysisWorkspace
        workspace={manyPurchases}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-page-size="50"');
    expect(markup).toContain('data-total="55"');
    expect(markup.match(/data-testid="team-economy-evidence-row"/g)).toHaveLength(50);
  });

  it('labels rejected purchase evidence as partial instead of unavailable', () => {
    const partialWorkspace = workspace();
    const contradictoryPurchase = partialWorkspace.rounds[0]?.events.find(
      (item) => item.id === 'buy-a1-r1',
    );
    if (contradictoryPurchase) contradictoryPurchase.detail = { cost: 2_700, userteam: 3 };

    const markup = renderToStaticMarkup(
      <TeamEconomyAnalysisWorkspace
        workspace={partialWorkspace}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain(translate(currentLocale(), 'analysis.roundContext.partial'));
    expect(markup).not.toContain(translate(currentLocale(), 'analysis.roundContext.unavailable'));
  });
});
