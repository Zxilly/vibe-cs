import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

const ITEMS: OverflowMenuItem[] = [
  { id: 'review', label: <Trans>Review 与注释</Trans> },
  { id: 'teams', label: <Trans>阵容</Trans>, disabled: true },
];

describe('OverflowMenu', () => {
  it('renders a closed disclosure', () => {
    const html = renderMarkup(<OverflowMenu items={ITEMS} label="更多视图" />);

    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="更多视图"');
    expect(html).toContain('更多');
    expect(html).not.toContain('role="menu"');
    // The chevron is drawn, not read.
    expect(html).toContain('<span aria-hidden="true">▾</span>');
  });

  it('disappears entirely when nothing folded', () => {
    expect(renderMarkup(<OverflowMenu items={[]} label="更多视图" />)).toBe('');
  });

  it('takes call-site trigger copy', () => {
    const html = renderMarkup(
      <OverflowMenu items={ITEMS} label="更多操作" triggerLabel={<Trans>其他</Trans>} />,
    );

    expect(html).toContain('其他');
  });
});
