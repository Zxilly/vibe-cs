import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { ClipView } from './ClipView';
import { createSampleTimeline } from './sampleTimeline';
import { getClip } from './timelineModel';

const timeline = createSampleTimeline();
const aurora = getClip(timeline, 'v1-aurora')!;
const music = getClip(timeline, 'a2-music')!;

describe('ClipView markup', () => {
  it('is a button, so a clip can be reached and edited from the keyboard', () => {
    const markup = renderMarkup(<ClipView clip={aurora} kind="video" />);
    expect(markup).toContain('<button');
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it('carries its position in seconds and lets CSS do the pixels', () => {
    const markup = renderMarkup(<ClipView clip={aurora} kind="video" />);
    expect(markup).toContain('--tl-t0:42.167');
    expect(markup).toContain('--tl-dur:28');
    expect(markup).toContain('--tl-dx:0');
    // Spec §0.5: no per-frame `left` / `width`.
    expect(markup).not.toContain('left:');
    expect(markup).not.toContain('width:');
  });

  it('takes its colour from the lane kind, not from the clip', () => {
    expect(renderMarkup(<ClipView clip={aurora} kind="video" />)).toContain('data-kind="video"');
    expect(renderMarkup(<ClipView clip={music} kind="audio" />)).toContain('data-kind="audio"');
    // The inset differs by kind too: 8px in a video lane, 6px elsewhere.
    expect(renderMarkup(<ClipView clip={aurora} kind="video" />)).toContain('--tl-inset:8');
    expect(renderMarkup(<ClipView clip={music} kind="audio" />)).toContain('--tl-inset:6');
  });

  it('names itself with its label and its span', () => {
    const markup = renderMarkup(<ClipView clip={aurora} kind="video" />);
    expect(markup).toContain('aria-label="Aurora_R13_ace.mp4，00:42 至 01:10"');
  });

  it('states its selection in words as well as in colour', () => {
    const markup = renderMarkup(<ClipView clip={aurora} kind="video" selected />);
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain('已选中');
  });

  it('states a refused drop in words as well as in colour', () => {
    const markup = renderMarkup(<ClipView clip={aurora} kind="video" blocked />);
    expect(markup).toContain('data-blocked="true"');
    expect(markup).toContain('放到匹配类型的轨道');
  });

  it('marks the partner of the selected clip as linked', () => {
    expect(renderMarkup(<ClipView clip={music} kind="audio" linked />)).toContain('data-linked="true"');
  });

  it('carries the live drag offset as a single pixel number', () => {
    const markup = renderMarkup(<ClipView clip={aurora} kind="video" dragging dragOffsetPx={-96} />);
    expect(markup).toContain('--tl-dx:-96');
    expect(markup).toContain('data-dragging="true"');
  });

  it('shows the timeline span by default and the source window under the slip tool', () => {
    expect(renderMarkup(<ClipView clip={aurora} kind="video" />)).toContain('00:42–01:10');
    // 入点 00:00:04:07 / 出点 00:00:32:07, the Inspector's two rows.
    const slipping = renderMarkup(<ClipView clip={aurora} kind="video" showSourceWindow />);
    expect(slipping).toContain('00:00:04:07');
    expect(slipping).toContain('00:00:32:07');
  });

  it('exposes the source in point for a test to read without a getter', () => {
    expect(renderMarkup(<ClipView clip={aurora} kind="video" />)).toContain('data-source-in="4.133"');
  });
});
