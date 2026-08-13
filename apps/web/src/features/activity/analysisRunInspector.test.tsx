import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AnalysisRunDetail } from '../../shared/desktop/dto';
import { AnalysisRunInspector } from './AnalysisRunInspector';

const detail: AnalysisRunDetail = {
  run: {
    id: 'run-1', demo_id: 'demo-1', input_sha256: 'a'.repeat(64), input_size: 42,
    status: 'interrupted', stage: 'interrupted', error: 'desktop restarted',
    created_at: '2026-08-13T01:00:00Z', updated_at: '2026-08-13T01:01:00Z',
  },
  events: [{
    run_id: 'run-1', sequence: 0, stage: 'validating_input',
    message_code: 'input_validation_started', detail: null,
    created_at: '2026-08-13T01:00:00Z',
  }, {
    run_id: 'run-1', sequence: 1, stage: 'interrupted',
    message_code: 'interrupted', detail: 'desktop restarted',
    created_at: '2026-08-13T01:01:00Z',
  }],
  result_available: false,
};

describe('analysis run inspector', () => {
  it('renders persisted identity, stage, bounded events, and error without a percentage', () => {
    const markup = renderToStaticMarkup(<AnalysisRunInspector detail={detail} loading={false} error={null} />);
    expect(markup).toContain('data-analysis-run-id="run-1"');
    expect(markup).toContain('a'.repeat(64));
    expect(markup).toContain('desktop restarted');
    expect(markup).toContain('data-event-sequence="1"');
    expect(markup).not.toContain('<progress');
    expect(markup).not.toContain('%');
  });

  it('keeps detail fetch failure explicit instead of fabricating events from the feed item', () => {
    const markup = renderToStaticMarkup(
      <AnalysisRunInspector detail={null} loading={false} error="detail unavailable" />,
    );
    expect(markup).toContain('detail unavailable');
    expect(markup).not.toContain('data-event-sequence');
  });
});
