import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Toolbar, type ToolbarAction } from './Toolbar';

/** 02 Demo 资料库: 「监听目录」 beside 「导入 Demo」. */
const ACTIONS: ToolbarAction[] = [
  {
    id: 'watch',
    control: (
      <button type="button">
        <Trans>监听目录</Trans>
      </button>
    ),
    label: <Trans>监听目录</Trans>,
  },
  {
    id: 'export',
    control: (
      <button type="button">
        <Trans>导出元数据</Trans>
      </button>
    ),
    label: <Trans>导出元数据</Trans>,
  },
];

const PRIMARY = (
  <button type="button">
    <Trans>导入 Demo</Trans>
  </button>
);

describe('Toolbar', () => {
  it('draws the 02 资料库 top bar: title, meta, actions, main action', () => {
    const html = renderMarkup(
      <Toolbar
        title={<Trans>Demo 资料库</Trans>}
        meta={<Trans>248 场 · 3 个监听目录</Trans>}
        actions={ACTIONS}
        primary={PRIMARY}
        collapsed={false}
      />,
    );

    expect(html).toContain('data-toolbar-height="topbar"');
    expect(html).toContain('data-collapsed="false"');
    expect(html).toContain('Demo 资料库');
    expect(html).toContain('248 场 · 3 个监听目录');
    expect(html).toContain('data-toolbar-action="watch"');
    expect(html).toContain('data-toolbar-action="export"');
    expect(html).toContain('data-toolbar-primary');
  });

  it('renders the title as a heading sized from the §3.2 scale', () => {
    const html = renderMarkup(<Toolbar title={<Trans>交付</Trans>} collapsed={false} />);

    // §3.2 puts 页面标题 at --text-2xl. It is spelled inline because base.css
    // is unlayered and its `h2` rule outranks any utility class.
    expect(html).toContain('<h2 data-toolbar-title="true"');
    expect(html).toContain('style="font-size:var(--text-2xl)"');
  });

  it('sizes a panel head from the same scale one step down', () => {
    const html = renderMarkup(
      <Toolbar title={<Trans>比赛详情</Trans>} height="panel" collapsed={false} />,
    );

    expect(html).toContain('data-toolbar-height="panel"');
    expect(html).toContain('style="font-size:var(--text-base)"');
  });

  it('shows no overflow trigger while every action fits', () => {
    const html = renderMarkup(<Toolbar actions={ACTIONS} primary={PRIMARY} collapsed={false} />);

    expect(html).not.toContain('aria-haspopup="menu"');
    expect(html).not.toContain('data-overflow-menu');
  });

  it('folds the secondary actions into a closed 更多 menu once collapsed', () => {
    const html = renderMarkup(<Toolbar actions={ACTIONS} primary={PRIMARY} collapsed />);

    expect(html).toContain('data-collapsed="true"');
    expect(html).not.toContain('data-toolbar-action=');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    // Closed means closed: no menu in the markup until it is opened.
    expect(html).not.toContain('role="menu"');
  });

  it('keeps the main action on the bar at every width (spec §8)', () => {
    const expanded = renderMarkup(<Toolbar actions={ACTIONS} primary={PRIMARY} collapsed={false} />);
    const collapsed = renderMarkup(<Toolbar actions={ACTIONS} primary={PRIMARY} collapsed />);

    for (const html of [expanded, collapsed]) {
      expect(html).toContain('data-toolbar-primary');
      expect(html).toContain('导入 Demo');
    }
  });

  it('can keep a named number of secondary actions on the bar when collapsed', () => {
    const html = renderMarkup(
      <Toolbar actions={ACTIONS} primary={PRIMARY} collapsed inlineActionsWhenCollapsed={1} />,
    );

    expect(html).toContain('data-toolbar-action="watch"');
    expect(html).not.toContain('data-toolbar-action="export"');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('paints the context bar tone the reference gives 比赛工作区', () => {
    const html = renderMarkup(
      <Toolbar tone="chrome" title={<Trans>Aurora vs Meridian</Trans>} collapsed={false} />,
    );

    expect(html).toContain('bg-surface-chrome');
  });
});
