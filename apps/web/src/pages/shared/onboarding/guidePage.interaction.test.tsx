/*
 * Interaction tests for 使用引导 and the workbench's 首次使用三步提示条.
 *
 * The two are one feature split across two surfaces (「02 补齐」 asked for the
 * strip; §10 kept the page for the environment self-check), so they are tested
 * together — and the first thing asserted is that they describe the same three
 * steps, because the failure mode of a split feature is that the halves drift.
 */

import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderPage } from '../../../test/renderPage';
import { GuidePage } from './GuidePage';
import { FIRST_RUN_STEPS } from './firstRunSteps';
import { FirstRunStrip } from './FirstRunStrip';

/* `listDemos` answers a `Paginated<DemoSummary>`; only `items.length` is read
   here, so the rows are the minimum shape rather than full fixtures. */
const EMPTY_LIBRARY = { items: [], total: 0, page: 1, page_size: 1 };

const ONE_DEMO = {
  items: [{ id: 'demo-1', display_name: 'Aurora vs Meridian' }],
  total: 1,
  page: 1,
  page_size: 1,
};

const READY_DEMO = {
  items: [{ id: 'demo-1', display_name: 'Aurora vs Meridian', lifecycle_status: 'ready' }],
  total: 1,
  page: 1,
  page_size: 1,
};

const CHECKS = {
  checks: [
    { kind: 'game', state: 'ready', label: 'CS2', detail: '版本 1.40.9.6' },
    { kind: 'hlae', state: 'missing', label: '受管 HLAE', detail: '未探测到可执行文件' },
  ],
  checked_at: '2026-08-16T08:02:00.000Z',
};

function render(element: React.ReactElement, overrides: Record<string, unknown> = {}) {
  renderPage({
    element,
    client: {
      listDemos: () => Promise.resolve(EMPTY_LIBRARY),
      listProjects: () => Promise.resolve([]),
      quickCheck: () => Promise.resolve(CHECKS),
      ...overrides,
    },
  });
}

