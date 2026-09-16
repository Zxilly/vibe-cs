/*
 * `interaction` project — `AnalysisFailure`, the way out of an analysis that
 * will not open.
 *
 * The case this guards: a stored result the running version cannot read. The
 * record says 「已就绪」, the read fails the same way on every 「重试」, and the
 * only fix is a new run. The state has to name that action, and once the run
 * is on it has to notice 「已就绪」 by itself and re-read.
 */

import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDemo, useStartDemoAnalysis } from '../../../../data/demos';
import { DEMO_ID } from '../../../../test/fixtures/matchAnalysis';
import { AnalysisFailure } from './viewChrome';
import { mutationResult, queryResult, renderView } from './test/renderView';

vi.mock('../../../../data/demos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../data/demos')>();
  return { ...actual, useDemo: vi.fn(), useStartDemoAnalysis: vi.fn() };
});

const READ_ERROR = { status: 500, code: 'storage_error', message: 'The local database operation failed' };

function demo(lifecycle: 'ready' | 'analyzing') {
  return queryResult({ id: DEMO_ID, lifecycle_status: lifecycle });
}

beforeEach(() => {
  vi.mocked(useDemo).mockReturnValue(demo('ready') as never);
  vi.mocked(useStartDemoAnalysis).mockReturnValue(mutationResult({ isSuccess: false }) as never);
});

describe('AnalysisFailure', () => {
  it('says which step failed in its own words, and keeps the service line as a diagnostic', () => {
    renderView(<AnalysisFailure view="rounds" title="回合" demoId={DEMO_ID} error={READ_ERROR} onRetry={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '这场比赛的分析结果没能打开' })).toBeTruthy();
    expect(document.body.textContent).toContain('Demo 文件和资料库记录没有改动');
    expect(document.body.textContent).toContain('The local database operation failed');
    expect(screen.getByRole('link', { name: '回到资料库' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '设置与诊断' })).toBeTruthy();
    expect(document.querySelector('[data-match-panel="analysis-failure"]')).not.toBeNull();
  });

  it('starts a new run for this demo, and retries in place', () => {
    const mutate = vi.fn();
    const onRetry = vi.fn();
    vi.mocked(useStartDemoAnalysis).mockReturnValue(mutationResult({ mutate }) as never);
    renderView(<AnalysisFailure view="rounds" title="回合" demoId={DEMO_ID} error={READ_ERROR} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    expect(mutate).toHaveBeenCalledWith([DEMO_ID]);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('holds 重新分析 with its reason while the run is on, then re-reads at 已就绪', () => {
    const onRetry = vi.fn();
    vi.mocked(useStartDemoAnalysis).mockReturnValue(mutationResult({ isSuccess: true }) as never);
    vi.mocked(useDemo).mockReturnValue(demo('analyzing') as never);
    const view = renderView(
      <AnalysisFailure view="rounds" title="回合" demoId={DEMO_ID} error={READ_ERROR} onRetry={onRetry} />,
    );

    const again = screen.getByRole('button', { name: '重新分析' }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    expect(document.body.textContent).toContain('正在重新分析，完成后这里会自动刷新');
    expect(screen.getByRole('link', { name: '查看分析进度' }).getAttribute('href')).toBe('/tasks');
    expect(onRetry).not.toHaveBeenCalled();
    // The record is polled only while a run started here is on.
    expect(vi.mocked(useDemo)).toHaveBeenLastCalledWith(DEMO_ID, { pollMs: 2_000 });

    vi.mocked(useDemo).mockReturnValue(demo('ready') as never);
    view.rerender(
      <MemoryRouter>
        <AnalysisFailure view="rounds" title="回合" demoId={DEMO_ID} error={READ_ERROR} onRetry={onRetry} />
      </MemoryRouter>,
    );
    expect(onRetry).toHaveBeenCalledTimes(1);

    // A re-render at the same state is not a second arrival.
    view.rerender(
      <MemoryRouter>
        <AnalysisFailure view="rounds" title="回合" demoId={DEMO_ID} error={READ_ERROR} onRetry={onRetry} />
      </MemoryRouter>,
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
