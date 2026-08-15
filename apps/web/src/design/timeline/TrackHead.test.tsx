import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { createSampleTimeline } from './sampleTimeline';
import { TrackHead } from './TrackHead';

const [v2, v1, a1, , t1] = createSampleTimeline().tracks;

describe('TrackHead markup', () => {
  it('draws the artboard’s two-part label', () => {
    const markup = renderMarkup(<TrackHead track={v1!} />);
    expect(markup).toContain('V1');
    expect(markup).toContain('主画面');
    expect(markup).toContain('data-track="v1"');
  });

  it('declares the lane height its lane will use', () => {
    expect(renderMarkup(<TrackHead track={v2!} />)).toContain('--tl-lane-h:62');
    expect(renderMarkup(<TrackHead track={a1!} />)).toContain('--tl-lane-h:52');
    expect(renderMarkup(<TrackHead track={t1!} />)).toContain('--tl-lane-h:44');
  });

  it('picks out the current lane', () => {
    expect(renderMarkup(<TrackHead track={v1!} />)).toContain('data-current="false"');
    expect(renderMarkup(<TrackHead track={v1!} current />)).toContain('data-current="true"');
  });

  it('reports a locked lane', () => {
    expect(renderMarkup(<TrackHead track={{ ...v1!, locked: true }} />)).toContain('data-locked="true"');
    expect(renderMarkup(<TrackHead track={v1!} />)).toContain('data-locked="false"');
  });
});
