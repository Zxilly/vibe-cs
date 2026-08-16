import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, Highlight } from '../../shared/desktop/viewModels';
import {
  HighlightAnnotationReviewButton,
  type HighlightAnnotationReviewButtonProps,
} from './HighlightAnnotationReviewButton';

const highlight: Highlight = {
  id: 'fallen-r12-4k',
  label: 'FalleN 4K',
  category: 'multi-kill',
  kind: 'multi_kill',
  description: 'Four exact eliminations',
  tags: ['4k'],
  victims: ['victim-a'],
  player_id: 'fallen-id',
  round: 12,
  start_tick: 12_000,
  end_tick: 12_640,
  confidence: 0.95,
};

const workspace: AnalysisWorkspace = {
  demo_id: '00000000-0000-4000-8000-000000000001',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [{ id: 'fallen-id', name: 'FalleN', team: 'A', kills: 4, deaths: 0, assists: 0, headshot_rate: 0.25, kill_death_ratio: 4, adr: 100 }],
  rounds: [{ number: 12, winner: 'A', reason: 'elimination', start_tick: 11_000, end_tick: 13_000, team_a_score: 7, team_b_score: 5, events: [] }],
  highlights: [highlight],
};

function render(overrides: Partial<HighlightAnnotationReviewButtonProps> = {}) {
  return renderToStaticMarkup(
    <HighlightAnnotationReviewButton
      workspace={workspace}
      highlight={highlight}
      onOpen={() => undefined}
      {...overrides}
    />,
  );
}

describe('highlight annotation review button', () => {
  it('makes persisted review state discoverable on the highlight card', () => {
    const markup = render({ summary: { total: 3, open: 2, resolved: 1 } });

    expect(markup).toContain('data-action="review-annotations"');
    expect(markup).toContain('data-review-state="open"');
    expect(markup).toContain('2 待复盘');
    expect(markup).toContain('3 复盘注释');
  });

  it('fails closed when the card no longer matches current canonical highlight facts', () => {
    const markup = render({ highlight: { ...highlight, start_tick: highlight.start_tick + 1 } });

    expect(markup).toMatch(/data-action="review-annotations"[^>]*disabled=""/);
    expect(markup).toMatch(/data-action="review-annotations"[^>]*title="[^"]+"/);
  });

  it('keeps the exact review drawer action usable while its summary is loading', () => {
    const markup = render({ loading: true });

    expect(markup).toContain('正在读取持久注释…');
    expect(markup).not.toContain('0 复盘注释');
    expect(markup).not.toMatch(/data-action="review-annotations"[^>]*disabled=""/);
  });

  it('does not claim zero annotations when persisted summary loading failed', () => {
    const markup = render({ unavailable: true });

    expect(markup).toContain('data-review-state="unavailable"');
    expect(markup).toContain('持久注释状态不可用');
    expect(markup).not.toContain('保存注释');
    expect(markup).not.toContain('0 复盘注释');
    expect(markup).not.toMatch(/data-action="review-annotations"[^>]*disabled=""/);
  });
});
