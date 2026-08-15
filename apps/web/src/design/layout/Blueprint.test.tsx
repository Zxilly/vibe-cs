import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Blueprint } from './Blueprint';

describe('Blueprint', () => {
  it('wears all four registration marks', () => {
    // Industry's readme: 「Do not drop the registration marks from a framed
    // element.」 The four <i>s come from the component so a call site cannot.
    const html = renderMarkup(
      <Blueprint>
        <p>
          <Trans>回合时间线</Trans>
        </p>
      </Blueprint>,
    );

    expect(html).toContain('class="blueprint"');
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      expect(html).toContain(`class="corner ${corner}"`);
    }
    expect(html.split('aria-hidden="true"')).toHaveLength(5);
  });

  it('keeps the marks out of the accessibility tree', () => {
    const html = renderMarkup(<Blueprint>x</Blueprint>);

    expect(html).toContain('<i aria-hidden="true" class="corner tl"></i>');
  });

  it('renders the content before the marks', () => {
    const html = renderMarkup(
      <Blueprint>
        <span>记分板</span>
      </Blueprint>,
    );

    expect(html.indexOf('记分板')).toBeLessThan(html.indexOf('class="corner tl"'));
  });

  it('takes the element and the extra classes the call site needs', () => {
    const html = renderMarkup(
      <Blueprint as="figure" className="p-4" aria-label="雷达">
        <svg />
      </Blueprint>,
    );

    expect(html).toContain('<figure class="blueprint p-4" aria-label="雷达">');
  });
});
