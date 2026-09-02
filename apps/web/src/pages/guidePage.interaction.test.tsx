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

import { renderPage } from './delivery/test/renderPage';
import { GuidePage } from './GuidePage';
import { FIRST_RUN_STEPS } from './home/firstRunSteps';
import { FirstRunStrip } from './home/FirstRunStrip';

/* `listDemos` answers a `Paginated<DemoSummary>`; only `items.length` is read
   here, so the rows are the minimum shape rather than full fixtures. */
const EMPTY_LIBRARY = { items: [], total: 0, page: 1, page_size: 1 };

const ONE_DEMO = {
  items: [{ id: 'demo-1', display_name: 'Aurora vs Meridian' }],
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
  it('presents the pipeline beside readiness and focuses the first real action', async () => {
    render(<GuidePage />);
    await screen.findByText('这台机器现在能做什么');

    expect(document.querySelector('[data-guide-current="true"]')?.getAttribute('data-guide-step')).toBe('import');
    expect(document.querySelectorAll('[data-guide-step]')).toHaveLength(3);
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
    // The service's own words are kept beside the consequence.
    expect(document.body.textContent).toContain('未探测到可执行文件');
  });

  it('points at the diagnostics section for the raw states', async () => {
    render(<GuidePage />);
    await screen.findByText('这台机器现在能做什么');
    expect(document.querySelector('a[href="/settings?section=advanced&item=dependencies"]')).not.toBeNull();
  });

});
