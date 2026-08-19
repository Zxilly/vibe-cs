/*
 * `interaction` project — 交付 at the §8 fold.
 *
 * Two rules meet on this page at 1100px:
 *
 *   §8, the non-negotiable one   the view switcher and the page's own action
 *                                stay on the bar. `Toolbar` folds `actions`
 *                                into 「更多」 by default (§10.1 gap 6), and
 *                                §10.3 gap 2 asked short-titled pages —
 *                                library and delivery by name — to pass
 *                                `inlineActionsWhenCollapsed`. This is that
 *                                page doing it, asserted rather than assumed.
 *   §8 rule 2                    the 520px 任务记录 rail is not an Inspector,
 *                                and the folded artboard has no second column
 *                                for it. It is dropped, and the Seg — still on
 *                                the bar — is the way to the same records.
 */

import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { COLLAPSE_BREAKPOINT_PX } from '../../design/layout';
import { stubMatchMedia, type MatchMediaStub } from '../../design/layout/collapse.testing';
import type { OutputPage } from '../../shared/desktop/dto';
import type { ActivityFeed } from '../../shared/desktop/viewModels';
import { DeliveryPage } from '../DeliveryPage';
import { HEALTHY, renderPage } from './test/renderPage';

const FEED: ActivityFeed = {
  items: [],
  total: 0,
  page: 1,
  page_size: 50,
  summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 },
};

const OUTPUTS: OutputPage = { items: [], total: 0, page: 1, page_size: 12, scan_limited: false };

const CLIENT = {
  listActivities: () => Promise.resolve(FEED),
  listOutputs: () => Promise.resolve(OUTPUTS),
};

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe('1100 × 700', () => {
  it('keeps the view switcher and the page action on the bar', async () => {
    media = stubMatchMedia(COLLAPSE_BREAKPOINT_PX);
    const { container } = renderPage({
      element: <DeliveryPage />,
      client: CLIENT,
      route: '/delivery',
      health: HEALTHY,
    });

    await waitFor(() => {
      expect(container.querySelector('[data-toolbar][data-collapsed="true"]')).not.toBeNull();
    });

    expect(screen.getByRole('radio', { name: '成品文件' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /清理无效记录/u })).toBeTruthy();
    // Neither went into 「更多」, so the menu has nothing to open.
    expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull();
  });

  it('drops the 520px rail, because the folded artboard has no column for it', async () => {
    media = stubMatchMedia(COLLAPSE_BREAKPOINT_PX);
    const { container } = renderPage({
      element: <DeliveryPage />,
      client: CLIENT,
      route: '/delivery',
      health: HEALTHY,
    });

    await waitFor(() => {
      expect(container.querySelector('[data-toolbar][data-collapsed="true"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-split-aside]')).toBeNull();
  });

  it('brings the rail back above the fold', async () => {
    media = stubMatchMedia(COLLAPSE_BREAKPOINT_PX + 1);
    const { container } = renderPage({
      element: <DeliveryPage />,
      client: CLIENT,
      route: '/delivery',
      health: HEALTHY,
    });

    await waitFor(() => {
      expect(container.querySelector('[data-split-aside]')).not.toBeNull();
    });
  });
});
