/*
 * `interaction` project — the §8 fold and the §4.4 address.
 *
 * Both need a real viewport and a real click, which is what separates this file
 * from `matchWorkspace.test.tsx`.
 *
 * The fold is asserted on **both sides of 1100**, and on the transition, using
 * `stubMatchMedia(width)` — jsdom's own `matchMedia` always answers `false` and
 * never fires, so without the stub a test proving 「it folds」 would be proving
 * nothing. The width form (rather than the boolean one) matters here: the
 * context bar folds at its own 1600 (§10.3 deviation 1) and the rail and the
 * Inspector at §8's 1100, and a flat answer would move all three together.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stubMatchMedia, type MatchMediaStub } from '../../../design/layout/collapse.testing';
import type { DesktopClient } from '../../../data/desktopClient';
import { MATCH_VIEW_IDS } from './viewContract';
import { ANALYSIS, DEMO, DEMO_ID } from './test/fixtures';
import { renderWorkspace } from './test/renderWorkspace';
import { reasonOf } from '../../../test/reason';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

/** A bridge that answers with the artboard's match. */
function loaded(): Partial<DesktopClient> {
  return {
    getDemo: vi.fn(() => Promise.resolve(DEMO)),
    getAnalysis: vi.fn(() => Promise.resolve(ANALYSIS)),
  };
}

function address(): string {
  return document.querySelector('[data-address]')?.textContent ?? '';
}

/**
 * Wide enough that *nothing* is folded. The context bar has its own, later
 * breakpoint — `CONTEXT_BAR_BREAKPOINT_PX` (1600), §10.3 deviation 1 — so at
 * 1400 the rail is a rail while the bar has already moved its metadata line and
 * its focus chips into the 「比赛信息」 disclosure. A test about what the bar
 * prints has to be above 1600; a test about the rail and the Inspector only
 * needs to be above 1100.
 */
const UNFOLDED_PX = 1700;

describe('shared horizontal view navigation', () => {
  it('shows all nine views above the breakpoint without a second rail', () => {
    media = stubMatchMedia(1400);
    renderWorkspace();

    expect(document.querySelector('[data-subnav="rail"]')).toBeNull();
    expect(document.querySelectorAll('[data-subnav="tabs"] [data-subnav-item]')).toHaveLength(9);
    expect(screen.queryByRole('button', { name: /更多视图/u })).toBeNull();
  });

  it('is a row of tabs at the breakpoint itself, with the rest under 更多', () => {
    // The artboard is drawn at exactly 1100 × 700 and shows the folded state.
    media = stubMatchMedia(1100);
    renderWorkspace();

    expect(document.querySelector('[data-subnav="tabs"]')).not.toBeNull();
    expect(document.querySelector('[data-subnav="rail"]')).toBeNull();
    // Nine views do not fit; the tail is reachable rather than dropped.
    expect(screen.getByRole('button', { name: /更多视图/u })).toBeTruthy();
  });

  it('keeps the current view visible even when it would fall past the cut', () => {
    media = stubMatchMedia(1100);
    renderWorkspace({ url: `/match/${DEMO_ID}?view=teams` });

    const current = document.querySelector('[data-subnav="tabs"] [aria-current="page"]');
    expect(current?.getAttribute('data-subnav-item')).toBe('teams');
  });

  it('folds only the overflow items in response to the viewport', async () => {
    media = stubMatchMedia(1400);
    renderWorkspace();
    expect(document.querySelectorAll('[data-subnav="tabs"] [data-subnav-item]')).toHaveLength(9);

    media.setWidth(1000);
    await waitFor(() => {
      expect(document.querySelectorAll('[data-subnav="tabs"] [data-subnav-item]')).toHaveLength(5);
    });
    expect(document.querySelector('[data-subnav="rail"]')).toBeNull();
  });
});

describe('§8 rule 2 — the Inspector folds into a strip plus a drawer', () => {
  it('is a docked 380px panel above the breakpoint', () => {
    media = stubMatchMedia(1400);
    renderWorkspace();

    expect(document.querySelector('[data-inspector="docked"]')).not.toBeNull();
    expect(document.querySelector('[data-inspector="summary"]')).toBeNull();
  });

  it('becomes a summary strip at the fold, keeping the main action on it', () => {
    media = stubMatchMedia(1100);
    renderWorkspace();

    const strip = document.querySelector('[data-inspector="summary"]');
    expect(strip).not.toBeNull();
    expect(document.querySelector('[data-inspector="docked"]')).toBeNull();
    // §8's non-negotiable line: 加入作品 stays on the strip, never in the drawer
    // only — with no selection it is disabled and explains what is missing.
    const add = strip?.querySelector('[data-match-add-to-video]');
    expect(add).not.toBeNull();
    expect(reasonOf(add)).toContain('先选择');
  });

  it('opens the drawer from the strip', async () => {
    media = stubMatchMedia(1100);
    renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: '详情' }));
    await waitFor(() => {
      expect(document.querySelector('[data-inspector="drawer"]')).not.toBeNull();
    });
  });

  it('folds together with the rail — one observation, not two', async () => {
    media = stubMatchMedia(1400);
    renderWorkspace();

    media.setWidth(900);
    await waitFor(() => {
      expect(document.querySelector('[data-inspector="summary"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-subnav="tabs"]')).not.toBeNull();
  });
});

