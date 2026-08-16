/*
 * 「09 快速合辑」 at the §8 fold.
 *
 * The one non-negotiable rule: **主动作在任何宽度下保持可见，不进溢出菜单.**
 * 「生成视频」 is this page's main action, so it stays on the bar at 1100px
 * while 「在多轨编辑器中打开」 — a secondary action — is allowed to fold into
 * 「更多」.
 *
 * The Inspector folds too (collapse rule 2: 「右侧 Inspector 不再常驻，收成底部
 * 44px 选中摘要 + 可召出的右侧抽屉」), which is why the toolbar's copy of the
 * action is the one that has to survive: the panel's copy goes inside the
 * drawer with the rest of 包装 and 导出.
 */

import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { stubMatchMedia, type MatchMediaStub } from '../../design/layout/collapse.testing';
import { montageClient, renderMontage } from './test/renderMontage';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

describe('折叠态', () => {
  it('keeps 「生成视频」 on the bar and folds only the secondary action', async () => {
    media = stubMatchMedia(1000);
    renderMontage({ client: montageClient() });
    await screen.findByText('Kael 个人集锦 v2');

    /* The toolbar's copy is still a button on the bar, not a menu item. */
    const toolbarButton = document.querySelector('[data-montage-export="toolbar"]');
    expect(toolbarButton).not.toBeNull();
    expect(toolbarButton?.closest('[data-toolbar-primary]')).not.toBeNull();
    expect(toolbarButton?.closest('[data-overflow-menu]')).toBeNull();

    /* And the fold really happened — the secondary action left the bar. */
    await waitFor(() => expect(screen.getByRole('button', { name: '更多操作' })).toBeTruthy());
  });

  it('keeps it visible when the window widens again', async () => {
    media = stubMatchMedia(1000);
    renderMontage({ client: montageClient() });
    await screen.findByText('Kael 个人集锦 v2');

    media.setWidth(1600);

    await waitFor(() => expect(screen.queryByRole('button', { name: '更多操作' })).toBeNull());
    expect(document.querySelector('[data-montage-export="toolbar"]')).not.toBeNull();
  });
});
