import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../test/render';
import { Blueprint } from './Blueprint';

describe('Blueprint', () => {
  it('draws the frame and nothing else', () => {
    // The frame is a quiet hairline box: no registration marks, ticks or
    // rules outside the border — decoration that reads as stray lines on a
    // data-dense screen.
    const html = renderMarkup(
      <Blueprint>
        <p>
          <Trans>回合时间线</Trans>
        </p>
      </Blueprint>,
    );

    expect(html).toContain('class="blueprint"');
    expect(html).not.toContain('corner');
    expect(html).not.toContain('<i');
  });

  it('renders only the content inside the frame', () => {
    const html = renderMarkup(
      <Blueprint>
        <span>记分板</span>
      </Blueprint>,
    );

    expect(html).toBe('<div class="blueprint"><span>记分板</span></div>');
  });

  it('takes the element and the extra classes the call site needs', () => {
    const html = renderMarkup(
      <Blueprint as="figure" className="p-4" aria-label="雷达">
        <svg />
      </Blueprint>,
    );

    expect(html).toMatch(/^<figure[^>]*aria-label="雷达"[^>]*class="blueprint p-4"/u);
  });
});