describe('§4.4 — every selection is the address', () => {
  it('writes ?view= when a rail entry is chosen', async () => {
    media = stubMatchMedia(1400);
    renderWorkspace();

    fireEvent.click(document.querySelector('[data-subnav-item="highlights"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('view=highlights');
    });
    expect(document.querySelector('[data-match-view="highlights"]')).not.toBeNull();
  });

  it('carries round, player and tick across a view change', async () => {
    media = stubMatchMedia(1400);
    renderWorkspace({
      url: `/match/${DEMO_ID}?view=rounds&round=21&player=kael&tick=149380`,
    });

    fireEvent.click(document.querySelector('[data-subnav-item="replay"]') as HTMLElement);
    await waitFor(() => {
      expect(address()).toContain('view=replay');
    });
    const at = address();
    expect(at).toContain('round=21');
    expect(at).toContain('player=kael');
    expect(at).toContain('tick=149380');
  });

  it('falls back to 概览 on an unreadable view without erasing the selection', () => {
    media = stubMatchMedia(1400);
    renderWorkspace({ url: `/match/${DEMO_ID}?view=cosmetics&round=21` });

    expect(document.querySelector('[data-match-view="overview"]')).not.toBeNull();
    expect(document.querySelector('[data-match-view-context]')?.textContent).toContain('R21');
  });

  it('clears the focused player from the context bar chip', async () => {
    media = stubMatchMedia(UNFOLDED_PX);
    renderWorkspace({ url: `/match/${DEMO_ID}?player=kael`, client: loaded() });

    const chip = await screen.findByRole('button', { name: 'Kael' });
    fireEvent.click(chip);
    await waitFor(() => {
      expect(address()).not.toContain('player=');
    });
  });
});

describe('what the shell reads', () => {
  it('names the match from the library record and the analysis together', async () => {
    media = stubMatchMedia(UNFOLDED_PX);
    renderWorkspace({ client: loaded() });

    expect(await screen.findByText('Aurora')).toBeTruthy();
    expect(screen.getByText('Meridian')).toBeTruthy();
    // 「Mirage · 2026-08-14 · 3 回合 · 64 tick」 — the round count is the parsed
    // list, and the tick rate is stated rather than assumed.
    expect(screen.getByText('Mirage')).toBeTruthy();
    expect(screen.getByText('64 tick')).toBeTruthy();
  });

  it('badges 高光 with the real count once the analysis lands, and not before', async () => {
    media = stubMatchMedia(1400);
    renderWorkspace({ client: loaded() });

    const item = document.querySelector('[data-subnav-item="highlights"]') as HTMLElement;
    expect(item.textContent).toBe('高光');
    await waitFor(() => {
      expect(item.textContent).toBe('高光2');
    });
  });

  it('renders the identity failure in place, with the way out still reachable', async () => {
    media = stubMatchMedia(1400);
    renderWorkspace({
      client: {
        getDemo: () => Promise.reject(new Error('索引里没有这场比赛')),
        getAnalysis: () => new Promise(() => undefined),
      },
    });

    expect(await screen.findByText('索引里没有这场比赛')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: '资料库' })).toBeNull();
  });
});

describe('a failed analysis read', () => {
  const failing = (): Partial<DesktopClient> => ({
    getDemo: vi.fn(() => Promise.resolve(DEMO)),
    // The shape `shared/desktop/client` rejects with, after it has said the
    // service's `storage_error` in product copy.
    getAnalysis: vi.fn(() => Promise.reject(Object.assign(new Error('本地数据库读写失败'), { status: 500, code: 'storage_error' }))),
  });

  it.each(MATCH_VIEW_IDS)('renders one shared panel for ?view=%s, and no Inspector', async (view) => {
    media = stubMatchMedia(1400);
    renderWorkspace({ url: `/match/${DEMO_ID}?view=${view}`, client: failing() });

    expect(await screen.findByRole('heading', { name: '这场比赛的分析结果没能打开' })).toBeTruthy();
    expect(document.body.textContent).toContain('本地数据库读写失败');
    const frame = document.querySelector('[data-match-view]');
    expect(frame?.getAttribute('data-match-view')).toBe(view);
    expect(frame?.getAttribute('data-match-view-state')).toBe('error');
    expect(document.querySelector('[data-match-panel="analysis-failure"]')).not.toBeNull();
    // The failure is the whole workspace's: no panel beside it offers an
    // empty list or 「加入作品」 for a document that could not be read.
    expect(document.querySelector('[data-inspector]')).toBeNull();
    expect(screen.queryByText('这一段没有可列出的事件')).toBeNull();
    expect(screen.getByRole('button', { name: '重新分析' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '设置与诊断' })).toBeTruthy();
  });

  it('retries the read from the panel', async () => {
    media = stubMatchMedia(1400);
    const client = failing();
    renderWorkspace({ url: `/match/${DEMO_ID}?view=rounds`, client });
    await screen.findByRole('button', { name: '重试' });

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(client.getAnalysis).toHaveBeenCalledTimes(2);
    });
  });
});

