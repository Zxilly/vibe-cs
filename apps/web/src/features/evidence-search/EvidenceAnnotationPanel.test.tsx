import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { EvidenceSearchItem } from '../../shared/desktop/dto';
import { EvidenceAnnotationPanel } from './EvidenceAnnotationPanel';

const item: EvidenceSearchItem = {
  evidence_id: 'demo:demo-1/event:kill-7',
  demo_id: 'demo-1',
  demo_display_name: 'Major M1',
  map_name: 'de_mirage',
  match_date: null,
  round: 7,
  tick: 42_000,
  end_tick: 42_000,
  event_type: 'kill',
  actor_id: 'fallen',
  actor_name: 'FalleN',
  target_id: 'target',
  target_name: 'Target',
  weapon: 'awp',
  headshot: false,
  penetrated: false,
  source_kind: 'event',
  source_id: 'kill-7',
  attributes: {},
  analysis_href: '/analysis?demo=demo-1',
  replay_href: '/analysis?demo=demo-1&tab=replay',
};

describe('evidence annotation panel', () => {
  it('anchors a review note composer to the exact evidence locator', () => {
    const markup = renderToStaticMarkup(
      <EvidenceAnnotationPanel item={item} onClose={() => undefined} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('data-testid="evidence-annotation-panel"');
    expect(markup).toContain('data-evidence-id="demo:demo-1/event:kill-7"');
    expect(markup).toContain('R7 · tick 42,000');
    expect(markup).toContain('name="annotation-body"');
    expect(markup).toContain('name="annotation-tags"');
  });
});
