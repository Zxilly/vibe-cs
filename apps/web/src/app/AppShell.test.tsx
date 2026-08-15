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

  it('mounts the title bar, the rail, the outlet and the Agent column in one column-then-row frame', () => {
    const html = renderShell('/library');

    expect(html).toContain('data-app-shell');
    expect(html).toContain('data-shell-titlebar');
    expect(html).toContain('data-shell-nav="expanded"');
    expect(html).toContain('data-shell-main');
    expect(html).toContain('data-agent-rail="collapsed"');
    expect(html).toContain('data-test-page');
  });

  it('puts the rail before the outlet and the Agent column after it', () => {
    const html = renderShell('/library');
    const nav = html.indexOf('data-shell-nav');
    const main = html.indexOf('data-shell-main');
    const rail = html.indexOf('data-agent-rail');

    expect(nav).toBeGreaterThan(-1);
    expect(nav).toBeLessThan(main);
    expect(main).toBeLessThan(rail);
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

  it('names the group and the entry for a rail destination', () => {
    expect(renderShell('/library')).toContain('资料库 › Demo 资料库');
  });

  it('drops the group for 工作台, which has none', () => {
    const html = renderShell('/');
    expect(html).toContain('>工作台<');
    expect(html).not.toContain('› 工作台');
  });

  it('reads the query, so 输出 and 任务记录 are told apart on one path', () => {
    expect(renderShell('/delivery?view=tasks')).toContain('交付 › 任务记录');
    expect(renderShell('/delivery')).toContain('交付 › 输出');
  });

  it('names the leaf for the detail routes the rail cannot list', () => {
    expect(renderShell('/match/aurora-meridian')).toContain('资料库 › 比赛工作区');
    expect(renderShell('/players/kael')).toContain('资料库 › 玩家档案');
    expect(renderShell('/delivery/task/t-1')).toContain('交付 › 任务详情');
    expect(renderShell('/recovery')).toContain('设置与诊断 › 恢复中心');
  });

  it('leaves the crumb empty for an address outside the table', () => {
    const html = renderShell('/does-not-exist');
    expect(html).toContain('data-titlebar-crumb');
    expect(html).toMatch(/data-titlebar-crumb="true" class="[^"]*"><\/span>/u);
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

  it('still reaches the Agent from the icon rail, so nothing is hidden without a route', () => {
    const html = renderShell('/library', { collapsed: true });

    // The sparkle item survives the fold: it is the artboard's own entry point
    // and the reason the right column can go.
    expect(html).toContain('data-nav-item="agent"');
  });

  it('renders the expanded rail at full width when nothing is folded', () => {
    expect(renderShell('/library')).toContain('w-[var(--w-nav)]');
  });
});
