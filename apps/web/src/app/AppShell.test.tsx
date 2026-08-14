import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from '../shared/stores/uiStore';
import { AppShell, commandPaletteDestinations, workspaceNavigationGroups } from './AppShell';
import { routePaths } from './router';

function renderShell() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <AppShell />
    </MemoryRouter>,
  );
}

describe('application shell navigation', () => {
  beforeEach(() => {
    useUiStore.setState({
      sidebarCollapsed: false,
      language: 'zh-CN',
      theme: 'light',
    });
  });

  it('keeps every icon-only-capable navigation link named and titled when persisted collapse is off', () => {
    const markup = renderShell();

    expect(markup).not.toContain('is-sidebar-collapsed');
    for (const label of ['总览', '比赛', '玩家目录', '本地五人阵容', '证据检索', '制作', '录制计划', '剪辑工程', '集锦编排', '剪辑工作台', '交付', '任务活动', '设置']) {
      expect(markup).toContain(`aria-label="${label}" title="${label}"`);
    }
    expect(markup).toContain('>复盘<');
    expect(markup).toContain('>剪辑<');
    expect(markup).not.toContain('aria-label="AI 协作" title="AI 协作"');
    expect(markup).toContain('class="ai-workspace-dock"');
    expect(markup).toContain('aria-label="AI 工作台"');
  });

  it('defines exactly two primary delivery workflows', () => {
    expect(workspaceNavigationGroups.map((group) => group.id)).toEqual(['review', 'edit']);
    expect(workspaceNavigationGroups[0]?.items.map((item) => item.path)).toEqual([
      '/library', '/players', '/lineups', '/evidence-search', '/match-history',
    ]);
    expect(workspaceNavigationGroups[1]?.items.map((item) => item.path)).toEqual([
      '/production', '/queue', '/studio', '/montage', '/studio/editor', '/outputs',
    ]);
  });

  it('offers every reachable core workspace in the command palette without a demo-less analysis deep link', () => {
    const paths = commandPaletteDestinations.map((destination) => destination.path);
    const reachablePaths = new Set<string>(routePaths);

    expect(paths).toEqual(expect.arrayContaining([
      '/',
      '/library',
      '/evidence-search',
      '/production',
      '/activity',
      '/outputs',
      '/settings',
      '/players',
      '/match-history',
      '/queue',
      '/studio',
      '/montage',
      '/studio/editor',
      '/recovery',
    ]));
    expect(paths).not.toContain('/analysis');
    expect(paths).not.toContain('/copilot');
    expect(paths.every((path) => reachablePaths.has(path))).toBe(true);
  });
});
