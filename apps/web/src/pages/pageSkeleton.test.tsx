/*
 * `markup` project — every §7 page's skeleton.
 *
 * One table over all fifteen pages, because the thing being asserted is the
 * same for all of them and it is a contract, not a coincidence: each route
 * renders a `design/layout/Page` with a `Toolbar` carrying its own title, and a
 * content area.
 *
 * ── What the `phase` column is for ─────────────────────────────────────────
 *
 * Phase 1 gave every route a stub whose body was one `Empty` saying 「本页
 * 在阶段 X 实现」, and this file pinned that sentence for all fifteen. A phase
 * that lands *replaces* the sentence, so the column now carries `built` as well
 * as the phase, and the two halves are asserted in opposite directions:
 *
 *   built: false   the notice is still there, word for word, with a way out
 *    the notice is **gone** — a page that shipped its real body
 *                  and left 「本页在阶段 X 实现」 standing beside it would be
 *                  lying twice over, and only this direction catches that.
 *
 * So flipping a flag here is part of landing a phase, and forgetting to flip it
 * fails rather than passes. `phase` itself stays because §10 assigns every page
 * to one and the last assertion in this file checks the assignment is covered.
 *
 * The per-page detail — parameters, queries, back links — is
 * `pageDetail.test.tsx`.
 */

import type { ComponentType } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../test/render';
import { LEGACY_UI_TERMS } from '../terminology';
import { AgentPage } from './AgentPage';
import { DeliveryPage } from './DeliveryPage';
import { EditorPage } from './EditorPage';
import { EvidencePage } from './EvidencePage';
import { GuidePage } from './GuidePage';
import { HistoryPage } from './HistoryPage';
import { HomePage } from './HomePage';
import { LibraryPage } from './LibraryPage';
import { MatchWorkspacePage } from './MatchWorkspacePage';
import { MontagePage } from './MontagePage';
import { PlayerProfilePage } from './PlayerProfilePage';
import { PlayersPage } from './PlayersPage';
import { RecordingPage } from './RecordingPage';
import { RecoveryPage } from './RecoveryPage';
import { SettingsPage } from './SettingsPage';
import { TaskDetailPage } from './TaskDetailPage';

interface PageCase {
  /** The §7 pattern the route table declares. */
  readonly pattern: string;
  /** A concrete address for it. */
  readonly at: string;
  readonly Component: ComponentType;
  /**
   * The `Toolbar` title, as rendered. It is the *page's* heading, which is not
   * always the rail entry: `/` is 「今日工作」 under a rail that says 「工作台」,
   * and `/delivery` is 「交付」 under two entries that say 输出 and 任务记录 —
   * both straight off the artboards (01 and 11).
   */
  readonly title: string;
  /** The spec §10 phase that fills the body in. */
  /** Whether that phase has landed. See the file header. */
  /**
   * What sits in the `Page`'s toolbar slot. Fourteen pages put a
   * `design/layout/Toolbar` there. `/match/:demoId` puts
   * `domain/match/MatchContextBar` there instead, and that is not a shortcut:
   * §3.4 names `--h-topbar` 「页面顶栏 / 比赛上下文栏」, the 03 artboard draws the
   * scoreline and the focus chips in that 56px band, and the bar has to be *the
   * same object* across all nine sub-views (§7). Its title is the rail's active
   * entry, not a heading of its own.
   */
  readonly chrome?: 'toolbar' | 'context-bar';
}

