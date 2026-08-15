import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { TimeRuler } from './TimeRuler';
import { createTimeScale } from './timeScale';

describe('TimeRuler markup', () => {
  it('draws a tick per subdivision and a label per major tick', () => {
    const markup = renderMarkup(<TimeRuler scale={createTimeScale(1)} lengthSeconds={60} playhead={0} />);
    // 0–60 at 12 px/s: majors every 10s, subdivisions every 5s.
    expect(markup.match(/class="tl-tick"/gu)).toHaveLength(13);
    expect(markup).toContain('data-major="true"');
    expect(markup).toContain('data-major="false"');
    expect(markup).toContain('>00:00<');
    expect(markup).toContain('>00:30<');
    expect(markup).toContain('>01:00<');
  });

  it('positions every tick in seconds, leaving the multiplication to CSS', () => {
    const markup = renderMarkup(<TimeRuler scale={createTimeScale(1)} lengthSeconds={20} playhead={0} />);
    // `--tl-t` carries the time; nothing in the markup mentions a pixel.
    expect(markup).toContain('--tl-t:10');
    expect(markup).not.toContain('left:');
  });

  it('re-labels itself at another zoom without changing its structure', () => {
    const close = renderMarkup(<TimeRuler scale={createTimeScale(8)} lengthSeconds={10} playhead={0} />);
    expect(close).toContain('>00:01<');
    expect(close).toContain('>00:09<');
  });

  it('is a plain strip with no role when it cannot be scrubbed', () => {
    const markup = renderMarkup(<TimeRuler scale={createTimeScale(1)} lengthSeconds={60} playhead={12} />);
    expect(markup).not.toContain('role="slider"');
    expect(markup).not.toContain('tabindex');
  });

  it('becomes the playhead’s slider when it can be scrubbed', () => {
    const markup = renderMarkup(
      <TimeRuler scale={createTimeScale(1)} lengthSeconds={60} playhead={31.167} onPlayheadChange={() => {}} />,
    );
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('aria-label="播放头"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="60"');
    expect(markup).toContain('aria-valuenow="31.167"');
    expect(markup).toContain('aria-valuetext="00:31"');
    expect(markup).toContain('tabindex="0"');
  });

  it('never reports a maximum below the playhead', () => {
    const markup = renderMarkup(
      <TimeRuler scale={createTimeScale(1)} lengthSeconds={10} playhead={90} onPlayheadChange={() => {}} />,
    );
    expect(markup).toContain('aria-valuemax="90"');
  });

  it('renders nothing but the strip for a zero-length sequence', () => {
    const markup = renderMarkup(<TimeRuler scale={createTimeScale(1)} lengthSeconds={0} playhead={0} />);
    expect(markup).not.toContain('tl-tick');
  });
});
