import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from './render';

// Guards the wiring itself: if the Lingui macro pass stops running, or the
// providers stop being applied, this fails before any page test does.
describe('renderMarkup', () => {
  it('renders the zh-CN source copy without a compiled catalog', () => {
    const html = renderMarkup(
      <span>
        <Trans>确认并生成视频</Trans>
      </span>,
    );
    expect(html).toBe('<span>确认并生成视频</span>');
  });
});