const PAGES: readonly PageCase[] = [
  { pattern: '/', at: '/', Component: HomePage, title: '今日工作' },
  {
    pattern: '/library',
    at: '/library',
    Component: LibraryPage,
    title: 'Demo 资料库',
  },
  {
    pattern: '/history',
    at: '/history',
    Component: HistoryPage,
    title: '比赛历史',
  },
  {
    pattern: '/players',
    at: '/players',
    Component: PlayersPage,
    title: '玩家目录',
  },
  {
    pattern: '/players/:playerId',
    at: '/players/kael',
    Component: PlayerProfilePage,
    title: '玩家档案',
  },
  {
    pattern: '/evidence',
    at: '/evidence',
    Component: EvidencePage,
    title: '证据检索',
  },
  {
    pattern: '/match/:demoId',
    at: '/match/aurora-vs-meridian',
    Component: MatchWorkspacePage,
    title: '概览',
    chrome: 'context-bar',
  },
  {
    pattern: '/agent',
    at: '/agent',
    Component: AgentPage,
    title: 'Agent 创作',
  },
  {
    pattern: '/recording',
    at: '/recording',
    Component: RecordingPage,
    title: '录制计划',
  },
  {
    pattern: '/montage',
    at: '/montage',
    Component: MontagePage,
    title: '快速剪辑',
  },
  {
    pattern: '/editor',
    at: '/editor',
    Component: EditorPage,
    title: '多轨编辑器',
  },
  {
    pattern: '/delivery',
    at: '/delivery',
    Component: DeliveryPage,
    title: '成品',
  },
  {
    pattern: '/delivery/task/:taskId',
    at: '/delivery/task/t-42',
    Component: TaskDetailPage,
    title: '后台任务详情',
  },
  {
    pattern: '/settings',
    at: '/settings',
    Component: SettingsPage,
    title: '设置与诊断',
  },
  {
    pattern: '/recovery',
    at: '/recovery',
    Component: RecoveryPage,
    title: '恢复中心',
  },
  {
    pattern: '/guide',
    at: '/guide',
    Component: GuidePage,
    title: '使用引导',
  },
];

function renderPage(pattern: string, at: string, Component: ComponentType): string {
  return renderMarkup(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path={pattern} element={<Component />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe.each(PAGES)('$at', ({ pattern, at, Component, title, chrome }) => {
  const html = renderPage(pattern, at, Component);

  it('is a Page with the four slots, not a bare div', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('data-page-body');
  });

  it('carries its title in the bar the artboard gives it', () => {
    if ((chrome ?? 'toolbar') === 'toolbar') {
      expect(html).toContain('data-toolbar=');
      expect(html).toContain(`data-toolbar-title="true"`);
    } else {
      expect(html).toContain('data-match-context-bar=');
      // The workspace's own heading is the rail entry that is current.
      expect(html).toContain('aria-current="page"');
    }
    expect(html).toContain(title);
  });

  it('keeps legacy IA nouns out of rendered page chrome', () => {
    const chrome = [
      ...html.matchAll(/<h[1-6][^>]*(?:data-toolbar-title|data-match-context-title)[^>]*>[\s\S]*?<\/h[1-6]>/gu),
    ]
      .map((match) => match[0])
      .join('\n');

    for (const legacy of LEGACY_UI_TERMS) expect(chrome).not.toContain(legacy);
  });

  it('ships a real body, not a notice about which phase would build one', () => {
    // The scaffolding this once guarded is gone: there is no placeholder
    // component left to render, and no page that would want it.
    expect(html).not.toContain('本页在阶段');
  });

  it('invents no data — no names, no fake progress', () => {
    /* These pages render with no service and an empty cache, so anything
       recognisable from a fixture would mean the page is drawing something it
       was never given. A progress bar is the same failure in numeric form:
       §4.3 allows one only when the denominator is real. */
    expect(html).not.toContain('Aurora');
    expect(html).not.toContain('role="progressbar"');
  });

});

describe('the page table', () => {
  it('covers every §7 destination exactly once', () => {
    /* A count, not a comparison against `ROUTE_PATHS` — §2.1 rule 3 keeps
       `pages/**` out of `app/**`, and this file is under `pages/`. The real
       cross-check lives in `src/routes.test.tsx`, which is the composition
       root and is allowed to see both sides; it is what catches a route added
       without a page. */
    expect(PAGES).toHaveLength(16);
    expect(new Set(PAGES.map((entry) => entry.pattern)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((entry) => entry.Component)).size).toBe(PAGES.length);
  });
});
