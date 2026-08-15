/*
 * `markup` project — the phase notice.
 */

import { Trans } from '@lingui/react/macro';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../test/render';
import { PagePlaceholder } from './PagePlaceholder';

function render(node: Parameters<typeof renderMarkup>[0]): string {
  return renderMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe('PagePlaceholder', () => {
  it('names the phase rather than saying 「即将上线」', () => {
    const html = render(<PagePlaceholder phase="3c" description={<Trans>比赛工作区</Trans>} />);
    expect(html).toContain('本页在阶段 3c 实现');
    expect(html).not.toContain('即将');
  });

  it('reads as empty, not as a failure — a page that is not built yet is not broken', () => {
    const html = render(<PagePlaceholder phase="3a" description={<Trans>交付</Trans>} />);
    expect(html).toContain('data-tone="empty"');
    expect(html).not.toContain('data-tone="error"');
  });

  it('offers 返回工作台 by default, satisfying EmptyState’s required recovery action', () => {
    expect(render(<PagePlaceholder phase="3d" description={<Trans>玩家</Trans>} />)).toContain(
      '返回工作台',
    );
  });

  it('lets a page replace the action with one that fits it better', () => {
    const html = render(
      <PagePlaceholder phase="3g" description={<Trans>工作台</Trans>} actions={<span>打开资料库</span>} />,
    );
    expect(html).toContain('打开资料库');
    expect(html).not.toContain('返回工作台');
  });

  it('shows no percentage — 「不显示虚构百分比」', () => {
    const html = render(<PagePlaceholder phase="3f" description={<Trans>编辑器</Trans>} />);
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('%');
  });
});
