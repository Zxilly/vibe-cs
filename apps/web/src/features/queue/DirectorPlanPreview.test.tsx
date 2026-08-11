import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DirectorPlanPreview } from './DirectorPlanPreview';

describe('DirectorPlanPreview', () => {
  it('renders evidence, merge counts and honest victim warnings', () => {
    const markup = renderToStaticMarkup(<DirectorPlanPreview plan={{
      source_item_count: 2,
      merged_item_count: 1,
      victim_reaction_count: 1,
      unresolved_victim_requests: 1,
      warnings: ['没有稳定受害者身份的镜头不会生成'],
      shots: [{
        demo_id: 'demo',
        source_item_ids: ['a', 'b'],
        player_id: '76561198000000000',
        kind: 'player',
        start_tick: 100,
        end_tick: 300,
        score: 0.92,
        evidence: ['highlight h1', 'headshot'],
        explanation: '相邻镜头已合并',
      }],
    }} />);
    expect(markup).toContain('证据导演镜头单');
    expect(markup).toContain('1 次合并');
    expect(markup).toContain('没有稳定受害者身份');
    expect(markup).toContain('证据 0.92');
    expect(markup).toContain('highlight h1');
  });
});
