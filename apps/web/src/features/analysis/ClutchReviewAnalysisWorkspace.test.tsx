import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, Highlight, PlayerAnalysis } from '../../shared/desktop/dto';
import { ClutchReviewAnalysisWorkspace } from './ClutchReviewAnalysisWorkspace';

const player = (id: string, name: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id,
  name,
  team,
  kills: 0,
  deaths: 0,
  assists: 0,
  headshot_rate: 0,
  kill_death_ratio: 0,
  adr: 0,
});

function workspace(): AnalysisWorkspace {
  const highlights: Highlight[] = [{
    id: '16:76561198074762801:144102-clutch',
    label: '1v2 clutch',
    category: 'clutch',
    kind: 'clutch',
    description: 'Won a 1v2 situation with 2 elimination(s)',
    tags: ['1v2', 'clutch'],
    victims: ['molodoy', 'yuurih'],
    player_id: 'm0nesy',
    round: 16,
    start_tick: 143_974,
    end_tick: 144_911,
    confidence: 0.83,
  }, {
    id: 'ordinary-failure',
    label: 'Full-match death reel',
    category: 'entry',
    kind: 'fail',
    description: 'An ordinary death collection item',
    tags: ['timeline', 'death_reel'],
    victims: [],
    player_id: 'm0nesy',
    round: 16,
    start_tick: 140_000,
    end_tick: 140_256,
    confidence: 0.5,
  }];
  return {
    demo_id: 'major-m2',
    map_name: 'de_anubis',
    tick_rate: 64,
    duration_seconds: 3_000,
    teams: [],
    players: [
      player('m0nesy', 'm0NESY', 'A'),
      player('molodoy', 'molodoy', 'B'),
      player('yuurih', 'yuurih', 'B'),
    ],
    rounds: [{
      number: 16,
      winner: 'A',
      reason: 'elimination',
      start_tick: 136_040,
      end_tick: 144_815,
      team_a_score: 9,
      team_b_score: 7,
      events: [],
    }],
    highlights,
  };
}

describe('ClutchReviewAnalysisWorkspace component', () => {
  it('renders the canonical clutch opportunity, filters, inspector, and one action set', () => {
    expect(ClutchReviewAnalysisWorkspace).toBeTypeOf('function');
    const markup = renderToStaticMarkup(
      <ClutchReviewAnalysisWorkspace
        workspace={workspace()}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toContain('data-testid="clutch-review-workspace"');
    expect(markup).toContain('data-testid="clutch-review-summary"');
    expect(markup).toContain('data-testid="clutch-review-filter-outcome"');
    expect(markup).toContain('data-testid="clutch-review-filter-opponents"');
    expect(markup).toContain('data-testid="clutch-review-filter-player"');
    expect(markup.match(/data-testid="clutch-review-evidence-row"/g)).toHaveLength(1);
    expect(markup).toContain('data-evidence-id="demo:major-m2/highlight:16:76561198074762801:144102-clutch"');
    expect(markup).not.toContain('ordinary-failure');
    expect(markup).toContain('data-testid="clutch-review-inspector"');
    for (const action of ['round', 'replay', 'watch', 'add']) {
      expect(markup.match(new RegExp('data-action="' + action + '"', 'g'))).toHaveLength(1);
    }
  });

  it('disables Add when the canonical evidence ID was just queued', () => {
    const canonicalId = 'demo:major-m2/highlight:16:76561198074762801:144102-clutch';
    const markup = renderToStaticMarkup(
      <ClutchReviewAnalysisWorkspace
        workspace={workspace()}
        serviceAvailable
        runtimeIdle
        watchPending={false}
        addedEvidenceIds={new Set([canonicalId])}
        onNavigate={() => undefined}
        onWatch={() => undefined}
        onAddProduction={() => undefined}
      />,
    );

    expect(markup).toMatch(/data-action="add"[^>]*disabled/);
    expect(markup).toContain('This clutch evidence is already in the production plan.');
  });
});