describe('用这场比赛新建作品', () => {
  it('names the project after the match, lists the Demo as its source and opens it', async () => {
    media = stubMatchMedia(1700);
    const createProject = vi.fn((request: { name: string; source_demo_ids: string[] }) => Promise.resolve({
      id: '00000000-0000-4000-8000-000000000009',
      name: request.name, revision: 1,
      document: {
        width: 1920, height: 1080, fps: 60, duration_seconds: 0,
        story_track_id: '00000000-0000-4000-8000-000000000002',
        tracks: [{
          id: '00000000-0000-4000-8000-000000000002', name: 'Story', kind: 'video',
          order: 0, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [],
        }],
        markers: [], settings: { source_demo_ids: request.source_demo_ids, ripple_sequence_markers: false, use_media_proxies: false },
      },
      created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T00:00:00Z',
    }));
    const applyProjectPatch = vi.fn((patch: { project_id: string }) => Promise.resolve({
      project: { id: patch.project_id, name: DEMO.display_name, revision: 2 },
      change_group: { id: 'cg-1' },
    }));
    renderWorkspace({
      url: `/match/${DEMO_ID}?view=overview`,
      // The stubs answer with the fields this flow reads; the cast keeps the
      // fixture to those rather than a full change group.
      client: { ...loaded(), createProject, applyProjectPatch } as unknown as Partial<DesktopClient>,
    });

    // Disabled with a reason until the demo record is read; the reason's
    // tooltip wrapper comes and goes with it, so the button is re-queried.
    await screen.findByRole('button', { name: '用这场比赛新建作品' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '用这场比赛新建作品' }).hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: '用这场比赛新建作品' }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledTimes(1);
    });
    expect(createProject.mock.calls[0]?.[0]).toMatchObject({
      name: DEMO.display_name,
      source_demo_ids: [DEMO_ID],
    });
    await waitFor(() => {
      expect(applyProjectPatch).toHaveBeenCalledTimes(1);
    });
    // The whole match is the first Story clip, so the editor opens on something.
    expect(JSON.stringify(applyProjectPatch.mock.calls[0]?.[0])).toContain('整场比赛');
    // The harness only routes `/match/:demoId`, so leaving for the project is
    // observed as the workspace (and its address probe) unmounting.
    await waitFor(() => {
      expect(document.querySelector('[data-match-content]')).toBeNull();
    });
  });
});

describe('加入作品', () => {
  it('adds straight into the project that sent the user here, with no dialog', async () => {
    media = stubMatchMedia(1400);
    const existing = {
      id: '00000000-0000-4000-8000-000000000001',
      name: '现有作品', revision: 1,
      document: {
        width: 1920, height: 1080, fps: 60, duration_seconds: 0,
        story_track_id: '00000000-0000-4000-8000-000000000002',
        tracks: [{
          id: '00000000-0000-4000-8000-000000000002', name: 'Story', kind: 'video' as const,
          order: 0, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [],
        }],
        markers: [], settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
      },
      created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-20T00:00:00Z',
    };
    const patches: { project_id: string; base_revision: number }[] = [];
    renderWorkspace({
      url: `/match/${DEMO_ID}?view=rounds&round=2&project=${existing.id}`,
      client: {
        ...loaded(),
        listProjects: () => Promise.resolve([existing]),
        applyProjectPatch: (patch: { project_id: string; base_revision: number }) => {
          patches.push(patch);
          return Promise.resolve({
            project: { ...existing, revision: 2 },
            change_group: {
              id: 'change-1', project_id: existing.id, from_revision: 1, to_revision: 2,
              author: { kind: 'human' }, status: 'completed', summary: '加入', reverts_change_group_id: null,
              operations: [], inverse_operations: [], created_at: '2026-08-20T00:00:00Z', completed_at: '2026-08-20T00:00:00Z',
            },
          });
        },
        listActivities: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 50, summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 } }),
        listOutputs: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 100, scan_limited: false }),
      },
    });

    expect(await screen.findByText('正在为作品选材')).toBeTruthy();
    expect((screen.getByLabelText('选材目标作品') as HTMLSelectElement).value).toBe(existing.id);
    fireEvent.click(await screen.findByRole('button', { name: '把这个回合加入作品' }));
    expect(await screen.findByText('本次已加入 1 个')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(patches).toMatchObject([{ project_id: existing.id, base_revision: 1 }]);
  });

});
