import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commands } from '../../shared/desktop/client';
import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import { AiReviewPanel, type ReviewConfiguration } from './AiReviewPanel';

const workspace: AnalysisWorkspace = {
  demo_id: 'demo-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 1_200,
  teams: [],
  players: [],
  rounds: [],
  highlights: [],
};

function render(configuration: ReviewConfiguration, source: 'service' | 'preview' = 'service') {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AiReviewPanel
        demoId="demo-1"
        workspace={workspace}
        selectedPlayer={null}
        source={source}
        configuration={configuration}
      />
    </MemoryRouter>,
  );
}

describe('AI review availability', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows unconfigured and configuration-error states without generating', () => {
    const reviewSpy = vi.spyOn(commands, 'reviewDemo');
    const unconfigured = render({
      status: 'ready',
      configured: false,
      provider: '',
      model: '',
    });
    const failedConfig = render({
      status: 'error',
      configured: false,
      provider: '',
      model: '',
    });

    expect(unconfigured).toContain('尚未配置可用的提供方');
    expect(unconfigured).toContain('disabled');
    expect(failedConfig).toContain('无法读取辅助模型配置');
    expect(reviewSpy).not.toHaveBeenCalled();
  });

  it('never sends explicitly marked preview analysis', () => {
    const reviewSpy = vi.spyOn(commands, 'reviewDemo');
    const markup = render({
      status: 'ready',
      configured: true,
      provider: 'local',
      model: 'review-model',
    }, 'preview');

    expect(markup).toContain('预览数据不会发送到模型服务');
    expect(markup).toContain('disabled');
    expect(reviewSpy).not.toHaveBeenCalled();
  });
});
