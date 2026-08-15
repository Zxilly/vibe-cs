import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { createSampleTimeline } from './sampleTimeline';
import { TimelinePrototype } from './TimelinePrototype';

const markup = renderMarkup(<TimelinePrototype initial={createSampleTimeline()} />);

describe('TimelinePrototype markup', () => {
  it('names the region and states the zoom as the artboard does', () => {
    expect(markup).toContain('aria-label="多轨时间轴"');
    expect(markup).toContain('1 秒 = 12 px');
  });

  it('offers the artboard’s tools, reusing the design system’s controls', () => {
    for (const label of ['选择', '剃刀', '滑移', '波纹删除', '吸附', '撤销', '重做']) {
      expect(markup).toContain(label);
    }
    // Seg, not a row of buttons: the tool group is a real radio group.
    expect(markup).toContain('name="timeline-tool"');
    expect(markup).toContain('type="radio"');
  });

  it('draws five heads and five lanes', () => {
    expect(markup.match(/class="tl-head"/gu)).toHaveLength(5);
    expect(markup.match(/class="tl-lane"/gu)).toHaveLength(5);
    for (const name of ['V2', 'V1', 'A1', 'A2', 'T1']) expect(markup).toContain(`>${name}<`);
  });

  it('draws every clip of the fixture', () => {
    expect(markup.match(/class="tl-clip"/gu)).toHaveLength(10);
    expect(markup).toContain('Kael_Mirage_1v3.mp4');
    expect(markup).toContain('low-orbit.mp3');
    expect(markup).toContain('1v3 CLUTCH');
  });

  it('puts the pixels-per-second on the container and only there', () => {
    expect(markup).toContain('--tl-pps:12');
    expect(markup.match(/--tl-pps:/gu)).toHaveLength(1);
  });

  it('draws the ruler, the markers and the playhead', () => {
    expect(markup).toContain('role="slider"');
    expect(markup).toContain('class="tl-marker"');
    expect(markup).toContain('class="tl-playhead"');
    expect(markup).toContain('00:31');
  });

  it('starts with nothing selected and no refusal showing', () => {
    expect(markup).toContain('未选中片段');
    expect(markup).not.toContain('data-selected="true"');
    expect(markup).not.toContain('没有移动');
  });

  it('disables the actions that need a selection, with a reason', () => {
    // Spec §4.1 / the artboard: 「不隐藏、不静默失败」— a disabled action says why.
    expect(markup).toContain('先选中一个片段');
    expect(markup).toContain('没有可撤销的操作');
  });

  it('sizes the canvas from the sequence length, in seconds', () => {
    expect(markup).toContain('--tl-length:86.667');
    expect(markup).toContain('--tl-scroll:0');
  });
});
