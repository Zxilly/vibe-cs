import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, Highlight } from '../../shared/desktop/viewModels';
import { HighlightAnnotationReviewControl } from './HighlightAnnotationReviewControl';

const highlight: Highlight = {
  id: 'fallen-r12-4k', label: 'FalleN 4K', category: 'multi-kill', kind: 'multi_kill',
  description: 'Four exact eliminations', tags: ['4k'], victims: ['victim-a'],
  player_id: 'fallen-id', round: 12, start_tick: 12_000, end_tick: 12_640, confidence: 0.95,
};
const workspace: AnalysisWorkspace = {
  demo_id: '00000000-0000-4000-8000-000000000001', map_name: 'de_mirage', tick_rate: 64, duration_seconds: 2_958,
  teams: [],
  players: [{ id: 'fallen-id', name: 'FalleN', team: 'A', kills: 4, deaths: 0, assists: 0, headshot_rate: 0.25, kill_death_ratio: 4, adr: 100 }],
  rounds: [{ number: 12, winner: 'A', reason: 'elimination', start_tick: 11_000, end_tick: 13_000, team_a_score: 7, team_b_score: 5, events: [] }],
  highlights: [highlight],
};

describe('highlight annotation review control', () => {
  it('owns one canonical review drawer while keeping its locator immutable', () => {
    const markup = renderToStaticMarkup(
      <HighlightAnnotationReviewControl
        workspace={workspace}
        highlight={highlight}
        open
        summary={{ total: 1, open: 1, resolved: 0 }}
        onOpen={() => undefined}
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(markup).toContain('data-action="review-annotations"');
    expect(markup).toContain('data-testid="evidence-annotation-panel"');
    expect(markup).toContain('data-evidence-id="demo:00000000-0000-4000-8000-000000000001/highlight:fallen-r12-4k"');
    expect(markup).not.toContain('name="demo_id"');
    expect(markup).not.toContain('name="evidence_id"');
    expect(markup).not.toContain('name="round"');
    expect(markup).not.toContain('name="tick"');
  });
});
