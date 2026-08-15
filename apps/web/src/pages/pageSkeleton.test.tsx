/*
 * `markup` project — every §7 page's skeleton.
 *
 * One table over all fifteen pages, because the thing being asserted is the
 * same for all of them and it is a contract, not a coincidence: each route
 * renders a `design/layout/Page` with a `Toolbar` carrying its title, and a
 * content area holding the phase notice. Phase 3 replaces the notice and keeps
 * everything else, so this file is what tells its owner they only changed the
 * body.
 *
 * The per-page detail — parameters, queries, back links — is
 * `pageDetail.test.tsx`.
 */

import type { ComponentType } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../test/render';
import { AgentPage } from './AgentPage';
import { DeliveryPage } from './DeliveryPage';
import { EditorPage } from './EditorPage';
import { EvidencePage } from './EvidencePage';
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
  /** The `Toolbar` title, as rendered. */
  readonly title: string;
  /** The spec §10 phase that fills the body in. */
  readonly phase: string;
}

const PAGES: readonly PageCase[] = [
  { pattern: '/', at: '/', Component: HomePage, title: '工作台', phase: '3g' },
  { pattern: '/library', at: '/library', Component: LibraryPage, title: 'Demo 资料库', phase: '3b' },
  { pattern: '/history', at: '/history', Component: HistoryPage, title: '比赛历史', phase: '3d' },
  { pattern: '/players', at: '/players', Component: PlayersPage, title: '玩家目录', phase: '3d' },
  {
    pattern: '/players/:playerId',
    at: '/players/kael',
    Component: PlayerProfilePage,
    title: '玩家档案',
    phase: '3d',
  },
  { pattern: '/evidence', at: '/evidence', Component: EvidencePage, title: '证据检索', phase: '3d' },
  {
    pattern: '/match/:demoId',
    at: '/match/aurora-vs-meridian',
    Component: MatchWorkspacePage,
    title: '概览',
    phase: '3c',
  },
  { pattern: '/agent', at: '/agent', Component: AgentPage, title: 'Agent 创作', phase: '3e' },
  { pattern: '/recording', at: '/recording', Component: RecordingPage, title: '录制计划', phase: '3f' },
  { pattern: '/montage', at: '/montage', Component: MontagePage, title: '快速合辑', phase: '3f' },
  { pattern: '/editor', at: '/editor', Component: EditorPage, title: '多轨编辑器', phase: '3f' },
  { pattern: '/delivery', at: '/delivery', Component: DeliveryPage, title: '输出', phase: '3a' },
  {
    pattern: '/delivery/task/:taskId',
    at: '/delivery/task/t-42',
    Component: TaskDetailPage,
    title: '任务详情',
    phase: '3a',
  },
  { pattern: '/settings', at: '/settings', Component: SettingsPage, title: '设置与诊断', phase: '3g' },
  { pattern: '/recovery', at: '/recovery', Component: RecoveryPage, title: '恢复中心', phase: '3g' },
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

describe.each(PAGES)('$at', ({ pattern, at, Component, title, phase }) => {
  const html = renderPage(pattern, at, Component);

  it('is a Page with the four slots, not a bare div', () => {
    expect(html).toContain('data-page=');
    expect(html).toContain('data-page-toolbar');
    expect(html).toContain('data-page-body');
  });

  it('carries its title in a Toolbar', () => {
    expect(html).toContain('data-toolbar=');
    expect(html).toContain(`data-toolbar-title="true"`);
    expect(html).toContain(title);
  });

  it('says which phase fills the content area, and offers a way out of it', () => {
    expect(html).toContain(`本页在阶段 ${phase} 实现`);
    // `EmptyState` makes the recovery action a required prop; this is it.
    expect(html).toMatch(/返回工作台|打开 Demo 资料库/u);
  });

  it('invents no data — no counts, no names, no fake progress', () => {
    expect(html).not.toContain('Aurora');
    expect(html).not.toContain('%');
    expect(html).not.toContain('role="progressbar"');
  });
});

describe('the page table', () => {
  it('covers every §7 destination exactly once', () => {
    expect(PAGES).toHaveLength(15);
    expect(new Set(PAGES.map((entry) => entry.pattern)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((entry) => entry.Component)).size).toBe(PAGES.length);
  });

  it('reaches every phase §10 assigns a page to', () => {
    expect(new Set(PAGES.map((entry) => entry.phase))).toEqual(
      new Set(['3a', '3b', '3c', '3d', '3e', '3f', '3g']),
    );
  });
});
