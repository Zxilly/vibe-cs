/*
 * `markup` project — the assembled frame.
 *
 * What this file is for: proving the shell mounts every band, in the right
 * order, with the right widths, and that the two states a static render can
 * reach (expanded and §8-folded) are both structurally correct. Focus, the
 * keyboard and the fold *transition* are `AppShell.interaction.test.tsx`.
 */

import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ApiHealth } from '../shared/desktop/dto';
import { renderMarkup } from '../test/render';
import { AppShell } from './AppShell';
import { resetShellStore } from './shell';

/** Never settles, so a static render only ever sees the `checking` state. */
function pendingProbe(): Promise<ApiHealth> {
  return new Promise<ApiHealth>(() => {});
}

function renderShell(
  at: string,
  options: { collapsed?: boolean; page?: ReactNode } = {},
): string {
  const page = options.page ?? <span data-test-page>页面内容</span>;
  return renderMarkup(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          element={
            <AppShell
              adapter={null}
              probe={pendingProbe}
              poll={false}
              {...(options.collapsed === undefined ? {} : { collapsed: options.collapsed })}
            />
          }
        >
          <Route path="*" element={page} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AppShell — the assembled frame', () => {
  beforeEach(() => {
    resetShellStore();
  });

  it('mounts the title bar, navigation and outlet without a right-edge Agent column', () => {
    const html = renderShell('/library');

    expect(html).toContain('data-app-shell');
    expect(html).toContain('data-shell-titlebar');
    expect(html).toContain('data-shell-nav="expanded"');
    expect(html).toContain('data-shell-main');
    expect(html).toContain('data-route-viewport');
    expect(html).not.toContain('data-agent-rail');
    expect(html).toContain('data-test-page');
  });

  it('gives a Project workbench a focused shell without global navigation chrome', () => {
    const html = renderShell('/projects/00000000-0000-4000-8000-000000000001');

    expect(html).toContain('data-titlebar-compact="true"');
    expect(html).not.toContain('data-shell-nav');
    expect(html).not.toContain('data-titlebar-command');
    expect(html).not.toContain('data-titlebar-activity');
    expect(html).toContain('data-shell-main');
  });

  it('gives every route one full-size clipped viewport', () => {
    const html = renderShell('/library');

    expect(html).toContain('data-route-path="/library"');
    expect(html).toMatch(
      /data-route-viewport="true"[^>]*class="[^"]*h-full[^"]*min-h-0[^"]*min-w-0[^"]*overflow-hidden/u,
    );
  });

  it('puts the navigation rail before the outlet and mounts no trailing rail', () => {
    const html = renderShell('/library');
    const nav = html.indexOf('data-shell-nav');
    const main = html.indexOf('data-shell-main');
    const rail = html.indexOf('data-agent-rail');

    expect(nav).toBeGreaterThan(-1);
    expect(nav).toBeLessThan(main);
    expect(rail).toBe(-1);
  });

  it('keeps the scroll boundary in the page, never in the shell', () => {
    const html = renderShell('/library');

    // The row and the main column clip; `design/layout/Page` owns the scroller.
    expect(html).toContain('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden');
    expect(html).toContain('flex h-full min-h-0 flex-col overflow-hidden');
  });

  it('names the main region so a skip link and aria have something to point at', () => {
    expect(renderShell('/')).toContain('id="main-content"');
  });

  it('renders no command palette until it is opened', () => {
    expect(renderShell('/')).not.toContain('command-palette');
  });

  it('renders no offline banner while the probe has not answered', () => {
    expect(renderShell('/')).not.toContain('本地服务未连接，分析、录制和导出暂时无法开始');
  });
});

describe('AppShell — the title bar crumb', () => {
  beforeEach(() => {
    resetShellStore();
  });

  /** The crumb's own markup, so an assertion is not matching the whole shell. */
  function crumb(path: string): string {
    return /<nav[^>]*data-titlebar-crumb=""[\s\S]*?<\/nav>/u.exec(renderShell(path))?.[0] ?? '';
  }

  /** The rungs, in order, as 「label」 or 「label→href」 for the ones that link. */
  function rungs(path: string): string[] {
    const html = crumb(path);
    return [...html.matchAll(/<(?:span|a)\b([^>]*)>([^<]*)</gu)]
      .filter(([, , text]) => (text ?? '').trim() !== '')
      .map(([, attrs = '', text = '']) => {
        const href = /href="([^"]*)"/u.exec(attrs)?.[1];
        return href === undefined ? text : `${text}→${href}`;
      });
  }

  it('is a real list, not a joined string', () => {
    const html = crumb('/library');
    expect(html).toContain('<ol');
    expect(html.match(/<li/gu)).toHaveLength(3); // 资料库 · separator · Demo 资料库
    // The separator is punctuation between two names, so it is not read out.
    expect(html).toContain('role="presentation"');
  });

  it('names the group and the entry for a rail destination', () => {
    expect(rungs('/library')).toEqual(['资料库', 'Demo 资料库']);
  });

  it('drops the group for 工作台, which has none', () => {
    expect(rungs('/')).toEqual(['工作台']);
  });

  it('reads the query, so 输出 and 任务记录 are told apart on one path', () => {
    expect(rungs('/delivery?view=tasks')).toEqual(['交付', '成品文件']);
    expect(rungs('/delivery')).toEqual(['交付', '成品文件']);
  });

  /* The rung that used to be dropped is the one you would climb. */
  it('links the parent list on a detail route, and marks the leaf as the page', () => {
    expect(rungs('/match/aurora-meridian')).toEqual([
      '资料库',
      'Demo 资料库→/library',
      '比赛工作区',
    ]);
    expect(rungs('/players/kael')).toEqual(['分析', '玩家目录→/players', '玩家档案']);
    expect(rungs('/recovery')).toEqual(['设置与诊断→/settings', '恢复中心']);

    expect(crumb('/match/aurora-meridian')).toContain('aria-current="page"');
  });

  it('leaves the crumb out entirely for an address outside the table', () => {
    expect(renderShell('/does-not-exist')).not.toContain('data-titlebar-crumb');
  });
});

describe('AppShell — the §8 fold at 1100 × 700', () => {
  beforeEach(() => {
    resetShellStore();
  });

  it('collapses the rail to the 56px icon column', () => {
    const html = renderShell('/library', { collapsed: true });

    expect(html).toContain('data-shell-folded="true"');
    expect(html).toContain('data-shell-nav="collapsed"');
    expect(html).toContain('w-[var(--w-nav-collapsed)]');
  });

  it('narrows the title bar brand block with it, so brand and rail keep one edge', () => {
    expect(renderShell('/library', { collapsed: true })).toContain(
      'data-shell-titlebar="nav-collapsed"',
    );
    expect(renderShell('/library')).toContain('data-shell-titlebar="nav-expanded"');
  });

  it('drops the Agent column entirely, as the 1100 × 700 board draws it', () => {
    const html = renderShell('/library', { collapsed: true });

    expect(html).not.toContain('data-agent-rail');
  });

  it('keeps the project Agent entry while retiring the separate right-edge rail', () => {
    const html = renderShell('/library', { collapsed: true });

    // The sparkle item survives the fold: it is the artboard's own entry point
    // and the reason the right column can go.
    expect(html).toContain('data-nav-item="projects"');
    expect(html).toContain('data-nav-item="agent"');
  });

  it('renders the expanded rail at full width when nothing is folded', () => {
    expect(renderShell('/library')).toContain('w-[var(--w-nav)]');
  });
});
