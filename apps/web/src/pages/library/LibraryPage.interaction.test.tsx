/*
 * `interaction` project — 「02 Demo 资料库」, driven.
 *
 * What can only be shown by acting on the page: the two views actually switch,
 * a selection actually caps at 12, the Inspector actually folds at the §8
 * breakpoint, a blocked action actually refuses to fire, and a row action
 * actually reaches the bridge.
 *
 * No real IPC. The bridge is a stub injected through `DesktopClientProvider`,
 * and the reads arrive pre-seeded in the cache so a test asserts on the write
 * it triggered rather than on a fetch waterfall.
 *
 * `fireEvent` rather than `user-event`, matching every other interaction test
 * in the workspace (`user-event` is not a dependency). The one place it
 * matters — 「a disabled action must not fire」 — uses the element's own
 * `.click()`, which the HTML spec makes a no-op on a disabled control, so the
 * assertion is about the button and not about the test helper.
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { COLLAPSE_BREAKPOINT_PX } from '../../design/layout';
import { stubMatchMedia, type MatchMediaStub } from '../../design/layout/collapse.testing';
import type { AnalysisRun } from '../../shared/desktop/dto';
import {
  CONFIG_FIXTURE,
  DEMO_FIXTURE,
  TAG_FIXTURE,
  WATCH_FIXTURE,
  demoPage,
  makeDemo,
  recorder,
  renderLibrary,
} from './test/renderLibrary';
import { reasonOf } from '../../test/reason';
import { resetProjectCollectionsForTesting } from '../../data/projectCollections';

const ONLINE = {
  demos: demoPage([DEMO_FIXTURE]),
  watch: WATCH_FIXTURE,
  tags: [TAG_FIXTURE],
  config: CONFIG_FIXTURE,
  serviceOnline: true,
} as const;

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
  resetProjectCollectionsForTesting();
});

describe('library acquisition and layout views', () => {
  it('switches to the card grid, and the table goes away', async () => {
    renderLibrary({ seed: ONLINE });

    expect(document.querySelector('[data-library-table]')).not.toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: '卡片' }));

    await waitFor(() => {
      expect(document.querySelector('[data-library-cards]')).not.toBeNull();
    });
    expect(document.querySelector('[data-library-table]')).toBeNull();
  });

  it('treats Steam as an acquisition entry, not a peer view tab', () => {
    renderLibrary({ seed: ONLINE });

    expect(screen.queryByRole('radiogroup', { name: '素材视图' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Steam 下载' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '视图' })).toBeTruthy();
  });

  it('opens Steam downloads inside the same library route', async () => {
    renderLibrary({
      at: '/library?view=steam',
      seed: ONLINE,
      client: {
        listMatchHistory: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 50 }),
        listActiveMatchDownloadJobs: () => Promise.resolve([]),
      },
    });

    expect(await screen.findByText('比赛历史')).toBeTruthy();
    expect(document.querySelector('[data-steam-library]')).not.toBeNull();
    expect(screen.queryByRole('radiogroup', { name: '素材视图' })).toBeNull();
    expect(screen.getByRole('link', { name: /Demo 资料库/u })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Steam 下载' })).toBeTruthy();
  });
});

describe('new project from a material row', () => {
  it('creates a plan directly from the match and opens the Agent composer', async () => {
    const created: unknown[] = [];
    renderLibrary({
      seed: ONLINE,
      client: {
        createAgentPlan: (draft) => {
          created.push(draft);
          return Promise.resolve({
            id: 'from-demo', title: draft.title, status: draft.status, revision: 1,
            shots: draft.shots, origin: [],
            agent_baseline: { revision: 1, captured_at: '2026-08-20T00:00:00Z', shots: draft.shots },
            created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T00:00:00Z',
          });
        },
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '用 Agent 制作' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ title: 'Aurora vs Meridian', shots: [] });
    await waitFor(() => expect(document.querySelector('[data-project-workspace]')).not.toBeNull());
  });
});

describe('the selection', () => {
  it('replaces the pager with the artboard’s accent strip', () => {
    renderLibrary({ seed: ONLINE });

    expect(screen.getByRole('navigation', { name: '分页' })).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Aurora vs Meridian' }));

    const bar = document.querySelector('[data-selection-bar]');
    expect(bar).not.toBeNull();
    expect(bar?.textContent).toContain('已选 1 场 · 上限 12 场');
    expect(bar?.textContent).toContain('分析选中的 1 场');
    expect(screen.queryByRole('navigation', { name: '分页' })).toBeNull();
  });

  it('caps at 12 and disables the thirteenth box rather than hiding it (§8)', () => {
    renderLibrary({
      seed: {
        ...ONLINE,
        demos: demoPage(Array.from({ length: 13 }, (_, index) => makeDemo(index))),
      },
    });

    const boxes = screen
      .getAllByRole('checkbox')
      .filter((box) => box.getAttribute('aria-label')?.startsWith('选择') === true);
    expect(boxes).toHaveLength(13);

    for (const box of boxes.slice(0, 12)) {
      fireEvent.click(box);
    }

    const last = boxes[12] as HTMLInputElement | undefined;
    expect(last?.disabled).toBe(true);
    expect(last?.isConnected).toBe(true);
  });

  it('starts an analysis for exactly the rows that are checked', async () => {
    // A whole `AnalysisRun`, not `{id}`: the stub is typed against the real
    // command signature, so an incomplete answer here would be a lie the test
    // could not catch at the call site.
    const start = recorder<AnalysisRun>({
      id: 'run-1',
      demo_id: 'demo-0',
      input_sha256: null,
      input_size: null,
      status: 'running',
      stage: 'parser_running',
      error: null,
      error_code: null,
      created_at: '2026-08-15T09:00:00Z',
      updated_at: '2026-08-15T09:00:00Z',
    });
    renderLibrary({
      seed: { ...ONLINE, demos: demoPage([makeDemo(0), makeDemo(1)]) },
      client: { startAnalysisRun: start.call, listDemos: () => Promise.resolve(demoPage([])) },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Aurora vs Meridian · 第 1 场' }));
    fireEvent.click(screen.getByRole('button', { name: /分析选中的 1 场/u }));

    await waitFor(() => {
      expect(start.calls()).toBe(1);
    });
    expect(start.lastArgs()[0]).toBe('demo-0');
  });

  it('creates one Agent project containing every selected Demo', async () => {
    const created: unknown[] = [];
    renderLibrary({
      seed: { ...ONLINE, demos: demoPage([makeDemo(0), makeDemo(1)]) },
      client: {
        createAgentPlan: (draft) => {
          created.push(draft);
          return Promise.resolve({
            id: 'series-plan', title: draft.title, status: draft.status, revision: 1,
            shots: draft.shots, origin: [],
            agent_baseline: { revision: 1, captured_at: '2026-08-23T00:00:00Z', shots: [] },
            created_at: '2026-08-23T00:00:00Z', updated_at: '2026-08-23T00:00:00Z',
          });
        },
      },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Aurora vs Meridian · 第 1 场' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Aurora vs Meridian · 第 2 场' }));
    fireEvent.click(screen.getByRole('button', { name: '用 Agent 创作' }));

    await waitFor(() => expect(created).toHaveLength(1));
    const stored = JSON.parse(globalThis.localStorage.getItem('vibe-cs.project-collections.v1') ?? '{}') as Record<string, Array<{ demoId: string }>>;
    expect(stored['plan:series-plan']?.map((entry) => entry.demoId)).toEqual(['demo-0', 'demo-1']);
    await waitFor(() => expect(document.querySelector('[data-project-workspace]')).not.toBeNull());
  });
});

describe('the Inspector', () => {
  it('follows the active row', async () => {
    renderLibrary({ seed: { ...ONLINE, detail: DEMO_FIXTURE } });

    await waitFor(() => {
      expect(document.querySelector('[data-inspector="docked"]')?.textContent).toContain(
        'aurora-meridian-mirage.dem',
      );
    });
    expect(document.querySelector('[data-inspector="docked"]')?.textContent).not.toContain(
      '在左侧选一场比赛',
    );
  });

  it('folds into the summary strip below the §8 breakpoint, keeping its main action', async () => {
    media = stubMatchMedia(COLLAPSE_BREAKPOINT_PX + 200);
    renderLibrary({ seed: { ...ONLINE, detail: DEMO_FIXTURE } });

    fireEvent.click(screen.getAllByText('Aurora vs Meridian')[0]!);
    expect(document.querySelector('[data-inspector="docked"]')).not.toBeNull();

    // 1100 × 700 — §8 rule 2: 「右侧 Inspector 不再常驻，收成底部选中摘要 + 抽屉」.
    act(() => {
      media?.setWidth(COLLAPSE_BREAKPOINT_PX);
    });

    await waitFor(() => {
      expect(document.querySelector('[data-inspector="summary"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-inspector="docked"]')).toBeNull();

    const strip = document.querySelector('[data-inspector="summary"]');
    // 46px — `--h-bar`, the token §3.4 merges the artboard's 44 into.
    expect(strip?.className).toContain('h-[var(--h-bar)]');
    expect(strip?.textContent).toContain('选中 Aurora vs Meridian');
    // The main action stays on the strip — 主动作不进溢出菜单, at any width.
    expect(document.querySelector('[data-inspector-summary-actions]')?.textContent).toContain(
      '打开比赛工作区',
    );

    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    await waitFor(() => {
      expect(document.querySelector('[data-inspector="drawer"]')).not.toBeNull();
    });
  });
});

describe('需要服务', () => {
  it('refuses to import while the gate has not answered, and says why', () => {
    const importer = recorder({ discovered: 0, imported: 0, updated: 0, skipped: 0, errors: [] });
    renderLibrary({
      seed: { ...ONLINE, serviceOnline: false },
      client: { importDemos: importer.call },
    });

    const button = screen.getByRole('button', { name: /导入 Demo/u }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(reasonOf(button)).toContain('本地服务');

    button.click();

    // 不静默失败 also means 不偷偷执行: the dialog never opens, nothing is sent.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(importer.calls()).toBe(0);
  });

  it('keeps the read-only page fully usable while blocked', () => {
    renderLibrary({ seed: { ...ONLINE, serviceOnline: false } });

    expect(screen.getAllByText('Aurora vs Meridian')).not.toHaveLength(0);
    expect(screen.getByRole('navigation', { name: '分页' })).toBeTruthy();
  });
});

describe('sorting and paging', () => {
  it('sorts through the address, so the order is shareable', async () => {
    const list = recorder(demoPage([DEMO_FIXTURE]));
    renderLibrary({ seed: ONLINE, client: { listDemos: list.call } });

    // Scoped to the table: the filter strip has a 「地图」 disclosure too, and
    // the two are different affordances that happen to share a word.
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: '地图' }));

    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(0);
    });
    expect(list.lastArgs()[0]).toMatchObject({ sort: 'map_asc' });
  });

  it('walks to the next page and asks the bridge for it', async () => {
    const list = recorder(demoPage([DEMO_FIXTURE], 248, 2));
    renderLibrary({
      seed: {
        ...ONLINE,
        demos: demoPage(Array.from({ length: 20 }, (_, index) => makeDemo(index)), 248),
      },
      client: { listDemos: list.call },
    });

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(0);
    });
    expect(list.lastArgs()[0]).toMatchObject({ page: 2, page_size: 20 });
  });
});

describe('the filter strip', () => {
  it('narrows by tag through the address and resets to page 1', async () => {
    const list = recorder(demoPage([]));
    renderLibrary({ at: '/library?page=4', seed: ONLINE, client: { listDemos: list.call } });

    // Radix opens a dropdown on the press, not on the click.
    fireEvent.pointerDown(screen.getByRole('button', { name: '标签' }), { button: 0, ctrlKey: false });
    fireEvent.click(
      within(await screen.findByRole('menu', { name: '标签' })).getByRole('menuitem', { name: '待剪素材' }),
    );

    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(0);
    });
    expect(list.lastArgs()[0]).toMatchObject({ tag_id: 'tag-1', page: 1 });
  });
});