describe('the guide pipeline and the first-run entry', () => {
  it('keeps the full three-step definition in the guide and one import action on home', async () => {
    expect(FIRST_RUN_STEPS).toHaveLength(3);

    render(<FirstRunStrip />);
    await waitFor(() => {
      expect(document.querySelector('[data-home-block="first-run"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-first-run-step]')).toBeNull();
    expect(screen.getAllByRole('link', { name: '导入 Demo' })).toHaveLength(1);
  });

  it('are the pipeline, not a tour of the navigation', () => {
    expect(FIRST_RUN_STEPS.map((step) => step.id)).toEqual(['import', 'analyse', 'create']);
    expect(FIRST_RUN_STEPS.map((step) => step.to)).toEqual(['/library', '/library', '/projects/new?step=shotlist']);
  });
});

describe('the first-run strip', () => {
  it('shows while the library is empty', async () => {
    render(<FirstRunStrip />);
    await waitFor(() => {
      expect(document.querySelector('[data-home-block="first-run"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain('素材为空');
    expect(screen.getAllByRole('link', { name: '导入 Demo' })).toHaveLength(1);
  });

  it('disappears as soon as there is one Demo', async () => {
    // The condition is the data, not a stored flag: a flag stays dismissed
    // after the user clears their library and genuinely is starting over.
    render(<FirstRunStrip />, { listDemos: () => Promise.resolve(ONE_DEMO) });
    await waitFor(() => {
      expect(document.querySelector('[data-home-block="first-run"]')).toBeNull();
    });
  });

  it('shows nothing while the read is in flight', () => {
    // Appearing and then vanishing moves everything below it twice.
    render(<FirstRunStrip />, { listDemos: () => new Promise(() => {}) });
    expect(document.querySelector('[data-home-block="first-run"]')).toBeNull();
  });

  it('shows nothing when the library would not load', async () => {
    // An error is not first use — telling a returning user they have nothing
    // would be a guess.
    render(<FirstRunStrip />, { listDemos: () => Promise.reject(new Error('nope')) });
    await waitFor(() => {
      expect(document.querySelector('[data-home-block="first-run"]')).toBeNull();
    });
  });
});

describe('使用引导', () => {
  it('reports an empty dependency check instead of implying the machine is ready', async () => {
    render(<GuidePage />, { quickCheck: () => Promise.resolve({ checks: [], checked_at: CHECKS.checked_at }) });
    expect(await screen.findByText(/没有收到环境检查结果/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeTruthy();
  });

  it('presents the pipeline beside readiness and, on an empty machine, points at the first step', async () => {
    render(<GuidePage />);
    await screen.findByText('这台机器现在能做什么');

    await waitFor(() => {
      expect(document.querySelector('[data-guide-current="true"]')?.getAttribute('data-guide-step')).toBe('import');
    });
    expect(document.querySelectorAll('[data-guide-step]')).toHaveLength(3);
    expect(document.querySelector('[data-guide-done]')).toBeNull();
  });

  it('marks the steps the data says are taken and points at the next one', async () => {
    // The accent face is the shell's 「you are here」; on a library with an
    // analysed match it belongs on 「让 Agent 做一条视频」, not on 「导入 Demo」.
    render(<GuidePage />, {
      listDemos: (query: { status?: string }) => Promise.resolve(query.status === 'ready' ? READY_DEMO : ONE_DEMO),
    });

    await waitFor(() => {
      expect(document.querySelector('[data-guide-current="true"]')?.getAttribute('data-guide-step')).toBe('create');
    });
    expect(document.querySelector('[data-guide-step="import"]')?.getAttribute('data-guide-done')).toBe('true');
    expect(document.querySelector('[data-guide-step="analyse"]')?.getAttribute('data-guide-done')).toBe('true');
    expect(document.querySelector('[data-guide-step="create"]')?.getAttribute('data-guide-done')).toBeNull();
    expect(screen.getAllByText('已完成')).toHaveLength(2);
  });

  it('points at nothing once all three steps are taken', async () => {
    render(<GuidePage />, {
      listDemos: () => Promise.resolve(READY_DEMO),
      listProjects: () => Promise.resolve([{ id: 'p-1' }]),
    });

    await waitFor(() => {
      expect(document.querySelectorAll('[data-guide-done="true"]')).toHaveLength(3);
    });
    expect(document.querySelector('[data-guide-current="true"]')).toBeNull();
  });

  it('keeps each step one target with the step name as its accessible name', async () => {
    render(<GuidePage />);
    await screen.findByText('这台机器现在能做什么');

    const link = screen.getByRole('link', { name: '让 Agent 做一条视频' });
    expect(link.getAttribute('href')).toBe('/projects/new?step=shotlist');
    // The anchor is stretched over its card, so the number and the sentence
    // beside the title are not a dead zone inside something drawn as a button.
    expect(link.className).toContain('after:absolute');
    expect(link.closest('[data-guide-step]')?.className).toContain('relative');
  });

  it('says what each dependency is for', async () => {
    render(<GuidePage />);
    await waitFor(() => {
      expect(document.querySelector('[data-guide-check="game"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain('回放与录制都用它');
  });

  it('says what still works when one is missing', async () => {
    // The question a first-time user has: what can I do *today*.
    render(<GuidePage />);
    await waitFor(() => {
      expect(document.querySelector('[data-guide-check="hlae"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain('导入、分析和剪辑都不受影响');
    // Implementation diagnostics do not appear in onboarding.
    expect(document.body.textContent).not.toContain('未探测到可执行文件');
    expect(document.body.textContent).toContain('录制组件');
  });

  it('points at the diagnostics section for the raw states', async () => {
    render(<GuidePage />);
    await screen.findByText('这台机器现在能做什么');
    expect(document.querySelector('a[href="/settings?section=advanced&item=dependencies"]')).not.toBeNull();
  });

});
