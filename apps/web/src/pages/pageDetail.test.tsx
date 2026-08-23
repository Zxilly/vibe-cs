/*
 * `markup` project — the part of each page that is not boilerplate.
 *
 * §7 gives six routes a query and five a path parameter. Both are the page's
 * contract with the address bar, and both survive into phase 3 unchanged, so
 * they are pinned here rather than left to whoever fills the body in.
 *
 * The detail routes also carry the reference's back link (03's 「‹ 资料库」).
 * The title bar's crumb says where you *are*; this is the way back, and the two
 * are not the same affordance.
 */

import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../test/render';
import { DeliveryPage } from './DeliveryPage';
import { EvidencePage } from './EvidencePage';
import { LibraryPage } from './LibraryPage';
import { MatchWorkspacePage } from './MatchWorkspacePage';
import { MATCH_VIEW_IDS } from './match/viewContract';
import { PlayerProfilePage } from './PlayerProfilePage';
import { RecoveryPage } from './RecoveryPage';
import { SettingsPage, SETTINGS_SECTIONS } from './SettingsPage';
import { TaskDetailPage } from './TaskDetailPage';

function at(pattern: string, url: string, element: ReactElement): string {
  return renderMarkup(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={pattern} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the §7 queries', () => {
  it('/library?view=table|card', () => {
    expect(at('/library', '/library', <LibraryPage />)).toContain('表格视图');
    expect(at('/library', '/library?view=card', <LibraryPage />)).toContain('卡片视图');
    expect(at('/library', '/library?view=grid', <LibraryPage />)).toContain('表格视图');
  });

  it('/evidence?view=evidence|annotations', () => {
    expect(at('/evidence', '/evidence?view=annotations', <EvidencePage />)).toContain('注释');
    expect(at('/evidence', '/evidence', <EvidencePage />)).toContain('证据检索');
  });

  it('/delivery?view=tasks leaves the page on finished files for the shell redirect', () => {
    const outputs = at('/delivery', '/delivery', <DeliveryPage />);
    const tasks = at('/delivery', '/delivery?view=tasks', <DeliveryPage />);

    /* Both faces print both words — the Seg in the topbar carries 输出 and
       任务记录 whichever is showing — so the title is no longer what tells them
       apart. Their own filter strips are: 输出 filters by output kind, 任务记录
       by task state, and neither control exists on the other face. */
    expect(outputs).toContain('name="delivery-output-filter"');
    expect(outputs).not.toContain('name="delivery-task-state"');
    expect(tasks).not.toContain('name="delivery-task-state"');
    expect(tasks).toContain('name="delivery-output-filter"');

    // The retired Seg is absent on both forms; AppShell owns the legacy redirect.
    expect(outputs).not.toContain('name="delivery-view"');
    expect(tasks).not.toContain('name="delivery-view"');
  });

  it.each(SETTINGS_SECTIONS)('/settings?section=%s', (section) => {
    const html = at('/settings', `/settings?section=${section}`, <SettingsPage />);
    expect(html).toContain('设置与诊断');
    // The fifth-round rename: the fourth section is 「AI 与 Agent」, not 「AI」.
    if (section === 'ai') expect(html).toContain('AI 与 Agent');
  });

  it.each(MATCH_VIEW_IDS)('/match/:demoId?view=%s', (view) => {
    const html = at('/match/:demoId', `/match/aurora?view=${view}`, <MatchWorkspacePage />);
    // The bar prints the map and the teams, never the file id, so the frame
    // carries the id the route was opened on.
    expect(html).toContain('data-match-demo="aurora"');
    expect(html).toContain('data-match-context-bar');
    expect(html).toContain(`data-match-view="${view}"`);
  });

  it('/match/:demoId opens on 概览, the §7 default', () => {
    const bare = at('/match/:demoId', '/match/aurora', <MatchWorkspacePage />);
    const unknown = at('/match/:demoId', '/match/aurora?view=nonsense', <MatchWorkspacePage />);
    expect(bare).toContain('data-match-view="overview"');
    expect(unknown).toContain('data-match-view="overview"');
  });

  it('declares nine match views, per §7 s merge table', () => {
    expect(MATCH_VIEW_IDS).toHaveLength(9);
    expect(MATCH_VIEW_IDS).toContain('teams');
  });
});

describe('the §7 path parameters', () => {
  it('/players/:playerId shows the id it was given', () => {
    expect(at('/players/:playerId', '/players/kael', <PlayerProfilePage />)).toContain('kael');
  });

  it('/delivery/task/:taskId shows the id it was given', () => {
    expect(at('/delivery/task/:taskId', '/delivery/task/t-42', <TaskDetailPage />)).toContain('t-42');
  });

});

describe('detail-route navigation', () => {
  it('leaves the match return path to the shell breadcrumb', () => {
    const html = at('/match/:demoId', '/match/aurora', <MatchWorkspacePage />);
    expect(html).not.toContain('data-match-back=');
  });

  it('leaves player-directory navigation to the shell breadcrumb', () => {
    expect(at('/players/:playerId', '/players/kael', <PlayerProfilePage />)).not.toContain('‹ 玩家');
  });

  it('leaves task-detail return navigation to the shell breadcrumb', () => {
    const html = at('/delivery/task/:taskId', '/delivery/task/t-1', <TaskDetailPage />);
    expect(html).not.toContain('‹ 后台任务');
  });

  it('takes 恢复中心 back to the entry that lights for it', () => {
    expect(at('/recovery', '/recovery', <RecoveryPage />)).toContain('href="/settings"');
  });
});
