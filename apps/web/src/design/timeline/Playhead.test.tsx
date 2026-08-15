import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { MarkerLayer, Playhead } from './Playhead';
import { createSampleTimeline } from './sampleTimeline';

describe('Playhead markup', () => {
  it('carries its instant in seconds and draws the artboard’s flag', () => {
    const markup = renderMarkup(<Playhead timeSeconds={31.167} />);
    expect(markup).toContain('--tl-t:31.167');
    expect(markup).toContain('tl-playhead-flag');
    expect(markup).toContain('data-time="31.167"');
  });

  it('is decoration unless it is given a name', () => {
    expect(renderMarkup(<Playhead timeSeconds={0} />)).toContain('role="presentation"');
    const named = renderMarkup(<Playhead timeSeconds={31.167} label="播放头 00:31" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="播放头 00:31"');
  });
});

describe('MarkerLayer markup', () => {
  const { markers } = createSampleTimeline();

  it('draws one full-height guide per marker, each with its label', () => {
    const markup = renderMarkup(<MarkerLayer markers={markers} />);
    expect(markup.match(/class="tl-marker"/gu)).toHaveLength(2);
    expect(markup).toContain('--tl-t:20');
    expect(markup).toContain('--tl-t:55');
    expect(markup).toContain('入场');
    expect(markup).toContain('残局开始');
  });

  it('renders nothing for a sequence with no markers', () => {
    expect(renderMarkup(<MarkerLayer markers={[]} />)).toBe('');
  });
});
