import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AnalysisLifecycleNotice, analysisCancelledActivityHref } from './AnalysisLifecycleNotice';

describe('analysis lifecycle notice', () => {
  it('keeps cancellation distinct and links to its exact durable run in Activity', () => {
    expect(analysisCancelledActivityHref('run/1'))
      .toBe('/activity?activity=analysis%3Arun%2F1');
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AnalysisLifecycleNotice
          state="cancelled"
          lifecycle="discovered"
          message="Analysis run was cancelled."
          runId="run/1"
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('分析已取消');
    expect(markup).toContain('/activity?activity=analysis%3Arun%2F1');
    expect(markup).toContain('data-analysis-outcome="cancelled"');
    expect(markup).not.toContain('tone--danger');
  });

  it('uses run-observation copy instead of presenting an old Demo lifecycle as current', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AnalysisLifecycleNotice
          state="observing"
          lifecycle="discovered"
          message={null}
          runId="run-1"
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('正在载入比赛数据。');
    expect(markup).not.toContain('文件已入库，尚未提取比赛数据。');
  });
});
