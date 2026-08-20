import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { splitSubNavTabs, SubNav, type SubNavItem } from './SubNav';

/** The nine 比赛工作区 views of spec §7, in the reference's order. */
const VIEWS: SubNavItem[] = [
  { id: 'overview', label: <Trans>概览</Trans> },
  { id: 'rounds', label: <Trans>回合</Trans> },
  { id: 'players', label: <Trans>玩家</Trans> },
  { id: 'duels', label: <Trans>对位</Trans> },
  { id: 'utility', label: <Trans>道具与经济</Trans> },
  { id: 'replay', label: <Trans>回放与热力图</Trans> },
  { id: 'highlights', label: <Trans>高光</Trans>, badge: 18 },
  { id: 'review', label: <Trans>Review 与注释</Trans> },
  { id: 'teams', label: <Trans>阵容</Trans> },
];

describe('SubNav rail', () => {
  it('draws the 190px column of the 03 比赛工作区 artboard', () => {
    const html = renderMarkup(
      <SubNav items={VIEWS} activeId="overview" label="视图导航" collapsed={false} />,
    );

    expect(html).toContain('data-subnav="rail"');
    expect(html).toContain('aria-label="视图导航"');
    expect(html).toContain('w-[var(--w-subnav)]');
    for (const view of VIEWS) expect(html).toContain(`data-subnav-item="${view.id}"`);
  });

  it('marks the current view with aria-current rather than colour alone', () => {
    const html = renderMarkup(
      <SubNav items={VIEWS} activeId="highlights" label="视图导航" collapsed={false} />,
    );

    expect(html.split('aria-current="page"')).toHaveLength(2);
    const active = html.slice(html.indexOf('data-subnav-item="highlights"'));
    expect(active.slice(0, 200)).toContain('aria-current="page"');
  });

  it('carries the 「高光 18」 count badge', () => {
    const html = renderMarkup(
      <SubNav items={VIEWS} activeId="overview" label="视图导航" collapsed={false} />,
    );

    expect(html).toContain('>18</span>');
  });

  it('is a navigation, not a tablist — the view lives in the URL (§4.4)', () => {
    const html = renderMarkup(
      <SubNav items={VIEWS} activeId="overview" label="视图导航" collapsed={false} />,
    );

    expect(html).toContain('<nav ');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('role="tablist"');
  });
});

describe('SubNav tabs', () => {
  it('turns into top tabs plus 更多 at the breakpoint (§8 rule 3)', () => {
    const html = renderMarkup(<SubNav items={VIEWS} activeId="overview" label="视图导航" collapsed />);

    expect(html).toContain('data-subnav="tabs"');
    expect(html).toContain('h-[var(--h-bar)]');
    // The artboard draws five tabs, then 更多 ▾.
    expect(html.split('data-subnav-item=').length - 1).toBe(5);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('更多');
  });

  it('keeps every view reachable, on the bar or in the menu', () => {
    const html = renderMarkup(<SubNav items={VIEWS} activeId="overview" label="视图导航" collapsed />);

    expect(html).toContain('data-subnav-item="utility"');
    expect(html).not.toContain('data-subnav-item="teams"');
    expect(html).toContain('aria-expanded="false"');
  });
});

describe('splitSubNavTabs', () => {
  it('folds nothing when everything fits', () => {
    const { visible, folded } = splitSubNavTabs(VIEWS.slice(0, 4), 'overview', 5);

    expect(visible).toHaveLength(4);
    expect(folded).toHaveLength(0);
  });

  it('cuts at the visible count', () => {
    const { visible, folded } = splitSubNavTabs(VIEWS, 'overview', 5);

    expect(visible.map((item) => item.id)).toEqual([
      'overview',
      'rounds',
      'players',
      'duels',
      'utility',
    ]);
    expect(folded.map((item) => item.id)).toEqual(['replay', 'highlights', 'review', 'teams']);
  });

  /*
   * The bar has to keep saying which view you are looking at. A current view
   * hidden inside 「更多」 would leave every tab unmarked, which reads as "no
   * view selected" — so it takes the last visible slot and the tab it displaces
   * goes into the menu in its place.
   */
  it('promotes the current view out of the menu, swapping with the last tab', () => {
    const { visible, folded } = splitSubNavTabs(VIEWS, 'teams', 5);

    expect(visible.map((item) => item.id)).toEqual([
      'overview',
      'rounds',
      'players',
      'duels',
      'teams',
    ]);
    expect(folded.map((item) => item.id)).toEqual(['replay', 'highlights', 'review', 'utility']);
    expect(visible.length + folded.length).toBe(VIEWS.length);
  });
});
