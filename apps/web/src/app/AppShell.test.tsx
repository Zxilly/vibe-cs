import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from '../shared/stores/uiStore';
import { AppShell, commandPaletteDestinations } from './AppShell';
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
    for (const label of ['总览', 'AI 协作', '比赛', '证据检索', '制作', '任务活动', '交付', '设置']) {
      expect(markup).toContain(`aria-label="${label}" title="${label}"`);
    }
  });

  it('offers every reachable core workspace in the command palette without a demo-less analysis deep link', () => {
    const paths = commandPaletteDestinations.map((destination) => destination.path);
    const reachablePaths = new Set<string>(routePaths);

    expect(paths).toEqual(expect.arrayContaining([
      '/',
      '/copilot',
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
    expect(paths.every((path) => reachablePaths.has(path))).toBe(true);
  });
});
